use std::collections::HashMap;

use worker::js_sys::{Array, Date, JSON, JsString, Object, TypeError};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Request, Response, Url};
use worker::worker_sys::R2Bucket;

use crate::html_rewriter::JsResult;
use crate::http::{error, json_input, status};
use crate::image::{WIDTHS, add_presentation, parent_key, variant_key};
use crate::media::{supported_type, valid_image_key};
use crate::runtime::{
    attribute, body_text, encode_utf8, get, js_number, js_string, json, list, object, only_if,
    parse_object, property, read_json, set,
};
use crate::{image_references, reference_index, site_assets};

const MAX_SOURCES: usize = 2000;
const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_UNINDEXED: usize = 30;

pub async fn library(request: &Request, url: &Url, storage: &R2Bucket) -> JsResult<Response> {
    match request.method().as_str() {
        "GET" => list_images(url, storage).await,
        "DELETE" => delete_image(request, storage).await,
        _ => Err(error(405, "请求方式不正确。")),
    }
}

fn cursor(value: Option<String>) -> JsResult<Option<(f64, String)>> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let invalid = || error(400, "分页位置不正确。");
    let parsed = JSON::parse(&value).map_err(|_| invalid())?;
    if !Array::is_array(&parsed) {
        return Err(invalid());
    }
    let parts: Array = parsed.unchecked_into();
    let time = parts.get(0).as_f64().filter(|value| value.is_finite());
    let key = parts.get(1).as_string().filter(|key| valid_image_key(key));
    match (parts.length(), time, key) {
        (2, Some(time), Some(key)) => Ok(Some((time, key))),
        _ => Err(invalid()),
    }
}

async fn list_images(url: &Url, storage: &R2Bucket) -> JsResult<Response> {
    let params = url.search_params();
    let after = cursor(params.get("cursor"))?;
    let mut catalog = Vec::new();
    let mut current = JsValue::UNDEFINED;
    loop {
        let page = list(
            storage,
            "uploads/",
            current,
            1000,
            &["httpMetadata", "customMetadata"],
        )
        .await?;
        catalog.extend(page.objects.iter());
        if catalog.len() > MAX_SOURCES * 4
            || catalog
                .iter()
                .filter(|item| {
                    let key = attribute(item, "key");
                    parent_key(&key) == key
                })
                .count()
                > MAX_SOURCES
        {
            return Err(error(
                413,
                "当前图片超过 2000 张，暂时无法在网页图片库完整管理。",
            ));
        }
        current = page.cursor;
        if !current.is_truthy() {
            break;
        }
    }
    let mut families = HashMap::<String, Vec<JsValue>>::new();
    let mut images = Vec::new();
    for item in catalog {
        let key = attribute(&item, "key");
        let parent = parent_key(&key);
        if parent != key {
            families.entry(parent.to_owned()).or_default().push(item);
            continue;
        }
        let mime = attribute(&property(&item, "httpMetadata"), "contentType");
        if !valid_image_key(&key) || !supported_type(&mime) {
            continue;
        }
        let uploaded: Date = property(&item, "uploaded").unchecked_into();
        let time = uploaded.get_time();
        if after
            .as_ref()
            .is_none_or(|(last, last_key)| time < *last || (time == *last && key > *last_key))
        {
            images.push((item, key, mime, uploaded, time));
        }
    }
    images.sort_by(|a, b| b.4.total_cmp(&a.4).then_with(|| a.1.cmp(&b.1)));
    let complete = params.get("catalog").as_deref() == Some("1");
    let more = !complete && images.len() > 24;
    if !complete {
        images.truncate(24);
    }
    let next = if more {
        let (_, key, _, _, time) = images
            .last()
            .expect("a truncated catalog has a final image");
        let value: Array = [JsValue::from_f64(*time), JsValue::from_str(key)]
            .into_iter()
            .collect();
        JSON::stringify(&value)?.into()
    } else {
        JsValue::NULL
    };
    let mut scan = ReferenceScan::new(images.iter().map(|(_, key, _, _, _)| key.clone()), storage);
    let mut reference_error = String::new();
    if let Err(error) = scan.run().await {
        if status(&error).is_none() {
            return Err(error);
        }
        reference_error = attribute(&error, "message");
        scan.references.clear();
    }
    let result = Array::new();
    for (item, key, mime, uploaded, _) in images {
        let metadata = property(&item, "customMetadata");
        let stored_name = property(&metadata, "name");
        let name = if stored_name.is_truthy() {
            stored_name
        } else {
            key.rsplit('/').next().unwrap_or_default().into()
        };
        let size = property(&item, "size");
        let optimization = attribute(&metadata, "optimization");
        let can_optimize = js_number(&size) >= 80_000.0
            && matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp")
            && optimization != "skipped"
            && (optimization == "processing" || !families.contains_key(&key));
        let response = object(&[
            ("key", key.clone().into()),
            ("name", name),
            ("url", format!("/images/{key}").into()),
            ("size", size),
            ("canOptimize", can_optimize.into()),
            ("optimization", optimization.into()),
        ])?;
        add_presentation(
            &response,
            &item,
            families.get(&key).map(Vec::as_slice).unwrap_or(&[]),
        )?;
        set(&response, "uploaded", uploaded.to_iso_string())?;
        set(&response, "etag", property(&item, "etag"))?;
        set(
            &response,
            "references",
            reference_array(scan.references.get(&key))?,
        )?;
        result.push(&response);
    }
    json(
        200,
        &[
            ("images", result.into()),
            ("reindexRequired", scan.reindex_required.into()),
            ("referencesChecked", reference_error.is_empty().into()),
            ("referenceError", reference_error.into()),
            ("cursor", next),
            ("catalog", complete.into()),
        ],
    )
}

