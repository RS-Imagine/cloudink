use std::rc::Rc;

use worker::js_sys::{Array, Function, JsString, Object, Promise, Uint8Array};
use worker::wasm_bindgen::{self, JsCast, JsValue, closure::Closure, prelude::wasm_bindgen};
use worker::wasm_bindgen_futures::{JsFuture, future_to_promise};
use worker::web_sys::{Blob, File, FormData, Headers, ReadableStream, Request, Response, Url};
use worker::worker_sys::{R2Bucket, R2Object, R2ObjectBody};

use crate::html_rewriter::JsResult;
use crate::image_header::{ImageInfo, ImageType, image_info, image_type};
use crate::media::{MAX_IMAGE, valid_image_key};
use crate::public_cache::{response_init, stream_response};
use crate::runtime::{
    attribute, cancel_body, get, js_number, js_string, json, json_object, limited_body, object,
    only_if, property, set, sha256_hex,
};

pub const WIDTHS: [u32; 3] = [640, 1280, 1920];
const VARIANTS_BODY_LIMIT: u32 = 6_000_000 + 64 * 1024;
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

#[wasm_bindgen]
extern "C" {
    pub type Hooks;

    #[wasm_bindgen(method, catch, js_name = withContentMutation)]
    fn with_mutation(this: &Hooks, storage: &R2Bucket, work: &Function) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = jsonInput)]
    pub fn json_input(this: &Hooks, request: &Request, limit: u32) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = activeBackup)]
    pub fn active_backup(this: &Hooks, storage: &R2Bucket) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = readPostIndex)]
    pub fn read_post_index(this: &Hooks, storage: &R2Bucket, id: &str) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = managedImageKeys)]
    pub fn managed_images(this: &Hooks, source: &JsString) -> JsResult<Array>;

    #[wasm_bindgen(method, catch, js_name = referenceShardKey)]
    pub fn shard_key(this: &Hooks, hash: &str) -> JsResult<String>;

    #[wasm_bindgen(method, catch, js_name = readReferenceShard)]
    pub fn read_shard(this: &Hooks, storage: &R2Bucket, key: &str) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = checkedReferenceKeys)]
    pub fn checked_keys(this: &Hooks, shard: &JsValue, hash: &str) -> JsResult<Promise>;

    #[wasm_bindgen(method, catch, js_name = imageReferenceMetadata)]
    pub fn ref_metadata(this: &Hooks, source: &JsString, storage: &R2Bucket) -> JsResult<Promise>;

    #[wasm_bindgen(method, getter, js_name = referenceVersion)]
    pub fn ref_version(this: &Hooks) -> String;

    #[wasm_bindgen(method, catch, js_name = siteIconDerivedKeys)]
    pub fn icon_derivatives(this: &Hooks, key: &str) -> JsResult<JsValue>;

    #[wasm_bindgen(method, js_name = errorStatus)]
    pub fn error_status(this: &Hooks, error: &JsValue) -> JsValue;

    #[wasm_bindgen(method)]
    pub fn error(this: &Hooks, status: u16, message: &str) -> JsValue;
}

pub fn parent_key(key: &str) -> &str {
    let parent = [".w640.webp", ".w1280.webp", ".w1920.webp"]
        .into_iter()
        .find_map(|suffix| key.strip_suffix(suffix));
    parent
        .filter(|parent| valid_image_key(parent))
        .unwrap_or(key)
}

pub async fn handle(request: &Request, storage: &R2Bucket, hooks: &Hooks) -> JsResult<Response> {
    let url = Url::new(&request.url())?;
    match (url.pathname().as_str(), request.method().as_str()) {
        ("/api/upload", "POST") => upload(request, storage, hooks).await,
        ("/api/images/optimize", "POST") => optimize(request, storage, hooks).await,
        ("/api/images/reindex", "POST") => {
            crate::image_library::reindex(request, storage, hooks).await
        }
        ("/api/images", _) => crate::image_library::library(request, &url, storage, hooks).await,
        ("/api/image", "GET") => read_image(&url, storage, hooks).await,
        _ => Err(hooks.error(404, "接口不存在。")),
    }
}

async fn read_image(url: &Url, storage: &R2Bucket, hooks: &Hooks) -> JsResult<Response> {
    let Some(key) = url.search_params().get("key").filter(|key| {
        key.len() <= 1024 && !key.contains("..") && !key.starts_with('/') && valid_image_key(key)
    }) else {
        return Err(hooks.error(400, "图片地址不正确。"));
    };
    let image = get(storage, &key).await?;
    if !image.is_truthy() {
        return Err(hooks.error(404, "图片不存在。"));
    }
    let headers = Headers::new()?;
    headers.set("Cache-Control", "private, max-age=300")?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    let raw: &R2Object = image.unchecked_ref();
    raw.write_http_metadata(headers.clone())?;
    headers.set("ETag", &raw.http_etag()?)?;
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'")?;
    let body: ReadableStream = property(&image, "body").unchecked_into();
    stream_response(Some(&body), 200, &headers)
}

