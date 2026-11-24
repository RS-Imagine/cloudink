mod backup;
mod backup_jobs;
mod browser_publish;
mod discovery;
mod draft_listing;
mod drafts;
mod feed;
mod html_rewriter;
mod icon;
mod icon_raster;
mod image;
mod image_header;
mod image_library;
mod maintenance;
mod media;
mod page_rendering;
mod post_addresses;
mod post_index;
mod public_cache;
mod publishing;
mod reader;
mod router;
mod runtime;
mod site;

use worker::js_sys::{self, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures;
use worker::worker_sys::R2Bucket;
use worker::{Bucket, Context, Error, Response, Result, web_sys};

#[wasm_bindgen]
pub async fn maintain_storage(
    storage: JsValue,
    hooks: JsValue,
) -> html_rewriter::JsResult<JsValue> {
    maintenance::run(storage.unchecked_into(), hooks.unchecked_into()).await
}

#[wasm_bindgen]
pub async fn site_settings(
    request: web_sys::Request,
    storage: JsValue,
    hooks: JsValue,
) -> html_rewriter::JsResult<web_sys::Response> {
    site::handle(&request, &storage.unchecked_into(), &hooks.unchecked_into()).await
}

#[wasm_bindgen]
pub async fn backup_request(
    request: web_sys::Request,
    storage: JsValue,
    session: JsValue,
    hooks: JsValue,
) -> html_rewriter::JsResult<web_sys::Response> {
    let url = web_sys::Url::new(&request.url())?;
    let path = url.pathname();
    let storage: &R2Bucket = storage.unchecked_ref();
    let hooks: &drafts::Hooks = hooks.unchecked_ref();
    if path == "/api/backup/jobs" || path.starts_with("/api/backup/jobs/") {
        backup_jobs::handle(request, storage, hooks, session).await
    } else {
        backup::handle(&request, &url, storage, hooks).await
    }
}

#[wasm_bindgen]
pub async fn image_request(
    request: web_sys::Request,
    storage: JsValue,
    hooks: JsValue,
) -> html_rewriter::JsResult<web_sys::Response> {
    image::handle(&request, &storage.unchecked_into(), &hooks.unchecked_into()).await
}

#[wasm_bindgen]
pub async fn content_request(
    request: web_sys::Request,
    storage: JsValue,
    session: JsValue,
    hooks: JsValue,
) -> html_rewriter::JsResult<web_sys::Response> {
    let url = web_sys::Url::new(&request.url())?;
    let path = url.pathname();
    let storage: &R2Bucket = storage.unchecked_ref();
    let hooks: &drafts::Hooks = hooks.unchecked_ref();
    match path.as_str() {
        "/api/posts" if request.method() == "GET" => {
            draft_listing::posts(&url, storage, hooks, &session).await
        }
        "/api/shorts" if request.method() == "GET" => {
            draft_listing::shorts(&url, storage, hooks).await
        }
        "/api/publish" if request.method() == "POST" => {
            publishing::publish(&request, storage, hooks).await
        }
        "/api/publish/status" if request.method() == "GET" => {
            let state = publishing::status(storage, hooks, false, &JsValue::UNDEFINED).await?;
            runtime::json_object(200, &state)
        }
        _ => {
            if let Some(slug) = path
                .strip_prefix("/api/posts/")
                .and_then(|rest| rest.strip_suffix("/rename"))
            {
                return post_addresses::rename_draft(&request, storage, hooks, slug).await;
            }
            if let Some((id, action)) = path
                .strip_prefix("/api/publish/")
                .and_then(|rest| rest.split_once('/'))
            {
                return match (action, request.method().as_str()) {
                    ("plan", "POST") => browser_publish::plan(&request, storage, hooks, id).await,
                    ("file", "PUT") => browser_publish::stage(&request, storage, hooks, id).await,
                    ("commit", "POST") => {
                        browser_publish::commit(&request, storage, hooks, id).await
                    }
                    ("cancel", "POST") => browser_publish::cancel(storage, hooks, id).await,
                    _ => Err(hooks.error(405, "请求方式不正确。")),
                };
            }
            let target = path
                .strip_prefix("/api/posts/")
                .map(|slug| (drafts::Kind::Post, slug))
                .or_else(|| {
                    path.strip_prefix("/api/shorts/")
                        .map(|slug| (drafts::Kind::Short, slug))
                });
            let Some((kind, slug)) = target else {
                return Err(hooks.error(404, "接口不存在。"));
            };
            drafts::item(&request, &url, storage, hooks, kind, slug).await
        }
    }
}

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
    let input = format!(
        "reader-v5:{response_version}:{template_version}:{origin}{path}{value}:{site_icon}"
    );
    Ok(format!(
        "\"{}\"",
        runtime::sha256_hex(&Uint8Array::from(input.as_bytes())).await?
    ))
}
