use worker::js_sys::{Array, Date, Function, JsString, Object, Promise, RegExp};
use worker::wasm_bindgen::{self, JsCast, JsValue, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Request, Response, Url};
use worker::worker_sys::R2Bucket;

use crate::html_rewriter::JsResult;
use crate::page_rendering::valid_slug;
use crate::runtime::{
    body_text, digest_text, get, json, object, only_if, own_property, property, read_json, set,
};

const DRAFT_DATE: &str = "2000-01-01";
const SHORT_DATE: &str = "2000-01-01 00:00";

#[wasm_bindgen]
extern "C" {
    pub type Hooks;

    #[wasm_bindgen(method, catch, js_name = jsonInput)]
    pub fn json_input(this: &Hooks, request: &Request, max: u32) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = managedImageKeys)]
    pub fn managed_images(this: &Hooks, source: &JsString) -> JsResult<Array>;

    #[wasm_bindgen(method, catch, js_name = imageReferenceMetadata)]
    pub fn ref_metadata(
        this: &Hooks,
        source: &JsString,
        storage: &R2Bucket,
        previous: &JsValue,
    ) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = parseSource)]
    pub fn parse_post(this: &Hooks, source: &JsString) -> JsResult<JsValue>;

    #[wasm_bindgen(method, catch, js_name = parseShortSource)]
    pub fn parse_short(this: &Hooks, source: &JsString) -> JsResult<JsValue>;

    #[wasm_bindgen(method, catch, js_name = validateDraft)]
    fn validate_post(this: &Hooks, draft: &JsValue) -> JsResult<JsValue>;

    #[wasm_bindgen(method, catch, js_name = validateShortDraft)]
    fn validate_short(this: &Hooks, draft: &JsValue) -> JsResult<JsValue>;

    #[wasm_bindgen(method, catch, js_name = serializeDraft)]
    pub fn serialize_post(this: &Hooks, draft: &JsValue) -> JsResult<JsString>;

    #[wasm_bindgen(method, catch, js_name = serializeShortDraft)]
    pub fn serialize_short(this: &Hooks, draft: &JsValue) -> JsResult<JsString>;

    #[wasm_bindgen(method, catch, js_name = ensureManagedImages)]
    pub fn ensure_images(
        this: &Hooks,
        storage: &R2Bucket,
        source: &JsString,
        origin: &str,
    ) -> JsResult<Promise>;

    #[wasm_bindgen(method, getter, js_name = referenceVersion)]
    pub fn ref_version(this: &Hooks) -> JsValue;

    #[wasm_bindgen(method, getter, js_name = templateVersion)]
    pub fn template_version(this: &Hooks) -> JsValue;

    #[wasm_bindgen(method, getter, js_name = generationVersion)]
    pub fn generation_version(this: &Hooks) -> JsValue;

    #[wasm_bindgen(method, getter, js_name = responseVersion)]
    pub fn response_version(this: &Hooks) -> JsValue;

    #[wasm_bindgen(method, getter, js_name = setupToken)]
    pub fn setup_token(this: &Hooks) -> JsString;

    #[wasm_bindgen(method, catch, js_name = validateSite)]
    pub fn validate_site(this: &Hooks, value: &JsValue) -> JsResult<JsValue>;

    #[wasm_bindgen(method, catch, js_name = ensureHomeIllustration)]
    pub fn ensure_illustration(
        this: &Hooks,
        storage: &R2Bucket,
        site: &JsValue,
    ) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = ensureSiteIcon)]
    pub fn ensure_icon(this: &Hooks, storage: &R2Bucket, site: &JsValue) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = withContentMutation)]
    pub fn with_mutation(this: &Hooks, storage: &R2Bucket, work: &Function) -> JsResult<Promise>;

    #[wasm_bindgen(method, js_name = errorStatus)]
    pub fn error_status(this: &Hooks, error: &JsValue) -> JsValue;

    #[wasm_bindgen(method)]
    pub fn error(this: &Hooks, status: u16, message: &str) -> JsValue;
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Post,
    Short,
}