async fn read_form(request: &Request, limit: u32, hooks: &Hooks) -> JsResult<FormData> {
    let bytes = limited_body(request, limit, || hooks.error(413, "上传内容太大。")).await?;
    let headers = Headers::new()?;
    headers.set(
        "Content-Type",
        &request.headers().get("Content-Type")?.unwrap_or_default(),
    )?;
    let response =
        Response::new_with_opt_js_u8_array_and_init(Some(&bytes), &response_init(200, &headers))?;
    Ok(JsFuture::from(response.form_data()?)
        .await?
        .unchecked_into())
}

struct Variant {
    key: String,
    bytes: Uint8Array,
    info: ImageInfo,
}

async fn prepare_variants(
    form: &FormData,
    info: Option<ImageInfo>,
    source_size: f64,
    key: &str,
    hooks: &Hooks,
) -> JsResult<Vec<Variant>> {
    let mut prepared = Vec::new();
    for width in WIDTHS {
        let part = form.get(&format!("w{width}"));
        if !part.is_truthy() {
            continue;
        }
        if part.is_string() {
            return Err(hooks.error(400, "压缩图片大小不正确。"));
        }
        let blob: Blob = part.unchecked_into();
        if blob.size() > 2_000_000.0 || blob.size() >= source_size {
            return Err(hooks.error(400, "压缩图片大小不正确。"));
        }
        let bytes = Uint8Array::new(&JsFuture::from(blob.array_buffer()).await?);
        let format = sniff(&bytes, hooks)?;
        let variant = image_info(&bytes);
        if let (Some(variant), Some(source)) = (variant, info)
            && format.mime == "image/webp"
            && !variant.animated
            && variant.width == width
            && !source.animated
            && width <= source.width
            && (f64::from(variant.height)
                - f64::from(source.height) * f64::from(width) / f64::from(source.width))
            .abs()
                <= 1.0
        {
            prepared.push(Variant {
                key: variant_key(key, width),
                bytes,
                info: variant,
            });
        } else {
            return Err(hooks.error(400, "压缩图片的格式或尺寸不正确。"));
        }
    }
    Ok(prepared)
}

fn sniff(bytes: &Uint8Array, hooks: &Hooks) -> JsResult<ImageType> {
    image_type(bytes).ok_or_else(|| hooks.error(400, "请上传 JPEG、PNG、GIF、WebP 或 AVIF 图片。"))
}

pub fn variant_key(key: &str, width: u32) -> String {
    format!("{key}.w{width}.webp")
}

async fn heads(storage: &R2Bucket, key: &str) -> JsResult<Vec<JsValue>> {
    let results = Array::new();
    for width in WIDTHS {
        results.push(&storage.head(variant_key(key, width))?.into());
    }
    let results: Array = JsFuture::from(Promise::all(&results))
        .await?
        .unchecked_into();
    Ok(results.iter().filter(JsValue::is_truthy).collect())
}

fn dimensions(metadata: &Object, info: Option<ImageInfo>) -> JsResult<()> {
    if let Some(info) = info {
        set(metadata, "width", info.width.to_string())?;
        set(metadata, "height", info.height.to_string())?;
    }
    Ok(())
}

fn upload_options(mime: &str, custom: Object) -> JsResult<Object> {
    let options = only_if("etagDoesNotMatch", "*".into())?;
    set(&options, "customMetadata", custom)?;
    set(
        &options,
        "httpMetadata",
        object(&[
            ("contentType", mime.into()),
            ("cacheControl", IMMUTABLE.into()),
        ])?,
    )?;
    Ok(options)
}

async fn put_variant(storage: &R2Bucket, variant: &Variant) -> JsResult<JsValue> {
    let custom = Object::new();
    dimensions(&custom, Some(variant.info))?;
    let options = upload_options("image/webp", custom)?;
    JsFuture::from(storage.put(
        variant.key.clone(),
        variant.bytes.clone().into(),
        options.into(),
    )?)
    .await
}

struct Upload {
    key: String,
    name: String,
    format: ImageType,
    bytes: Uint8Array,
    info: Option<ImageInfo>,
    variants: Vec<Variant>,
}

