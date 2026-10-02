use blog_core::models::{FrontMatter, PostDraft, SiteConfig};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct PreviewRequest { config: SiteConfig, draft: EditorDraft }

#[derive(Deserialize, Serialize)]
struct EditorDraft { front_matter: FrontMatter, body_markdown: String }

#[wasm_bindgen]
pub fn render_preview(input: &str) -> Result<String, JsValue> {
    let request: PreviewRequest = serde_json::from_str(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let draft=PostDraft {front_matter:request.draft.front_matter,body_markdown:request.draft.body_markdown};
    blog_core::render_preview(&request.config, &draft).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn parse_markdown(source: &str) -> Result<String, JsValue> {
    let post = blog_core::content::parse_post(source).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&EditorDraft { front_matter: post.front_matter, body_markdown: post.body_markdown })
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn stylesheet() -> String { blog_core::render::stylesheet().to_owned() }

#[wasm_bindgen]
pub fn render_release(input: &str) -> Result<String, JsValue> {
    let files = blog_core::bundle::render_release(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&files).map_err(|e| JsValue::from_str(&e.to_string()))
}