impl Kind {
    pub fn storage_prefix(self) -> &'static str {
        match self {
            Self::Post => "drafts/",
            Self::Short => "shorts/",
        }
    }

    fn release_field(self) -> &'static str {
        match self {
            Self::Post => "markdown_posts",
            Self::Short => "markdown_shorts",
        }
    }

    fn not_found(self) -> &'static str {
        match self {
            Self::Post => "文章不存在。",
            Self::Short => "短记不存在。",
        }
    }

    fn modified(self) -> &'static str {
        match self {
            Self::Post => "文章已修改，请重新打开。",
            Self::Short => "短记已修改，请重新打开。",
        }
    }

    fn parse(self, source: &JsString, hooks: &Hooks) -> JsResult<JsValue> {
        match self {
            Self::Post => hooks.parse_post(source),
            Self::Short => hooks.parse_short(source),
        }
    }

    fn serialize(self, draft: &JsValue, hooks: &Hooks) -> JsResult<JsString> {
        match self {
            Self::Post => hooks.serialize_post(draft),
            Self::Short => hooks.serialize_short(draft),
        }
    }
}

pub async fn item(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
    kind: Kind,
    slug: &str,
) -> JsResult<Response> {
    if !valid_slug(slug) {
        return Err(hooks.error(
            400,
            "文章地址只能使用英文字母、数字、短横线和下划线（最多 100 个字符）。",
        ));
    }
    let key = format!("{}{slug}.md", kind.storage_prefix());
    match request.method().as_str() {
        "GET" => read_item(storage, hooks, kind, &key, slug).await,
        "PUT" => save_item(request, url, storage, hooks, kind, &key, slug).await,
        "DELETE" => delete_item(request, storage, hooks, kind, &key, slug).await,
        _ => Err(hooks.error(404, "接口不存在。")),
    }
}

async fn read_item(
    storage: &R2Bucket,
    hooks: &Hooks,
    kind: Kind,
    key: &str,
    slug: &str,
) -> JsResult<Response> {
    let stored = get(storage, key).await?;
    let (source, etag) = if stored.is_truthy() && !deleted(&stored) {
        (body_text(&stored).await?, property(&stored, "etag"))
    } else {
        let release =
            crate::publishing::current_release(storage, hooks, &JsValue::UNDEFINED).await?;
        let source = own_property(&property(&release, kind.release_field()), slug);
        if !source.is_truthy() {
            return Err(hooks.error(404, kind.not_found()));
        }
        (source.unchecked_into(), JsValue::NULL)
    };
    json(
        200,
        &[
            ("draft", kind.parse(&source, hooks)?),
            ("source", source.into()),
            ("etag", etag),
        ],
    )
}

