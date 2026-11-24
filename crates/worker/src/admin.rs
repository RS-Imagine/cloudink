use futures_util::try_join;
use worker::js_sys::{Error, JSON};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::{JsFuture, future_to_promise};
use worker::web_sys::{Headers, Request, Response, Url};
use worker::worker_sys::R2Bucket;
use worker::{Context, Env, console_error};

use crate::config::Config;
use crate::drafts::Kind;
use crate::html_rewriter::JsResult;
use crate::http::{self, error};
use crate::public_cache::stream_response;
use crate::runtime::{json, json_object, property, read_json};
use crate::{
    assets, auth, backup, backup_jobs, browser_publish, draft_listing, drafts, image, maintenance,
    post_addresses, publishing, site, storage as r2,
};

const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; font-src 'self' https://cdn.jsdelivr.net; frame-src 'self' blob:; worker-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

pub async fn respond(
    request: &Request,
    env: &Env,
    storage: &R2Bucket,
    config: &Config,
    ctx: Option<&Context>,
) -> JsResult<Response> {
    let url = Url::new(&request.url())?;
    match route(request, &url, env, storage, config, ctx).await {
        Ok(response) => Ok(response),
        Err(failure) => {
            if let Some(status) = http::status(&failure) {
                let message = failure.unchecked_ref::<Error>().message();
                return protect(json(status, &[("error", message.into())])?, false);
            }
            let path = JSON::stringify(http::safe_path(&url.pathname()).as_ref())?;
            let method = JSON::stringify(&request.method().into())?;
            let kind = JSON::stringify(http::error_type(&failure).as_ref())?;
            console_error!(
                "{{\"event\":\"request_failed\",\"route\":{path},\"method\":{method},\"type\":{kind}}}"
            );
            protect(
                json(500, &[("error", "操作未完成，请稍后重试。".into())])?,
                false,
            )
        }
    }
}

async fn route(
    request: &Request,
    url: &Url,
    env: &Env,
    storage: &R2Bucket,
    config: &Config,
    ctx: Option<&Context>,
) -> JsResult<Response> {
    let path = url.pathname();
    if path == "/api/config" && request.method() == "GET" {
        return protect(config_response(url, storage).await?, false);
    }
    if let Some(response) = assets::response(request, &path)? {
        return protect(response, true);
    }
    if let Some(response) = auth::route(request, url, env, storage, config, &path).await? {
        return protect(response, false);
    }
    if !path.starts_with("/api/") {
        return Err(error(404, "页面不存在。"));
    }
    let session = auth::require_session(request, url, storage).await?;
    let changing = changes_references(&path, &request.method());
    if !changing && path != "/api/upload" {
        return protect(
            api(request, url, &path, storage, config, &session).await?,
            false,
        );
    }
    let storage = storage.clone();
    let request = Clone::clone(request);
    let url = url.clone();
    let config = config.clone();
    let response = future_to_promise(async move {
        let run = |binding: &R2Bucket| {
            let binding = binding.clone();
            let (request, url, path, config, session) = (&request, &url, &path, &config, &session);
            async move { api(request, url, path, &binding, config, session).await }
        };
        let response = if changing {
            r2::with_mutation(&storage, |guarded| run(&guarded)).await
        } else {
            run(&storage).await
        };
        response.map(Into::into)
    });
    if let Some(ctx) = ctx {
        let pending = response.clone();
        ctx.wait_until(async move {
            let _ = JsFuture::from(pending).await;
        });
    }
    protect(JsFuture::from(response).await?.unchecked_into(), false)
}

fn protect(response: Response, asset: bool) -> JsResult<Response> {
    let headers = Headers::new_with_headers(&response.headers())?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("Referrer-Policy", "same-origin")?;
    headers.set("X-Frame-Options", "DENY")?;
    headers.set(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
    )?;
    headers.set("Content-Security-Policy", CSP)?;
    if !asset {
        headers.set("Cache-Control", "no-store")?;
    }
    stream_response(response.body().as_ref(), response.status(), &headers)
}

async fn config_response(url: &Url, storage: &R2Bucket) -> JsResult<Response> {
    let (account, draft_site, pointer) = try_join!(
        async { JsFuture::from(storage.head("auth/account.json".to_owned())?).await },
        read_json(storage, "draft-site.json"),
        read_json(storage, "state/published.json"),
    )?;
    let from_site = |field, fallback: JsValue| {
        let saved = property(&draft_site, field);
        if !saved.is_null() && !saved.is_undefined() {
            return saved;
        }
        let published = property(&pointer, field);
        if published.is_null() || published.is_undefined() {
            fallback
        } else {
            published
        }
    };
    let origin = url.origin();
    json(
        200,
        &[
            ("siteUrl", origin.as_str().into()),
            ("imageOrigin", format!("{origin}/images").into()),
            ("initialized", account.is_truthy().into()),
            ("siteIcon", from_site("siteIcon", "".into())),
            ("siteIconSize", from_site("siteIconSize", 0.into())),
        ],
    )
}

