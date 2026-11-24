use worker::js_sys::{Error, JsString, RegExp, Uint8Array, WeakSet};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::web_sys::Request;

use crate::html_rewriter::JsResult;
use crate::runtime::{limited_body, property, set};

thread_local! {
    static HTTP_ERRORS: WeakSet<Error> = WeakSet::new_typed();
    static PRIVATE_ID: RegExp = RegExp::new(r"/[A-Za-z0-9_-]{20,}", "g");
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = TextDecoder)]
    type TextDecoder;

    #[wasm_bindgen(constructor, catch, js_class = TextDecoder)]
    fn new() -> JsResult<TextDecoder>;

    #[wasm_bindgen(method, catch)]
    fn decode(this: &TextDecoder, input: &Uint8Array) -> JsResult<JsString>;

    #[wasm_bindgen(js_namespace = JSON, js_name = parse, catch)]
    fn parse_json(text: &JsString) -> JsResult<JsValue>;
}

pub fn error(status: u16, message: &str) -> JsValue {
    let error = Error::new(message);
    let _ = set(&error, "status", status);
    HTTP_ERRORS.with(|errors| errors.add(&error));
    error.into()
}

pub fn status(error: &JsValue) -> Option<u16> {
    let error = error.dyn_ref::<Error>()?;
    if !HTTP_ERRORS.with(|errors| errors.has(error)) {
        return None;
    }
    property(error, "status")
        .as_f64()
        .map(|status| status as u16)
}

pub fn safe_path(path: &str) -> JsString {
    PRIVATE_ID.with(|pattern| JsString::from(path).replace_by_pattern(pattern, "/:id"))
}

pub fn error_type(error: &JsValue) -> JsString {
    error
        .dyn_ref::<Error>()
        .map(|error| error.name())
        .unwrap_or_else(|| "unknown".into())
}

pub async fn json_input(request: &Request, max: u32) -> JsResult<JsValue> {
    if !request
        .headers()
        .get("content-type")?
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return Err(error(415, "请使用 JSON 请求。"));
    }
    let input = async {
        let bytes = limited_body(request, max, || error(413, "上传内容太大。")).await?;
        let result = parse_json(&TextDecoder::new()?.decode(&bytes)?)?;
        if result.is_object() && !worker::js_sys::Array::is_array(&result) {
            return Ok(result);
        }
        Err(JsValue::UNDEFINED)
    }
    .await;
    input.map_err(|failure| {
        if status(&failure).is_some() {
            failure
        } else {
            error(400, "请求格式不正确。")
        }
    })
}
