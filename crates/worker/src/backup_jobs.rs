use std::collections::{HashMap, HashSet};

use worker::js_sys::{self, Array, Date, JSON, JsString, Object, Promise};
use worker::wasm_bindgen::{JsCast, JsValue, closure::Closure};
use worker::wasm_bindgen_futures::{JsFuture, future_to_promise};
use worker::web_sys::{Request, Response, Url, WorkerGlobalScope};
use worker::worker_sys::R2Bucket;

use crate::backup::{self, MAX_BACKUP, MAX_FILES, MAX_IMAGES, MAX_TEXT};
use crate::browser_publish::{entries, is_hash, nonnegative_integer};
use crate::draft_listing::list_active;
use crate::drafts::{Hooks, Kind, deleted};
use crate::html_rewriter::JsResult;
use crate::image::parent_key;
use crate::media::valid_image_key;
use crate::post_addresses;
use crate::publishing::current_release;
use crate::runtime::{
    attribute, body_text, cancel_body, digest_text, encode_utf8, get, js_number, json, json_object,
    object, own_property, parse_object, property, read_json, set, set_own,
};

const ACTIVE: &str = "state/backup-task.json";
const MAX_SOURCE: f64 = 2_100_000.0;
const BATCH_BYTES: f64 = 1_000_000.0;
const BATCH_FILES: usize = 32;
const TTL: f64 = 24.0 * 60.0 * 60_000.0;

thread_local! {
    static LOCALE: (Array, Object) = (Array::new(), Object::new());
}

pub async fn handle(
    request: Request,
    storage: &R2Bucket,
    hooks: &Hooks,
    session: JsValue,
) -> JsResult<Response> {
    let bindings: &JsValue = hooks.as_ref();
    let bindings = bindings.clone();
    let callback = Closure::wrap(Box::new(move |storage: JsValue| {
        let request = Clone::clone(&request);
        let session = session.clone();
        let bindings = bindings.clone();
        future_to_promise(async move {
            route(
                &request,
                storage.unchecked_ref(),
                bindings.unchecked_ref(),
                &session,
            )
            .await
            .map(Into::into)
        })
    }) as Box<dyn FnMut(JsValue) -> Promise>);
    Ok(
        JsFuture::from(hooks.with_backup_budget(storage, callback.as_ref().unchecked_ref())?)
            .await?
            .unchecked_into(),
    )
}

async fn route(
    request: &Request,
    storage: &R2Bucket,
    hooks: &Hooks,
    session: &JsValue,
) -> JsResult<Response> {
    let url = Url::new(&request.url())?;
    let path = url.pathname();
    let method = request.method();
    let owner = property(session, "version");
    if path == "/api/backup/jobs" {
        match method.as_str() {
            "GET" => {
                let task = active(storage).await?;
                let output = if task.is_truthy() && property(&task, "owner") == owner {
                    public_task(&task, false)?.into()
                } else {
                    JsValue::NULL
                };
                return json_object(200, &output);
            }
            "POST" => return start(request, storage, hooks, owner).await,
            _ => return Err(hooks.error(404, "备份任务接口不存在。")),
        }
    }
    let Some(path) = path.strip_prefix("/api/backup/jobs/") else {
        return Err(hooks.error(404, "备份任务接口不存在。"));
    };
    let (id, action) = path.split_once('/').unwrap_or((path, ""));
    if !valid_id(id)
        || !matches!(
            action,
            "" | "read" | "preflight" | "verify-images" | "apply" | "finish" | "cancel"
        )
        || (action.is_empty() && path.ends_with('/'))
    {
        return Err(hooks.error(404, "备份任务接口不存在。"));
    }
    let (stored, task) = read_task(storage, id, &owner, hooks).await?;
    if action.is_empty() && method == "GET" {
        return respond(&task);
    }
    if method != "POST" {
        return Err(hooks.error(405, "请求方式不正确。"));
    }
    let etag = property(&stored, "etag");
    let phase = attribute(&task, "phase");
    if action == "cancel" {
        if !matches!(phase.as_str(), "cancelled" | "complete") {
            set(&task, "phase", "cancelled")?;
            set(&task, "entries", Array::new())?;
            set(&task, "images", Array::new())?;
            checkpoint(storage, &task, etag, hooks).await?;
            remove_chunks(storage, &task).await?;
        }
        clear_active(storage, &attribute(&task, "id")).await?;
        return respond(&task);
    }
    if phase == "cancelled" {
        return Err(hooks.error(409, "任务已取消，已恢复内容仍保留。"));
    }
    match action {
        "read" => read_export(request, storage, hooks, &task).await,
        "preflight" => preflight(request, &url, storage, hooks, &task, etag).await,
        "verify-images" => verify_images(request, storage, hooks, &task, etag).await,
        "apply" => apply(request, &url, storage, hooks, &task, etag).await,
        "finish" => finish(&url, storage, hooks, &task, etag).await,
        _ => Err(hooks.error(404, "备份任务接口不存在。")),
    }
}

