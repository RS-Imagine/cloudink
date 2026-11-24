use worker::js_sys::{Function, JSON, JsString, Object, Promise, Reflect, RegExp};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Headers, ReadableStream, Request, RequestInit, Response, Url};
use worker::worker_sys::R2Bucket;
use worker::{Context, console_error};

use crate::html_rewriter::{JsResult, string_response};
use crate::public_cache::{
    self as cache, Group, REVALIDATE, not_modified, stream_response, text_response,
};
use crate::runtime::{js_string, property};

const EDITOR_ASSETS: &[&str] = &[
    "/writing-illustration.svg",
    "/backup.js",
    "/publication.js",
    "/home-illustration.js",
    "/post-address.js",
    "/editorial-botanical.svg",
    "/editorial-botanical.webp",
    "/image.worker.js",
    "/image-maintenance.js",
    "/admin-theme.js",
    "/app.js",
    "/shorts.js",
    "/images.js",
    "/editor-tools.js",
    "/markdown-import.js",
    "/preview.js",
    "/image-upload.js",
    "/style.css",
    "/preview.worker.js",
    "/preview-highlight.js",
    "/blog_wasm.js",
    "/blog_wasm_bg.wasm",
];
const ASSET_CACHE: &str = "public, max-age=300, stale-while-revalidate=86400";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const PTR_TTL: u32 = 30;
const PAGE_TTL: u32 = 604800;
const DISCOVERY_TTL: u32 = 3600;

thread_local! {
    static POST_PAGE: RegExp = RegExp::new(r"^/post/page/([1-9]\d*)(?:/|/index\.html)?$", "");
    static SHORT_PAGE: RegExp = RegExp::new(r"^/shorts/page/([1-9]\d*)(?:/|/index\.html)?$", "");
    static ARTICLE: RegExp = RegExp::new(r"^/posts/([A-Za-z0-9_-]{1,100})(?:/|/index\.html)?$", "");
    static SHORT_ASSET: RegExp = RegExp::new(r"^shorts/page/[1-9]\d*/index\.html$", "");
    static READER_ASSET: RegExp = RegExp::new(
        r"^/reader-assets/(?:highlight\.js|share-card\.js|katex\.css|code\.css|editorial-font\.css|(?:katex|highlight|editorial-font)-LICENSE\.txt|fonts/(?:KaTeX_[A-Za-z0-9_-]+|noto-serif(?:-sc)?-[a-z0-9-]+)\.woff2)$", "",
    );
    static PUBLISH_COMMIT: RegExp = RegExp::new(r"/api/publish/[a-f0-9-]{36}/commit$", "");
}

#[wasm_bindgen]
extern "C" {
    pub type Services;

    #[wasm_bindgen(method, catch)]
    fn admin(this: &Services, request: &Request, with_context: bool) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch)]
    fn image(this: &Services, request: &Request) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch)]
    fn icon(this: &Services, request: &Request) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch)]
    fn asset(this: &Services, request: &Request) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch)]
    fn sanitize(this: &Services, html: &JsString) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch)]
    fn mime(this: &Services, path: &str) -> JsResult<String>;

    #[wasm_bindgen(method, catch)]
    fn icons(this: &Services, value: &JsValue) -> JsResult<JsValue>;

    #[wasm_bindgen(method, getter, js_name = legacyImagePath)]
    fn legacy_image_path(this: &Services) -> Function;

}

pub struct PublicRouter<'a> {
    pub request: &'a Request,
    pub storage: &'a R2Bucket,
    pub ctx: &'a Context,
    pub services: &'a Services,
    pub template_version: &'a str,
    pub response_version: &'a str,
}