async fn delete_image(request: &Request, storage: &R2Bucket) -> JsResult<Response> {
    let input = json_input(request, 4096).await?;
    let Some(key) = property(&input, "key")
        .as_string()
        .filter(|key| valid_image_key(key))
    else {
        return Err(error(400, "图片路径不正确。"));
    };
    if parent_key(&key) != key {
        return Err(error(400, "请从图片库删除整张图片。"));
    }
    let object = JsFuture::from(storage.head(key.clone())?).await?;
    if !object.is_truthy() {
        return Err(error(404, "图片已经不存在，请刷新图片库。"));
    }
    if property(&input, "etag") != property(&object, "etag") {
        return Err(error(409, "图片已变化，请刷新图片库后重试。"));
    }
    let pending = read_json(storage, "state/pending.json").await?;
    if publication_pending(&pending) {
        return Err(error(
            409,
            "网站正在发布，请等待完成或取消发布后再删除图片。",
        ));
    }
    let mut scan = ReferenceScan::new([key.clone()].into_iter(), storage);
    scan.run().await?;
    let references = reference_array(scan.references.get(&key))?;
    if references.length() != 0 {
        return json(
            409,
            &[
                ("error", "图片仍被文章或网站设置引用，请先处理引用。".into()),
                ("references", references.into()),
            ],
        );
    }
    let mut keys: Vec<JsValue> = WIDTHS
        .into_iter()
        .map(|width| variant_key(&key, width).into())
        .collect();
    if let Some(icons) = site_assets::derivatives(&key) {
        keys.extend(icons.generated().into_iter().map(JsValue::from_str));
    }
    keys.push(key.clone().into());
    JsFuture::from(storage.delete_multiple(keys)?).await?;
    json(200, &[("deleted", true.into()), ("key", key.into())])
}

