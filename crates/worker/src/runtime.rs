use std::fmt::Write;

use worker::js_sys::{self, JSON, JsString, Object, Reflect, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::web_sys::{
    Headers, ReadableStream, ReadableStreamDefaultReader, Request, Response, WorkerGlobalScope,
};
use worker::worker_sys::R2Bucket;

use crate::html_rewriter::{JsResult, string_response};
use crate::public_cache::response_init;
use crate::wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = String)]
    pub fn js_string(value: &JsValue) -> JsString;

    #[wasm_bindgen(js_name = Number)]
    pub fn js_number(value: &JsValue) -> f64;
}

pub fn property(object: &JsValue, key: &str) -> JsValue {
    if object.is_object() {
        return Reflect::get(object, &key.into()).unwrap_or(JsValue::UNDEFINED);
    }
    JsValue::UNDEFINED
}

pub fn set(object: &JsValue, key: &str, value: impl Into<JsValue>) -> Result<(), JsValue> {
    Reflect::set(object, &key.into(), &value.into()).map(drop)
}

pub fn attribute(object: &JsValue, key: &str) -> String {
    property(object, key).as_string().unwrap_or_default()
}

pub fn object(fields: &[(&str, JsValue)]) -> JsResult<Object> {
    let result = Object::new();
    for (key, value) in fields {
        set(&result, key, value)?;
    }
    Ok(result)
}

pub fn json(status: u16, fields: &[(&str, JsValue)]) -> JsResult<Response> {
    let value = object(fields)?;
    json_object(status, &value)
}

pub fn json_object(status: u16, value: &JsValue) -> JsResult<Response> {
    let headers = Headers::new()?;
    headers.set("Content-Type", "application/json; charset=utf-8")?;
    headers.set("Cache-Control", "no-store")?;
    string_response(&JSON::stringify(value)?, &response_init(status, &headers))
}

pub async fn get(storage: &R2Bucket, key: &str) -> JsResult<JsValue> {
    JsFuture::from(storage.get(key.to_owned(), JsValue::UNDEFINED)?).await
}

pub fn only_if(condition: &str, value: JsValue) -> JsResult<Object> {
    let conditional = object(&[(condition, value)])?;
    object(&[("onlyIf", conditional.into())])
}

pub async fn cancel_body(object: &JsValue) -> JsResult<()> {
    let body: ReadableStream = property(object, "body").unchecked_into();
    JsFuture::from(body.cancel()).await.map(drop)
}

pub async fn limited_body(
    request: &Request,
    limit: u32,
    too_large: impl Fn() -> JsValue,
) -> JsResult<Uint8Array> {
    if js_number(
        &request
            .headers()
            .get("content-length")?
            .unwrap_or_default()
            .into(),
    ) > f64::from(limit)
    {
        return Err(too_large());
    }
    let Some(body) = request.body() else {
        return Ok(Uint8Array::new_with_length(0));
    };
    let reader: ReadableStreamDefaultReader = body.get_reader().unchecked_into();
    let mut chunks = Vec::new();
    let mut size = 0;
    let result = async {
        loop {
            let read = JsFuture::from(reader.read()).await?;
            if property(&read, "done").is_truthy() {
                return Ok(());
            }
            let bytes: Uint8Array = property(&read, "value").unchecked_into();
            if bytes.length() > limit - size {
                JsFuture::from(reader.cancel()).await?;
                return Err(too_large());
            }
            size += bytes.length();
            chunks.push(bytes);
        }
    }
    .await;
    reader.release_lock();
    result?;
    let whole = Uint8Array::new_with_length(size);
    let mut offset = 0;
    for chunk in chunks {
        whole.set(&chunk, offset);
        offset += chunk.length();
    }
    Ok(whole)
}

pub async fn sha256_hex(bytes: &Uint8Array) -> JsResult<String> {
    let global = js_sys::global().unchecked_into::<WorkerGlobalScope>();
    let digest = global
        .crypto()?
        .subtle()
        .digest_with_str_and_js_u8_array("SHA-256", bytes)?;
    let digest = Uint8Array::new(&JsFuture::from(digest).await?);
    let mut hex = String::with_capacity(64);
    for byte in digest.to_vec() {
        write!(hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(hex)
}