impl PublicRouter<'_> {
    pub async fn respond(&self) -> JsResult<Response> {
        match self.route().await {
            Ok(response) => Ok(response),
            Err(error) => {
                let kind = error
                    .dyn_ref::<worker::js_sys::Error>()
                    .map(|err| err.name())
                    .unwrap_or_else(|| "unknown".into());
                console_error!(
                    "{{\"event\":\"web_request_failed\",\"type\":{}}}",
                    JSON::stringify(kind.as_ref())?
                );
                protect(
                    &text_response(
                        Some("服务暂时不可用，请检查 Cloudflare 配置后重试。"),
                        503,
                        &Headers::new()?,
                    )?,
                    false,
                    REVALIDATE,
                )
            }
        }
    }

    async fn route(&self) -> JsResult<Response> {
        let url = Url::new(&self.request.url())?;
        let path = url.pathname();
        let method = self.request.method();
        let head = method == "HEAD";
        let can_read = head || method == "GET";
        if matches!(path.as_str(), "/admin" | "/admin/") {
            if !can_read {
                return method_not_allowed(false);
            }
            url.set_pathname("/");
            let init = RequestInit::new();
            init.set_method("GET");
            init.set_headers_headers(&self.request.headers());
            let admin_request = Request::new_with_str_and_init(&url.href(), &init)?;
            let response = await_response(self.services.admin(&admin_request, false)?).await?;
            return if head {
                stream_response(None, response.status(), &response.headers())
            } else {
                Ok(response)
            };
        }
        if path.starts_with("/api/") || EDITOR_ASSETS.contains(&path.as_str()) {
            let response = await_response(self.services.admin(self.request, true)?).await?;
            if method == "POST"
                && response.ok()
                && PUBLISH_COMMIT.with(|pattern| pattern.test(&path))
                && let Ok(key) = self.cache_key(Group::Pointer)
            {
                cache::delete(&key).await;
            }
            return Ok(response);
        }
        if path.starts_with("/images/") {
            return await_response(self.services.image(self.request)?).await;
        }
        if path.starts_with("/site-icon/") {
            return await_response(self.services.icon(self.request)?).await;
        }
        if !can_read {
            return method_not_allowed(true);
        }
        if matches!(
            path.as_str(),
            "/sw.js" | "/client.js" | "/theme.js" | "/styles.css"
        ) {
            return self.static_asset(&path, 200, false, REVALIDATE).await;
        }
        if path == "/favicon.svg" || READER_ASSET.with(|pattern| pattern.test(&path)) {
            let policy = if path.starts_with("/reader-assets/fonts/") {
                IMMUTABLE
            } else {
                ASSET_CACHE
            };
            return self.static_asset(&path, 200, false, policy).await;
        }
        if capture(&SHORT_PAGE, &path).as_deref() == Some("1") {
            url.set_pathname("/shorts/");
            return protect(
                &Response::redirect_with_status(&url.href(), 301)?,
                false,
                REVALIDATE,
            );
        }

        let key = public_path(&path)?;
        let published = self.published().await?;
        let icon = property(&published, "siteIcon");
        let site_icon = truthy_string(&icon).unwrap_or_default();
        if path == "/favicon.ico" {
            let icons = self.services.icons(&icon)?;
            let location = icon_path(&icons, "faviconIco").unwrap_or_else(|| "/favicon.svg".into());
            let headers = Headers::new()?;
            headers.set(
                "Location",
                &Url::new_with_base(&location, &url.origin())?.pathname(),
            )?;
            return protect(&stream_response(None, 302, &headers)?, false, ASSET_CACHE);
        }

        let id = truthy_string(&property(&published, "id"));
        let clarity = truthy_string(&property(&published, "clarityId")).unwrap_or_default();
        let analytics = (1..=64).contains(&clarity.len())
            && clarity.bytes().all(|byte| byte.is_ascii_alphanumeric());
        let pages = property(&published, "pages");
        let version = key
            .as_deref()
            .and_then(|key| truthy_string(&property(&pages, key)));
        let tag = if let Some(version) = version {
            format!("{version}:{clarity}:{site_icon}")
        } else {
            format!("{}:{site_icon}", id.as_deref().unwrap_or("initial"))
        };
        let page_key = self.cache_key(Group::Page(&tag))?;
        if let Some(cached) = cache::read(&page_key).await {
            let response = cache::client_response(&cached, self.request, true)?;
            let policy = response
                .headers()
                .get("Cache-Control")?
                .filter(|value| !value.is_empty());
            return protect(
                &response,
                analytics,
                policy.as_deref().unwrap_or(REVALIDATE),
            );
        }
        if matches!(path.as_str(), "/robots.txt" | "/sitemap.xml" | "/feed.xml") {
            let response = crate::discovery_response(
                &path,
                &url.origin(),
                self.storage,
                id.as_deref(),
                &pages,
                self.template_version,
                self.response_version,
            )
            .await?;
            cache::write(self.ctx, &page_key, &response, DISCOVERY_TTL)?;
            return cache::client_response(&response, self.request, false);
        }
        if path == "/analytics.js" {
            let script = if analytics {
                let id = JSON::stringify(&clarity.into())?;
                format!(
                    "window.clarity=window.clarity||function(){{(window.clarity.q=window.clarity.q||[]).push(arguments)}};const s=document.createElement('script');s.async=true;s.src=\"https://www.clarity.ms/tag/\"+{id};document.head.append(s);"
                )
            } else {
                "/* Analytics is disabled. */".to_owned()
            };
            let headers = Headers::new()?;
            headers.set("Content-Type", "text/javascript; charset=utf-8")?;
            return protect(
                &text_response((!head).then_some(script.as_str()), 200, &headers)?,
                analytics,
                ASSET_CACHE,
            );
        }

        if let (Some(key), Some(id)) = (key.as_deref(), id.as_deref()) {
            let release = ReleasedPage {
                id,
                pages: &pages,
                published: &published,
                icon: &icon,
                site_icon: &site_icon,
                analytics,
            };
            if let Some(response) = self.published_page(&url, key, &page_key, &release).await? {
                return Ok(response);
            }
        }
        match key.as_deref() {
            Some("manifest.webmanifest") => {
                self.static_asset("/manifest.webmanifest", 200, false, ASSET_CACHE)
                    .await
            }
            Some("_release.json") => {
                let release = Object::new();
                let id = id
                    .as_deref()
                    .map(JsValue::from_str)
                    .unwrap_or(JsValue::NULL);
                Reflect::set(&release, &"id".into(), &id)?;
                let headers = Headers::new()?;
                headers.set("Content-Type", "application/json")?;
                let json = JSON::stringify(&release)?.as_string().unwrap_or_default();
                protect(
                    &text_response((!head).then_some(json.as_str()), 200, &headers)?,
                    false,
                    REVALIDATE,
                )
            }
            Some("index.html") => self.static_asset("/", 200, false, REVALIDATE).await,
            Some("about/index.html") => self.static_asset("/about/", 200, false, REVALIDATE).await,
            Some("post/index.html") => self.static_asset("/post/", 200, false, REVALIDATE).await,
            Some("shorts/index.html") => {
                self.static_asset("/shorts/", 200, false, REVALIDATE).await
            }
            Some("search_index.json") => {
                self.static_asset("/search_index.json", 200, false, REVALIDATE)
                    .await
            }
            Some(key) if SHORT_ASSET.with(|pattern| pattern.test(key)) => {
                let path = format!("/{}", key.strip_suffix("index.html").unwrap_or(key));
                self.static_asset(&path, 200, false, REVALIDATE).await
            }
            _ => {
                self.static_asset("/404.html", 404, analytics, REVALIDATE)
                    .await
            }
        }
    }

    fn cache_key(&self, group: Group<'_>) -> JsResult<Request> {
        cache::key(
            &self.request.url(),
            group,
            self.template_version,
            self.response_version,
        )
    }

    async fn published(&self) -> JsResult<JsValue> {
        let key = self.cache_key(Group::Pointer)?;
        let cached = cache::read(&key).await;
        let published = match &cached {
            Some(pointer) => JsFuture::from(pointer.json()?).await?,
            None => crate::feed::read_json(self.storage, "state/published.json".into()).await?,
        };
        if property(&published, "siteIcon").is_undefined()
            && let Some(id) = truthy_string(&property(&published, "id"))
        {
            let legacy = self
                .storage
                .get(format!("releases/{id}.posts.json"), JsValue::UNDEFINED)?;
            let legacy = JsFuture::from(legacy).await?;
            let site = if legacy.is_null() {
                JsValue::UNDEFINED
            } else {
                crate::feed::object_json(legacy)
                    .await
                    .ok()
                    .map(|value| property(&value, "site"))
                    .unwrap_or(JsValue::UNDEFINED)
            };
            let icon = property(&site, "siteIcon");
            let icon = if icon.is_truthy() { icon } else { "".into() };
            Reflect::set(&published, &"siteIcon".into(), &icon)?;
            let size = property(&site, "siteIconSize");
            if size.is_truthy() {
                Reflect::set(&published, &"siteIconSize".into(), &size)?;
            }
        }
        if cached.is_none() && published.is_truthy() {
            let headers = Headers::new()?;
            headers.set("Content-Type", "application/json")?;
            let response = string_response(
                &JSON::stringify(&published)?,
                &cache::response_init(200, &headers),
            )?;
            cache::write(self.ctx, &key, &response, PTR_TTL)?;
        }
        Ok(published)
    }

    async fn published_page(
        &self,
        url: &Url,
        key: &str,
        page_key: &Request,
        release: &ReleasedPage<'_>,
    ) -> JsResult<Option<Response>> {
        let analytics = release.analytics;
        let id = release.id;
        let pages = release.pages;
        if let Some(from) = article_key_slug(key) {
            let redirects = property(release.published, "postRedirects");
            if redirects.is_object()
                && Object::has_own(redirects.unchecked_ref::<Object>(), &from.into())
                && let Some(target) = truthy_string(&property(&redirects, from))
                && target != from
                && crate::valid_post_slug(&target)
            {
                url.set_pathname(&format!("/posts/{target}/"));
                return Ok(Some(protect(
                    &Response::redirect_with_status(&url.href(), 301)?,
                    analytics,
                    REVALIDATE,
                )?));
            }
        }
        let storage_key = if pages.is_truthy() {
            truthy_string(&property(pages, key)).map(|key| format!("public/content/{key}"))
        } else {
            Some(format!("public/{id}/{key}"))
        };
        let head = self.request.method() == "HEAD";
        let object = if let Some(storage_key) = storage_key {
            let promise = if head {
                self.storage.head(storage_key)?
            } else {
                self.storage.get(storage_key, JsValue::UNDEFINED)?
            };
            JsFuture::from(promise).await?
        } else {
            JsValue::NULL
        };
        if object.is_truthy() {
            let etag = js_string(&property(&object, "httpEtag"))
                .as_string()
                .unwrap_or_default();
            let etag = if key.ends_with(".html") {
                crate::public_etag(
                    &url.origin(),
                    &url.pathname(),
                    &etag,
                    release.site_icon,
                    self.template_version,
                    self.response_version,
                )
                .await?
            } else {
                etag
            };
            let headers = Headers::new()?;
            headers.set("Content-Type", &self.services.mime(key)?)?;
            headers.set("ETag", &etag)?;
            if head && not_modified(self.request, Some(&etag))? {
                return Ok(Some(protect(
                    &stream_response(None, 304, &headers)?,
                    analytics,
                    REVALIDATE,
                )?));
            }
            let body = (!head)
                .then(|| property(&object, "body"))
                .and_then(as_stream);
            let status = if key == "404.html" { 404 } else { 200 };
            let html = self
                .render_html(
                    stream_response(body.as_ref(), status, &headers)?,
                    url,
                    analytics,
                    release.icon,
                )
                .await?;
            let policy = if key == "manifest.webmanifest" {
                ASSET_CACHE
            } else {
                REVALIDATE
            };
            let response = protect(&html, analytics, policy)?;
            if !head {
                cache::write(self.ctx, page_key, &response, PAGE_TTL)?;
            }
            return Ok(Some(cache::client_response(
                &response,
                self.request,
                false,
            )?));
        }
        if key == "manifest.webmanifest" {
            return self
                .static_asset("/manifest.webmanifest", 200, false, ASSET_CACHE)
                .await
                .map(Some);
        }

        // Setup can create a release before any pages exist. Once published, missing routes stay missing.
        let has_index = if pages.is_truthy() {
            property(pages, "index.html").is_truthy()
        } else {
            !JsFuture::from(self.storage.head(format!("public/{id}/index.html"))?)
                .await?
                .is_null()
        };
        if !has_index {
            return Ok(None);
        }
        let missing = if pages.is_truthy() {
            truthy_string(&property(pages, "404.html")).map(|key| format!("public/content/{key}"))
        } else {
            Some(format!("public/{id}/404.html"))
        };
        let missing = match missing {
            Some(key) => JsFuture::from(self.storage.get(key, JsValue::UNDEFINED)?).await?,
            None => JsValue::NULL,
        };
        let headers = Headers::new()?;
        headers.set("Content-Type", "text/html; charset=utf-8")?;
        let response = if head {
            stream_response(None, 404, &headers)?
        } else if let Some(body) = as_stream(property(&missing, "body")) {
            stream_response(Some(&body), 404, &headers)?
        } else {
            text_response(Some("Not found"), 404, &headers)?
        };
        let response = self
            .render_html(response, url, analytics, release.icon)
            .await?;
        Ok(Some(protect(&response, analytics, REVALIDATE)?))
    }

    async fn static_asset(
        &self,
        path: &str,
        status: u16,
        analytics: bool,
        policy: &str,
    ) -> JsResult<Response> {
        let requested = Url::new(&self.request.url())?;
        let destination = Url::new(&requested.href())?;
        destination.set_pathname(path);
        let request =
            Request::new_with_str_and_init(&destination.href(), self.request.unchecked_ref())?;
        if path == "/" || path.ends_with('/') || path.ends_with(".html") {
            request.headers().delete("If-None-Match")?;
        }
        let response = await_response(self.services.asset(&request)?).await?;
        let response = if self.request.method() != "HEAD" && is_html(&response)? {
            let body = JsFuture::from(response.text()?).await?.unchecked_into();
            let clean = JsFuture::from(self.services.sanitize(&body)?)
                .await?
                .unchecked_into();
            string_response(&clean, &cache::response_init(status, &response.headers()))?
        } else if status != 200 {
            stream_response(response.body().as_ref(), status, &response.headers())?
        } else {
            response
        };
        let response = self
            .render_html(response, &requested, false, &JsValue::UNDEFINED)
            .await?;
        protect(
            &response,
            analytics,
            if status == 200 { policy } else { REVALIDATE },
        )
    }

    async fn render_html(
        &self,
        response: Response,
        url: &Url,
        analytics: bool,
        icon: &JsValue,
    ) -> JsResult<Response> {
        if !is_html(&response)? {
            return Ok(response);
        }
        let icons = self.services.icons(icon)?;
        crate::reader::render(
            response,
            Clone::clone(url),
            analytics,
            icon_path(&icons, "apple"),
            icon_path(&icons, "icon512"),
            self.services.legacy_image_path(),
        )
        .await
    }
}