pub async fn active(storage: &R2Bucket) -> JsResult<JsValue> {
    let entry = read_json(storage, ACTIVE).await?;
    let id = attribute(&entry, "id");
    if !entry.is_truthy() || number(&entry, "expires") <= Date::now() || !valid_id(&id) {
        return Ok(JsValue::NULL);
    }
    let task = read_json(storage, &task_key(&id)).await?;
    if task.is_truthy()
        && number(&task, "expires") > Date::now()
        && !matches!(attribute(&task, "phase").as_str(), "complete" | "cancelled")
    {
        Ok(task)
    } else {
        Ok(JsValue::NULL)
    }
}

async fn read_task(
    storage: &R2Bucket,
    id: &str,
    owner: &JsValue,
    hooks: &Hooks,
) -> JsResult<(JsValue, JsValue)> {
    let stored = get(storage, &task_key(id)).await?;
    if !stored.is_truthy() {
        return Err(hooks.error(404, "备份任务不存在，请重新选择备份。"));
    }
    let task = parse_object(&stored).await?;
    if property(&task, "owner") != *owner {
        return Err(hooks.error(403, "备份任务属于其他登录版本，请重新开始。"));
    }
    if number(&task, "expires") <= Date::now() {
        return Err(hooks.error(410, "备份任务已过期，已恢复内容仍保留，请重新开始。"));
    }
    Ok((stored, task))
}

fn public_task(task: &JsValue, include_entries: bool) -> JsResult<Object> {
    let output = Object::new();
    for field in [
        "id",
        "mode",
        "phase",
        "expires",
        "preflight",
        "batches",
        "applied",
        "verifiedImages",
    ] {
        set(&output, field, property(task, field))?;
    }
    let images = array(task, "images");
    let entries = array(task, "entries");
    set(&output, "imageCount", images.length())?;
    set(&output, "restored", property(task, "restored"))?;
    set(&output, "total", entries.length())?;
    if include_entries {
        let paths: Array = entries
            .iter()
            .map(|entry| property(&entry, "path"))
            .collect();
        set(&output, "entries", paths)?;
    }
    set(&output, "result", property(task, "result"))?;
    if include_entries && property(task, "mode") == "export" {
        let created: JsString = property(task, "createdAt").unchecked_into();
        set(
            &output,
            "manifest",
            backup::manifest(property(task, "site"), images, created)?,
        )?;
    }
    Ok(output)
}

fn respond(task: &JsValue) -> JsResult<Response> {
    let output = public_task(task, false)?;
    json_object(200, &output)
}

