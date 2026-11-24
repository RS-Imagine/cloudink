use worker::Context;
use worker::js_sys::{Array, JSON, Object, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Blob, FormData, Headers, ReadableStream, Request, Response, Url};
use worker::worker_sys::R2Bucket;

use crate::html_rewriter::JsResult;
use crate::http::{error, json_input};
use crate::icon::{self, PREFIX as ICON_PREFIX};
use crate::public_cache::{self as cache, Group, not_modified, stream_response, text_response};
use crate::runtime::{attribute, cancel_body, get, json, only_if, parse_object, property, set};
use crate::{image_references, models, publishing, site_assets};

const DRAFT_SITE: &str = "draft-site.json";
const ICON_CACHE: &str = "public, max-age=31536000, immutable";

pub async fn handle(request: &Request, storage: &R2Bucket) -> JsResult<Response> {
    let url = Url::new(&request.url())?;
    match (url.pathname().as_str(), request.method().as_str()) {
        ("/api/settings", "GET") => read_settings(storage).await,
        ("/api/settings", "PUT") => save_settings(request, storage, &url.origin()).await,
        ("/api/site-icon", "POST") => upload_icon(request, storage).await,
        ("/api/site-icon/derivatives", "POST") => backfill_icon(request, storage).await,
        _ => Err(error(404, "接口不存在。")),
    }
}

async fn read_settings(storage: &R2Bucket) -> JsResult<Response> {
    let draft = get(storage, DRAFT_SITE).await?;
    let released = property(
        &publishing::current_release(storage, &JsValue::UNDEFINED).await?,
        "site",
    );
    let etag = property(&draft, "etag");
    let site = if draft.is_truthy() {
        parse_object(&draft).await?
    } else {
        released
    };
    let icon = property(&site, "siteIcon");
    let ready = site_assets::ready(storage, &icon).await?;
    json(
        200,
        &[
            ("site", site),
            (
                "etag",
                if etag.is_truthy() {
                    etag
                } else {
                    JsValue::NULL
                },
            ),
            ("siteIconDerivativesReady", ready.into()),
        ],
    )
}

async fn save_settings(request: &Request, storage: &R2Bucket, origin: &str) -> JsResult<Response> {
    let data = json_input(request, 500_000).await?;
    let site = models::validate_site(&property(&data, "site"))?;
    let about = property(&site, "about").as_string().unwrap_or_default();
    image_references::ensure(storage, &about.into(), origin).await?;
    site_assets::ensure_illustration(storage, &site).await?;
    site_assets::ensure_icon(storage, &site).await?;
    let old = get(storage, DRAFT_SITE).await?;
    let etag = property(&old, "etag");
    if old.is_truthy() && property(&data, "etag") != etag {
        cancel_body(&old).await?;
        return Err(settings_conflict());
    }
    let text = JSON::stringify(&site)?;
    let condition = if old.is_truthy() {
        let prior = models::validate_site(&parse_object(&old).await?)?;
        if JSON::stringify(&prior)? == text {
            return json(
                200,
                &[("site", site), ("etag", etag), ("unchanged", true.into())],
            );
        }
        only_if("etagMatches", etag)?
    } else {
        only_if("etagDoesNotMatch", "*".into())?
    };
    let saved =
        JsFuture::from(storage.put(DRAFT_SITE.into(), text.into(), condition.into())?).await?;
    if !saved.is_truthy() {
        return Err(settings_conflict());
    }
    json(200, &[("site", site), ("etag", property(&saved, "etag"))])
}

fn settings_conflict() -> JsValue {
    error(409, "网站信息刚刚被修改，请重新打开设置。")
}