async fn save_item(
    request: &Request,
    url: &Url,
    storage: &R2Bucket,
    hooks: &Hooks,
    kind: Kind,
    key: &str,
    slug: &str,
) -> JsResult<Response> {
    if kind == Kind::Post {
        crate::post_addresses::assert_writable(storage, slug, hooks).await?;
    }
    let input = JsFuture::from(hooks.json_input(
        request,
        if kind == Kind::Post {
            2_100_000
        } else {
            1_000_000
        },
    )?)
    .await?;
    let explicit_source = property(&input, "source");
    let (draft, source) = match kind {
        Kind::Post if explicit_source.is_string() => {
            let source: JsString = explicit_source.unchecked_into();
            (hooks.parse_post(&source)?, source)
        }
        Kind::Post => {
            let draft = hooks.validate_post(&property(&input, "draft"))?;
            set(&property(&draft, "front_matter"), "draft", true)?;
            let source = hooks.serialize_post(&draft)?;
            (draft, source)
        }
        Kind::Short => {
            let draft = hooks.validate_short(&input)?;
            let front = property(&draft, "front_matter");
            if property(&front, "slug") != slug {
                return Err(hooks.error(400, "短记地址与请求地址不一致。"));
            }
            set(&front, "draft", true)?;
            let source = hooks.serialize_short(&draft)?;
            (draft, source)
        }
    };
    if kind == Kind::Post && property(&property(&draft, "front_matter"), "slug") != slug {
        return Err(hooks.error(400, "文章地址与保存地址不一致。"));
    }
    JsFuture::from(hooks.ensure_images(storage, &source, &url.origin())?).await?;
    let existing = JsFuture::from(storage.head(key.to_owned())?).await?;
    let active = existing.is_truthy() && !deleted(&existing);
    let etag = property(&existing, "etag");
    let expected = property(&input, "etag");
    if active && expected != etag {
        return Err(hooks.error(
            409,
            match kind {
                Kind::Post => "这篇文章在另一个窗口中发生了修改。请导出当前内容，再重新打开文章。",
                Kind::Short => "这条短记在另一个窗口中发生了修改，请重新打开。",
            },
        ));
    }
    if !active && expected.is_truthy() {
        return Err(hooks.error(
            409,
            match kind {
                Kind::Post => "文章已删除或改址，请重新打开。",
                Kind::Short => "短记已删除，请重新打开。",
            },
        ));
    }
    let previous = property(&existing, "customMetadata");
    if kind == Kind::Post {
        let summary = draft_summary(&draft, storage, &previous, hooks).await?;
        let pointer = read_json(storage, "state/published.json").await?;
        let index = if pointer.is_truthy() {
            crate::post_index::read(
                storage,
                &crate::runtime::attribute(&pointer, "id"),
                |status, text| hooks.error(status, text),
            )
            .await?
        } else {
            JsValue::NULL
        };
        let published = own_property(&property(&index, "posts"), slug);
        let changed = !published.is_truthy()
            || property(&published, "digest") != property(&summary, "digest");
        if active && unchanged(&previous, &source, hooks).await? {
            let uploaded: Date = property(&existing, "uploaded").unchecked_into();
            return json(
                200,
                &[
                    ("draft", draft),
                    ("source", source.into()),
                    ("etag", etag),
                    ("saved_at", uploaded.to_iso_string().into()),
                    ("created", false.into()),
                    ("unchanged", true.into()),
                    ("changed", changed.into()),
                ],
            );
        }
        let metadata = summary;
        set(&metadata, "source_digest", source_digest(&source).await?)?;
        let saved = save_source(storage, key, &existing, &source, metadata).await?;
        if !saved.is_truthy() {
            return Err(hooks.error(409, "这篇文章刚刚发生了修改，请重新打开。"));
        }
        return json(
            200,
            &[
                ("draft", draft),
                ("source", source.into()),
                ("etag", property(&saved, "etag")),
                ("saved_at", Date::new_0().to_iso_string().into()),
                ("created", (!active).into()),
                ("changed", changed.into()),
            ],
        );
    }
    if active && unchanged(&previous, &source, hooks).await? {
        return json(
            200,
            &[
                ("ok", true.into()),
                ("etag", etag),
                ("unchanged", true.into()),
            ],
        );
    }
    let summary = short_summary(&draft, &source, storage, &previous, hooks).await?;
    let saved = save_source(storage, key, &existing, &source, summary).await?;
    if !saved.is_truthy() {
        return Err(hooks.error(409, "这条短记刚刚发生了修改，请重新打开。"));
    }
    json(
        200,
        &[("ok", true.into()), ("etag", property(&saved, "etag"))],
    )
}

async fn save_source(
    storage: &R2Bucket,
    key: &str,
    existing: &JsValue,
    source: &JsString,
    metadata: Object,
) -> JsResult<JsValue> {
    let options = if existing.is_truthy() {
        only_if("etagMatches", property(existing, "etag"))?
    } else {
        only_if("etagDoesNotMatch", "*".into())?
    };
    set(&options, "customMetadata", metadata)?;
    set(
        &options,
        "httpMetadata",
        object(&[("contentType", "text/markdown; charset=utf-8".into())])?,
    )?;
    JsFuture::from(storage.put(key.to_owned(), source.clone().into(), options.into())?).await
}

