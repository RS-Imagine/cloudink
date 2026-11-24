use worker::Context;
use worker::js_sys::{JsString, decode_uri_component};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Headers, ReadableStream, Request, Response, Url};
use worker::worker_sys::{R2Bucket, R2Object};

use crate::html_rewriter::JsResult;
use crate::icon::PREFIX as ICON_PREFIX;
use crate::public_cache::{self as cache, Group, stream_response, text_response};
use crate::runtime::property;

pub const MAX_IMAGE: u32 = 10 * 1024 * 1024;

pub fn valid_image_key(key: &str) -> bool {
    if let Some((hash, ext)) = key
        .strip_prefix(ICON_PREFIX)
        .and_then(|name| name.split_once('.'))
        && hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && matches!(
            ext,
            "svg" | "ico" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif"
        )
    {
        return true;
    }
    key.len() <= 1024
        && key
            .strip_prefix("uploads/")
            .and_then(|path| path.rsplit_once('.'))
            .is_some_and(|(stem, ext)| {
                !stem.is_empty()
                    && matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif")
                    && stem.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-')
                    })
            })
        && !key.split('/').any(|part| matches!(part, "" | "." | ".."))
}

pub fn legacy_image_path(input: &str, origin: &str) -> Option<String> {
    let url = Url::new_with_base(input, origin).ok()?;
    let params = url.search_params();
    if url.origin() != origin
        || !url.username().is_empty()
        || !url.password().is_empty()
        || url.pathname() != "/api/image"
        || params.get_all("key").length() != 1
    {
        return None;
    }
    let key = params.get("key")?;
    valid_image_key(&key).then(|| format!("/images/{key}"))
}

pub fn supported_type(mime: &str) -> bool {
    matches!(
        mime,
        "image/jpeg"
            | "image/png"
            | "image/webp"
            | "image/gif"
            | "image/avif"
            | "image/svg+xml"
            | "image/x-icon"
    )
}

pub async fn public_image(
    request: &Request,
    storage: &R2Bucket,
    context: &Context,
) -> JsResult<Response> {
    let method = request.method();
    let head = method == "HEAD";
    if !head && method != "GET" {
        let headers = Headers::new()?;
        headers.set("Allow", "GET, HEAD")?;
        return text_response(Some("Method not allowed"), 405, &headers);
    }
    let url = Url::new(&request.url())?;
    let path = url.pathname();
    let Ok(key) = decode_uri_component(path.strip_prefix("/images/").unwrap_or_default()) else {
        return text_response(Some("Invalid image path"), 400, &Headers::new()?);
    };
    let key = key.as_string().unwrap_or_default();
    if !valid_image_key(&key) {
        return text_response(Some("Not found"), 404, &Headers::new()?);
    }
    if let Some(referer) = request.headers().get("Referer")?
        && !Url::new(&referer).is_ok_and(|referrer| referrer.origin() == url.origin())
    {
        let headers = Headers::new()?;
        headers.set("Vary", "Referer")?;
        headers.set("Cache-Control", "no-store")?;
        return text_response(Some("Forbidden"), 403, &headers);
    }
    let cache_key = cache::key(&request.url(), Group::Media, "", "")?;
    if let Some(cached) = cache::read(&cache_key).await {
        let headers = Headers::new_with_headers(&cached.headers())?;
        headers.set("Vary", "Referer")?;
        let response = stream_response(cached.body().as_ref(), 200, &headers)?;
        return cache::client_response(&response, request, true);
    }
    let object = if head {
        JsFuture::from(storage.head(key)?).await?
    } else {
        JsFuture::from(storage.get(key, JsValue::UNDEFINED)?).await?
    };
    if !object.is_truthy() {
        return text_response(Some("Not found"), 404, &Headers::new()?);
    }
    let raw: &R2Object = object.unchecked_ref();
    let body: Option<ReadableStream> = (!head).then(|| property(&object, "body").unchecked_into());
    let headers = Headers::new()?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("Vary", "Referer")?;
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'")?;
    headers.set("Cache-Control", "public, max-age=86400")?;
    raw.write_http_metadata(headers.clone())?;
    if !headers
        .get("Content-Type")?
        .is_some_and(|mime| supported_type(&mime))
    {
        cancel_stream(body.as_ref()).await?;
        return text_response(Some("Unsupported image"), 415, &Headers::new()?);
    }
    let etag = raw.http_etag()?;
    headers.set("ETag", &etag)?;
    if request.headers().get("If-None-Match")?.is_some_and(|tags| {
        tags.split(',').any(|tag| {
            let tag = JsString::from(tag).trim().as_string().unwrap_or_default();
            let tag = tag.strip_prefix("W/").unwrap_or(&tag);
            tag == "*" || tag == etag
        })
    }) {
        cancel_stream(body.as_ref()).await?;
        return stream_response(None, 304, &headers);
    }
    let response = stream_response(body.as_ref(), 200, &headers)?;
    if !head {
        cache::write(context, &cache_key, &response, 86400)?;
    }
    Ok(response)
}

pub async fn cancel_stream(body: Option<&ReadableStream>) -> JsResult<()> {
    if let Some(body) = body {
        JsFuture::from(body.cancel()).await?;
    }
    Ok(())
}