async fn start(
    request: &Request,
    storage: &R2Bucket,
    hooks: &Hooks,
    owner: JsValue,
) -> JsResult<Response> {
    let input = JsFuture::from(hooks.json_input(request, 2_500_000)?).await?;
    let mode = attribute(&input, "mode");
    if !matches!(mode.as_str(), "restore" | "export") {
        return Err(hooks.error(400, "请选择备份或恢复。"));
    }
    let prior = active(storage).await?;
    let prior = if property(&prior, "owner") == owner {
        prior
    } else {
        JsValue::NULL
    };
    let id = js_sys::global()
        .unchecked_into::<WorkerGlobalScope>()
        .crypto()?
        .random_uuid();
    let expires = Date::now() + TTL;
    let task = object(&[
        ("id", id.clone().into()),
        ("owner", owner),
        ("expires", expires.into()),
        ("mode", mode.clone().into()),
        (
            "phase",
            if mode == "restore" {
                "preflight".into()
            } else {
                "applying".into()
            },
        ),
        ("entries", Array::new().into()),
        ("images", Array::new().into()),
        ("site", Object::new().into()),
        ("createdAt", Date::new_0().to_iso_string().into()),
        ("preflight", 0.into()),
        ("batches", 0.into()),
        ("applied", 0.into()),
        ("restored", 0.into()),
        ("verifiedImages", 0.into()),
    ])?;
    if mode == "restore" {
        fill_restore(hooks, &input, &task).await?;
        if prior.is_truthy() {
            if property(&prior, "mode") == "restore"
                && property(&prior, "fingerprint") == property(&task, "fingerprint")
            {
                let output = public_task(&prior, true)?;
                return json_object(200, &output);
            }
            return Err(hooks.error(409, "已有未完成备份任务，请继续原任务或先取消。"));
        }
        let settings = get(storage, "draft-site.json").await?;
        if settings.is_truthy() && property(&input, "settings_etag") != property(&settings, "etag")
        {
            return Err(hooks.error(409, "网站设置已变化，请重新打开设置。"));
        }
        set(&task, "settingsEtag", nullable(&settings, "etag"))?;
        set(&task, "settingsVersion", nullable(&settings, "version"))?;
        if settings.is_truthy() {
            cancel_body(&settings).await?;
        }
        if array(&task, "entries").length() == 0 {
            set(&task, "phase", "applying")?;
        }
    } else {
        if prior.is_truthy() {
            if property(&prior, "mode") == "export" {
                let output = public_task(&prior, true)?;
                return json_object(200, &output);
            }
            return Err(hooks.error(409, "请先完成或取消当前恢复任务。"));
        }
        fill_export(storage, hooks, &task).await?;
    }
    checkpoint(storage, &task, JsValue::UNDEFINED, hooks).await?;
    let active = object(&[("id", id.into()), ("expires", expires.into())])?;
    put_json(storage, ACTIVE, &active).await?;
    let output = public_task(&task, true)?;
    json_object(201, &output)
}

async fn fill_restore(hooks: &Hooks, input: &JsValue, task: &Object) -> JsResult<()> {
    let manifest = property(input, "manifest");
    let sources = property(&manifest, "entries");
    let images = property(&manifest, "images");
    if !manifest.is_truthy()
        || property(&manifest, "format") != "cloudink-backup"
        || property(&manifest, "schema_version").as_f64() != Some(1.0)
        || !Array::is_array(&sources)
        || !Array::is_array(&images)
    {
        return Err(hooks.error(400, "备份清单格式无效。"));
    }
    let site = hooks.validate_site(&property(&manifest, "site"))?;
    let sources: Array = sources.unchecked_into();
    let images: Array = images.unchecked_into();
    if sources.length() as usize > MAX_FILES {
        return Err(hooks.error(413, "备份原稿数量过多。"));
    }
    let mut chosen = HashMap::new();
    let mut seen = HashSet::new();
    for entry in sources.iter() {
        let path = attribute(&entry, "path");
        let parsed = backup::source_path(&path);
        let hash = property(&entry, "hash");
        let invalid = || hooks.error(400, "备份原稿路径、大小或摘要无效。");
        let Some(parsed) = parsed else {
            return Err(invalid());
        };
        let size = property(&entry, "size");
        if !seen.insert(path.clone())
            || !is_hash(&hash)
            || !size
                .as_f64()
                .is_some_and(|size| nonnegative_integer(size) && size <= MAX_SOURCE)
        {
            return Err(invalid());
        }
        let target = format!("{}{}.md", parsed.kind.storage_prefix(), parsed.slug);
        if parsed.draft || !chosen.contains_key(&target) {
            let selected = object(&[
                ("path", path.into()),
                ("target", target.clone().into()),
                ("hash", hash),
                ("size", size),
            ])?;
            chosen.insert(target, selected);
        }
    }
    let bytes = text_budget(&sources, hooks)?;
    let mut ordered: Vec<_> = chosen.into_iter().collect();
    ordered.sort_by(|(a, _), (b, _)| compare(a, b));
    let entries: Array = ordered
        .into_iter()
        .map(|(_, entry)| JsValue::from(entry))
        .collect();
    image_budget(&images, bytes, hooks)?;
    let mut sorted_images = images.to_vec();
    sorted_images.sort_by(|a, b| compare(&attribute(a, "key"), &attribute(b, "key")));
    let sorted_images: Array = sorted_images.into_iter().collect();
    let fingerprint = object(&[
        ("entries", entries.clone().into()),
        ("site", site.clone()),
        ("images", sorted_images.into()),
        ("settings", nullable(input, "settings_etag")),
    ])?;
    set(task, "site", site)?;
    set(task, "entries", entries)?;
    set(task, "images", images)?;
    set(
        task,
        "fingerprint",
        digest_text(&JSON::stringify(&fingerprint)?).await?,
    )?;
    Ok(())
}

