mod discovery;
mod feed;
mod html_rewriter;
mod public_cache;
mod reader;
mod router;

use worker::js_sys::{self, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures;
use worker::worker_sys::R2Bucket;
use worker::{Bucket, Context, Error, Response, Result, web_sys};

#[wasm_bindgen]
pub async fn route_request(
    request: web_sys::Request,
    storage: JsValue,
    ctx: JsValue,
    services: JsValue,
    template_version: String,
    response_version: String,
) -> html_rewriter::JsResult<web_sys::Response> {
    let storage = storage.unchecked_into::<R2Bucket>();
    let context = Context::new(ctx.unchecked_into());
    let services = services.unchecked_into::<router::Services>();
    router::PublicRouter {
        request: &request,
        storage: &storage,
        ctx: &context,
        services: &services,
        template_version: &template_version,
        response_version: &response_version,
    }
    .respond()
    .await
}

async fn discovery_response(
    path: &str,
    origin: &str,
    storage: &R2Bucket,
    release: Option<&str>,
    pages: &JsValue,
    template_version: &str,
    response_version: &str,
) -> std::result::Result<web_sys::Response, JsValue> {
    let response = match path {
        "/robots.txt" => discovery::robots(origin),
        "/sitemap.xml" => {
            let binding: &JsValue = storage.as_ref();
            let bucket = binding.clone().unchecked_into::<Bucket>();
            discovery::sitemap(origin, &bucket, release, pages).await
        }
        "/feed.xml" => {
            rss_response(
                origin,
                storage,
                release,
                pages,
                template_version,
                response_version,
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