async fn upload(request: &Request, storage: &R2Bucket, hooks: &Hooks) -> JsResult<Response> {
    let form = read_form(request, MAX_IMAGE + VARIANTS_BODY_LIMIT, hooks).await?;
    let file = form.get("file");
    if !file.is_truthy() || file.is_string() {
        return Err(hooks.error(400, "请选择图片。"));
    }
    let file: File = file.unchecked_into();
    if file.size() > f64::from(MAX_IMAGE) {
        return Err(hooks.error(413, "每张图片最多 10 MB。"));
    }
    let bytes = Uint8Array::new(&JsFuture::from(file.array_buffer()).await?);
    let format = sniff(&bytes, hooks)?;
    let info = image_info(&bytes);
    let key = format!(
        "uploads/sha256/{}.{}",
        sha256_hex(&bytes).await?,
        format.ext
    );
    let variants = prepare_variants(&form, info, file.size(), &key, hooks).await?;
    let upload = Rc::new(Upload {
        key,
        name: file.name(),
        format,
        bytes,
        info,
        variants,
    });
    if let Some(existing) = upload.existing(storage).await? {
        return Ok(existing);
    }
    let error_hook: &JsValue = hooks.as_ref();
    let error_hook = error_hook.clone();
    let work = Closure::wrap(Box::new(move |bucket: JsValue| {
        let upload = Rc::clone(&upload);
        let hook = error_hook.clone();
        future_to_promise(async move {
            upload
                .write(bucket.unchecked_ref(), hook.unchecked_ref())
                .await
                .map(Into::into)
        })
    }) as Box<dyn FnMut(JsValue) -> Promise>);
    Ok(
        JsFuture::from(hooks.with_mutation(storage, work.as_ref().unchecked_ref())?)
            .await?
            .unchecked_into(),
    )
}

impl Upload {
    async fn existing(&self, storage: &R2Bucket) -> JsResult<Option<Response>> {
        let original = JsFuture::from(storage.head(self.key.clone())?).await?;
        if !original.is_truthy() {
            return Ok(None);
        }
        let variants = heads(storage, &self.key).await?;
        Ok(Some(self.response(&original, &variants, true)?))
    }

    async fn write(&self, storage: &R2Bucket, hooks: &Hooks) -> JsResult<Response> {
        if let Some(existing) = self.existing(storage).await? {
            return Ok(existing);
        }
        let mut created = Vec::new();
        let saved = async {
            let mut variants = Vec::new();
            for variant in &self.variants {
                let mut stored = JsFuture::from(storage.head(variant.key.clone())?).await?;
                if !stored.is_truthy() {
                    stored = put_variant(storage, variant).await?;
                    if !stored.is_truthy() {
                        return Err(hooks.error(409, "图片正在变化，请重试。"));
                    }
                    created.push(variant.key.clone().into());
                }
                variants.push(stored);
            }
            let name = JsString::from(self.name.as_str()).slice(0, 160);
            let metadata = object(&[("name", name.into())])?;
            dimensions(&metadata, self.info)?;
            let options = upload_options(self.format.mime, metadata)?;
            let saved = JsFuture::from(storage.put(
                self.key.clone(),
                self.bytes.clone().into(),
                options.into(),
            )?)
            .await?;
            if !saved.is_truthy() {
                return Err(hooks.error(409, "图片正在变化，请重试。"));
            }
            self.response(&saved, &variants, false)
        }
        .await;
        if saved.is_err() && !created.is_empty() {
            JsFuture::from(storage.delete_multiple(created)?).await?;
        }
        saved
    }

    fn response(&self, stored: &JsValue, variants: &[JsValue], reused: bool) -> JsResult<Response> {
        let mut name = property(&property(stored, "customMetadata"), "name");
        if !reused || !name.is_truthy() {
            name = self.name.clone().into();
        }
        let response = object(&[
            ("key", self.key.clone().into()),
            ("url", format!("/images/{}", self.key).into()),
            ("name", name),
        ])?;
        if reused {
            set(&response, "deduplicated", true)?;
        }
        add_presentation(&response, stored, variants)?;
        json_object(if reused { 200 } else { 201 }, &response)
    }
}