async fn fill_export(storage: &R2Bucket, hooks: &Hooks, task: &Object) -> JsResult<()> {
    let release = current_release(storage, hooks, &JsValue::UNDEFINED).await?;
    set(task, "releaseId", property(&release, "id"))?;
    set(
        task,
        "site",
        backup::selected_site(storage, hooks, &release).await?,
    )?;
    let files = Array::new();
    for (field, prefix) in [
        ("markdown_posts", "published"),
        ("markdown_shorts", "published-shorts"),
    ] {
        for (slug, source) in entries(&property(&release, field)) {
            let entry = object(&[
                ("path", format!("{prefix}/{slug}.md").into()),
                ("size", encode_utf8(source.unchecked_ref()).length().into()),
            ])?;
            files.push(&entry);
        }
    }
    for kind in [Kind::Post, Kind::Short] {
        for stored in list_active(storage, hooks, kind).await? {
            let path = attribute(&stored, "key");
            if backup::source_path(&path).is_none() || number(&stored, "size") > MAX_SOURCE {
                return Err(hooks.error(413, "原稿路径或大小超出网页备份范围。"));
            }
            let entry = object(&[
                ("path", path.into()),
                ("size", property(&stored, "size")),
                ("etag", property(&stored, "etag")),
            ])?;
            files.push(&entry);
        }
    }
    let bytes = text_budget(&files, hooks)?;
    let images = Array::new();
    for stored in backup::objects(
        storage,
        "uploads/",
        MAX_IMAGES,
        hooks,
        "文件数量超过网页备份限制。",
    )
    .await?
    {
        if valid_image_key(&attribute(&stored, "key")) {
            let image = backup::image_record(&stored)?;
            images.push(&image);
        }
    }
    image_budget(&images, bytes, hooks)?;
    set(task, "entries", files)?;
    set(task, "images", images)?;
    Ok(())
}

