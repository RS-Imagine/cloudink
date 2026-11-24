use std::collections::HashMap;

use worker::js_sys::{Array, JSON, JsString, Object};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::worker_sys::R2Bucket;

use crate::browser_publish::{copy, entries};
use crate::drafts::Hooks;
use crate::html_rewriter::JsResult;
use crate::media::valid_image_key;
use crate::runtime::{
    attribute, digest_text, object, own_property, property, read_json, set, set_own,
};

pub fn key(id: &str) -> String {
    format!("releases/{id}.posts.json")
}

pub async fn read(
    storage: &R2Bucket,
    id: &str,
    error: impl Fn(u16, &str) -> JsValue,
) -> JsResult<JsValue> {
    let index = read_json(storage, &key(id)).await?;
    if !index.is_truthy() {
        return Ok(JsValue::NULL);
    }
    let posts = property(&index, "posts");
    let shorts = property(&index, "shorts");
    if property(&index, "schema_version").as_f64() != Some(1.0)
        || property(&index, "id") != id
        || !property(&index, "site").is_truthy()
        || !posts.is_truthy()
        || (!shorts.is_undefined()
            && (!shorts.is_object()
                || Array::is_array(&shorts)
                || values(&shorts).any(|short| !has_strings(&short, &["date", "snippet"]))))
        || values(&posts)
            .any(|post| !has_strings(&post, &["title", "date", "description", "digest"]))
    {
        return Err(error(503, "文章摘要索引无效，请重新发布网站。"));
    }
    let images = property(&index, "images");
    if !images.is_undefined() {
        let entries = property(&images, "entries");
        if !property(&images, "version").is_string()
            || !Array::is_array(&entries)
            || entries
                .unchecked_ref::<Array>()
                .iter()
                .any(|entry| !valid_image_entry(&entry))
        {
            return Err(error(
                503,
                "发布图片引用摘要无效；图片仍受保护，请重新发布。",
            ));
        }
    }
    Ok(index)
}

pub async fn build(
    release: &JsValue,
    base: &JsValue,
    prior: &JsValue,
    hooks: &Hooks,
) -> JsResult<JsValue> {
    let reusable = prior.is_truthy() && property(prior, "id") == property(base, "id");
    let posts = Object::new();
    let shorts = Object::new();
    let earlier = property(base, "markdown_posts");
    let old = property(prior, "posts");
    for (slug, source) in entries(&property(release, "markdown_posts")) {
        let old_post = own_property(&old, &slug);
        if reusable && old_post.is_truthy() && property(&earlier, &slug) == source {
            set_own(&posts, &slug, old_post)?;
            continue;
        }
        let draft = hooks.parse_post(source.unchecked_ref())?;
        let front = property(&draft, "front_matter");
        if property(&front, "slug") != slug {
            return Err(hooks.error(400, "文章地址与原稿不一致。"));
        }
        if !property(&front, "draft").is_truthy() {
            let post = copy(&front);
            set(&post, "digest", editorial_digest(&draft).await?)?;
            set_own(&posts, &slug, post.into())?;
        }
    }
    let earlier = property(base, "markdown_shorts");
    let old = property(prior, "shorts");
    for (slug, source) in entries(&property(release, "markdown_shorts")) {
        let old_short = own_property(&old, &slug);
        if reusable && property(&earlier, &slug) == source && !old_short.is_undefined() {
            set_own(&shorts, &slug, old_short)?;
            continue;
        }
        let draft = hooks.parse_short(source.unchecked_ref())?;
        let front = property(&draft, "front_matter");
        if property(&front, "slug") != slug {
            return Err(hooks.error(400, "短记地址与原稿不一致。"));
        }
        if !property(&front, "draft").is_truthy() {
            let body = property(&draft, "body_markdown");
            let body: &JsString = body.unchecked_ref();
            let summary = object(&[
                ("date", property(&front, "date")),
                ("snippet", body.slice(0, 300).into()),
            ])?;
            set_own(&shorts, &slug, summary.into())?;
        }
    }
    let images = image_index(release, base, prior, reusable, hooks)?;
    Ok(object(&[
        ("schema_version", 1.into()),
        ("id", property(release, "id")),
        ("site", property(release, "site")),
        ("posts", posts.into()),
        ("shorts", shorts.into()),
        ("images", images.into()),
    ])?
    .into())
}