struct ReleasedPage<'a> {
    id: &'a str,
    pages: &'a JsValue,
    published: &'a JsValue,
    icon: &'a JsValue,
    site_icon: &'a str,
    analytics: bool,
}

fn public_path(path: &str) -> JsResult<Option<String>> {
    match path {
        "/" | "/index.html" => return Ok(Some("index.html".into())),
        "/404.html" | "/search_index.json" | "/_release.json" | "/manifest.webmanifest" => {
            return Ok(Some(path[1..].into()));
        }
        _ => {}
    }
    for section in ["/about", "/post", "/archive", "/shorts"] {
        if matches!(path.strip_prefix(section), Some("" | "/" | "/index.html")) {
            return Ok(Some(format!("{}/index.html", &section[1..])));
        }
    }
    if let Some(number) = capture(&POST_PAGE, path).filter(|number| number != "1") {
        return Ok(Some(format!("post/page/{number}/index.html")));
    }
    if let Some(number) = capture(&SHORT_PAGE, path) {
        if number == "1" {
            return Ok(Some("shorts/index.html".into()));
        }
        // Preserve the original JavaScript Number formatting for very large page numbers.
        let number = number.parse::<f64>().unwrap_or(f64::INFINITY);
        let number = js_string(&JsValue::from_f64(number));
        return Ok(Some(format!("shorts/page/{number}/index.html")));
    }
    Ok(capture(&ARTICLE, path).map(|slug| format!("posts/{slug}/index.html")))
}