async fn read_export(
    request: &Request,
    storage: &R2Bucket,
    hooks: &Hooks,
    task: &JsValue,
) -> JsResult<Response> {
    let input = JsFuture::from(hooks.json_input(request, 4096)?).await?;
    if property(task, "mode") != "export" || property(task, "phase") != "applying" {
        return Err(hooks.error(409, "这不是可读取的导出任务。"));
    }
    let items = array(task, "entries");
    let total = items.length() as usize;
    let Some(mut next) = integer(&property(&input, "index")).filter(|&index| index <= total) else {
        return Err(hooks.error(400, "备份分页位置无效。"));
    };
    let selected: Vec<_> = items.iter().skip(next).take(BATCH_FILES).collect();
    let release = if selected
        .iter()
        .any(|entry| attribute(entry, "path").starts_with("published"))
    {
        read_json(
            storage,
            &format!("releases/{}.json", attribute(task, "releaseId")),
        )
        .await?
    } else {
        JsValue::NULL
    };
    let files = Object::new();
    let mut bytes = 0.0;
    for (position, entry) in selected.into_iter().enumerate() {
        let size = number(&entry, "size");
        if position > 0 && bytes + size > BATCH_BYTES {
            break;
        }
        let path = attribute(&entry, "path");
        let etag = property(&entry, "etag");
        let source = if etag.is_truthy() {
            let stored = get(storage, &path).await?;
            if !stored.is_truthy() || property(&stored, "etag") != etag || deleted(&stored) {
                if stored.is_truthy() {
                    cancel_body(&stored).await?;
                }
                return Err(hooks.error(409, "原稿在备份期间发生变化，请取消后重新备份。"));
            }
            body_text(&stored).await?.into()
        } else {
            let Some(parsed) = backup::source_path(&path) else {
                return Err(hooks.error(409, "备份快照缺失或发生变化，请重新备份。"));
            };
            let field = if parsed.kind == Kind::Short {
                "markdown_shorts"
            } else {
                "markdown_posts"
            };
            own_property(&property(&release, field), parsed.slug)
        };
        if !source.is_string() || f64::from(encode_utf8(source.unchecked_ref()).length()) != size {
            return Err(hooks.error(409, "备份快照缺失或发生变化，请重新备份。"));
        }
        set_own(&files, &path, source)?;
        bytes += size;
        next += 1;
    }
    json(
        200,
        &[
            ("files", files.into()),
            (
                "next",
                if next < total {
                    next.into()
                } else {
                    JsValue::NULL
                },
            ),
        ],
    )
}

async fn preflight(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
    task: &JsValue,
    etag: JsValue,
) -> JsResult<Response> {
    let input = JsFuture::from(hooks.json_input(request, 4_500_000)?).await?;
    if property(task, "mode") != "restore" {
        return Err(hooks.error(409, "这不是恢复任务。"));
    }
    let Some(index) = index(&input, "index") else {
        return Err(hooks.error(400, "恢复批次位置无效。"));
    };
    let preflight = number(task, "preflight");
    if index < preflight {
        return respond(task);
    }
    if property(task, "phase") != "preflight" || index != preflight {
        return Err(hooks.error(409, "请按顺序预检恢复内容。"));
    }
    let files = property(&input, "files");
    if !backup::record(&files) {
        return Err(hooks.error(400, "请提供当前批次原稿。"));
    }
    let names = Object::keys::<JsValue>(files.unchecked_ref()).length() as usize;
    if names == 0 || names > BATCH_FILES {
        return Err(hooks.error(413, "每批最多处理 32 份原稿。"));
    }
    let entries = array(task, "entries");
    let selected: Vec<_> = entries
        .iter()
        .skip(preflight as usize)
        .take(names)
        .collect();
    if selected.len() != names
        || selected
            .iter()
            .any(|entry| own_property(&files, &attribute(entry, "path")).is_undefined())
    {
        return Err(hooks.error(400, "当前批次与备份清单不一致。"));
    }
    let bytes = selected
        .iter()
        .map(|entry| number(entry, "size"))
        .sum::<f64>();
    if bytes > BATCH_BYTES && selected.len() > 1 {
        return Err(hooks.error(413, "请缩小当前恢复批次。"));
    }
    if count(task, "verifiedImages") != array(task, "images").length() as usize {
        return Err(hooks.error(409, "请先恢复并核对全部图片。"));
    }
    let (pointer, state) = post_addresses::snapshot(storage).await?;
    let items = Array::new();
    let sources = Array::new();
    for entry in &selected {
        let path = attribute(entry, "path");
        let raw = own_property(&files, &path);
        if !raw.is_string()
            || f64::from(encode_utf8(raw.unchecked_ref()).length()) != number(entry, "size")
            || property(entry, "hash") != digest_text(raw.unchecked_ref()).await?
        {
            return Err(hooks.error(400, "原稿与备份摘要不一致。"));
        }
        let parsed = backup::source_path(&path)
            .ok_or_else(|| hooks.error(400, "原稿地址与备份路径不一致。"))?;
        let source = backup::as_draft(
            raw.unchecked_ref(),
            &parsed,
            hooks,
            "原稿地址与备份路径不一致。",
        )?;
        if parsed.kind == Kind::Post {
            post_addresses::assert_writable_in_snapshot(&pointer, &state, parsed.slug, hooks)?;
        }
        let target = attribute(entry, "target");
        let existing = get(storage, &target).await?;
        if renamed(&existing) {
            return Err(hooks.error(409, "原地址已改址，恢复不会覆盖它。"));
        }
        let unchanged = existing.is_truthy() && !deleted(&existing);
        if unchanged && body_text(&existing).await? != source {
            return Err(hooks.error(409, &format!("已有不同原稿：{target}")));
        }
        if deleted(&existing) {
            cancel_body(&existing).await?;
        }
        sources.push(&source);
        let item = object(&[
            ("key", target.into()),
            ("source", source.into()),
            ("etag", nullable(&existing, "etag")),
            ("version", nullable(&existing, "version")),
            ("unchanged", unchanged.into()),
        ])?;
        items.push(&item);
    }
    JsFuture::from(hooks.ensure_images_many(storage, &sources, &url.origin())?).await?;
    let chunk = object(&[("items", items.into())])?;
    let batch = count(task, "batches");
    put_json(storage, &chunk_key(task, batch), &chunk).await?;
    set(task, "batches", batch + 1)?;
    let next = preflight as usize + selected.len();
    set(task, "preflight", next)?;
    if next == entries.length() as usize {
        set(task, "phase", "applying")?;
    }
    checkpoint(storage, task, etag, hooks).await?;
    respond(task)
}