pub fn add_presentation(
    response: &Object,
    original: &JsValue,
    variants: &[JsValue],
) -> JsResult<()> {
    let key = attribute(original, "key");
    let metadata = property(original, "customMetadata");
    let width = js_number(&property(&metadata, "width"));
    let height = js_number(&property(&metadata, "height"));
    let mut choices: Vec<_> = variants
        .iter()
        .filter_map(|item| {
            let item_key = attribute(item, "key");
            let width = property(&property(item, "customMetadata"), "width");
            let size = js_number(&width);
            (size > 0.0
                && attribute(&property(item, "httpMetadata"), "contentType") == "image/webp"
                && WIDTHS
                    .iter()
                    .any(|&width| item_key == variant_key(&key, width)))
            .then_some((item, item_key, size, width))
        })
        .collect();
    choices.sort_by(|a, b| a.2.total_cmp(&b.2));
    let normal = choices.iter().find(|(_, _, width, _)| *width >= 1280.0);
    let mut candidates: Vec<_> = choices
        .iter()
        .map(|(_, key, _, width)| {
            format!(
                "/images/{key} {}w",
                js_string(width).as_string().unwrap_or_default()
            )
        })
        .collect();
    if choices
        .last()
        .is_some_and(|(_, _, largest, _)| width > *largest)
    {
        candidates.push(format!(
            "/images/{key} {}w",
            js_string(&width.into()).as_string().unwrap_or_default()
        ));
    }
    if width > 0.0 && height > 0.0 {
        set(response, "width", width)?;
        set(response, "height", height)?;
    }
    set(
        response,
        "displayUrl",
        format!(
            "/images/{}",
            normal.map_or(key.as_str(), |(_, file, _, _)| file)
        ),
    )?;
    set(
        response,
        "thumbnailKey",
        choices.first().map_or(key.as_str(), |(_, file, _, _)| file),
    )?;
    set(response, "fullUrl", format!("/images/{key}"))?;
    set(response, "srcset", candidates.join(", "))?;
    let original_size = property(original, "size");
    let display_size = normal
        .map(|(item, _, _, _)| property(item, "size"))
        .filter(JsValue::is_truthy);
    set(
        response,
        "displaySize",
        display_size.unwrap_or_else(|| original_size.clone()),
    )?;
    let total = js_number(&original_size)
        + choices
            .iter()
            .map(|(item, _, _, _)| js_number(&property(item, "size")))
            .sum::<f64>();
    set(response, "totalSize", total)?;
    Ok(())
}

async fn optimize(request: &Request, storage: &R2Bucket, hooks: &Hooks) -> JsResult<Response> {
    let form = read_form(request, VARIANTS_BODY_LIMIT, hooks).await?;
    let Some(key) = form.get("key").as_string().filter(|key| {
        valid_image_key(key)
            && parent_key(key) == key
            && key
                .rsplit_once('.')
                .is_some_and(|(_, ext)| matches!(ext, "png" | "jpg" | "jpeg" | "webp"))
    }) else {
        return Err(hooks.error(400, "请选择可优化的 JPEG、PNG 或 WebP 原图。"));
    };
    let stale = || hooks.error(409, "原图已变化，请刷新后重新优化。");
    let stored = get(storage, &key).await?;
    if !stored.is_truthy() {
        return Err(hooks.error(404, "原图已不存在，请刷新图片库。"));
    }
    let etag = property(&stored, "etag");
    if form.get("etag") != etag {
        cancel_body(&stored).await?;
        return Err(stale());
    }
    let size = js_number(&property(&stored, "size"));
    if size > f64::from(MAX_IMAGE) {
        cancel_body(&stored).await?;
        return Err(hooks.error(413, "这张原图超过 10 MB，请先在外部处理。"));
    }
    let body: &R2ObjectBody = stored.unchecked_ref();
    let bytes = Uint8Array::new(&JsFuture::from(body.array_buffer()?).await?);
    let info = image_info(&bytes);
    let prepared = prepare_variants(&form, info, size, &key, hooks).await?;
    let old_metadata = property(&stored, "customMetadata");
    if attribute(&old_metadata, "optimization") == "processing" && prepared.is_empty() {
        return Err(hooks.error(
            409,
            "未能重新生成这张图片的版本，请重试或更换浏览器；已有版本仍保留。",
        ));
    }
    let save = |status: &str| -> JsResult<Promise> {
        let metadata = Object::new();
        if old_metadata.is_object() {
            Object::assign(&metadata, old_metadata.unchecked_ref());
        }
        dimensions(&metadata, info)?;
        set(&metadata, "optimization", status)?;
        let options = only_if("etagMatches", etag.clone())?;
        set(&options, "httpMetadata", property(&stored, "httpMetadata"))?;
        set(&options, "customMetadata", metadata)?;
        storage.put(key.clone(), bytes.clone().into(), options.into())
    };
    if !JsFuture::from(save("processing")?).await?.is_truthy() {
        return Err(stale());
    }
    let mut created = Vec::new();
    let complete = async {
        for variant in &prepared {
            if put_variant(storage, variant).await?.is_truthy() {
                created.push(variant.key.clone());
            }
        }
        let variants = heads(storage, &key).await?;
        let status = if variants.is_empty() {
            "skipped"
        } else {
            "complete"
        };
        if !JsFuture::from(save(status)?).await?.is_truthy() {
            return Err(stale());
        }
        let added = variants
            .iter()
            .filter(|item| created.contains(&attribute(item, "key")))
            .map(|item| js_number(&property(item, "size")))
            .sum::<f64>();
        json(
            200,
            &[
                ("key", key.clone().into()),
                ("optimized", (!variants.is_empty()).into()),
                ("addedBytes", added.into()),
            ],
        )
    }
    .await;
    if complete.is_err() && !created.is_empty() {
        JsFuture::from(storage.delete_multiple(created.into_iter().map(Into::into).collect())?)
            .await?;
    }
    complete
}
