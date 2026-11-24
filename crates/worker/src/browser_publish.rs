use worker::js_sys::{Array, Date, JSON, JsString, Object, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{CryptoKey, Request, Response, Url};
use worker::worker_sys::R2Bucket;

use crate::config::Config;
use crate::html_rewriter::JsResult;
use crate::http::{error, json_input};
use crate::page_rendering::{public_type, responsive_images, sanitize};
use crate::runtime::{
    attribute, body_text, cancel_body, digest_text, encode_utf8, get, js_number, js_string, json,
    json_object, limited_body, object, only_if, own_property, parse_object, property, read_json,
    set,
};

pub const PENDING: &str = "state/pending.json";
pub const PUBLISHED: &str = "state/published.json";
const ASSET_FILES: &[&str] = &["styles.css", "client.js", "favicon.svg", "sw.js"];
const MAX_PAGE: u32 = 8_000_000;
const MAX_MARKER: u32 = 4096;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = TextDecoder)]
    type TextDecoder;

    #[wasm_bindgen(constructor, catch, js_class = TextDecoder)]
    fn with_options(label: &str, options: &Object) -> JsResult<TextDecoder>;

    #[wasm_bindgen(method, catch)]
    fn decode(this: &TextDecoder, bytes: &Uint8Array) -> JsResult<JsString>;

}

pub async fn plan(request: &Request, storage: &R2Bucket, id: &str) -> JsResult<Response> {
    let (stored, state) = pending(storage, id).await?;
    let input = json_input(request, 150_000).await?;
    let supplied = property(&input, "sources");
    let files = generated_files(&state);
    let invalid = || error(400, "发布页面指纹不完整或无效。");
    if !record(&supplied)
        || entries(&supplied).any(|(path, hash)| !files.contains(&path) || !is_hash(&hash))
    {
        return Err(invalid());
    }
    let pointer = read_json(storage, PUBLISHED).await?;
    let prior = if compatible(&pointer, &state) {
        read_json(storage, &manifest_key(&attribute(&state, "previous_id"))).await?
    } else {
        JsValue::NULL
    };
    let sources = Object::new();
    let prior_sources = property(&prior, "sources");
    let render = property(&state, "render_files");
    for path in &files {
        let provided = own_property(&supplied, path);
        let old = property(&prior_sources, path);
        if !provided.is_truthy()
            && (!render.is_truthy() || contains(&render, path) || !old.is_truthy())
        {
            return Err(invalid());
        }
        set(
            &sources,
            path,
            if provided.is_truthy() { provided } else { old },
        )?;
    }
    let existing = property(&state, "plan");
    if existing.is_truthy() {
        let planned = property(&existing, "sources");
        if files
            .iter()
            .any(|path| property(&planned, path) != property(&sources, path))
        {
            return Err(error(409, "这次发布的页面已确定，请重新发布。"));
        }
        let files = missing_pages(
            storage,
            &property(&existing, "pages"),
            &property(&existing, "sizes"),
        )
        .await?;
        return json(200, &[("files", files.into())]);
    }
    let pages = Object::new();
    let sizes = Object::new();
    let changed = Array::new();
    let prior_pages = property(&prior, "pages");
    let prior_sizes = property(&prior, "sizes");
    for path in &files {
        let old_hash = property(&prior_pages, path);
        let source = property(&sources, path);
        if path != "_release.json" && property(&prior_sources, path) == source && is_hash(&old_hash)
        {
            set(&pages, path, old_hash)?;
            let size = property(&prior_sizes, path);
            if size.as_f64().is_some_and(nonnegative_integer) {
                set(&sizes, path, size)?;
            }
        } else {
            let generation = property(&state, "generation_version");
            let generation = if generation.is_truthy() {
                generation
            } else {
                property(&state, "response_version")
            };
            let scope = if property(&state, "force_rebuild").is_truthy() || path == "_release.json"
            {
                id
            } else {
                ""
            };
            let text = format!(
                "{}:{}:{path}:{scope}:{}",
                value_text(&generation),
                value_text(&property(&state, "template_version")),
                value_text(&source)
            );
            set(&pages, path, digest_text(&text.into()).await?)?;
            changed.push(&path.into());
        }
    }
    let result = object(&[
        ("sources", sources.into()),
        ("pages", pages.into()),
        ("sizes", sizes.into()),
    ])?;
    let updated = copy(&state);
    set(&updated, "files", string_array(&files))?;
    set(&updated, "plan", result)?;
    if !write_state(storage, PENDING, &updated, &stored)
        .await?
        .is_truthy()
    {
        return Err(error(409, "发布状态已经变化，请重试。"));
    }
    json(200, &[("files", changed.into())])
}