async fn apply(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
    task: &JsValue,
    etag: JsValue,
) -> JsResult<Response> {
    let input = JsFuture::from(hooks.json_input(request, 4096)?).await?;
    let Some(batch) = index(&input, "batch").filter(|_| property(task, "mode") == "restore") else {
        return Err(hooks.error(400, "恢复批次无效。"));
    };
    let applied = number(task, "applied");
    if batch < applied {
        return respond(task);
    }
    if property(task, "phase") != "applying"
        || batch != applied
        || applied >= number(task, "batches")
    {
        return Err(hooks.error(409, "请先完成预检并按顺序恢复。"));
    }
    let chunk = read_json(storage, &chunk_key(task, applied as usize)).await?;
    if !chunk.is_truthy() {
        return Err(hooks.error(409, "恢复预检数据缺失，请重新开始。"));
    }
    let (pointer, state) = post_addresses::snapshot(storage).await?;
    let items = array(&chunk, "items");
    let sources: Array = items.iter().map(|item| property(&item, "source")).collect();
    JsFuture::from(hooks.ensure_images_many(storage, &sources, &url.origin())?).await?;
    let mut restored = 0;
    for item in items.iter() {
        let key = attribute(&item, "key");
        let parsed = backup::source_path(&key)
            .filter(|source| source.draft)
            .ok_or_else(|| hooks.error(409, "恢复预检数据缺失，请重新开始。"))?;
        if parsed.kind == Kind::Post {
            post_addresses::assert_writable_in_snapshot(&pointer, &state, parsed.slug, hooks)?;
        }
        let existing = get(storage, &key).await?;
        if renamed(&existing) {
            return Err(hooks.error(409, "原地址已改址，请检查后重新恢复。"));
        }
        let source: JsString = property(&item, "source").unchecked_into();
        if existing.is_truthy() && !deleted(&existing) && body_text(&existing).await? == source {
            if !property(&item, "unchanged").is_truthy() {
                restored += 1;
            }
            continue;
        }
        if deleted(&existing) {
            cancel_body(&existing).await?;
        }
        if nullable(&existing, "version") != property(&item, "version")
            || nullable(&existing, "etag") != property(&item, "etag")
        {
            return Err(hooks.error(
                409,
                "原稿在恢复期间发生变化；已完成内容保留，请检查后重试。",
            ));
        }
        let saved = backup::put_restored_source(
            storage,
            &key,
            &source,
            parsed.kind,
            property(&existing, "etag"),
            hooks,
        )
        .await?;
        if !saved.is_truthy() {
            return Err(hooks.error(409, "原稿刚刚发生变化，请重新读取任务进度。"));
        }
        restored += 1;
    }
    set(task, "applied", applied + 1.0)?;
    set(task, "restored", count(task, "restored") + restored)?;
    checkpoint(storage, task, etag, hooks).await?;
    respond(task)
}

