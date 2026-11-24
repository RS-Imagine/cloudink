use std::collections::HashSet;

use futures_util::try_join;
use worker::js_sys::{JsString, Object, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Request, Response};
use worker::worker_sys::R2Bucket;

use crate::browser_publish::{PENDING, PUBLISHED, copy, entries, string_array, strings};
use crate::drafts::{Hooks, deleted};
use crate::html_rewriter::JsResult;
use crate::publishing::{busy, check_slug, current_release};
use crate::runtime::{
    attribute, body_text, get, js_number, json, object, only_if, own_property, property, read_json,
    set,
};

pub fn redirects(release: &JsValue, hooks: &Hooks) -> JsResult<Object> {
    let posts = property(release, "markdown_posts");
    let redirects = Object::new();
    for (slug, source) in entries(&posts) {
        let draft = hooks.parse_post(source.unchecked_ref())?;
        let front = property(&draft, "front_matter");
        if property(&front, "draft").is_truthy() {
            continue;
        }
        for alias in strings(&property(&front, "aliases")).filter(|alias| alias != &slug) {
            let prior = own_property(&redirects, &alias);
            if !own_property(&posts, &alias).is_undefined() || (prior.is_truthy() && prior != slug)
            {
                return Err(hooks.error(409, &format!("文章地址或旧链接已被其他文章占用：{alias}")));
            }
            crate::runtime::set_own(&redirects, &alias, slug.clone().into())?;
        }
    }
    if Object::keys(&redirects).length() > 2000 {
        return Err(hooks.error(413, "旧文章地址超过 2000 个。"));
    }
    Ok(redirects)
}

pub fn with_address(
    draft: &JsValue,
    slug: &str,
    remember: bool,
    hooks: &Hooks,
) -> JsResult<JsValue> {
    let next = copy(draft);
    let front = copy(&property(draft, "front_matter"));
    let mut unique = HashSet::new();
    let mut aliases: Vec<_> = strings(&property(&front, "aliases"))
        .filter(|alias| alias != slug && unique.insert(alias.clone()))
        .collect();
    if remember {
        let former = attribute(&front, "slug");
        if former != slug && unique.insert(former.clone()) {
            aliases.push(former);
        }
    }
    if aliases.len() > 100 {
        return Err(hooks.error(400, "这篇文章已保留 100 个旧地址，不能继续改址。"));
    }
    set(&front, "slug", slug)?;
    if aliases.is_empty() {
        Reflect::delete_property(&front, &"aliases".into())?;
    } else {
        set(&front, "aliases", string_array(&aliases))?;
    }
    set(&front, "draft", true)?;
    set(&next, "front_matter", front)?;
    Ok(next.into())
}

pub async fn address_target(
    storage: &R2Bucket,
    release: &JsValue,
    from: &str,
    to: &str,
    hooks: &Hooks,
) -> JsResult<JsValue> {
    check_slug(to, hooks)?;
    if from == to {
        return Err(hooks.error(400, "新地址与当前地址相同。"));
    }
    let redirects = redirects(release, hooks)?;
    let redirect = own_property(&redirects, to);
    if !own_property(&property(release, "markdown_posts"), to).is_undefined()
        || (redirect.is_truthy() && redirect != from)
    {
        return Err(hooks.error(409, "这个文章地址已被占用，请换一个。"));
    }
    let target = head(storage, to).await?;
    if target.is_truthy() && !deleted(&target) {
        return Err(hooks.error(409, "这个文章地址已被其他草稿占用，请换一个。"));
    }
    Ok(target)
}

pub async fn assert_writable(storage: &R2Bucket, slug: &str, hooks: &Hooks) -> JsResult<()> {
    let (pointer, state) = try_join!(read_json(storage, PUBLISHED), read_json(storage, PENDING))?;
    if !own_property(&property(&pointer, "postRedirects"), slug).is_undefined() {
        return Err(hooks.error(
            409,
            "这篇文章已修改地址，请重新打开文章，旧链接会自动跳转。",
        ));
    }
    if property(&property(&state, "rename"), "to") == slug && busy(&state) {
        return Err(hooks.error(409, "这个地址正在用于文章改址，请等待发布完成。"));
    }
    Ok(())
}

