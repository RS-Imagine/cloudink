mod feed;

use worker::js_sys::{self, Array, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures;
use worker::web_sys::{self, Url};
use worker::{Bucket, Cache, Context, Response, Result};

const POINTER_KEY: &str = "state/published.json";
const POINTER_TTL: u32 = 30;
const FEED_TTL: u32 = 3_600;
const CLIENT_POLICY: &str = "public, max-age=0, must-revalidate";

#[wasm_bindgen]
pub async fn rss_response(
    request: web_sys::Request,
    storage: JsValue,
    context: worker::worker_sys::Context,
    template_version: String,
    response_version: String,
) -> std::result::Result<Array, JsValue> {
    // The TS host passes its instrumented STORAGE binding and original execution context.
    let storage = storage.unchecked_into::<Bucket>();
    let result = serve_feed(
        &Url::new(&request.url())?,
        &storage,
        &Context::new(context),
        &template_version,
        &response_version,
    )
    .await;
    let (response, analytics_on_hit) =
        result.map_err(|error| js_sys::Error::new(&error.to_string()))?;
    let response = web_sys::Response::from(response);
    let analytics = analytics_on_hit.map(JsValue::from).unwrap_or(JsValue::NULL);
    Ok(Array::of2(&response, &analytics))
}

async fn serve_feed(
    url: &Url,
    storage: &Bucket,
    ctx: &Context,
    template_version: &str,
    response_version: &str,
) -> Result<(Response, Option<bool>)> {
    let cache = Cache::default();
    let namespace = format!("{template_version}/{response_version}");
    let pointer_key = cache_key(url, &namespace, "pointer", "", "/")?;
    let cached_pointer = cache.get(&pointer_key, false).await.ok().flatten();
    let pointer_hit = cached_pointer.is_some();
    let mut pointer = match cached_pointer {
        Some(mut response) => response.json().await?,
        None => feed::read_json(storage, POINTER_KEY)
            .await?
            .unwrap_or_default(),
    };
    feed::fill_legacy_icon(storage, &mut pointer).await?;
    if !pointer_hit && pointer.is_object() {
        write_cache(
            ctx,
            pointer_key,
            &mut Response::from_json(&pointer)?,
            POINTER_TTL,
        )?;
    }

    let id = pointer["id"].as_str().filter(|id| !id.is_empty());
    let icon = pointer["siteIcon"].as_str().unwrap_or_default();
    let version = format!("{}:{icon}", id.unwrap_or("initial"));
    let path = url.pathname();
    let page_key = cache_key(url, &namespace, "page", &version, &path)?;
    if let Some(response) = cache.get(&page_key, false).await.ok().flatten() {
        let analytics = pointer["clarityId"].as_str().is_some_and(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value.bytes().all(|b| b.is_ascii_alphanumeric())
        });
        return Ok((response, Some(analytics)));
    }

    let origin = url.origin();
    let rss = feed::render(storage, &origin, id, &pointer["pages"]).await?;
    let etag = feed_etag(
        &origin,
        &path,
        &rss.text,
        template_version,
        response_version,
    )
    .await?;
    let mut response = Response::from_bytes(rss.into_bytes())?;
    response
        .headers_mut()
        .set("Content-Type", "application/rss+xml; charset=utf-8")?;
    response.headers_mut().set("Cache-Control", CLIENT_POLICY)?;
    response.headers_mut().set("ETag", &etag)?;
    write_cache(ctx, page_key, &mut response, FEED_TTL)?;
    Ok((response, None))
}

// Match cache.ts so a successful TS publication invalidates Rust's pointer too.
fn cache_key(url: &Url, namespace: &str, group: &str, version: &str, path: &str) -> Result<String> {
    let key = Url::new(&url.href())?;
    let version = js_sys::encode_uri_component(version);
    key.set_pathname(&format!(
        "/__cloudink_cache/{namespace}/{group}/{version}{path}"
    ));
    key.set_search("");
    Ok(key.href())
}

fn write_cache(ctx: &Context, key: String, response: &mut Response, seconds: u32) -> Result<()> {
    let mut copy = response.cloned()?;
    let headers = copy.headers_mut();
    let policy = headers.get("Cache-Control")?;
    headers.set(
        "X-CloudInk-Client-Cache-Control",
        policy.as_deref().unwrap_or(CLIENT_POLICY),
    )?;
    headers.set("Cache-Control", &format!("public, max-age={seconds}"))?;
    headers.delete("Vary")?;
    headers.delete("Set-Cookie")?;
    ctx.wait_until(async move {
        let _ = Cache::default().put(key, copy).await;
    });
    Ok(())
}

async fn feed_etag(
    origin: &str,
    path: &str,
    body: &str,
    template_version: &str,
    response_version: &str,
) -> Result<String> {
    use std::fmt::Write;

    let input = format!("reader-v5:{response_version}:{template_version}:{origin}{path}{body}:");
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