async fn finish(
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
    task: &JsValue,
    etag: JsValue,
) -> JsResult<Response> {
    if property(task, "phase") == "complete" {
        return respond(task);
    }
    let restore = property(task, "mode") == "restore";
    if property(task, "phase") != "applying"
        || (restore
            && (property(task, "applied") != property(task, "batches")
                || count(task, "verifiedImages") != array(task, "images").length() as usize))
    {
        return Err(hooks.error(409, "请先完成全部恢复批次。"));
    }
    if restore {
        finish_restore(url, storage, hooks, task).await?;
    }
    set(task, "phase", "complete")?;
    set(task, "entries", Array::new())?;
    set(task, "images", Array::new())?;
    checkpoint(storage, task, etag, hooks).await?;
    remove_chunks(storage, task).await?;
    clear_active(storage, &attribute(task, "id")).await?;
    respond(task)
}

async fn finish_restore(
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
    task: &JsValue,
) -> JsResult<()> {
    let site = property(task, "site");
    let about = backup::value_or_null(&site, "about", "".into());
    JsFuture::from(hooks.ensure_images(storage, about.unchecked_ref(), &url.origin())?).await?;
    JsFuture::from(hooks.ensure_icon(storage, &site)?).await?;
    JsFuture::from(hooks.ensure_illustration(storage, &site)?).await?;
    let old = get(storage, "draft-site.json").await?;
    let text = JSON::stringify(&site)?;
    let old_etag = nullable(&old, "etag");
    let settings_etag = if old.is_truthy() && body_text(&old).await? == text {
        old_etag
    } else {
        if nullable(&old, "version") != property(task, "settingsVersion")
            || old_etag != property(task, "settingsEtag")
        {
            return Err(hooks.error(
                409,
                "原稿已恢复，网站设置发生变化；现有设置保留，请检查后重试。",
            ));
        }
        let saved = backup::put_text(storage, "draft-site.json", &text, old_etag).await?;
        if !saved.is_truthy() {
            return Err(hooks.error(409, "网站设置刚刚发生变化，请重新读取任务。"));
        }
        property(&saved, "etag")
    };
    let entries = array(task, "entries");
    let count = |prefix: &str| {
        entries
            .iter()
            .filter(|entry| attribute(entry, "target").starts_with(prefix))
            .count()
    };
    let result = object(&[
        ("restored", property(task, "restored")),
        ("drafts", count("drafts/").into()),
        ("shorts", count("shorts/").into()),
        ("site", site),
        ("etag", settings_etag),
    ])?;
    set(task, "result", result)
}

async fn verify_images(
    request: &Request,
    storage: &R2Bucket,
    hooks: &Hooks,
    task: &JsValue,
    etag: JsValue,
) -> JsResult<Response> {
    let input = JsFuture::from(hooks.json_input(request, 4096)?).await?;
    let Some(index) = index(&input, "index").filter(|_| property(task, "mode") == "restore") else {
        return Err(hooks.error(400, "图片核对批次无效。"));
    };
    let verified = number(task, "verifiedImages");
    if index < verified {
        return respond(task);
    }
    if index != verified || !matches!(attribute(task, "phase").as_str(), "preflight" | "applying") {
        return Err(hooks.error(409, "请按顺序核对图片。"));
    }
    let mut added = 0;
    for image in array(task, "images")
        .iter()
        .skip(verified as usize)
        .take(BATCH_FILES)
    {
        let saved = JsFuture::from(storage.head(attribute(&image, "key"))?).await?;
        if !saved.is_truthy() || property(&saved, "size") != property(&image, "size") {
            return Err(hooks.error(409, "备份图片尚未恢复完整，请重新选择同一份备份继续。"));
        }
        added += 1;
    }
    set(task, "verifiedImages", verified + f64::from(added))?;
    checkpoint(storage, task, etag, hooks).await?;
    respond(task)
}

fn renamed(value: &JsValue) -> bool {
    property(&property(value, "customMetadata"), "renamedTo").is_truthy()
}

