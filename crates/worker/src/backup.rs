use std::collections::{HashMap, HashSet};

use worker::js_sys::{Array, Date, JSON, JsString, Object, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Request, Response, Url};
use worker::worker_sys::{R2Bucket, R2ObjectBody};

use crate::browser_publish::{entries, nonnegative_integer};
use crate::drafts::{self, Hooks, Kind, deleted};
use crate::html_rewriter::JsResult;
use crate::image::{dimensions, parent_key};
use crate::image_header::{image_info, image_type};
use crate::media::{MAX_IMAGE, valid_image_key, valid_site_icon_key};
use crate::page_rendering::valid_slug;
use crate::post_addresses::assert_writable;
use crate::publishing::current_release;
use crate::runtime::{
    attribute, body_text, cancel_body, encode_utf8, get, js_number, json, json_object,
    limited_body, list, object, only_if, parse_object, property, set, set_own, sha256_hex,
};

pub const MAX_TEXT: usize = 8_000_000;
pub const MAX_FILES: usize = 2000;
pub const MAX_IMAGES: usize = MAX_FILES * 4;
pub const MAX_BACKUP: usize = 100 * 1024 * 1024;

pub async fn handle(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
) -> JsResult<Response> {
    match (url.pathname().as_str(), request.method().as_str()) {
        ("/api/backup", "GET") => export(storage, hooks).await,
        ("/api/backup/restore", "POST") => restore(request, url, storage, hooks).await,
        ("/api/backup/image", "PUT") => restore_image(request, url, storage, hooks).await,
        _ => Err(hooks.error(404, "接口不存在。")),
    }
}

pub struct SourcePath<'a> {
    pub slug: &'a str,
    pub kind: Kind,
    pub draft: bool,
}

pub fn source_path(path: &str) -> Option<SourcePath<'_>> {
    let (prefix, file) = path.split_once('/')?;
    let slug = file.strip_suffix(".md")?;
    if !valid_slug(slug) {
        return None;
    }
    let (kind, draft) = match prefix {
        "published" => (Kind::Post, false),
        "drafts" => (Kind::Post, true),
        "published-shorts" => (Kind::Short, false),
        "shorts" => (Kind::Short, true),
        _ => return None,
    };
    Some(SourcePath { slug, kind, draft })
}

fn history_path(path: &str) -> bool {
    let Some((slug, name)) = path
        .strip_prefix("history/")
        .and_then(|path| path.split_once('/'))
    else {
        return false;
    };
    valid_slug(slug)
        && name.strip_suffix(".md").is_some_and(|name| {
            !name.is_empty()
                && name.bytes().all(|byte| {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-'
                })
        })
}

pub async fn objects(
    storage: &R2Bucket,
    prefix: &str,
    limit: usize,
    hooks: &Hooks,
    message: &str,
) -> JsResult<Vec<JsValue>> {
    let mut objects = Vec::new();
    let mut cursor = JsValue::UNDEFINED;
    loop {
        let page = list(storage, prefix, cursor, 1000, &["customMetadata"]).await?;
        objects.extend(page.objects.iter());
        if objects.len() > limit {
            return Err(hooks.error(413, message));
        }
        cursor = page.cursor;
        if !cursor.is_truthy() {
            return Ok(objects);
        }
    }
}

const LEGACY_LIMIT: &str = "当前数据超过网页备份的数量限制，请通过 Cloudflare R2 备份。";
const TEXT_LIMIT: &str = "原稿超过网页备份限制，请通过 Cloudflare R2 备份。";

