use std::collections::HashSet;

use worker::js_sys::{Array, JSON, JsString, Object, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::worker_sys::R2Bucket;

use crate::drafts::deleted;
use crate::html_rewriter::JsResult;
use crate::http::error;
use crate::image_references::{VERSION, managed};
use crate::media::valid_image_key;
use crate::runtime::{
    cancel_body, digest_text, encode_utf8, get, js_number, list, object, own_property,
    parse_object, property, set_own,
};

pub const ROOT: &str = "image-reference-index/";
const MAX_SHARD: u32 = 1_000_000;

pub fn shard_key(hash: &str) -> String {
    format!("{ROOT}{}.json", hash.get(..2).unwrap_or_default())
}

pub async fn read_shard(storage: &R2Bucket, key: &str) -> JsResult<JsValue> {
    let value = get(storage, key).await?;
    if !value.is_truthy() {
        return Ok(Object::new().into());
    }
    if js_number(&property(&value, "size")) > f64::from(MAX_SHARD) {
        cancel_body(&value).await?;
        return Err(error(413, "图片引用索引过大，无法安全核对。"));
    }
    let data = parse_object(&value).await?;
    if !data.is_object() || Array::is_array(&data) {
        return Err(error(503, "图片引用索引无效，请更新引用索引。"));
    }
    Ok(data)
}

pub async fn metadata(
    source: &JsString,
    storage: &R2Bucket,
    previous: &JsValue,
) -> JsResult<JsValue> {
    let mut keys = managed(source)?;
    keys.sort();
    let keys: Array = keys.into_iter().map(JsValue::from).collect();
    let text = JSON::stringify(&keys)?;
    if encode_utf8(&text).length() <= 600 {
        return Ok(object(&[
            ("image_refs_version", VERSION.into()),
            ("image_refs", text.into()),
        ])?
        .into());
    }
    let hash = digest_text(&text).await?;
    if previous != &hash {
        let key = shard_key(&hash);
        let shard = read_shard(storage, &key).await?;
        if JSON::stringify(&property(&shard, &hash))? != text {
            set_own(shard.unchecked_ref(), &hash, keys.clone().into())?;
            let mut serialized = JSON::stringify(&shard)?;
            if encode_utf8(&serialized).length() > MAX_SHARD {
                prune(storage, &key).await?;
                let compact = read_shard(storage, &key).await?;
                set_own(compact.unchecked_ref(), &hash, keys.into())?;
                serialized = JSON::stringify(&compact)?;
            }
            if encode_utf8(&serialized).length() > MAX_SHARD {
                return Err(error(413, "图片引用索引需要先完成自动维护，请稍后重试。"));
            }
            JsFuture::from(storage.put(key, serialized.into(), JsValue::UNDEFINED)?).await?;
        }
    }
    Ok(object(&[
        ("image_refs_version", VERSION.into()),
        ("image_refs_hash", hash.into()),
    ])?
    .into())
}

pub async fn checked(shard: &JsValue, hash: &str) -> JsResult<Array> {
    let keys = own_property(shard, hash);
    let invalid = || {
        error(
            503,
            "图片引用索引缺失或损坏，请重新更新引用索引；图片仍受保护。",
        )
    };
    if !Array::is_array(&keys) {
        return Err(invalid());
    }
    let keys: Array = keys.unchecked_into();
    if !keys
        .iter()
        .all(|key| key.as_string().is_some_and(|key| valid_image_key(&key)))
        || digest_text(&JSON::stringify(&keys)?).await? != hash
    {
        return Err(invalid());
    }
    Ok(keys)
}

pub async fn prune(storage: &R2Bucket, key: &str) -> JsResult<u32> {
    let mut live = HashSet::new();
    let mut scanned = 0;
    let mut count = 0;
    for prefix in ["drafts/", "shorts/"] {
        let mut cursor = JsValue::UNDEFINED;
        loop {
            let page = list(storage, prefix, cursor, 1000, &["customMetadata"]).await?;
            for item in page.objects.iter() {
                scanned += 1;
                if scanned > 10_000 {
                    return Err(error(413, "原稿目录超过安全扫描上限。"));
                }
                if deleted(&item) {
                    continue;
                }
                count += 1;
                if count > 2_000 {
                    return Err(error(413, "原稿数量超过引用索引维护上限。"));
                }
                if let Some(hash) =
                    property(&property(&item, "customMetadata"), "image_refs_hash").as_string()
                {
                    live.insert(hash);
                }
            }
            cursor = page.cursor;
            if !cursor.is_truthy() {
                break;
            }
        }
    }
    let shard = read_shard(storage, key).await?;
    let shard: Object = shard.unchecked_into();
    let keys = Object::keys(&shard);
    let mut obsolete = 0;
    for name in keys.iter() {
        if name.as_string().is_some_and(|name| !live.contains(&name)) {
            Reflect::delete_property(&shard, &name)?;
            obsolete += 1;
        }
    }
    if obsolete != 0 {
        if obsolete == keys.length() {
            JsFuture::from(storage.delete(key.to_owned())?).await?;
        } else {
            JsFuture::from(storage.put(
                key.to_owned(),
                JSON::stringify(&shard)?.into(),
                JsValue::UNDEFINED,
            )?)
            .await?;
        }
    }
    Ok(obsolete)
}
