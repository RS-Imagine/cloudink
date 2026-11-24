use worker::Env;
use worker::js_sys::JsString;
use worker::wasm_bindgen::JsCast;

use crate::assets::{GENERATION_VERSION, RESPONSE_VERSION, TEMPLATE_VERSION};
use crate::runtime::property;

#[derive(Clone)]
pub struct Config {
    pub setup_token: JsString,
    pub template_version: &'static str,
    pub response_version: &'static str,
    pub generation_version: &'static str,
}

impl Config {
    pub fn new(env: &Env) -> Self {
        let token = property(env.as_ref(), "SETUP_TOKEN");
        Self {
            setup_token: if token.is_string() {
                token.unchecked_into()
            } else {
                "".into()
            },
            template_version: TEMPLATE_VERSION,
            response_version: RESPONSE_VERSION,
            generation_version: GENERATION_VERSION,
        }
    }
}