pub async fn assert_rename_unchanged(
    storage: &R2Bucket,
    state: &JsValue,
    hooks: &Hooks,
) -> JsResult<()> {
    let rename = property(state, "rename");
    if !rename.is_truthy() {
        return Ok(());
    }
    let source = head(storage, &attribute(&rename, "from")).await?;
    let target = head(storage, &attribute(&rename, "to")).await?;
    let target_etag = property(&target, "etag");
    let target_etag = if target_etag.is_truthy() {
        target_etag
    } else {
        JsValue::NULL
    };
    if !source.is_truthy()
        || property(&source, "etag") != property(&rename, "etag")
        || deleted(&source)
        || target_etag != property(&rename, "targetEtag")
    {
        return Err(hooks.error(
            409,
            "文章或目标地址在改址期间发生了变化，请重新打开文章后重试。",
        ));
    }
    Ok(())
}

pub async fn finish_rename(
    storage: &R2Bucket,
    state: &JsValue,
    known_release: &JsValue,
    hooks: &Hooks,
) -> JsResult<()> {
    let rename = property(state, "rename");
    if !rename.is_truthy() {
        return Ok(());
    }
    let from = attribute(&rename, "from");
    let to = attribute(&rename, "to");
    let etag = property(&rename, "etag");
    let id = property(state, "release_id");
    let target = head(storage, &to).await?;
    if property(&property(&target, "customMetadata"), "renameRelease") != id {
        let release = if known_release.is_truthy() {
            known_release.clone()
        } else {
            read_json(
                storage,
                &format!("releases/{}.json", attribute(state, "release_id")),
            )
            .await?
        };
        let published = own_property(&property(&release, "markdown_posts"), &to);
        if !published.is_truthy() {
            return Err(hooks.error(503, "改址后的原稿尚未就绪，请稍后重试。"));
        }
        let draft = hooks.parse_post(published.unchecked_ref())?;
        set(&property(&draft, "front_matter"), "draft", true)?;
        let text = hooks.serialize_post(&draft)?;
        let summary =
            crate::drafts::draft_summary(&draft, storage, &JsValue::UNDEFINED, hooks).await?;
        let metadata = summary;
        set(&metadata, "renameRelease", id.clone())?;
        let saved = save_renamed(
            storage,
            &to,
            &text,
            property(&rename, "targetEtag"),
            metadata,
        )
        .await?;
        if !saved.is_truthy() {
            let recovered = head(storage, &to).await?;
            if property(&property(&recovered, "customMetadata"), "renameRelease") != id {
                return Err(hooks.error(503, "新地址原稿正在恢复，请稍后重试；已发布正文仍保留。"));
            }
        }
    }
    let source = head(storage, &from).await?;
    if source.is_truthy() && !deleted(&source) && property(&source, "etag") == etag {
        retire(storage, &from, etag, &to, hooks).await?;
    }
    Ok(())
}