async fn delete_item(
    request: &Request,
    storage: &R2Bucket,
    hooks: &Hooks,
    kind: Kind,
    key: &str,
    slug: &str,
) -> JsResult<Response> {
    let release = crate::publishing::current_release(storage, hooks, &JsValue::UNDEFINED).await?;
    if own_property(&property(&release, kind.release_field()), slug).is_truthy() {
        return Err(hooks.error(409, "请先取消发布，再删除草稿。"));
    }
    let input = JsFuture::from(hooks.json_input(request, 4096)?).await?;
    let existing = JsFuture::from(storage.head(key.to_owned())?).await?;
    if existing.is_truthy() {
        let etag = property(&existing, "etag");
        if property(&input, "etag") != etag {
            return Err(hooks.error(409, kind.modified()));
        }
        let (front, metadata) = match kind {
            Kind::Post => (
                object(&[
                    ("title", "已删除".into()),
                    ("slug", slug.into()),
                    ("date", DRAFT_DATE.into()),
                    ("description", "".into()),
                    ("draft", true.into()),
                ])?,
                object(&[("title", "已删除".into()), ("deleted", "true".into())])?,
            ),
            Kind::Short => (
                object(&[
                    ("date", SHORT_DATE.into()),
                    ("slug", slug.into()),
                    ("draft", true.into()),
                ])?,
                object(&[("date", SHORT_DATE.into()), ("deleted", "true".into())])?,
            ),
        };
        // Retain the ETag-guarded tombstone so a stale writer cannot restore the item.
        let draft = object(&[("front_matter", front.into()), ("body_markdown", "".into())])?;
        let source = kind.serialize(&draft, hooks)?;
        let options = only_if("etagMatches", etag)?;
        set(&options, "customMetadata", metadata)?;
        let saved =
            JsFuture::from(storage.put(key.to_owned(), source.into(), options.into())?).await?;
        if !saved.is_truthy() {
            return Err(hooks.error(409, kind.modified()));
        }
    }
    json(200, &[("ok", true.into())])
}

pub fn deleted(object: &JsValue) -> bool {
    property(&property(object, "customMetadata"), "deleted").is_truthy()
}

async fn unchanged(metadata: &JsValue, source: &JsString, hooks: &Hooks) -> JsResult<bool> {
    Ok(
        property(metadata, "image_refs_version") == hooks.ref_version()
            && property(metadata, "source_digest") == source_digest(source).await?,
    )
}

pub async fn source_digest(source: &JsString) -> JsResult<String> {
    let text = JsString::from("source-v1:").concat(source);
    digest_text(&text).await
}

pub async fn draft_summary(
    draft: &JsValue,
    storage: &R2Bucket,
    previous: &JsValue,
    hooks: &Hooks,
) -> JsResult<Object> {
    let front = property(draft, "front_matter");
    let title = property(&front, "title");
    let description = property(&front, "description");
    let summary = object(&[
        (
            "title",
            title.unchecked_ref::<JsString>().slice(0, 120).into(),
        ),
        ("date", property(&front, "date")),
        (
            "description",
            description.unchecked_ref::<JsString>().slice(0, 240).into(),
        ),
    ])?;
    let body = property(draft, "body_markdown");
    let references = JsFuture::from(hooks.ref_metadata(
        body.unchecked_ref(),
        storage,
        &property(previous, "image_refs_hash"),
    )?)
    .await?;
    Object::assign(&summary, references.unchecked_ref());
    set(
        &summary,
        "digest",
        crate::post_index::editorial_digest(draft).await?,
    )?;
    Ok(summary)
}

async fn short_summary(
    draft: &JsValue,
    source: &JsString,
    storage: &R2Bucket,
    previous: &JsValue,
    hooks: &Hooks,
) -> JsResult<Object> {
    let body = property(draft, "body_markdown");
    let summary = object(&[
        ("source_digest", source_digest(source).await?.into()),
        ("date", property(&property(draft, "front_matter"), "date")),
        (
            "snippet",
            body.unchecked_ref::<JsString>()
                .slice(0, 300)
                .replace_by_pattern(&RegExp::new(r"\r?\n", "g"), " ")
                .into(),
        ),
    ])?;
    let references = JsFuture::from(hooks.ref_metadata(
        source,
        storage,
        &property(previous, "image_refs_hash"),
    )?)
    .await?;
    Object::assign(&summary, references.unchecked_ref());
    Ok(summary)
}
