use worker::js_sys::{JsString, Reflect};
use worker::wasm_bindgen::{self, JsValue, prelude::wasm_bindgen};

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