pub async fn stage(
    request: &Request,
    storage: &R2Bucket,
    config: &Config,
    id: &str,
) -> JsResult<Response> {
    let (_, state) = pending(storage, id).await?;
    let url = Url::new(&request.url())?;
    let path = url.search_params().get("path").unwrap_or_default();
    if !contains(&property(&state, "files"), &path) {
        return Err(error(400, "这不是当前发布中的页面。"));
    }
    let limit = if path == "_release.json" {
        MAX_MARKER
    } else {
        MAX_PAGE
    };
    let bytes = limited_body(request, limit, || error(413, "上传内容太大。")).await?;
    let decoder = TextDecoder::with_options(
        "utf-8",
        &object(&[("fatal", true.into()), ("ignoreBOM", false.into())])?,
    )?;
    let mut body = decoder.decode(&bytes)?;
    let plan = property(&state, "plan");
    let key = page_key(&plan, id, &path);
    if plan.is_truthy()
        && property(&property(&plan, "sources"), &path) != digest_text(&body).await?
    {
        return Err(error(409, "网页内容与本次发布指纹不一致，请重新生成。"));
    }
    if path == "_release.json" {
        validate_marker(&body, &state)?;
    }
    if plan.is_truthy() {
        let existing = JsFuture::from(storage.head(key.clone())?).await?;
        if existing.is_truthy() {
            let size = property(&existing, "size");
            let receipt = signed_receipt(config, &state, &path, &size).await?;
            return json(
                200,
                &[
                    ("ok", true.into()),
                    ("reused", true.into()),
                    ("receipt", receipt.into()),
                ],
            );
        }
    }
    if path.ends_with(".html") {
        body = responsive_images(&sanitize(&body).await?, storage, &url.origin()).await?;
    }
    // Once an upload has won the conditional write its bytes remain immutable.
    let options = only_if("etagDoesNotMatch", "*".into())?;
    set(
        &options,
        "httpMetadata",
        object(&[("contentType", public_type(&path).into())])?,
    )?;
    let written = JsFuture::from(storage.put(key.clone(), body.into(), options.into())?).await?;
    let mut size = property(&written, "size");
    if size.is_null() || size.is_undefined() {
        size = property(&JsFuture::from(storage.head(key)?).await?, "size");
    }
    if size.is_undefined() {
        return Err(error(409, "页面未能保存，请重试。"));
    }
    if plan.is_truthy() {
        let receipt = signed_receipt(config, &state, &path, &size).await?;
        return json(200, &[("ok", true.into()), ("receipt", receipt.into())]);
    }
    json(200, &[("ok", true.into())])
}

pub async fn cancel(storage: &R2Bucket, id: &str) -> JsResult<Response> {
    let pending = get(storage, PENDING).await?;
    if !pending.is_truthy() {
        return Err(error(409, "这次发布已经结束。"));
    }
    let state = parse_object(&pending).await?;
    if property(&state, "release_id") != id {
        return Err(error(409, "发布版本已经变化。"));
    }
    let object = get(storage, PUBLISHED).await?;
    let pointer = if object.is_truthy() {
        parse_object(&object).await?
    } else {
        JsValue::NULL
    };
    if property(&pointer, "id") == id {
        return json_object(200, &with_status(&state, "deployed")?);
    }
    if object.is_truthy() && property(&pointer, "publishing") == id {
        let updated = copy(&pointer);
        set(&updated, "publishing", JsValue::UNDEFINED)?;
        if !write_state(storage, PUBLISHED, &updated, &object)
            .await?
            .is_truthy()
        {
            let current = read_json(storage, PUBLISHED).await?;
            if property(&current, "id") == id {
                return json_object(200, &with_status(&state, "deployed")?);
            }
            return Err(error(409, "发布状态已经变化，请刷新后重试。"));
        }
    }
    let failed = with_status(&state, "failed")?;
    set(
        &failed,
        "error",
        "发布未完成；草稿和上次上线版本已保留，可以重新发布。",
    )?;
    write_state(storage, PENDING, &failed, &pending).await?;
    json_object(200, &failed)
}

