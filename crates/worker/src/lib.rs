mod feed;

use worker::js_sys::{self, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures;
use worker::{Bucket, Response, Result, web_sys};

#[wasm_bindgen]
pub async fn rss_response(
    origin: String,
    storage: JsValue,
    release: Option<String>,
    pages: JsValue,
    template_version: String,
    response_version: String,
) -> std::result::Result<web_sys::Response, JsValue> {
    // The host passes its instrumented STORAGE binding on an RSS cache miss.
    let storage = storage.unchecked_into::<Bucket>();
    let rss = feed::render(&storage, &origin, release.as_deref(), &pages)
        .await
        .map_err(|error| js_sys::Error::new(&error.to_string()))?;
    let etag = feed_etag(&origin, &rss.text, &template_version, &response_version).await?;
    let mut response = Response::from_bytes(rss.into_bytes())?;
    let headers = response.headers_mut();
    headers.set("Content-Type", "application/rss+xml; charset=utf-8")?;
    headers.set("Cache-Control", "public, max-age=0, must-revalidate")?;
    headers.set("ETag", &etag)?;
    Ok(response.into())
}

async fn feed_etag(
    origin: &str,
    body: &str,
    template_version: &str,
    response_version: &str,
) -> Result<String> {
    use std::fmt::Write;

    let input = format!("reader-v5:{response_version}:{template_version}:{origin}/feed.xml{body}:");
    let global = js_sys::global().unchecked_into::<web_sys::WorkerGlobalScope>();
    let digest = global
        .crypto()?
        .subtle()
        .digest_with_str_and_u8_array("SHA-256", input.as_bytes())?;
    let digest = Uint8Array::new(&wasm_bindgen_futures::JsFuture::from(digest).await?);
    let mut etag = String::from("\"");
    for byte in digest.to_vec() {
        write!(etag, "{byte:02x}").expect("writing to String cannot fail");
    }
    etag.push('"');
    Ok(etag)
}