fn index(value: &JsValue, name: &str) -> Option<f64> {
    property(value, name)
        .as_f64()
        .filter(|&value| nonnegative_integer(value))
}

fn text_budget(entries: &Array, hooks: &Hooks) -> JsResult<f64> {
    let bytes = entries
        .iter()
        .map(|entry| number(&entry, "size"))
        .sum::<f64>();
    if entries.length() as usize > MAX_FILES || bytes > MAX_TEXT as f64 {
        return Err(hooks.error(413, "备份原稿超过 2000 份或 8 MB 限制。"));
    }
    Ok(bytes)
}

fn image_budget(images: &Array, text_bytes: f64, hooks: &Hooks) -> JsResult<()> {
    if images.length() as usize > MAX_IMAGES {
        return Err(hooks.error(413, "备份图片文件数量过多。"));
    }
    let mut keys = HashSet::new();
    let mut families = HashSet::new();
    let mut bytes = text_bytes;
    for image in images.iter() {
        let Some((key, size)) = backup::image_description(&image) else {
            return Err(hooks.error(400, "备份图片清单无效或存在重复路径。"));
        };
        if !keys.insert(key.clone()) {
            return Err(hooks.error(400, "备份图片清单无效或存在重复路径。"));
        }
        families.insert(parent_key(&key).to_owned());
        bytes += size;
    }
    if families.len() > MAX_FILES || bytes > MAX_BACKUP as f64 {
        return Err(hooks.error(413, "备份超过 2000 张图片或 100 MB 限制。"));
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
}

fn task_key(id: &str) -> String {
    format!("backup-tasks/{id}/state.json")
}

fn chunk_key(task: &JsValue, offset: usize) -> String {
    format!(
        "backup-tasks/{}/chunks/{offset}.json",
        attribute(task, "id")
    )
}

fn array(value: &JsValue, key: &str) -> Array {
    property(value, key).unchecked_into()
}

fn number(value: &JsValue, key: &str) -> f64 {
    js_number(&property(value, key))
}

fn nullable(value: &JsValue, key: &str) -> JsValue {
    backup::value_or_null(value, key, JsValue::NULL)
}

fn integer(value: &JsValue) -> Option<usize> {
    let value = value.as_f64()?;
    (nonnegative_integer(value) && value <= usize::MAX as f64).then_some(value as usize)
}

fn count(value: &JsValue, key: &str) -> usize {
    number(value, key) as usize
}

fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    LOCALE.with(|(locales, options)| {
        JsString::from(a)
            .locale_compare(b, locales, options)
            .cmp(&0)
    })
}

async fn checkpoint(
    storage: &R2Bucket,
    task: &JsValue,
    etag: JsValue,
    hooks: &Hooks,
) -> JsResult<()> {
    let saved = backup::put_text(
        storage,
        &task_key(&attribute(task, "id")),
        &JSON::stringify(task)?,
        etag,
    )
    .await?;
    if !saved.is_truthy() {
        return Err(hooks.error(409, "备份任务已变化，请读取最新进度。"));
    }
    Ok(())
}

async fn put_json(storage: &R2Bucket, key: &str, value: &JsValue) -> JsResult<()> {
    JsFuture::from(storage.put(
        key.to_owned(),
        JSON::stringify(value)?.into(),
        JsValue::UNDEFINED,
    )?)
    .await
    .map(drop)
}

async fn clear_active(storage: &R2Bucket, id: &str) -> JsResult<()> {
    let active = read_json(storage, ACTIVE).await?;
    if property(&active, "id") == id {
        JsFuture::from(storage.delete(ACTIVE.to_owned())?).await?;
    }
    Ok(())
}

async fn remove_chunks(storage: &R2Bucket, task: &JsValue) -> JsResult<()> {
    let batches = count(task, "batches");
    for offset in (0..batches).step_by(1000) {
        let keys = (offset..batches.min(offset + 1000))
            .map(|batch| chunk_key(task, batch).into())
            .collect();
        JsFuture::from(storage.delete_multiple(keys)?).await?;
    }
    Ok(())
}
