use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use worker::js_sys::{Array, JsString, Object, Promise, decode_uri_component};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::{JsFuture, future_to_promise};
use worker::web_sys::{ResponseInit, Url};
use worker::worker_sys::R2Bucket;

use crate::html_rewriter::{HtmlRewriter, JsResult, string_response};
use crate::image::{WIDTHS, add_presentation, parent_key, variant_key};
use crate::media::valid_image_key;
use crate::runtime::{js_string, object, property};

pub async fn sanitize(html: &JsString) -> JsResult<JsString> {
    let rewriter = HtmlRewriter::new();
    rewriter.on_element(
        "script,base,iframe,object,embed,form,meta[http-equiv]",
        |element| element.remove(),
    )?;
    rewriter.on_element("*", |element| {
        for attribute in Array::from(&element.attributes()).iter() {
            let pair: Array = attribute.unchecked_into();
            let name = pair.get(0).as_string().unwrap_or_default();
            if name.to_lowercase().starts_with("on") {
                element.remove_attribute(&name)?;
            }
        }
        Ok(())
    })?;
    for (element, script) in [
        ("head", r#"<script src="/theme.js"></script>"#),
        ("body", r#"<script src="/client.js" defer></script>"#),
        ("body", r#"<script src="/analytics.js" defer></script>"#),
    ] {
        let html = object(&[("html", true.into())])?;
        rewriter.on_element(element, move |element| {
            element.append(&script.into(), &html)
        })?;
    }
    let response = string_response(html, &ResponseInit::new())?;
    Ok(JsFuture::from(rewriter.transform(&response)?.text()?)
        .await?
        .unchecked_into())
}

pub async fn responsive_images(
    html: &JsString,
    storage: &R2Bucket,
    origin: &str,
) -> JsResult<JsString> {
    let families: Rc<RefCell<HashMap<String, Promise>>> = Rc::default();
    let storage = storage.clone();
    let origin = origin.to_owned();
    let rewriter = HtmlRewriter::new();
    rewriter.on_element_async(".article-body img, .home-thumbnail img", move |element| {
        let families = Rc::clone(&families);
        let storage = storage.clone();
        let origin = origin.clone();
        async move {
            if element.has_attribute("srcset") {
                return Ok(());
            }
            let source = element
                .attribute("src")
                .and_then(|src| src.as_string())
                .unwrap_or_default();
            let Some(key) = responsive_image_key(&source, &origin) else {
                return Ok(());
            };
            let pending = {
                let mut families = families.borrow_mut();
                if let Some(pending) = families.get(&key) {
                    pending.clone()
                } else {
                    if families.len() >= 100 {
                        return Ok(());
                    }
                    let image_key = key.clone();
                    let pending =
                        future_to_promise(async move { image_family(&storage, &image_key).await });
                    families.insert(key, pending.clone());
                    pending
                }
            };
            let presentation = JsFuture::from(pending).await?;
            if !presentation.is_truthy() {
                return Ok(());
            }
            let width = property(&presentation, "width");
            let height = property(&presentation, "height");
            if !element.has_attribute("width")
                && !element.has_attribute("height")
                && width.is_truthy()
                && height.is_truthy()
            {
                element.set_attribute("width", &js_string(&width))?;
                element.set_attribute("height", &js_string(&height))?;
            }
            let srcset = property(&presentation, "srcset");
            if srcset.is_truthy() {
                element
                    .set_attribute("src", property(&presentation, "displayUrl").unchecked_ref())?;
                element.set_attribute("srcset", srcset.unchecked_ref())?;
                if !element.has_attribute("sizes") {
                    element.set_attribute(
                        "sizes",
                        &"(max-width: 759px) calc(100vw - 44px), 720px".into(),
                    )?;
                }
                element.set_attribute(
                    "data-full-src",
                    property(&presentation, "fullUrl").unchecked_ref(),
                )?;
            }
            Ok(())
        }
    })?;
    let response = string_response(html, &ResponseInit::new())?;
    Ok(JsFuture::from(rewriter.transform(&response)?.text()?)
        .await?
        .unchecked_into())
}

fn responsive_image_key(source: &str, origin: &str) -> Option<String> {
    let url = Url::new_with_base(source, origin).ok()?;
    if url.origin() != origin {
        return None;
    }
    let path = url.pathname();
    let original = decode_uri_component(path.strip_prefix("/images/")?)
        .ok()?
        .as_string()?;
    let key = parent_key(&original);
    valid_image_key(key).then(|| key.to_owned())
}

async fn image_family(storage: &R2Bucket, key: &str) -> JsResult<JsValue> {
    let objects = Array::new();
    objects.push(&storage.head(key.to_owned())?.into());
    for width in WIDTHS {
        objects.push(&storage.head(variant_key(key, width))?.into());
    }
    let objects: Array = JsFuture::from(Promise::all(&objects))
        .await?
        .unchecked_into();
    let original = objects.get(0);
    if !original.is_truthy() {
        return Ok(JsValue::NULL);
    }
    let variants: Vec<_> = objects.iter().skip(1).filter(JsValue::is_truthy).collect();
    let presentation = Object::new();
    add_presentation(&presentation, &original, &variants)?;
    Ok(presentation.into())
}

pub fn public_type(path: &str) -> &'static str {
    if matches!(
        path,
        "index.html"
            | "404.html"
            | "about/index.html"
            | "post/index.html"
            | "archive/index.html"
            | "shorts/index.html"
    ) || ["post/page/", "shorts/page/"].iter().any(|prefix| {
        path.strip_prefix(prefix)
            .and_then(|page| page.strip_suffix("/index.html"))
            .is_some_and(|page| {
                page.as_bytes()
                    .first()
                    .is_some_and(|first| matches!(first, b'1'..=b'9'))
                    && page.bytes().all(|digit| digit.is_ascii_digit())
            })
    }) || path
        .strip_prefix("posts/")
        .and_then(|slug| slug.strip_suffix("/index.html"))
        .is_some_and(valid_slug)
    {
        return "text/html; charset=utf-8";
    }
    if path.ends_with(".json") {
        return "application/json; charset=utf-8";
    }
    match path {
        "client.js" | "sw.js" => "text/javascript; charset=utf-8",
        "styles.css" => "text/css; charset=utf-8",
        "favicon.svg" => "image/svg+xml",
        "manifest.webmanifest" => "application/manifest+json; charset=utf-8",
        _ => match path
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "avif" => "image/avif",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "txt" => "text/plain; charset=utf-8",
            "pdf" => "application/pdf",
            _ => "application/octet-stream",
        },
    }
}

pub fn valid_slug(slug: &str) -> bool {
    (1..=100).contains(&slug.len())
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