pub async fn reindex(request: &Request, storage: &R2Bucket) -> JsResult<Response> {
    let input = json_input(request, 4096).await?;
    let prefix = property(&input, "prefix");
    let cursor = property(&input, "cursor");
    let Some(section) = DraftSection::for_prefix(&prefix) else {
        return Err(error(400, "引用索引分页参数不正确。"));
    };
    if !cursor.is_undefined()
        && cursor
            .as_string()
            .is_none_or(|value| value.encode_utf16().count() > 2048)
    {
        return Err(error(400, "引用索引分页参数不正确。"));
    }
    let page = list(storage, section.prefix(), cursor, 8, &["customMetadata"]).await?;
    let version = image_references::VERSION;
    let mut updated = 0;
    for item in page.objects.iter() {
        let meta = property(&item, "customMetadata");
        if property(&meta, "deleted").is_truthy() {
            continue;
        }
        if attribute(&meta, "image_refs_version") == version {
            if !property(&meta, "image_refs").is_undefined() {
                continue;
            }
            if let Some(hash) = valid_hash(&meta) {
                let shard = reference_index::shard_key(&hash);
                let checked = async {
                    let content = reference_index::read_shard(storage, &shard).await?;
                    reference_index::checked(&content, &hash).await
                }
                .await;
                match checked {
                    Ok(_) => continue,
                    Err(error) if status(&error) == Some(503) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        let key = attribute(&item, "key");
        if DraftSection::Posts
            .slug(&key)
            .or_else(|| DraftSection::Shorts.slug(&key))
            .is_none()
            || js_number(&property(&item, "size")) > 2_100_000.0
        {
            return Err(error(
                413,
                "原稿格式或大小超出引用索引更新范围；图片仍受保护。",
            ));
        }
        let draft = get(storage, &key).await?;
        let etag = property(&draft, "etag");
        if !draft.is_truthy() || etag != property(&item, "etag") {
            return Err(error(409, "原稿已变化，请重新更新索引。"));
        }
        let text = body_text(&draft).await?;
        let metadata = Object::new();
        let previous = property(&draft, "customMetadata");
        if previous.is_object() {
            Object::assign(&metadata, previous.unchecked_ref());
        }
        let indexed = reference_index::metadata(&text, storage, &JsValue::UNDEFINED).await?;
        Object::assign(&metadata, indexed.unchecked_ref());
        let options = only_if("etagMatches", etag)?;
        set(&options, "customMetadata", metadata)?;
        set(&options, "httpMetadata", property(&draft, "httpMetadata"))?;
        let saved = JsFuture::from(storage.put(key, text.into(), options.into())?).await?;
        if !saved.is_truthy() {
            return Err(error(409, "原稿已变化，请重新更新索引。"));
        }
        updated += 1;
    }
    let next = if !page.cursor.is_undefined() {
        object(&[("prefix", section.prefix().into()), ("cursor", page.cursor)])?.into()
    } else if section == DraftSection::Posts {
        object(&[("prefix", DraftSection::Shorts.prefix().into())])?.into()
    } else {
        JsValue::NULL
    };
    json(200, &[("updated", updated.into()), ("next", next)])
}

#[derive(Clone, Copy, PartialEq)]
enum DraftSection {
    Posts,
    Shorts,
}

impl DraftSection {
    fn for_prefix(value: &JsValue) -> Option<Self> {
        match value.as_string().as_deref() {
            Some("shorts/") => Some(Self::Shorts),
            Some("drafts/") => Some(Self::Posts),
            None if value.is_undefined() => Some(Self::Posts),
            _ => None,
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Posts => "drafts/",
            Self::Shorts => "shorts/",
        }
    }

    fn slug(self, key: &str) -> Option<&str> {
        let slug = key.strip_prefix(self.prefix())?.strip_suffix(".md")?;
        ((1..=100).contains(&slug.len())
            && slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        .then_some(slug)
    }

    fn unindexed_limit(self) -> usize {
        match self {
            Self::Posts => MAX_UNINDEXED,
            Self::Shorts => 3 * MAX_UNINDEXED,
        }
    }
}

#[derive(Clone, PartialEq)]
struct Reference {
    kind: &'static str,
    title: String,
    slug: Option<String>,
}

impl Reference {
    fn new(kind: &'static str, title: impl Into<String>, slug: Option<String>) -> Self {
        Self {
            kind,
            title: title.into(),
            slug,
        }
    }
}

fn reference_array(references: Option<&Vec<Reference>>) -> JsResult<Array> {
    let result = Array::new();
    for reference in references.into_iter().flatten() {
        let item = object(&[
            ("kind", reference.kind.into()),
            ("title", reference.title.clone().into()),
        ])?;
        if let Some(slug) = &reference.slug {
            set(&item, "slug", slug.clone())?;
        }
        result.push(&item);
    }
    Ok(result)
}

struct ReferenceScan<'a> {
    storage: &'a R2Bucket,
    references: HashMap<String, Vec<Reference>>,
    shards: HashMap<String, JsValue>,
    text_bytes: usize,
    shard_bytes: usize,
    sources: usize,
    scanned: usize,
    unindexed: usize,
    reindex_required: bool,
}

impl<'a> ReferenceScan<'a> {
    fn new(keys: impl Iterator<Item = String>, storage: &'a R2Bucket) -> Self {
        Self {
            storage,
            references: keys.map(|key| (key, Vec::new())).collect(),
            shards: HashMap::new(),
            text_bytes: 0,
            shard_bytes: 0,
            sources: 0,
            scanned: 0,
            unindexed: 0,
            reindex_required: false,
        }
    }

    async fn run(&mut self) -> JsResult<()> {
        if self.references.is_empty() {
            return Ok(());
        }
        let pointer = read_json(self.storage, "state/published.json").await?;
        if pointer.is_truthy() {
            self.release(&attribute(&pointer, "id"), "published")
                .await?;
        }
        let pending = read_json(self.storage, "state/pending.json").await?;
        if publication_pending(&pending)
            && property(&pending, "release_id") != property(&pointer, "id")
        {
            self.release(&attribute(&pending, "release_id"), "pending")
                .await?;
        }
        let task = crate::backup_jobs::active(self.storage).await?;
        if task.is_truthy() {
            let title = if attribute(&task, "mode") == "restore" {
                "正在恢复的备份"
            } else {
                "正在下载的备份"
            };
            let reference = Reference::new("backup", title, None);
            let invalid = || JsValue::from(TypeError::new("Invalid backup image records"));
            let images = property(&task, "images");
            if !Array::is_array(&images) {
                return Err(invalid());
            }
            let images: Array = images.unchecked_into();
            for image in images.iter() {
                let key = property(&image, "key").as_string().ok_or_else(invalid)?;
                self.add(&key, &reference);
            }
        }
        let settings = get(self.storage, "draft-site.json").await?;
        if settings.is_truthy() {
            if js_number(&property(&settings, "size")) > 500_000.0 {
                return Err(error(413, "网站设置过大，无法安全检查图片引用。"));
            }
            self.source(
                &body_text(&settings).await?,
                Reference::new("settings", "网站设置（待发布）", None),
            )?;
        }
        self.drafts(DraftSection::Posts).await?;
        self.drafts(DraftSection::Shorts).await
    }

    async fn release(&mut self, id: &str, kind: &'static str) -> JsResult<()> {
        let index = crate::post_index::read(self.storage, id).await?;
        let images = property(&index, "images");
        let label = if kind == "published" {
            "网站设置（已发布）"
        } else {
            "网站设置（待发布）"
        };
        if attribute(&images, "version") == image_references::VERSION {
            for entry in array(&images, "entries").iter() {
                let settings = property(&entry, "settings").is_truthy();
                let title = attribute(&entry, "title");
                let slug = property(&entry, "slug")
                    .as_string()
                    .filter(|slug| !slug.is_empty());
                let reference = Reference::new(
                    if settings { "settings" } else { kind },
                    if settings && title == "网站设置" {
                        label.to_owned()
                    } else {
                        title
                    },
                    slug,
                );
                self.add_many(&array(&entry, "keys"), &reference);
            }
            return Ok(());
        }
        let release = get(self.storage, &format!("releases/{id}.json")).await?;
        if !release.is_truthy() || js_number(&property(&release, "size")) > 16_000_000.0 {
            return Err(error(
                503,
                "发布版本无法完整读取，暂时不能安全检查图片引用。",
            ));
        }
        let data = parse_object(&release).await?;
        for field in ["markdown_posts", "markdown_shorts"] {
            let contents = property(&data, field);
            if !contents.is_truthy() && field == "markdown_shorts" {
                continue;
            }
            for entry in Object::entries(contents.unchecked_ref()).iter() {
                let entry: Array = entry.unchecked_into();
                let slug = entry.get(0).as_string().unwrap_or_default();
                let text = entry.get(1);
                self.source(
                    text.unchecked_ref(),
                    Reference::new(kind, slug.clone(), Some(slug)),
                )?;
            }
        }
        self.source(
            &JSON::stringify(&property(&data, "site"))?,
            Reference::new("settings", label, None),
        )?;
        let about = property(&data, "about_markdown");
        if about.is_truthy() {
            self.source(
                about.unchecked_ref(),
                Reference::new("settings", "关于页面", None),
            )?;
        }
        Ok(())
    }

    async fn drafts(&mut self, section: DraftSection) -> JsResult<()> {
        let mut cursor = JsValue::UNDEFINED;
        loop {
            let page = list(
                self.storage,
                section.prefix(),
                cursor,
                1000,
                &["customMetadata"],
            )
            .await?;
            for item in page.objects.iter() {
                self.scanned += 1;
                if self.scanned > 10000 {
                    return Err(error(413, "原稿目录超过安全扫描上限；图片仍受保护。"));
                }
                let meta = property(&item, "customMetadata");
                if property(&meta, "deleted").is_truthy() {
                    continue;
                }
                self.sources += 1;
                if self.sources > MAX_SOURCES {
                    return Err(error(
                        413,
                        "原稿超过 2000 篇，无法完整检查引用；图片不会被删除。",
                    ));
                }
                let key = attribute(&item, "key");
                let slug = section.slug(&key).ok_or_else(|| {
                    error(
                        503,
                        match section {
                            DraftSection::Posts => {
                                "原稿目录包含无法识别的对象，无法安全检查图片引用。"
                            }
                            DraftSection::Shorts => {
                                "短记目录包含无法识别的对象，无法安全检查图片引用。"
                            }
                        },
                    )
                })?;
                let title = property(&meta, "title")
                    .as_string()
                    .filter(|title| !title.is_empty());
                let reference = Reference::new(
                    "draft",
                    if section == DraftSection::Posts {
                        title.unwrap_or_else(|| slug.to_owned())
                    } else {
                        slug.to_owned()
                    },
                    Some(slug.to_owned()),
                );
                self.draft(&item, &key, &meta, reference, section).await?;
            }
            cursor = page.cursor;
            if !cursor.is_truthy() {
                return Ok(());
            }
        }
    }

    async fn draft(
        &mut self,
        item: &JsValue,
        key: &str,
        meta: &JsValue,
        reference: Reference,
        section: DraftSection,
    ) -> JsResult<()> {
        if attribute(meta, "image_refs_version") == image_references::VERSION {
            let indexed = property(meta, "image_refs");
            if !indexed.is_undefined() {
                let invalid = || error(503, "图片引用索引无效，请重新保存原稿。");
                let source = js_string(&indexed).as_string().unwrap_or_default();
                let parsed = JSON::parse(&source).map_err(|_| invalid())?;
                if !Array::is_array(&parsed) {
                    return Err(invalid());
                }
                let keys: Array = parsed.unchecked_into();
                if !keys
                    .iter()
                    .all(|key| key.as_string().is_some_and(|key| valid_image_key(&key)))
                {
                    return Err(invalid());
                }
                self.add_many(&keys, &reference);
                return Ok(());
            }
            if let Some(hash) = valid_hash(meta) {
                match self.checked_shard(&hash).await {
                    Ok(keys) => self.add_many(&keys, &reference),
                    Err(error) => {
                        self.reindex_required = true;
                        return Err(error);
                    }
                }
                return Ok(());
            }
        }
        self.reindex_required = true;
        self.unindexed += 1;
        if self.unindexed > section.unindexed_limit() {
            return Err(error(
                413,
                "旧原稿较多，暂时无法完成引用检查；为避免误删，图片会保留。",
            ));
        }
        if self.text_bytes as f64 + js_number(&property(item, "size")) > MAX_TEXT_BYTES as f64 {
            return Err(error(413, "原稿超过图片管理检查上限，图片不会被删除。"));
        }
        let body = get(self.storage, key).await?;
        if !body.is_truthy() {
            return Err(error(409, "原稿正在变化，请刷新图片库后重试。"));
        }
        self.source(&body_text(&body).await?, reference)
    }

    async fn checked_shard(&mut self, hash: &str) -> JsResult<Array> {
        let key = reference_index::shard_key(hash);
        if !self.shards.contains_key(&key) {
            let shard = reference_index::read_shard(self.storage, &key).await?;
            self.shard_bytes += text_bytes(&JSON::stringify(&shard)?);
            if self.shard_bytes > MAX_TEXT_BYTES {
                return Err(error(413, "引用索引超过安全检查上限；图片仍受保护。"));
            }
            self.shards.insert(key.clone(), shard);
        }
        reference_index::checked(&self.shards[&key], hash).await
    }

    fn source(&mut self, text: &JsString, reference: Reference) -> JsResult<()> {
        self.text_bytes += text_bytes(text);
        if self.text_bytes > MAX_TEXT_BYTES {
            return Err(error(
                413,
                "引用内容超过图片管理检查上限，无法安全判断图片是否可删除。",
            ));
        }
        for key in image_references::managed(text)? {
            self.add(&key, &reference);
        }
        Ok(())
    }

    fn add_many(&mut self, keys: &Array, reference: &Reference) {
        for key in keys.iter().filter_map(|key| key.as_string()) {
            self.add(&key, reference);
        }
    }

    fn add(&mut self, key: &str, reference: &Reference) {
        if let Some(references) = self.references.get_mut(parent_key(key))
            && !references.contains(reference)
        {
            references.push(reference.clone());
        }
    }
}

fn valid_hash(meta: &JsValue) -> Option<String> {
    property(meta, "image_refs_hash")
        .as_string()
        .filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn publication_pending(value: &JsValue) -> bool {
    matches!(
        attribute(value, "status").as_str(),
        "queued" | "building" | "built"
    )
}

fn array(value: &JsValue, field: &str) -> Array {
    property(value, field).unchecked_into()
}

fn text_bytes(text: &JsString) -> usize {
    encode_utf8(text).length() as usize
}