fn release_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
}

fn parse_action<'a>(path: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let (id, action) = path.strip_prefix(prefix)?.split_once('/')?;
    release_id(id).then_some((id, action))
}

fn slug_path(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn changes_references(path: &str, method: &str) -> bool {
    if matches!(method, "GET" | "HEAD") {
        return false;
    }
    path.starts_with("/api/posts/")
        || path.starts_with("/api/shorts/")
        || matches!(
            path,
            "/api/settings"
                | "/api/publish"
                | "/api/backup/restore"
                | "/api/backup/jobs"
                | "/api/backup/image"
                | "/api/images"
                | "/api/images/optimize"
                | "/api/images/reindex"
        )
        || parse_action(path, "/api/publish/")
            .is_some_and(|(_, action)| matches!(action, "plan" | "commit" | "cancel"))
        || parse_action(path, "/api/backup/jobs/").is_some_and(|(_, action)| {
            matches!(
                action,
                "preflight" | "verify-images" | "apply" | "finish" | "cancel"
            )
        })
}

async fn api(
    request: &Request,
    url: &Url,
    path: &str,
    storage: &R2Bucket,
    config: &Config,
    session: &JsValue,
) -> JsResult<Response> {
    let method = request.method();
    match (path, method.as_str()) {
        ("/api/maintenance", "GET") => {
            return json_object(200, &read_json(storage, "state/maintenance.json").await?);
        }
        ("/api/maintenance", "POST") => {
            return json(200, &[("maintenance", maintenance::run(storage).await?)]);
        }
        ("/api/site-icon" | "/api/site-icon/derivatives", "POST")
        | ("/api/settings", "GET" | "PUT") => return site::handle(request, storage).await,
        ("/api/images", _)
        | ("/api/images/optimize" | "/api/images/reindex" | "/api/upload", "POST")
        | ("/api/image", "GET") => return image::handle(request, storage).await,
        ("/api/backup/jobs", _) => return backup_jobs::handle(request, storage, session).await,
        ("/api/backup", "GET") | ("/api/backup/restore", "POST") | ("/api/backup/image", "PUT") => {
            return backup::handle(request, url, storage).await;
        }
        ("/api/publish", "POST") => return publishing::publish(request, storage, config).await,
        ("/api/publish/status", "GET") => {
            return json_object(
                200,
                &publishing::status(storage, false, &JsValue::UNDEFINED).await?,
            );
        }
        ("/api/posts", "GET") => return draft_listing::posts(url, storage, config, session).await,
        ("/api/shorts", "GET") => return draft_listing::shorts(url, storage).await,
        ("/api/export", "GET") => {
            return Err(error(410, "此导出接口已停用，请刷新后台并使用分批备份。"));
        }
        _ => {}
    }
    if path.starts_with("/api/backup/jobs/") {
        return backup_jobs::handle(request, storage, session).await;
    }
    if let Some((id, action @ ("file" | "plan" | "commit" | "cancel"))) =
        parse_action(path, "/api/publish/")
    {
        return match (action, method.as_str()) {
            ("plan", "POST") => browser_publish::plan(request, storage, id).await,
            ("file", "PUT") => browser_publish::stage(request, storage, config, id).await,
            ("commit", "POST") => browser_publish::commit(request, storage, config, id).await,
            ("cancel", "POST") => browser_publish::cancel(storage, id).await,
            _ => Err(error(405, "请求方式不正确。")),
        };
    }
    if let Some(slug) = path
        .strip_prefix("/api/posts/")
        .and_then(|rest| rest.strip_suffix("/rename"))
        .filter(|slug| method == "POST" && slug_path(slug))
    {
        return post_addresses::rename_draft(request, storage, slug).await;
    }
    for (prefix, kind) in [("/api/posts/", Kind::Post), ("/api/shorts/", Kind::Short)] {
        if let Some(slug) = path.strip_prefix(prefix).filter(|slug| slug_path(slug)) {
            return drafts::item(request, url, storage, kind, slug).await;
        }
    }
    Err(error(404, "接口不存在。"))
}
