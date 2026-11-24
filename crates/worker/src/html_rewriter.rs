use worker::js_sys::{JsString, Object, Reflect};
use worker::wasm_bindgen::{self, JsValue, closure::Closure, prelude::wasm_bindgen};
use worker::web_sys::{Response, ResponseInit};

pub type JsResult<T> = std::result::Result<T, JsValue>;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = HTMLRewriter)]
    pub type HtmlRewriter;

    #[wasm_bindgen(constructor, js_class = HTMLRewriter)]
    pub fn new() -> HtmlRewriter;

    #[wasm_bindgen(method, catch, js_name = on)]
    fn register(this: &HtmlRewriter, selector: &str, handler: &Object) -> JsResult<()>;

    #[wasm_bindgen(method, catch)]
    pub fn transform(this: &HtmlRewriter, response: &Response) -> JsResult<Response>;

    pub type Element;

    #[wasm_bindgen(method, getter, js_name = tagName)]
    pub fn tag_name(this: &Element) -> String;

    #[wasm_bindgen(method, getter, js_name = attributes)]
    pub fn attributes(this: &Element) -> JsValue;

    #[wasm_bindgen(method, js_name = getAttribute)]
    pub fn attribute(this: &Element, name: &str) -> Option<JsString>;

    #[wasm_bindgen(method, js_name = hasAttribute)]
    pub fn has_attribute(this: &Element, name: &str) -> bool;

    #[wasm_bindgen(method, catch, js_name = setAttribute)]
    pub fn set_attribute(this: &Element, name: &str, value: &JsString) -> JsResult<()>;

    #[wasm_bindgen(method, catch, js_name = removeAttribute)]
    pub fn remove_attribute(this: &Element, name: &str) -> JsResult<()>;

    #[wasm_bindgen(method, catch)]
    pub fn remove(this: &Element) -> JsResult<()>;

    #[wasm_bindgen(method, catch)]
    pub fn append(this: &Element, content: &JsString, options: &Object) -> JsResult<()>;

    pub type Comment;

    #[wasm_bindgen(method, catch, js_name = remove)]
    pub fn remove_comment(this: &Comment) -> JsResult<()>;

    pub type TextChunk;

    #[wasm_bindgen(method, getter)]
    pub fn text(this: &TextChunk) -> JsString;

    #[wasm_bindgen(js_name = Response)]
    type StringResponse;

    #[wasm_bindgen(constructor, catch, js_class = Response)]
    fn with_string(body: &JsString, init: &ResponseInit) -> JsResult<StringResponse>;
}

impl HtmlRewriter {
    pub fn on_element(
        &self,
        selector: &str,
        f: impl FnMut(Element) -> JsResult<()> + 'static,
    ) -> JsResult<()> {
        let callback = Closure::wrap(Box::new(f) as Box<dyn FnMut(Element) -> JsResult<()>>);
        self.on_handler(selector, "element", callback.into_js_value())
    }

    pub fn on_text(&self, selector: &str, f: impl FnMut(TextChunk) + 'static) -> JsResult<()> {
        let callback = Closure::wrap(Box::new(f) as Box<dyn FnMut(TextChunk)>);
        self.on_handler(selector, "text", callback.into_js_value())
    }

    pub fn on_comments(
        &self,
        selector: &str,
        f: impl FnMut(Comment) -> JsResult<()> + 'static,
    ) -> JsResult<()> {
        let callback = Closure::wrap(Box::new(f) as Box<dyn FnMut(Comment) -> JsResult<()>>);
        self.on_handler(selector, "comments", callback.into_js_value())
    }

    fn on_handler(&self, selector: &str, event: &str, callback: JsValue) -> JsResult<()> {
        // The runtime retains each callback while it consumes the transformed stream.
        let handler = Object::new();
        Reflect::set(&handler, &event.into(), &callback)?;
        self.register(selector, &handler)
    }
}

pub fn string_response(body: &JsString, init: &ResponseInit) -> JsResult<Response> {
    use worker::wasm_bindgen::JsCast;
    Ok(StringResponse::with_string(body, init)?.unchecked_into())
}
