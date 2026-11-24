mod discovery;
mod feed;
mod html_rewriter;
mod reader;

use worker::js_sys::{self, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures;
use worker::worker_sys::R2Bucket;
use worker::{Bucket, Error, Response, Result, web_sys};

#[wasm_bindgen]
pub async fn reader_html(
    response: web_sys::Response,
    url: web_sys::Url,
    analytics: bool,
    apple_icon: Option<String>,
    fallback_icon: Option<String>,
    legacy_image_path: js_sys::Function,
) -> html_rewriter::JsResult<web_sys::Response> {
    reader::render(
        response,
        url,
        analytics,
        apple_icon,
        fallback_icon,
        legacy_image_path,
    )
    .await
}

#[wasm_bindgen]
pub async fn reader_etag(
    value: String,
    url: web_sys::Url,
    site_icon: String,
    template_version: String,
    response_version: String,
) -> html_rewriter::JsResult<String> {
    public_etag(
        &url.origin(),
        &url.pathname(),
        &value,
        &site_icon,
        &template_version,
        &response_version,
    )
    .await
    .map_err(Into::into)
}

#[wasm_bindgen]
pub async fn discovery_response(
    path: String,
    origin: String,
    storage: JsValue,
    release: Option<String>,
    pages: JsValue,
    template_version: String,
    response_version: String,
) -> std::result::Result<web_sys::Response, JsValue> {
    // The host passes its instrumented STORAGE binding on a cache miss.
    let response = match path.as_str() {
        "/robots.txt" => discovery::robots(&origin),
        "/sitemap.xml" => {
            let storage = storage.unchecked_into::<Bucket>();
            discovery::sitemap(&origin, &storage, release.as_deref(), &pages).await
        }
        "/feed.xml" => {
            let storage = storage.unchecked_into::<R2Bucket>();
            rss_response(
                &origin,
                &storage,
                release.as_deref(),
                &pages,
                &template_version,
                &response_version,
            )
            .await
        }
        _ => Err(Error::RustError("Unknown discovery route".into())),
    };
    response
        .map(Into::into)
        .map_err(|error| js_sys::Error::new(&error.to_string()).into())
}

async fn rss_response(
    origin: &str,
    storage: &R2Bucket,
    release: Option<&str>,
    pages: &JsValue,
    template_version: &str,
    response_version: &str,
) -> Result<Response> {
    let rss = feed::render(storage, origin, release, pages).await?;
    let etag = public_etag(
        origin,
        "/feed.xml",
        &rss.text,
        "",
        template_version,
        response_version,
    )
    .await?;
    let mut response = public_response(
        Response::from_bytes(rss.into_bytes())?,
        "application/rss+xml; charset=utf-8",
    )?;
    response.headers_mut().set("ETag", &etag)?;
    Ok(response)
}

fn public_response(mut response: Response, content_type: &str) -> Result<Response> {
    let headers = response.headers_mut();
    headers.set("Content-Type", content_type)?;
    headers.set("Cache-Control", "public, max-age=0, must-revalidate")?;
    Ok(response)
}

fn valid_post_slug(slug: &str) -> bool {
    (1..=100).contains(&slug.len())
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

async fn public_etag(
    origin: &str,
    path: &str,
    value: &str,
    site_icon: &str,
    template_version: &str,
    response_version: &str,
) -> Result<String> {
    use std::fmt::Write;

    let input = format!(
        "reader-v5:{response_version}:{template_version}:{origin}{path}{value}:{site_icon}"
    );
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