pub async fn commit(
    request: &Request,
    storage: &R2Bucket,
    config: &Config,
    id: &str,
) -> JsResult<Response> {
    let input = json_input(request, 250_000).await?;
    let receipts = property(&input, "receipts");
    if !receipts.is_undefined() && !record(&receipts) {
        return Err(error(400, "页面保存凭据格式不正确。"));
    }
    let (stored, state) = pending(storage, id).await?;
    let locked = write_state(storage, PENDING, &with_status(&state, "built")?, &stored).await?;
    if !locked.is_truthy() {
        return Err(error(409, "另一个窗口正在完成发布。"));
    }
    let mut committed = false;
    let result = async {
        let (sizes, verification, total) =
            verify_pages(storage, config, id, &state, &receipts).await?;
        let release = read_json(storage, &format!("releases/{id}.json")).await?;
        if !release.is_truthy() {
            return Err(error(503, "发布版本缺失。"));
        }
        if total > 16_000_000.0 {
            return Err(error(413, "生成后的网页超过 16 MB，请减少内容后重试。"));
        }
        let latest = JsFuture::from(storage.head(PENDING.to_owned())?).await?;
        if property(&latest, "etag") != property(&locked, "etag") {
            return Err(error(409, "这次发布已取消，请重新发布。"));
        }
        let pointer = get(storage, PUBLISHED).await?;
        let current = if pointer.is_truthy() {
            parse_object(&pointer).await?
        } else {
            JsValue::NULL
        };
        if !pointer.is_truthy()
            || property(&current, "id") != property(&state, "previous_id")
            || property(&current, "publishing") != id
        {
            return Err(error(409, "这次发布已取消或线上版本已经变化，请重新发布。"));
        }
        crate::post_addresses::assert_rename_unchanged(storage, &state).await?;
        let plan = property(&state, "plan");
        if plan.is_truthy() {
            let manifest = copy(&plan);
            set(&manifest, "sizes", sizes)?;
            write_state(storage, &manifest_key(id), &manifest, &JsValue::UNDEFINED).await?;
        }
        let live = object(&[
            ("id", id.into()),
            ("published_at", Date::new_0().to_iso_string().into()),
        ])?;
        if plan.is_truthy() {
            set(&live, "pages", property(&plan, "pages"))?;
        }
        let previous = Array::new();
        previous.push(&property(&current, "id"));
        if let Some(id) = strings(&property(&current, "previous_ids")).next() {
            previous.push(&id.into());
        }
        set(&live, "previous_ids", previous)?;
        let site = property(&release, "site");
        for field in ["clarityId", "siteIcon"] {
            let value = property(&site, field);
            set(
                &live,
                field,
                if value.is_truthy() { value } else { "".into() },
            )?;
        }
        let icon_size = property(&site, "siteIconSize");
        if icon_size.is_truthy() {
            set(&live, "siteIconSize", icon_size)?;
        }
        set(
            &live,
            "postRedirects",
            crate::post_addresses::redirects(&release)?,
        )?;
        for (public, state_key) in [
            ("templateVersion", "template_version"),
            ("responseVersion", "response_version"),
            ("generationVersion", "generation_version"),
        ] {
            set(&live, public, property(&state, state_key))?;
        }
        if !write_state(storage, PUBLISHED, &live, &pointer)
            .await?
            .is_truthy()
        {
            return Err(error(409, "线上版本已经变化，请重新发布。"));
        }
        committed = true;
        crate::post_addresses::finish_rename(storage, &state, &release).await?;
        let done = with_status(&state, "deployed")?;
        write_state(storage, PENDING, &done, &locked).await?;
        set(&done, "verification", verification)?;
        json_object(200, &done)
    }
    .await;
    if result.is_err() && !committed {
        let failed = with_status(&state, "failed")?;
        set(&failed, "error", "发布未完成；草稿和上次上线版本已保留。")?;
        write_state(storage, PENDING, &failed, &locked).await?;
    }
    result
}