async fn upload_icon(request: &Request, storage: &R2Bucket) -> JsResult<Response> {
    let content_type = request
        .headers()
        .get("Content-Type")?
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.starts_with("multipart/form-data") {
        let form = read_form(request, "无法解析上传的图标表单，请重试。").await?;
        let file = form.get("file");
        if !file.is_truthy() || file.is_string() {
            return Err(error(400, "请选择网站图标文件。"));
        }
        let file: Blob = file.unchecked_into();
        let bytes = JsFuture::from(file.array_buffer()).await?;
        let icon = icon::inspect(Uint8Array::new(&bytes)).await?;
        let key = property(&icon, "key").as_string().unwrap_or_default();
        let derived = icon::derivatives(&form, &key).await?;
        let result_keys = Array::new();
        let items = Array::new();
        for item in derived.iter() {
            result_keys.push(&property(&item, "key"));
            items.push(&item);
        }
        items.push(&icon_with_name(&icon)?);
        let written = put_icon_objects(storage, &items).await?;
        return icon_response(
            &icon,
            Some(result_keys),
            JsValue::TRUE,
            written.length() == 0,
        );
    }

    let bytes = JsFuture::from(request.array_buffer()?).await?;
    let icon = icon::inspect(Uint8Array::new(&bytes)).await?;
    let key = property(&icon, "key");
    let key_text = key.as_string().unwrap_or_default();
    let existing = JsFuture::from(storage.head(key_text.clone())?).await?;
    let ready = site_assets::ready(storage, &key).await?.into();
    if same_icon_object(&existing, &icon) {
        return icon_response(&icon, None, ready, true);
    }
    let item = icon_with_name(&icon)?;
    let options = only_if("etagDoesNotMatch", "*".into())?;
    add_icon_options(&options, &item)?;
    JsFuture::from(storage.put(key_text, property(&item, "bytes"), options.into())?).await?;
    icon_response(&icon, None, ready, false)
}

async fn backfill_icon(request: &Request, storage: &R2Bucket) -> JsResult<Response> {
    let form = read_form(request, "无法解析派生图标表单，请重试。").await?;
    let Some(key) = form
        .get("key")
        .as_string()
        .filter(|key| crate::media::valid_site_icon_key(key))
    else {
        return Err(error(400, "网站图标地址不正确。"));
    };
    let original = JsFuture::from(storage.head(key.clone())?).await?;
    let mime = attribute(&property(&original, "httpMetadata"), "contentType");
    if !original.is_truthy() || mime != site_assets::mime(&key) {
        return Err(error(404, "原网站图标不存在，请重新上传图标。"));
    }
    let derived = icon::derivatives(&form, &key).await?;
    let created = put_icon_objects(storage, &derived).await?;
    json(
        200,
        &[
            ("key", key.into()),
            ("derivativesReady", true.into()),
            ("created", created.into()),
        ],
    )
}

async fn read_form(request: &Request, message: &str) -> JsResult<FormData> {
    let form = match request.form_data() {
        Ok(promise) => JsFuture::from(promise).await,
        Err(error) => Err(error),
    };
    form.map(JsCast::unchecked_into)
        .map_err(|_| error(400, message))
}

async fn put_icon_objects(storage: &R2Bucket, items: &Array) -> JsResult<Array> {
    let created = Array::new();
    let write_all = async {
        for item in items.iter() {
            let key = property(&item, "key");
            let key_text = key.as_string().unwrap_or_default();
            let existing = JsFuture::from(storage.head(key_text.clone())?).await?;
            if same_icon_object(&existing, &item) {
                continue;
            }
            let options = Object::new();
            add_icon_options(&options, &item)?;
            let saved =
                JsFuture::from(storage.put(key_text, property(&item, "bytes"), options.into())?)
                    .await?;
            if !saved.is_truthy() {
                return Err(error(500, "保存网站图标失败，请重试。"));
            }
            created.push(&key);
        }
        Ok(())
    };
    if let Err(error) = write_all.await {
        if created.length() != 0
            && let Ok(removed) = storage.delete_multiple(created.to_vec())
        {
            let _ = JsFuture::from(removed).await;
        }
        return Err(error);
    }
    Ok(created)
}