fn image_index(
    release: &JsValue,
    base: &JsValue,
    prior: &JsValue,
    reusable: bool,
    hooks: &Hooks,
) -> JsResult<Object> {
    let version = hooks.ref_version();
    let images = property(prior, "images");
    let mut old = HashMap::new();
    if reusable && property(&images, "version") == version {
        let entries: Array = property(&images, "entries").unchecked_into();
        for entry in entries.iter() {
            old.insert(attribute(&entry, "scope"), entry);
        }
    }
    let result = Array::new();
    let add = |scope: &str,
               source: JsValue,
               previous: JsValue,
               title: &str,
               slug: Option<&str>|
     -> JsResult<()> {
        if let Some(prior) = old.get(scope)
            && source == previous
        {
            result.push(prior);
        } else {
            let entry = object(&[("scope", scope.into()), ("title", title.into())])?;
            if let Some(slug) = slug.filter(|slug| !slug.is_empty()) {
                set(&entry, "slug", slug)?;
            } else {
                set(&entry, "settings", true)?;
            }
            set(
                &entry,
                "keys",
                hooks.managed_images(source.unchecked_ref())?,
            )?;
            result.push(&entry);
        }
        Ok(())
    };
    for (field, scope) in [("markdown_posts", "post"), ("markdown_shorts", "short")] {
        let previous = property(base, field);
        for (slug, source) in entries(&property(release, field)) {
            add(
                &format!("{scope}:{slug}"),
                source,
                property(&previous, &slug),
                &slug,
                Some(&slug),
            )?;
        }
    }
    let prior_site = if base.is_truthy() {
        JSON::stringify(&property(base, "site"))?.into()
    } else {
        JsValue::UNDEFINED
    };
    add(
        "site",
        JSON::stringify(&property(release, "site"))?.into(),
        prior_site,
        "网站设置",
        None,
    )?;
    let about = property(release, "about_markdown");
    add(
        "about",
        if about.is_truthy() { about } else { "".into() },
        property(base, "about_markdown"),
        "关于页面",
        None,
    )?;
    object(&[("version", version), ("entries", result.into())])
}

pub async fn editorial_digest(draft: &JsValue) -> JsResult<String> {
    let front = property(draft, "front_matter");
    let parts: Array = ["title", "slug", "date", "description"]
        .into_iter()
        .map(|name| property(&front, name))
        .collect();
    parts.push(&property(draft, "body_markdown"));
    let aliases = property(&front, "aliases");
    if property(&aliases, "length").is_truthy() {
        parts.push(&aliases);
    }
    digest_text(&JSON::stringify(&parts)?).await
}

fn values(value: &JsValue) -> impl Iterator<Item = JsValue> {
    Object::values(value.unchecked_ref()).to_vec().into_iter()
}

fn has_strings(value: &JsValue, names: &[&str]) -> bool {
    value.is_truthy() && names.iter().all(|name| property(value, name).is_string())
}

fn valid_image_entry(entry: &JsValue) -> bool {
    let slug = property(entry, "slug");
    let settings = property(entry, "settings");
    let keys = property(entry, "keys");
    has_strings(entry, &["scope", "title"])
        && (slug.is_undefined() || slug.is_string())
        && (settings.is_undefined() || settings.as_bool().is_some())
        && Array::is_array(&keys)
        && keys
            .unchecked_ref::<Array>()
            .iter()
            .all(|key| key.as_string().is_some_and(|key| valid_image_key(&key)))
}