async fn verify_pages(
    storage: &R2Bucket,
    config: &Config,
    id: &str,
    state: &JsValue,
    receipts: &JsValue,
) -> JsResult<(Object, Object, f64)> {
    let plan = property(state, "plan");
    let prior_sizes = property(&plan, "sizes");
    let sizes = Object::new();
    let mut reused = 0;
    let mut signed = 0;
    let mut heads = 0;
    let mut total = 0.0;
    for path in strings(&property(state, "files")) {
        let key = page_key(&plan, id, &path);
        let prior_size = property(&prior_sizes, &path);
        let submitted = own_property(receipts, &path);
        let size = if path == "_release.json" {
            let marker = get(storage, &key).await?;
            if !marker.is_truthy() {
                return Err(error(409, "发布标记尚未上传，请重新发布。"));
            }
            let marker_size = property(&marker, "size");
            if js_number(&marker_size) > f64::from(MAX_MARKER) {
                cancel_body(&marker).await?;
                return Err(error(413, "发布标记过大。"));
            }
            validate_marker(&body_text(&marker).await?, state)?;
            marker_size
        } else if !prior_size.is_undefined() {
            reused += 1;
            prior_size
        } else if !submitted.is_undefined() {
            let size = verify_receipt(config, state, &plan, &path, &submitted).await?;
            signed += 1;
            size
        } else {
            heads += 1;
            let file = JsFuture::from(storage.head(key)?).await?;
            if !file.is_truthy() {
                return Err(error(409, "页面尚未上传完整，请重新发布。"));
            }
            property(&file, "size")
        };
        total += js_number(&size);
        set(&sizes, &path, size)?;
    }
    let verification = object(&[
        ("reused", reused.into()),
        ("receipts", signed.into()),
        ("heads", heads.into()),
    ])?;
    Ok((sizes, verification, total))
}

async fn verify_receipt(
    config: &Config,
    state: &JsValue,
    plan: &JsValue,
    path: &str,
    submitted: &JsValue,
) -> JsResult<JsValue> {
    let invalid = || error(409, "页面保存凭据无效，请重新发布。");
    if !Array::is_array(submitted) || !plan.is_truthy() {
        return Err(invalid());
    }
    let submitted: &Array = submitted.unchecked_ref();
    let size = submitted.get(0);
    let hash = submitted.get(1);
    if submitted.length() != 2
        || !size
            .as_f64()
            .is_some_and(|size| nonnegative_integer(size) && size <= f64::from(MAX_PAGE))
        || !is_hash(&hash)
    {
        return Err(invalid());
    }
    let expected = receipt(config, state, path, &size).await?;
    if !crate::runtime::same_bytes(
        &encode_utf8(hash.unchecked_ref()),
        &encode_utf8(&expected.into()),
    )? {
        return Err(invalid());
    }
    Ok(size)
}

async fn pending(storage: &R2Bucket, id: &str) -> JsResult<(JsValue, JsValue)> {
    let object = get(storage, PENDING).await?;
    if !object.is_truthy() {
        return Err(error(409, "没有待完成的发布，请重新发布。"));
    }
    let state = parse_object(&object).await?;
    if property(&state, "release_id") != id
        || !matches!(attribute(&state, "status").as_str(), "queued" | "building")
        || Date::now() - Date::parse(&attribute(&state, "started_at")) > 30.0 * 60_000.0
    {
        return Err(error(409, "这次发布已结束或失效，请重新发布。"));
    }
    Ok((object, state))
}

pub fn compatible(pointer: &JsValue, state: &JsValue) -> bool {
    let generation = property(state, "generation_version");
    property(pointer, "id") == property(state, "previous_id")
        && property(pointer, "templateVersion") == property(state, "template_version")
        && (if generation.is_truthy() {
            property(pointer, "generationVersion") == generation
        } else {
            property(pointer, "responseVersion") == property(state, "response_version")
        })
        && !property(state, "force_rebuild").is_truthy()
}

pub fn generated_files(state: &JsValue) -> Vec<String> {
    strings(&property(state, "files"))
        .filter(|path| !ASSET_FILES.contains(&path.as_str()))
        .collect()
}

fn page_key(plan: &JsValue, id: &str, path: &str) -> String {
    if plan.is_truthy() {
        format!(
            "public/content/{}",
            value_text(&property(&property(plan, "pages"), path))
        )
    } else {
        format!("public/{id}/{path}")
    }
}

pub fn manifest_key(id: &str) -> String {
    format!("releases/{id}.manifest.json")
}

async fn missing_pages(storage: &R2Bucket, pages: &JsValue, sizes: &JsValue) -> JsResult<Array> {
    let missing = Array::new();
    for (path, hash) in entries(pages) {
        if property(sizes, &path).is_undefined()
            && !JsFuture::from(storage.head(format!("public/content/{}", value_text(&hash)))?)
                .await?
                .is_truthy()
        {
            missing.push(&path.into());
        }
    }
    Ok(missing)
}