async fn export(storage: &R2Bucket, hooks: &Hooks) -> JsResult<Response> {
    let release = current_release(storage, hooks, &JsValue::UNDEFINED).await?;
    let site = selected_site(storage, hooks, &release).await?;
    let files = Object::new();
    let mut text_bytes = 0;
    let mut text_count = 0;
    for (field, prefix) in [
        ("markdown_posts", "published"),
        ("markdown_shorts", "published-shorts"),
    ] {
        for (slug, source) in entries(&property(&release, field)) {
            add_text(
                &files,
                &format!("{prefix}/{slug}.md"),
                source.unchecked_ref(),
                &mut text_bytes,
                &mut text_count,
                hooks,
            )?;
        }
    }
    let drafts = objects(storage, "drafts/", MAX_FILES, hooks, LEGACY_LIMIT).await?;
    let shorts = objects(storage, "shorts/", MAX_FILES, hooks, LEGACY_LIMIT).await?;
    if drafts.len() + shorts.len() > 32 {
        return Err(hooks.error(409, "请刷新后台，使用分批备份功能导出。"));
    }
    for object in drafts.into_iter().chain(shorts) {
        if deleted(&object) {
            continue;
        }
        if text_bytes as f64 + js_number(&property(&object, "size")) > MAX_TEXT as f64 {
            return Err(hooks.error(413, TEXT_LIMIT));
        }
        let key = attribute(&object, "key");
        let value = get(storage, &key).await?;
        if value.is_truthy() {
            let source = body_text(&value).await?;
            add_text(
                &files,
                &key,
                &source,
                &mut text_bytes,
                &mut text_count,
                hooks,
            )?;
        }
    }
    let images = Array::new();
    let mut image_bytes = 0.0;
    let mut families = HashSet::new();
    for stored in objects(storage, "uploads/", MAX_IMAGES, hooks, LEGACY_LIMIT).await? {
        let key = attribute(&stored, "key");
        if !valid_image_key(&key) {
            continue;
        }
        families.insert(parent_key(&key).to_owned());
        if families.len() > MAX_FILES {
            return Err(hooks.error(413, "备份图片超过 2000 张。"));
        }
        let size = js_number(&property(&stored, "size"));
        image_bytes += size;
        if size > f64::from(MAX_IMAGE) || text_bytes as f64 + image_bytes > MAX_BACKUP as f64 {
            return Err(hooks.error(
                413,
                "图片与文字超过 100 MB 网页备份限制，请通过 Cloudflare R2 备份。",
            ));
        }
        let image = image_record(&stored)?;
        images.push(&image);
    }
    let value = object(&[
        ("format", "cloudink-backup".into()),
        ("schema_version", 1.into()),
        ("created_at", Date::new_0().to_iso_string().into()),
        ("site", site),
        ("files", files.into()),
        ("images", images.into()),
    ])?;
    json_object(200, &value)
}

pub async fn selected_site(
    storage: &R2Bucket,
    hooks: &Hooks,
    release: &JsValue,
) -> JsResult<JsValue> {
    let settings = get(storage, "draft-site.json").await?;
    if settings.is_truthy() {
        hooks.validate_site(&parse_object(&settings).await?)
    } else {
        Ok(property(release, "site"))
    }
}

fn add_text(
    files: &Object,
    key: &str,
    source: &JsString,
    bytes: &mut usize,
    count: &mut usize,
    hooks: &Hooks,
) -> JsResult<()> {
    *bytes += encode_utf8(source).length() as usize;
    if *bytes > MAX_TEXT || *count >= MAX_FILES {
        return Err(hooks.error(413, TEXT_LIMIT));
    }
    *count += 1;
    set_own(files, key, source.clone().into())
}

pub fn image_record(object_value: &JsValue) -> JsResult<Object> {
    object(&[
        ("key", property(object_value, "key")),
        ("size", property(object_value, "size")),
        ("etag", property(object_value, "httpEtag")),
    ])
}

pub fn manifest(site: JsValue, images: Array, created: JsString) -> JsResult<Object> {
    object(&[
        ("format", "cloudink-backup".into()),
        ("schema_version", 1.into()),
        ("created_at", created.into()),
        ("site", site),
        ("images", images.into()),
    ])
}

struct RestoreFile {
    key: String,
    source: JsString,
    kind: Kind,
    tombstone: Option<JsValue>,
    unchanged: bool,
}

