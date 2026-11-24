use std::fmt::Write;

use worker::js_sys::{self, JsString, Reflect, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::web_sys::WorkerGlobalScope;

use crate::html_rewriter::JsResult;
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