fn validate_marker(body: &JsString, state: &JsValue) -> JsResult<()> {
    let marker = JSON::parse(&body.as_string().unwrap_or_default())
        .map_err(|_| error(400, "发布标记无效。"))?;
    if property(&marker, "id") != property(state, "release_id") {
        return Err(error(400, "发布标记与当前版本不一致。"));
    }
    let template = property(state, "template_version");
    if template.is_truthy() && property(&marker, "template_version") != template {
        return Err(error(
            409,
            "后台版本已更新，请刷新页面后重试；草稿和线上内容仍保留。",
        ));
    }
    Ok(())
}

async fn signed_receipt(
    config: &Config,
    state: &JsValue,
    path: &str,
    size: &JsValue,
) -> JsResult<Array> {
    let receipt = receipt(config, state, path, size).await?;
    Ok([size.clone(), receipt.into()].into_iter().collect())
}

async fn receipt(config: &Config, state: &JsValue, path: &str, size: &JsValue) -> JsResult<String> {
    let crypto = crate::runtime::crypto()?.subtle();
    let options = object(&[("name", "HMAC".into()), ("hash", "SHA-256".into())])?;
    let key = encode_utf8(&config.setup_token);
    let usage: Array = [JsValue::from_str("sign")].into_iter().collect();
    let key: CryptoKey = JsFuture::from(crypto.import_key_with_object(
        "raw",
        key.unchecked_ref(),
        &options,
        false,
        &usage,
    )?)
    .await?
    .unchecked_into();
    let plan = property(state, "plan");
    let payload: Array = [
        property(state, "release_id"),
        path.into(),
        property(&property(&plan, "pages"), path),
        size.clone(),
    ]
    .into_iter()
    .collect();
    let message = encode_utf8(&JSON::stringify(&payload)?);
    let signature =
        JsFuture::from(crypto.sign_with_str_and_js_u8_array("HMAC", &key, &message)?).await?;
    Ok(crate::runtime::hex(&Uint8Array::new(&signature)))
}

pub async fn write_state(
    storage: &R2Bucket,
    key: &str,
    value: &JsValue,
    prior: &JsValue,
) -> JsResult<JsValue> {
    let condition = if prior.is_truthy() {
        only_if("etagMatches", property(prior, "etag"))?
    } else {
        only_if("etagDoesNotMatch", "*".into())?
    };
    JsFuture::from(storage.put(
        key.to_owned(),
        JSON::stringify(value)?.into(),
        condition.into(),
    )?)
    .await
}

fn with_status(state: &JsValue, status: &str) -> JsResult<JsValue> {
    let updated = copy(state);
    set(&updated, "status", status)?;
    Ok(updated.into())
}

pub fn copy(value: &JsValue) -> Object {
    let result = Object::new();
    if value.is_object() {
        let descriptors = Object::get_own_property_descriptors::<JsValue>(value.unchecked_ref());
        Object::define_properties(&result, descriptors.unchecked_ref());
    }
    result
}

pub fn entries(value: &JsValue) -> impl Iterator<Item = (String, JsValue)> {
    let values = if value.is_object() {
        Object::entries(value.unchecked_ref())
    } else {
        Array::new()
    };
    values.to_vec().into_iter().map(|entry| {
        let entry: Array = entry.unchecked_into();
        (entry.get(0).as_string().unwrap_or_default(), entry.get(1))
    })
}

fn record(value: &JsValue) -> bool {
    value.is_object() && !Array::is_array(value)
}

pub fn strings(value: &JsValue) -> impl Iterator<Item = String> {
    let values = if Array::is_array(value) {
        value.clone().unchecked_into::<Array>()
    } else {
        Array::new()
    };
    values
        .to_vec()
        .into_iter()
        .filter_map(|item| item.as_string())
}

fn contains(array: &JsValue, value: &str) -> bool {
    Array::is_array(array) && array.unchecked_ref::<Array>().includes(&value.into(), 0)
}

pub fn is_hash(hash: &JsValue) -> bool {
    hash.as_string().is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub fn nonnegative_integer(value: f64) -> bool {
    value >= 0.0 && value.fract() == 0.0
}

fn value_text(value: &JsValue) -> String {
    js_string(value).as_string().unwrap_or_default()
}

pub fn string_array(values: &[String]) -> Array {
    values.iter().map(|item| JsValue::from_str(item)).collect()
}