async fn restore(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
) -> JsResult<Response> {
    let input = JsFuture::from(hooks.json_input(request, 18_000_000)?).await?;
    let backup = property(&input, "backup");
    if !record(&backup) {
        return Err(hooks.error(400, "备份格式不正确。"));
    }
    let files = property(&backup, "files");
    let images = property(&backup, "images");
    if property(&backup, "format") != "cloudink-backup"
        || property(&backup, "schema_version").as_f64() != Some(1.0)
        || !record(&files)
        || !Array::is_array(&images)
    {
        return Err(hooks.error(400, "不支持这份备份，请使用 CloudInk 的“下载网站备份”。"));
    }
    let site = hooks.validate_site(&property(&backup, "site"))?;
    let files: Vec<_> = entries(&files).collect();
    let images: Array = images.unchecked_into();
    if files.len() > MAX_FILES || images.length() as usize > MAX_IMAGES {
        return Err(hooks.error(413, "备份文件数量过多。"));
    }
    if files.len() > 32 {
        return Err(hooks.error(409, "请刷新后台，使用分批恢复功能导入。"));
    }
    let mut writes = prepare_files(files, hooks)?;
    verify_legacy_images(storage, &images, hooks).await?;
    JsFuture::from(hooks.ensure_illustration(storage, &site)?).await?;
    JsFuture::from(hooks.ensure_icon(storage, &site)?).await?;
    let source = Array::new();
    source.push(&value_or_null(&site, "about", "".into()));
    for file in &writes {
        source.push(&file.source);
    }
    JsFuture::from(hooks.ensure_images_many(storage, &source, &url.origin())?).await?;
    let old = get(storage, "draft-site.json").await?;
    if old.is_truthy() && property(&input, "settings_etag") != property(&old, "etag") {
        return Err(hooks.error(409, "网站设置已变化，请重新打开设置后恢复。"));
    }
    for file in &mut writes {
        if file.kind == Kind::Post {
            let slug = source_path(&file.key).expect("validated restore path").slug;
            assert_writable(storage, slug, hooks).await?;
        }
        let existing = get(storage, &file.key).await?;
        if deleted(&existing)
            && !property(&property(&existing, "customMetadata"), "renamedTo").is_truthy()
        {
            file.tombstone = Some(property(&existing, "etag"));
            cancel_body(&existing).await?;
        } else if existing.is_truthy() {
            if body_text(&existing).await? != file.source {
                return Err(hooks.error(
                    409,
                    &format!(
                        "已有不同内容：{}。请先导出或处理现有原稿，恢复不会覆盖它。",
                        file.key
                    ),
                ));
            }
            file.unchanged = true;
        }
    }
    let mut restored = 0;
    for file in &writes {
        if file.unchanged {
            continue;
        }
        let etag = file.tombstone.clone().unwrap_or(JsValue::UNDEFINED);
        if put_restored_source(storage, &file.key, &file.source, file.kind, etag, hooks)
            .await?
            .is_truthy()
        {
            restored += 1;
        } else {
            let current = get(storage, &file.key).await?;
            if !current.is_truthy()
                || deleted(&current)
                || body_text(&current).await? != file.source
            {
                return Err(
                    hooks.error(409, "另一窗口修改了原稿。已恢复的内容保留，请检查后重试。")
                );
            }
        }
    }
    let text = JSON::stringify(&site)?;
    let etag = if old.is_truthy() && body_text(&old).await? == text {
        property(&old, "etag")
    } else {
        let saved = put_text(storage, "draft-site.json", &text, property(&old, "etag")).await?;
        if !saved.is_truthy() {
            return Err(hooks.error(409, "原稿已恢复，但网站设置发生了修改，请检查后重试。"));
        }
        property(&saved, "etag")
    };
    let drafts = writes.iter().filter(|file| file.kind == Kind::Post).count();
    json(
        200,
        &[
            ("restored", restored.into()),
            ("drafts", drafts.into()),
            ("site", site),
            ("etag", etag),
        ],
    )
}

