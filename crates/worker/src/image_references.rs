use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use pulldown_cmark::{Options, Parser, html};
use worker::js_sys::{Array, JsString, Promise, RegExp, decode_uri_component};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{ReadableStreamDefaultReader, ResponseInit, Url};
use worker::worker_sys::R2Bucket;

use crate::entities;
use crate::html_rewriter::{HtmlRewriter, JsResult, string_response};
use crate::http::error;
use crate::media::{legacy_image_path, valid_image_key};
use crate::runtime::{list, property};

pub const VERSION: &str = "2";

thread_local! {
    static MANAGED: RegExp = RegExp::new(r"uploads/[A-Za-z0-9_./-]{1,1016}\.(?:jpeg|jpg|png|webp|gif|avif|svg|ico)\b", "g");
    static ESCAPED: RegExp = RegExp::new(r"\\([^\w\s])", "g");
    static FRONT: RegExp = RegExp::new(r"^\uFEFF?\+\+\+\r?\n[\s\S]*?\r?\n\+\+\+(?:\r?\n|$)", "");
    static BOM: RegExp = RegExp::new(r"^\uFEFF", "");
    static SPACE: RegExp = RegExp::new(r"\s+", "");
}

pub fn managed(source: &JsString) -> JsResult<Vec<String>> {
    let source = source.as_string().unwrap_or_default();
    let decoded = entities::decode(&source, false);
    let decoded = percent_and_line_breaks(&decoded);
    let unescaped =
        ESCAPED.with(|pattern| JsString::from(decoded.as_str()).replace_by_pattern(pattern, "$1"));
    let slashes = JsString::from(decoded.replace('\\', "/"));
    let mut result = Vec::new();
    let mut found = HashSet::new();
    for text in [unescaped, slashes] {
        let matches = MANAGED.with(|pattern| text.match_all(pattern));
        for item in matches {
            let item: Array = item?.unchecked_into();
            let input = format!("/images/{}", item.get(0).as_string().unwrap_or_default());
            if let Some(key) = key_from_url(&input, "https://cloudink.invalid", false)
                && found.insert(key.clone())
            {
                result.push(key);
            }
        }
    }
    Ok(result)
}

fn percent_and_line_breaks(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut remaining = source;
    while !remaining.is_empty() {
        if remaining.starts_with('%')
            && let Some(hex) = remaining.get(1..3)
            && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            let ch = char::from(byte);
            if !matches!(ch, '\t' | '\r' | '\n') {
                output.push(ch);
            }
            remaining = &remaining[3..];
            continue;
        }
        let ch = remaining.chars().next().expect("nonempty source");
        if !matches!(ch, '\t' | '\r' | '\n') {
            output.push(ch);
        }
        remaining = &remaining[ch.len_utf8()..];
    }
    output
}

fn key_from_url(input: &str, origin: &str, local: bool) -> Option<String> {
    let decoded = entities::decode(input, true);
    let legacy = legacy_image_path(&decoded, origin);
    let url = Url::new_with_base(legacy.as_deref().unwrap_or(&decoded), origin).ok()?;
    if local && url.origin() != origin {
        return None;
    }
    let path = url.pathname();
    let key = decode_uri_component(path.strip_prefix("/images/")?)
        .ok()?
        .as_string()?;
    valid_image_key(&key).then_some(key)
}

async fn local_keys(source: &JsString, origin: &str) -> JsResult<Vec<String>> {
    if managed(source)?.is_empty() {
        return Ok(Vec::new());
    }
    let source = BOM.with(|pattern| source.replace_by_pattern(pattern, ""));
    let body = FRONT
        .with(|pattern| source.replace_by_pattern(pattern, ""))
        .as_string()
        .unwrap_or_default();
    let mut rendered = String::new();
    html::push_html(&mut rendered, Parser::new_ext(&body, Options::empty()));
    let found = Rc::new(RefCell::new(Vec::new()));
    let rewriter = HtmlRewriter::new();
    let observed = Rc::clone(&found);
    let origin = origin.to_owned();
    rewriter.on_element("img,source", move |element| {
        let add = |value: &JsString| {
            if let Some(key) = value
                .as_string()
                .and_then(|value| key_from_url(&value, &origin, true))
            {
                observed.borrow_mut().push(key);
            }
        };
        if let Some(source) = element.attribute("src") {
            add(&source);
        }
        if let Some(srcset) = element.attribute("srcset") {
            for item in srcset.split(",").iter() {
                let item: JsString = item.unchecked_into();
                let parts = SPACE.with(|pattern| item.trim().split_by_pattern(pattern));
                add(parts.get(0).unchecked_ref());
            }
        }
        Ok(())
    })?;
    let response = string_response(&rendered.into(), &ResponseInit::new())?;
    if let Some(body) = rewriter.transform(&response)?.body() {
        let reader: ReadableStreamDefaultReader = body.get_reader().unchecked_into();
        let read: JsResult<()> = async {
            loop {
                let chunk = JsFuture::from(reader.read()).await?;
                if property(&chunk, "done").is_truthy() {
                    return Ok(());
                }
            }
        }
        .await;
        reader.release_lock();
        read?;
    }
    let keys = std::mem::take(&mut *found.borrow_mut());
    Ok(keys)
}

pub async fn ensure(storage: &R2Bucket, sources: &JsValue, origin: &str) -> JsResult<()> {
    let sources: Array = if sources.is_string() {
        [sources.clone()].into_iter().collect()
    } else {
        sources.clone().unchecked_into()
    };
    let mut needed = HashSet::new();
    let mut ordered = Vec::new();
    for source in sources.iter() {
        for key in local_keys(source.unchecked_ref(), origin).await? {
            if needed.insert(key.clone()) {
                ordered.push(key);
            }
        }
    }
    if needed.is_empty() {
        return Ok(());
    }
    let missing = || {
        error(
            400,
            "内容引用了已经删除或尚未上传的图片，请移除该链接或重新上传后保存。",
        )
    };
    if needed.len() <= 12 {
        let requests = Array::new();
        for key in ordered {
            requests.push(&storage.head(key)?.into());
        }
        let found: Array = JsFuture::from(Promise::all(&requests))
            .await?
            .unchecked_into();
        if found.iter().any(|object| !object.is_truthy()) {
            return Err(missing());
        }
        return Ok(());
    }
    let mut cursor = JsValue::UNDEFINED;
    loop {
        let page = list(storage, "uploads/", cursor, 1000, &[]).await?;
        for object in page.objects.iter() {
            if let Some(key) = property(&object, "key").as_string() {
                needed.remove(&key);
            }
        }
        if needed.is_empty() {
            return Ok(());
        }
        cursor = page.cursor;
        if !cursor.is_truthy() {
            return Err(missing());
        }
    }
}
