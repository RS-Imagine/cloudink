use worker::js_sys::{Array, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::worker_sys::R2Bucket;

use crate::html_rewriter::JsResult;
use crate::http::error;
use crate::icon::PREFIX;
use crate::media::valid_site_icon_key;
use crate::models::valid_home_illustration;
use crate::runtime::{attribute, object, property, set};

pub struct DerivedIcons {
    pub ext: String,
    pub apple: String,
    pub icon192: String,
    pub icon512: String,
    pub maskable512: String,
    pub favicon_ico: String,
}

impl DerivedIcons {
    pub fn generated(&self) -> Vec<&str> {
        let mut keys = vec![
            self.apple.as_str(),
            &self.icon192,
            &self.icon512,
            &self.maskable512,
        ];
        if self.ext != "ico" {
            keys.push(&self.favicon_ico);
        }
        keys
    }
}

pub fn derivatives(key: &str) -> Option<DerivedIcons> {
    if !valid_site_icon_key(key) {
        return None;
    }
    let (stem, ext) = key.rsplit_once('.')?;
    Some(DerivedIcons {
        ext: ext.to_owned(),
        apple: format!("{stem}-180.png"),
        icon192: format!("{stem}-192.png"),
        icon512: format!("{stem}-512.png"),
        maskable512: format!("{stem}-512-maskable.png"),
        favicon_ico: if ext == "ico" {
            key.to_owned()
        } else {
            format!("{stem}-favicon.ico")
        },
    })
}

pub fn reader_icons(icon: &JsValue) -> JsResult<JsValue> {
    let Some(icon) = icon.as_string().and_then(|key| derivatives(&key)) else {
        return Ok(JsValue::NULL);
    };
    Ok(object(&[
        ("apple", icon.apple.into()),
        ("icon512", icon.icon512.into()),
        ("faviconIco", icon.favicon_ico.into()),
    ])?
    .into())
}

pub fn mime(key: &str) -> &'static str {
    match key
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub fn valid_asset_key(key: &str) -> bool {
    valid_site_icon_key(key)
        || key
            .strip_prefix(PREFIX)
            .and_then(|path| path.split_once('-'))
            .is_some_and(|(hash, name)| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    && matches!(
                        name,
                        "180.png" | "192.png" | "512.png" | "512-maskable.png" | "favicon.ico"
                    )
            })
}

pub async fn ensure_icon(storage: &R2Bucket, site: &JsValue) -> JsResult<()> {
    let icon = property(site, "siteIcon");
    if !icon.is_truthy() {
        Reflect::delete_property::<JsValue>(site.unchecked_ref(), &"siteIconSize".into())?;
        return Ok(());
    }
    let key = icon.as_string().unwrap_or_default();
    let object = JsFuture::from(storage.head(key.clone())?).await?;
    if !object.is_truthy()
        || attribute(&property(&object, "httpMetadata"), "contentType") != mime(&key)
    {
        return Err(error(400, "网站图标已被删除或尚未上传，请重新选择后保存。"));
    }
    set(site, "siteIconSize", property(&object, "size"))
}

pub async fn ensure_illustration(storage: &R2Bucket, site: &JsValue) -> JsResult<()> {
    let key = property(site, "homeIllustration");
    if !key.is_truthy() || key == "default" {
        return Ok(());
    }
    let key = key
        .as_string()
        .filter(|key| valid_home_illustration(key))
        .ok_or_else(|| error(400, "首页插画地址无效。"))?;
    let object = JsFuture::from(storage.head(key)?).await?;
    let mime = attribute(&property(&object, "httpMetadata"), "contentType");
    if !object.is_truthy()
        || !matches!(
            mime.as_str(),
            "image/jpeg"
                | "image/png"
                | "image/webp"
                | "image/gif"
                | "image/avif"
                | "image/svg+xml"
        )
    {
        return Err(error(400, "首页插画已被删除或尚未上传，请重新选择后保存。"));
    }
    Ok(())
}

pub async fn ready(storage: &R2Bucket, icon: &JsValue) -> JsResult<bool> {
    use worker::js_sys::Promise;

    let Some(keys) = icon.as_string().and_then(|icon| derivatives(&icon)) else {
        return Ok(true);
    };
    let keys = keys.generated();
    let requests = Array::new();
    for key in &keys {
        requests.push(&storage.head((*key).to_owned())?.into());
    }
    let results: Array = JsFuture::from(Promise::all(&requests))
        .await?
        .unchecked_into();
    Ok(keys.into_iter().zip(results.iter()).all(|(key, result)| {
        result.is_truthy()
            && attribute(&property(&result, "httpMetadata"), "contentType") == mime(key)
    }))
}