fn prepare_files(files: Vec<(String, JsValue)>, hooks: &Hooks) -> JsResult<Vec<RestoreFile>> {
    let mut ordered = Vec::<RestoreFile>::new();
    let mut positions = HashMap::<String, usize>::new();
    for (key, source) in files {
        if history_path(&key) {
            continue;
        }
        let path = source_path(&key)
            .filter(|_| source.is_string())
            .ok_or_else(|| hooks.error(400, "备份包含不支持的文件路径。"))?;
        let mismatch = if path.kind == Kind::Short {
            "备份短记地址与文件路径不一致。"
        } else {
            "备份文章地址与文件路径不一致。"
        };
        let text = as_draft(source.unchecked_ref(), &path, hooks, mismatch)?;
        let key = format!("{}{}.md", path.kind.storage_prefix(), path.slug);
        if let Some(&position) = positions.get(&key) {
            if path.draft {
                ordered[position].source = text;
            }
        } else {
            positions.insert(key.clone(), ordered.len());
            ordered.push(RestoreFile {
                key,
                source: text,
                kind: path.kind,
                tombstone: None,
                unchanged: false,
            });
        }
    }
    ordered.sort_by_key(|file| file.kind == Kind::Short);
    Ok(ordered)
}

pub fn as_draft(
    source: &JsString,
    path: &SourcePath,
    hooks: &Hooks,
    mismatch: &str,
) -> JsResult<JsString> {
    let draft = path.kind.parse(source, hooks)?;
    let front = property(&draft, "front_matter");
    if property(&front, "slug") != path.slug {
        return Err(hooks.error(400, mismatch));
    }
    set(&front, "draft", true)?;
    path.kind.serialize(&draft, hooks)
}

async fn verify_legacy_images(storage: &R2Bucket, images: &Array, hooks: &Hooks) -> JsResult<()> {
    let available: HashMap<_, _> = objects(storage, "uploads/", MAX_IMAGES, hooks, LEGACY_LIMIT)
        .await?
        .into_iter()
        .map(|image| (attribute(&image, "key"), property(&image, "size")))
        .collect();
    let mut total = 0.0;
    let mut families = HashSet::new();
    for image in images.iter() {
        let Some((key, size)) = image_description(&image) else {
            return Err(hooks.error(400, "备份图片信息不正确。"));
        };
        families.insert(parent_key(&key).to_owned());
        if families.len() > MAX_FILES {
            return Err(hooks.error(413, "备份图片超过 2000 张。"));
        }
        total += size;
        if total > MAX_BACKUP as f64 {
            return Err(hooks.error(413, "备份图片超过 100 MB。"));
        }
        if available.get(&key).and_then(JsValue::as_f64) != Some(size) {
            return Err(hooks.error(409, "备份图片尚未恢复完整，请重新选择备份重试。"));
        }
    }
    Ok(())
}

pub fn image_description(image: &JsValue) -> Option<(String, f64)> {
    let key = property(image, "key")
        .as_string()
        .filter(|key| valid_image_key(key))?;
    let size = property(image, "size")
        .as_f64()
        .filter(|&size| nonnegative_integer(size) && size <= f64::from(MAX_IMAGE))?;
    Some((key, size))
}

pub async fn put_restored_source(
    storage: &R2Bucket,
    key: &str,
    source: &JsString,
    kind: Kind,
    etag: JsValue,
    hooks: &Hooks,
) -> JsResult<JsValue> {
    let draft = kind.parse(source, hooks)?;
    let metadata = match kind {
        Kind::Post => drafts::draft_summary(&draft, storage, &JsValue::UNDEFINED, hooks).await?,
        Kind::Short => {
            drafts::short_summary(&draft, source, storage, &JsValue::UNDEFINED, hooks).await?
        }
    };
    let options = condition(etag)?;
    set(&options, "customMetadata", metadata)?;
    set(
        &options,
        "httpMetadata",
        object(&[("contentType", "text/markdown; charset=utf-8".into())])?,
    )?;
    JsFuture::from(storage.put(key.to_owned(), source.clone().into(), options.into())?).await
}

