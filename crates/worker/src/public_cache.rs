use worker::Context;
use worker::js_sys::{self, JsString};
use worker::wasm_bindgen::JsCast;
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{
    Cache, Headers, ReadableStream, Request, Response, ResponseInit, Url, WorkerGlobalScope,
};
use worker::worker_sys::ext::CacheStorageExt;

use crate::html_rewriter::JsResult;

pub const REVALIDATE: &str = "public, max-age=0, must-revalidate";

pub enum Group<'a> {
    Pointer,
    Page(&'a str),
    Media,
}

pub fn key(
    url: &str,
    group: Group<'_>,
    template_version: &str,
    response_version: &str,
) -> JsResult<Request> {
    let url = Url::new(url)?;
    let path = match group {
        Group::Pointer => {
            format!("/__cloudink_cache/{template_version}/{response_version}/pointer//")
        }
        Group::Page(version) => format!(
            "/__cloudink_cache/{template_version}/{response_version}/page/{}{}",
            js_sys::encode_uri_component(version)
                .as_string()
                .unwrap_or_default(),
            url.pathname(),
        ),
        Group::Media => format!("/__cloudink_cache/media-v1/image/{}", url.pathname()),
    };
    url.set_pathname(&path);
    url.set_search("");
    Request::new_with_str(&url.href())
}

fn default_cache() -> JsResult<Cache> {
    let scope: WorkerGlobalScope = js_sys::global().unchecked_into();
    Ok(scope.caches()?.default())
}

pub async fn read(key: &Request) -> Option<Response> {
    let result = JsFuture::from(default_cache().ok()?.match_with_request(key))
        .await
        .ok()?;
    result.dyn_into::<Response>().ok()
}

pub fn write(ctx: &Context, key: &Request, response: &Response, seconds: u32) -> JsResult<()> {
    if response.status() != 200 {
        return Ok(());
    }
    let body = response.clone()?;
    let headers = Headers::new_with_headers(&body.headers())?;
    let client_policy = headers
        .get("Cache-Control")?
        .filter(|value| !value.is_empty());
    headers.set(
        "X-CloudInk-Client-Cache-Control",
        client_policy.as_deref().unwrap_or(REVALIDATE),
    )?;
    headers.set("Cache-Control", &format!("public, max-age={seconds}"))?;
    headers.delete("Vary")?;
    headers.delete("Set-Cookie")?;
    let cached = stream_response(body.body().as_ref(), 200, &headers)?;
    let promise = default_cache()?.put_with_request(key, &cached);
    ctx.wait_until(async move {
        let _ = JsFuture::from(promise).await;
    });
    Ok(())
}

pub async fn delete(key: &Request) {
    if let Ok(cache) = default_cache() {
        let _ = JsFuture::from(cache.delete_with_request(key)).await;
    }
}

pub fn client_response(response: &Response, request: &Request, hit: bool) -> JsResult<Response> {
    let headers = Headers::new_with_headers(&response.headers())?;
    if let Some(policy) = headers
        .get("X-CloudInk-Client-Cache-Control")?
        .filter(|s| !s.is_empty())
    {
        headers.set("Cache-Control", &policy)?;
    }
    headers.delete("X-CloudInk-Client-Cache-Control")?;
    headers.set(
        "Cache-Status",
        if hit {
            "CloudInk; hit"
        } else {
            "CloudInk; fwd=uri-miss"
        },
    )?;
    if not_modified(request, headers.get("ETag")?.as_deref())? {
        return stream_response(None, 304, &headers);
    }
    let body = (request.method() != "HEAD")
        .then(|| response.body())
        .flatten();
    stream_response(body.as_ref(), response.status(), &headers)
}

pub fn not_modified(request: &Request, etag: Option<&str>) -> JsResult<bool> {
    Ok(request
        .headers()
        .get("If-None-Match")?
        .is_some_and(|value| {
            value.split(',').any(|tag| {
                let tag = JsString::from(tag).trim().as_string().unwrap_or_default();
                tag == "*"
                    || etag.is_some_and(|etag| tag.strip_prefix("W/").unwrap_or(&tag) == etag)
            })
        }))
}

pub fn stream_response(
    body: Option<&ReadableStream>,
    status: u16,
    headers: &Headers,
) -> JsResult<Response> {
    let init = response_init(status, headers);
    Response::new_with_opt_readable_stream_and_init(body, &init)
}

pub fn text_response(body: Option<&str>, status: u16, headers: &Headers) -> JsResult<Response> {
    let init = response_init(status, headers);
    Response::new_with_opt_str_and_init(body, &init)
}

pub fn response_init(status: u16, headers: &Headers) -> ResponseInit {
    let init = ResponseInit::new();
    init.set_status(status);
    init.set_headers_headers(headers);
    init
}