fn capture(pattern: &'static std::thread::LocalKey<RegExp>, path: &str) -> Option<String> {
    pattern.with(|pattern| pattern.exec(path)?.get(1).as_string())
}

fn article_key_slug(key: &str) -> Option<&str> {
    key.strip_prefix("posts/")?
        .strip_suffix("/index.html")
        .filter(|slug| crate::valid_post_slug(slug))
}

fn truthy_string(value: &JsValue) -> Option<String> {
    value
        .is_truthy()
        .then(|| js_string(value).as_string().unwrap_or_default())
}

fn icon_path(icons: &JsValue, name: &str) -> Option<String> {
    let key = property(icons, name).as_string()?;
    Some(format!(
        "/site-icon/{}",
        key.strip_prefix("uploads/icons/")?
    ))
}

fn as_stream(value: JsValue) -> Option<ReadableStream> {
    value.is_truthy().then(|| value.unchecked_into())
}

fn is_html(response: &Response) -> JsResult<bool> {
    Ok(response
        .headers()
        .get("Content-Type")?
        .is_some_and(|header| header.contains("text/html")))
}

async fn await_response(promise: Promise) -> JsResult<Response> {
    Ok(JsFuture::from(promise).await?.unchecked_into())
}

fn method_not_allowed(allow_header: bool) -> JsResult<Response> {
    let headers = Headers::new()?;
    if allow_header {
        headers.set("Allow", "GET, HEAD")?;
    }
    protect(
        &text_response(Some("Method not allowed"), 405, &headers)?,
        false,
        REVALIDATE,
    )
}

fn protect(response: &Response, analytics: bool, cache_control: &str) -> JsResult<Response> {
    let headers = Headers::new_with_headers(&response.headers())?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("Referrer-Policy", "same-origin")?;
    headers.set("X-Frame-Options", "DENY")?;
    let (scripts, connections) = if analytics {
        (
            " https://www.clarity.ms https://scripts.clarity.ms",
            " https://*.clarity.ms",
        )
    } else {
        ("", "")
    };
    headers.set("Content-Security-Policy", &format!(
        "default-src 'self'; script-src 'self'{scripts}; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self'{connections}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ))?;
    headers.set("Cache-Control", cache_control)?;
    stream_response(response.body().as_ref(), response.status(), &headers)
}