pub async fn put_text(
    storage: &R2Bucket,
    key: &str,
    text: &JsString,
    etag: JsValue,
) -> JsResult<JsValue> {
    let options = condition(etag)?;
    JsFuture::from(storage.put(key.to_owned(), text.clone().into(), options.into())?).await
}

fn condition(etag: JsValue) -> JsResult<Object> {
    if etag.is_truthy() {
        only_if("etagMatches", etag)
    } else {
        only_if("etagDoesNotMatch", "*".into())
    }
}

pub fn record(value: &JsValue) -> bool {
    value.is_object() && !Array::is_array(value)
}

pub fn value_or_null(value: &JsValue, key: &str, default: JsValue) -> JsValue {
    let value = property(value, key);
    if value.is_truthy() { value } else { default }
}

async fn restore_image(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
) -> JsResult<Response> {
    let Some(key) = url
        .search_params()
        .get("key")
        .filter(|key| valid_image_key(key))
    else {
        return Err(hooks.error(400, "图片路径不正确。"));
    };
    let bytes = limited_body(request, MAX_IMAGE, || hooks.error(413, "上传内容太大。")).await?;
    let (body, mime, ext) = if valid_site_icon_key(&key) {
        let binding: &JsValue = hooks.as_ref();
        let icon = crate::icon::inspect(bytes, binding.unchecked_ref()).await?;
        if property(&icon, "key") != key {
            return Err(hooks.error(400, "备份图标与其内容地址不一致。"));
        }
        (
            property(&icon, "bytes").unchecked_into::<Uint8Array>(),
            attribute(&icon, "type"),
            attribute(&icon, "ext"),
        )
    } else {
        let Some(kind) = image_type(&bytes) else {
            return Err(hooks.error(400, "请上传 JPEG、PNG、GIF、WebP 或 AVIF 图片。"));
        };
        (bytes, kind.mime.to_owned(), kind.ext.to_owned())
    };
    if key.starts_with("uploads/sha256/")
        && parent_key(&key) == key
        && key != format!("uploads/sha256/{}.{}", sha256_hex(&body).await?, ext)
    {
        return Err(hooks.error(400, "备份图片内容与摘要地址不一致。"));
    }
    let conflict = || hooks.error(409, "已有同名的不同图片，恢复不会覆盖它。");
    let existing = get(storage, &key).await?;
    if existing.is_truthy() {
        if !same_image(&existing, &body).await? {
            return Err(conflict());
        }
        return json(200, &[("ok", true.into())]);
    }
    let options = only_if("etagDoesNotMatch", "*".into())?;
    let metadata = Object::new();
    dimensions(&metadata, image_info(&body))?;
    set(&options, "customMetadata", metadata)?;
    set(
        &options,
        "httpMetadata",
        object(&[
            ("contentType", mime.into()),
            ("cacheControl", "public, max-age=31536000, immutable".into()),
        ])?,
    )?;
    let stored =
        JsFuture::from(storage.put(key.clone(), body.clone().into(), options.into())?).await?;
    if !stored.is_truthy() {
        let old = get(storage, &key).await?;
        if !old.is_truthy() || !same_image(&old, &body).await? {
            return Err(conflict());
        }
    }
    json(200, &[("ok", true.into())])
}

async fn same_image(object: &JsValue, content: &Uint8Array) -> JsResult<bool> {
    if property(object, "size").as_f64() != Some(f64::from(content.length())) {
        return Ok(false);
    }
    let object: &R2ObjectBody = object.unchecked_ref();
    let bytes = Uint8Array::new(&JsFuture::from(object.array_buffer()?).await?);
    futures_util::try_join!(sha256_hex(content), sha256_hex(&bytes))
        .map(|(left, right)| left == right)
}