pub async fn rename_draft(
    request: &Request,
    storage: &R2Bucket,
    hooks: &Hooks,
    slug: &str,
) -> JsResult<Response> {
    check_slug(slug, hooks)?;
    let release = current_release(storage, hooks, &JsValue::UNDEFINED).await?;
    let input = JsFuture::from(hooks.json_input(request, 4096)?).await?;
    let Some(to) = property(&input, "slug").as_string() else {
        return Err(hooks.error(400, "请填写新的文章地址。"));
    };
    check_slug(&to, hooks)?;
    if busy(&read_json(storage, PENDING).await?) {
        return Err(hooks.error(409, "发布正在进行，请等待完成后再修改地址。"));
    }
    if !own_property(&property(&release, "markdown_posts"), slug).is_undefined() {
        return Err(hooks.error(409, "已发布文章请使用“修改地址并发布”。"));
    }
    let source = get(storage, &draft_key(slug)).await?;
    let metadata = property(&source, "customMetadata");
    let expected = property(&input, "etag");
    if deleted(&source)
        && property(&metadata, "renamedTo") == to
        && property(&metadata, "renameSourceEtag") == expected
    {
        let moved = get(storage, &draft_key(&to)).await?;
        if moved.is_truthy() && !deleted(&moved) && same_rename(&moved, slug, &expected) {
            let text = body_text(&moved).await?;
            return draft_response(hooks.parse_post(&text)?, text, property(&moved, "etag"));
        }
    }
    assert_writable(storage, slug, hooks).await?;
    if !source.is_truthy() || deleted(&source) {
        return Err(hooks.error(404, "草稿不存在。"));
    }
    let etag = property(&source, "etag");
    if !expected.is_string() || etag != expected {
        return Err(hooks.error(409, "文章已修改，请重新打开后再修改地址。"));
    }
    if js_number(&property(&source, "size")) > 2_000_000.0 {
        return Err(hooks.error(413, "原稿超过地址修改的大小限制。"));
    }
    let draft = hooks.parse_post(&body_text(&source).await?)?;
    let draft = with_address(&draft, &to, false, hooks)?;
    let body = hooks.serialize_post(&draft)?;
    let prior = get(storage, &draft_key(&to)).await?;
    if prior.is_truthy()
        && !deleted(&prior)
        && same_rename(&prior, slug, &etag)
        && body_text(&prior).await? == body
    {
        retire(storage, slug, etag, &to, hooks).await?;
        return draft_response(draft, body, property(&prior, "etag"));
    }
    let target = address_target(storage, &release, slug, &to, hooks).await?;
    let summary = crate::drafts::draft_summary(&draft, storage, &JsValue::UNDEFINED, hooks).await?;
    let metadata = summary;
    set(&metadata, "renameFrom", slug)?;
    set(&metadata, "renameSourceEtag", etag.clone())?;
    let saved = save_renamed(storage, &to, &body, property(&target, "etag"), metadata).await?;
    if !saved.is_truthy() {
        return Err(hooks.error(409, "目标地址刚刚被使用，请换一个。"));
    }
    retire(storage, slug, etag, &to, hooks).await?;
    draft_response(draft, body, property(&saved, "etag"))
}

async fn retire(
    storage: &R2Bucket,
    slug: &str,
    etag: JsValue,
    to: &str,
    hooks: &Hooks,
) -> JsResult<()> {
    let front = object(&[
        ("title", "已改址".into()),
        ("slug", slug.into()),
        ("date", "2000-01-01".into()),
        ("description", "".into()),
        ("draft", true.into()),
    ])?;
    let draft = object(&[("front_matter", front.into()), ("body_markdown", "".into())])?;
    let body = hooks.serialize_post(&draft)?;
    let options = only_if("etagMatches", etag.clone())?;
    let metadata = object(&[
        ("title", "已改址".into()),
        ("deleted", "true".into()),
        ("renamedTo", to.into()),
        ("renameSourceEtag", etag),
    ])?;
    set(&options, "customMetadata", metadata)?;
    if !JsFuture::from(storage.put(draft_key(slug), body.into(), options.into())?)
        .await?
        .is_truthy()
    {
        return Err(hooks.error(409, "原稿已变化，新的原稿仍保留，请重新打开。"));
    }
    Ok(())
}

async fn save_renamed(
    storage: &R2Bucket,
    slug: &str,
    text: &JsString,
    etag: JsValue,
    metadata: Object,
) -> JsResult<JsValue> {
    let options = if etag.is_truthy() {
        only_if("etagMatches", etag)?
    } else {
        only_if("etagDoesNotMatch", "*".into())?
    };
    set(&options, "customMetadata", metadata)?;
    set(
        &options,
        "httpMetadata",
        object(&[("contentType", "text/markdown; charset=utf-8".into())])?,
    )?;
    JsFuture::from(storage.put(draft_key(slug), text.clone().into(), options.into())?).await
}

fn draft_response(draft: JsValue, source: JsString, etag: JsValue) -> JsResult<Response> {
    json(
        200,
        &[("draft", draft), ("source", source.into()), ("etag", etag)],
    )
}

fn same_rename(draft: &JsValue, slug: &str, etag: &JsValue) -> bool {
    let metadata = property(draft, "customMetadata");
    property(&metadata, "renameFrom") == slug && property(&metadata, "renameSourceEtag") == *etag
}

fn draft_key(slug: &str) -> String {
    format!("drafts/{slug}.md")
}

async fn head(storage: &R2Bucket, slug: &str) -> JsResult<JsValue> {
    JsFuture::from(storage.head(draft_key(slug))?).await
}
