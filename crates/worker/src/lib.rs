mod admin;
mod assets;
mod auth;
mod backup;
mod backup_jobs;
mod browser_publish;
mod config;
mod discovery;
mod draft_listing;
mod drafts;
mod entities;
mod feed;
mod html_rewriter;
mod http;
mod icon;
mod icon_raster;
mod image;
mod image_header;
mod image_library;
mod image_references;
mod maintenance;
mod media;
mod models;
mod page_rendering;
mod post_addresses;
mod post_index;
mod public_cache;
mod publishing;
mod reader;
mod reference_index;
mod router;
mod runtime;
mod site;
mod site_assets;
mod storage;

use worker::js_sys::{self, Date, JSON, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures;
use worker::worker_sys::R2Bucket;
use worker::{
    Bucket, Context, Env, Error, Response, Result, ScheduleContext, ScheduledEvent, event, web_sys,
};

#[event(fetch)]
async fn fetch(request: web_sys::Request, env: Env, ctx: Context) -> Result<web_sys::Response> {
    let storage = env.bucket("STORAGE")?;
    let storage: &JsValue = storage.as_ref();
    let stats = storage::Stats::new(storage.unchecked_ref())?;
    let started = Date::now();
    let id = storage::uuid()?;
    let config = config::Config::new(&env);
    let response = router::PublicRouter {
        request: &request,
        storage: &stats.bucket,
        ctx: &ctx,
        env: &env,
        config: &config,
    }
    .respond()
    .await?;
    let path = web_sys::Url::new(&request.url())?.pathname();
    let route = path.split('/').take(3).collect::<Vec<_>>().join("/");
    let route = http::safe_path(&route);
    stats.report(
        &id,
        &route.as_string().unwrap_or_default(),
        &request.method(),
        response.status(),
        started,
    )?;
    let headers = web_sys::Headers::new_with_headers(&response.headers())?;
    headers.set("X-Request-ID", &id)?;
    Ok(public_cache::stream_response(
        response.body().as_ref(),
        response.status(),
        &headers,
    )?)
}

#[event(scheduled)]
async fn scheduled(_: ScheduledEvent, env: Env, ctx: ScheduleContext) {
    ctx.wait_until(async move {
        let result = async {
            let binding = env
                .bucket("STORAGE")
                .map_err(|error| self::js_sys::Error::new(&error.to_string()))?;
            let binding: &JsValue = binding.as_ref();
            maintenance::run(binding.unchecked_ref()).await
        }
        .await;
        if let Err(error) = result {
            let kind = http::error_type(&error);
            if let Ok(kind) = JSON::stringify(kind.as_ref()) {
                worker::console_error!(
                    "{{\"event\":\"storage_maintenance_failed\",\"type\":{kind}}}"
                );
            }
        }
    });
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