fn icon_with_name(icon: &JsValue) -> JsResult<JsValue> {
    let item = Object::assign(&Object::new(), icon.unchecked_ref());
    let metadata = Object::new();
    set(
        &metadata,
        "name",
        format!("网站图标.{}", attribute(icon, "ext")),
    )?;
    set(&item, "metadata", metadata)?;
    Ok(item.into())
}

fn add_icon_options(options: &Object, item: &JsValue) -> JsResult<()> {
    let http = Object::new();
    set(&http, "contentType", property(item, "type"))?;
    set(&http, "cacheControl", ICON_CACHE)?;
    set(options, "httpMetadata", http)?;
    let custom = property(item, "metadata");
    if custom.is_truthy() {
        set(options, "customMetadata", custom)?;
    }
    Ok(())
}

fn same_icon_object(existing: &JsValue, item: &JsValue) -> bool {
    existing.is_truthy()
        && property(existing, "size") == property(&property(item, "bytes"), "byteLength")
        && property(&property(existing, "httpMetadata"), "contentType") == property(item, "type")
}

fn icon_response(
    icon: &JsValue,
    derived: Option<Array>,
    ready: JsValue,
    reused: bool,
) -> JsResult<Response> {
    let key = attribute(icon, "key");
    let url = format!(
        "/site-icon/{}",
        key.strip_prefix(ICON_PREFIX).unwrap_or_default()
    );
    let mut fields = vec![
        ("key", key.into()),
        ("url", url.into()),
        ("type", property(icon, "type")),
        ("ext", property(icon, "ext")),
        ("size", property(&property(icon, "bytes"), "byteLength")),
    ];
    if let Some(derived) = derived {
        fields.push(("derived", derived.into()));
    }
    fields.push(("derivativesReady", ready));
    if reused {
        fields.push(("reused", true.into()));
    }
    json(201, &fields)
}

pub async fn public_icon(
    request: &Request,
    storage: &R2Bucket,
    ctx: &Context,
) -> JsResult<Response> {
    let method = request.method();
    if method != "HEAD" && method != "GET" {
        let headers = Headers::new()?;
        headers.set("Allow", "GET, HEAD")?;
        return text_response(Some("Method not allowed"), 405, &headers);
    }
    let url = Url::new(&request.url())?;
    let path = url.pathname();
    let key = format!(
        "{ICON_PREFIX}{}",
        path.strip_prefix("/site-icon/").unwrap_or_default()
    );
    if !site_assets::valid_asset_key(&key) {
        return text_response(Some("Not found"), 404, &Headers::new()?);
    }
    let mime = site_assets::mime(&key);
    let key_request = cache::key(&request.url(), Group::Media, "", "")?;
    if let Some(cached) = cache::read(&key_request).await {
        return cache::client_response(&cached, request, true);
    }
    let head = method == "HEAD";
    let object = if head {
        JsFuture::from(storage.head(key)?).await?
    } else {
        get(storage, &key).await?
    };
    if !object.is_truthy() || attribute(&property(&object, "httpMetadata"), "contentType") != mime {
        if !head && object.is_truthy() {
            cancel_body(&object).await?;
        }
        return text_response(Some("Not found"), 404, &Headers::new()?);
    }
    let headers = Headers::new()?;
    let etag = attribute(&object, "httpEtag");
    for (name, value) in [
        ("Content-Type", mime),
        ("ETag", etag.as_str()),
        ("Cache-Control", ICON_CACHE),
        ("X-Content-Type-Options", "nosniff"),
        ("Content-Security-Policy", "sandbox; default-src 'none'"),
    ] {
        headers.set(name, value)?;
    }
    if not_modified(request, Some(&etag))? {
        if !head {
            cancel_body(&object).await?;
        }
        return stream_response(None, 304, &headers);
    }
    let body: Option<ReadableStream> = (!head).then(|| property(&object, "body").unchecked_into());
    let response = stream_response(body.as_ref(), 200, &headers)?;
    if !head {
        cache::write(ctx, &key_request, &response, 604800)?;
    }
    Ok(response)
}
