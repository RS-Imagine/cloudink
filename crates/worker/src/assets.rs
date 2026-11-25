use worker::js_sys::Uint8Array;
use worker::web_sys::{Headers, Request, Response};

use crate::html_rewriter::JsResult;
use crate::public_cache::{REVALIDATE, response_init, stream_response};

struct Asset {
    bytes: &'static [u8],
    mime: &'static str,
    etag: &'static str,
}

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../build-work/worker-assets/assets.rs"
));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../build-work/worker-versions.rs"
));

pub const TEMPLATE_VERSION: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../build-work/worker-assets/template-version"
));

pub fn editor_route(path: &str) -> bool {
    !matches!(path, "/" | "/favicon.svg" | "/manifest.webmanifest")
        && ASSETS.iter().any(|(asset_path, _)| *asset_path == path)
}

pub fn response(request: &Request, path: &str) -> JsResult<Option<Response>> {
    if request.method() != "GET" {
        return Ok(None);
    }
    let Some((_, asset)) = ASSETS.iter().find(|(asset_path, _)| *asset_path == path) else {
        return Ok(None);
    };
    let headers = Headers::new()?;
    headers.set("Content-Type", asset.mime)?;
    headers.set("ETag", asset.etag)?;
    headers.set(
        "Cache-Control",
        if path == "/" { "no-store" } else { REVALIDATE },
    )?;
    if path != "/"
        && request
            .headers()
            .get("If-None-Match")?
            .is_some_and(|value| {
                value.split(',').map(str::trim).any(|tag| {
                    let tag = tag.strip_prefix("W/").unwrap_or(tag);
                    tag == "*" || tag == asset.etag
                })
            })
    {
        return stream_response(None, 304, &headers).map(Some);
    }
    let bytes = Uint8Array::from(asset.bytes);
    Response::new_with_opt_js_u8_array_and_init(Some(&bytes), &response_init(200, &headers))
        .map(Some)
}
