use std::collections::HashSet;

use worker::js_sys::{self, Date, JSON, JsString, Object, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Request, Response, Url, WorkerGlobalScope};
use worker::worker_sys::R2Bucket;

use crate::browser_publish::{
    self, PENDING, PUBLISHED, compatible, copy, entries, generated_files, is_hash, manifest_key,
    nonnegative_integer, string_array, write_state,
};
use crate::config::Config;
use crate::drafts::{Kind, deleted};
use crate::html_rewriter::JsResult;
use crate::http::{error, json_input};
use crate::page_rendering::valid_slug;
use crate::runtime::{
    attribute, body_text, encode_utf8, get, json_object, object, only_if, own_property,
    parse_object, property, read_json, set,
};
use crate::{image_references, models, site_assets, storage as r2};

const CORE_FILES: &[&str] = &[
    "index.html",
    "post/index.html",
    "archive/index.html",
    "shorts/index.html",
    "404.html",
    "styles.css",
    "client.js",
    "favicon.svg",
    "manifest.webmanifest",
    "sw.js",
    "search_index.json",
    "site.json",
    "_release.json",
];

pub async fn initialize(storage: &R2Bucket, site: &JsValue) -> JsResult<()> {
    if JsFuture::from(storage.head(PUBLISHED.to_owned())?)
        .await?
        .is_truthy()
    {
        return Ok(());
    }
    let id = r2::uuid()?;
    let release = object(&[
        ("schema_version", 1.into()),
        ("id", id.clone().into()),
        ("created_at", Date::new_0().to_iso_string().into()),
        ("site", site.clone()),
        ("markdown_posts", Object::new().into()),
    ])?;
    let about = property(site, "about");
    if about.is_truthy() {
        set(
            &release,
            "about_markdown",
            about_source(about.unchecked_ref()),
        )?;
    }
    let index = object(&[
        ("schema_version", 1.into()),
        ("id", id.clone().into()),
        ("site", site.clone()),
        ("posts", Object::new().into()),
    ])?;
    put_json(storage, &format!("releases/{id}.posts.json"), &index).await?;
    put_json(storage, &format!("releases/{id}.json"), &release).await?;
    let value_or_empty = |field| {
        let value = property(site, field);
        if value.is_truthy() { value } else { "".into() }
    };
    let pointer = object(&[
        ("id", id.into()),
        ("clarityId", value_or_empty("clarityId")),
        ("siteIcon", value_or_empty("siteIcon")),
    ])?;
    let icon_size = property(site, "siteIconSize");
    if icon_size.is_truthy() {
        set(&pointer, "siteIconSize", icon_size)?;
    }
    let condition = only_if("etagDoesNotMatch", "*".into())?;
    JsFuture::from(storage.put(
        PUBLISHED.to_owned(),
        JSON::stringify(&pointer)?.into(),
        condition.into(),
    )?)
    .await?;
    Ok(())
}

fn about_source(body: &JsString) -> JsString {
    JsString::from("+++\ntitle = \"About\"\ndescription = \"\"\n+++\n\n").concat(body)
}

pub async fn current_release(storage: &R2Bucket, snapshot: &JsValue) -> JsResult<JsValue> {
    let pointer = if snapshot.is_undefined() {
        read_json(storage, PUBLISHED).await?
    } else {
        snapshot.clone()
    };
    if !pointer.is_truthy() {
        return Err(crate::http::error(
            503,
            "网站内容尚未初始化，请完成后台首次设置。",
        ));
    }
    let release = read_json(
        storage,
        &format!("releases/{}.json", attribute(&pointer, "id")),
    )
    .await?;
    if !release.is_truthy() {
        return Err(crate::http::error(503, "网站内容版本缺失，请联系维护者。"));
    }
    Ok(release)
}

pub async fn status(storage: &R2Bucket, locked: bool, snapshot: &JsValue) -> JsResult<JsValue> {
    let pending = get(storage, PENDING).await?;
    if !pending.is_truthy() {
        return Ok(JsValue::NULL);
    }
    let state = parse_object(&pending).await?;
    if !busy(&state) {
        return Ok(state);
    }
    let pointer = if snapshot.is_undefined() {
        read_json(storage, PUBLISHED).await?
    } else {
        snapshot.clone()
    };
    let current = property(&pointer, "id") == property(&state, "release_id");
    if current && property(&state, "rename").is_truthy() && !locked {
        let result = r2::with_mutation(storage, |guarded| async move {
            Box::pin(status(&guarded, true, &JsValue::UNDEFINED)).await
        })
        .await;
        return match result {
            Err(error) if crate::http::status(&error) == Some(503) => {
                let pending = copy(&state);
                set(&pending, "status", "built")?;
                Ok(pending.into())
            }
            result => result,
        };
    }
    if current {
        set(&state, "status", "deployed")?;
    }
    if busy(&state) && Date::now() - Date::parse(&attribute(&state, "started_at")) > 30.0 * 60_000.0
    {
        let id = attribute(&state, "release_id");
        let response = browser_publish::cancel(storage, &id).await?;
        return JsFuture::from(response.json()?).await;
    }
    let status = attribute(&state, "status");
    if status == "deployed" {
        crate::post_addresses::finish_rename(storage, &state, &JsValue::UNDEFINED).await?;
    }
    if matches!(status.as_str(), "deployed" | "failed") {
        write_state(storage, PENDING, &state, &pending).await?;
    }
    Ok(state)
}

pub async fn publish(request: &Request, storage: &R2Bucket, config: &Config) -> JsResult<Response> {
    let input = json_input(request, 4096).await?;
    status(storage, true, &JsValue::UNDEFINED).await?;
    let previous = get(storage, PENDING).await?;
    if previous.is_truthy() && busy(&parse_object(&previous).await?) {
        return Err(error(409, "上一次发布还在进行中，请等待完成。"));
    }
    let base = current_release(storage, &JsValue::UNDEFINED).await?;
    let release = copy(&base);
    set(&release, "site", copy(&property(&base, "site")))?;
    set(
        &release,
        "markdown_posts",
        copy(&property(&base, "markdown_posts")),
    )?;
    let shorts = property(&base, "markdown_shorts");
    if shorts.is_truthy() {
        set(&release, "markdown_shorts", copy(&shorts))?;
    }
    let id = js_sys::global()
        .unchecked_into::<WorkerGlobalScope>()
        .crypto()?
        .random_uuid();
    set(&release, "id", id.clone())?;
    set(&release, "created_at", Date::new_0().to_iso_string())?;
    let origin = Url::new(&request.url())?.origin();
    let rename = apply_requested_change(&input, &release, &base, storage, &origin).await?;
    crate::post_addresses::redirects(&release)?;
    if encode_utf8(&JSON::stringify(&release)?).length() > 16_000_000 {
        return Err(error(413, "网站内容超过当前版本的发布大小限制。"));
    }
    let site = property(&release, "site");
    site_assets::ensure_illustration(storage, &site).await?;
    site_assets::ensure_icon(storage, &site).await?;
    let base_id = property(&base, "id");
    let pending = object(&[
        ("release_id", id.clone().into()),
        ("previous_id", base_id.clone()),
        ("template_version", config.template_version.into()),
        ("response_version", config.response_version.into()),
        ("generation_version", config.generation_version.into()),
        (
            "force_rebuild",
            (property(&input, "rebuild") == JsValue::TRUE).into(),
        ),
        ("status", "queued".into()),
        ("started_at", Date::new_0().to_iso_string().into()),
    ])?;
    if let Some(rename) = rename {
        set(&pending, "rename", rename)?;
    }
    let files = required_pages(&release)?;
    if files.len() > 750 {
        return Err(error(413, "当前网页数量超过发布限制。"));
    }
    set(&pending, "files", string_array(&files))?;
    select_render_files(storage, &pending, &base, &release).await?;
    let saved = write_state(storage, PENDING, &pending, &previous).await?;
    if !saved.is_truthy() {
        return Err(error(409, "另一个发布正在启动，请刷新后重试。"));
    }
    let prepared = async {
        let prior = crate::post_index::read(storage, &attribute(&base, "id")).await?;
        let index = crate::post_index::build(&release, &base, &prior).await?;
        put_json(storage, &format!("releases/{id}.posts.json"), &index).await?;
        put_json(storage, &format!("releases/{id}.json"), &release).await?;
        claim(storage, &pending).await?;
        let response = copy(&pending);
        set(&response, "incremental", true)?;
        set(&response, "browser_release", release)?;
        json_object(202, &response)
    }
    .await;
    if prepared.is_err() {
        browser_publish::cancel(storage, &id).await?;
        return Err(error(
            503,
            "发布暂时未能准备好；草稿和线上版本已保留，请重试。",
        ));
    }
    prepared
}

async fn apply_requested_change(
    input: &JsValue,
    release: &Object,
    base: &JsValue,
    storage: &R2Bucket,
    origin: &str,
) -> JsResult<Option<Object>> {
    let rename_to = property(input, "renameTo");
    if !rename_to.is_undefined() && !rename_to.is_string() {
        return Err(error(400, "新文章地址格式不正确。"));
    }
    let mut rename = None;
    let posts: Object = property(release, "markdown_posts").unchecked_into();
    if let Some(slug) = property(input, "slug").as_string() {
        check_slug(&slug)?;
        let draft = get(storage, &format!("drafts/{slug}.md")).await?;
        if !draft.is_truthy() {
            return Err(error(404, "请先保存这篇文章的草稿。"));
        }
        let etag = property(&draft, "etag");
        if property(input, "etag") != etag {
            return Err(error(409, "文章刚刚发生了修改，请保存最新版本后再发布。"));
        }
        let mut parsed = models::parse_source(&body_text(&draft).await?, Kind::Post)?;
        if deleted(&draft) {
            return Err(error(409, "文章已删除或改址，请重新打开。"));
        }
        let published = !own_property(&property(base, "markdown_posts"), &slug).is_undefined();
        let target = if let Some(target) = rename_to.as_string() {
            if !published {
                return Err(error(409, "这篇文章尚未发布，请先修改草稿地址，再发布。"));
            }
            check_slug(&target)?;
            let reserved =
                crate::post_addresses::address_target(storage, base, &slug, &target).await?;
            parsed = crate::post_addresses::with_address(&parsed, &target, true)?;
            let old = property(&reserved, "etag");
            rename = Some(object(&[
                ("from", slug.clone().into()),
                ("to", target.clone().into()),
                ("etag", etag),
                (
                    "targetEtag",
                    if old.is_truthy() { old } else { JsValue::NULL },
                ),
            ])?);
            Reflect::delete_property(&posts, &slug.into())?;
            target
        } else {
            slug
        };
        let front = property(&parsed, "front_matter");
        set(&front, "draft", false)?;
        if published {
            set(
                &front,
                "updated",
                Date::new_0().to_iso_string().slice(0, 10),
            )?;
        }
        crate::runtime::set_own(&posts, &target, models::serialize(&parsed)?.into())?;
    } else if let Some(slug) = property(input, "shortSlug").as_string() {
        check_slug(&slug)?;
        let draft = get(storage, &format!("shorts/{slug}.md")).await?;
        if !draft.is_truthy() {
            return Err(error(404, "请先保存这条短记的草稿。"));
        }
        if property(input, "etag") != property(&draft, "etag") {
            return Err(error(409, "短记刚刚发生了修改，请保存最新版本后再发布。"));
        }
        if deleted(&draft) {
            return Err(error(409, "短记已删除，请重新打开。"));
        }
        let source = body_text(&draft).await?;
        image_references::ensure(storage, &source, origin).await?;
        let parsed = models::parse_source(&source, Kind::Short)?;
        set(&property(&parsed, "front_matter"), "draft", false)?;
        let shorts = copy(&property(release, "markdown_shorts"));
        crate::runtime::set_own(&shorts, &slug, models::serialize(&parsed)?.into())?;
        set(release, "markdown_shorts", shorts)?;
    } else if let Some(slug) = property(input, "unpublishShort").as_string() {
        check_slug(&slug)?;
        let shorts = property(release, "markdown_shorts");
        if shorts.is_truthy() {
            Reflect::delete_property::<JsValue>(shorts.unchecked_ref(), &slug.into())?;
        }
    } else if let Some(slug) = property(input, "unpublish").as_string() {
        check_slug(&slug)?;
        Reflect::delete_property(&posts, &slug.into())?;
    } else if property(input, "settings") == JsValue::TRUE {
        let site = read_json(storage, "draft-site.json").await?;
        if !site.is_truthy() {
            return Err(error(400, "请先保存网站信息。"));
        }
        let site = models::validate_site(&site)?;
        let about = property(&site, "about");
        set(release, "site", site)?;
        if !about.is_undefined() {
            Reflect::delete_property(release, &"about_markdown".into())?;
            let about: JsString = about.unchecked_into();
            if about.trim().length() != 0 {
                set(release, "about_markdown", about_source(&about))?;
            }
        }
    } else if property(input, "rebuild") != JsValue::TRUE {
        return Err(error(400, "请选择要发布的文章或网站信息。"));
    }
    if !rename_to.is_undefined() && rename.is_none() {
        return Err(error(400, "请选择需要改址的文章。"));
    }
    Ok(rename)
}

fn required_pages(release: &JsValue) -> JsResult<Vec<String>> {
    let mut posts = Vec::new();
    for (slug, source) in entries(&property(release, "markdown_posts")) {
        let draft = models::parse_source(source.unchecked_ref(), Kind::Post)?;
        let front = property(&draft, "front_matter");
        if property(&front, "slug") != slug {
            return Err(error(400, "文章地址与原稿不一致。"));
        }
        if !property(&front, "draft").is_truthy() {
            posts.push(slug);
        }
    }
    let mut shorts = 0usize;
    for (slug, source) in entries(&property(release, "markdown_shorts")) {
        let draft = models::parse_source(source.unchecked_ref(), Kind::Short)?;
        let front = property(&draft, "front_matter");
        if property(&front, "slug") != slug {
            return Err(error(400, "短记地址与原稿不一致。"));
        }
        if !property(&front, "draft").is_truthy() {
            shorts += 1;
        }
    }
    let mut files: Vec<_> = CORE_FILES.iter().map(|path| (*path).to_owned()).collect();
    files.extend(
        (2..=posts.len().div_ceil(10)).map(|number| format!("post/page/{number}/index.html")),
    );
    files.extend((2..=shorts.div_ceil(3)).map(|number| format!("shorts/page/{number}/index.html")));
    if property(release, "about_markdown").is_truthy() {
        files.push("about/index.html".to_owned());
    }
    posts.sort();
    files.extend(posts.iter().map(|slug| format!("posts/{slug}/index.html")));
    Ok(files)
}

async fn select_render_files(
    storage: &R2Bucket,
    state: &JsValue,
    base: &JsValue,
    release: &JsValue,
) -> JsResult<()> {
    let active = read_json(storage, PUBLISHED).await?;
    if !compatible(&active, state)
        || JSON::stringify(&property(base, "site"))? != JSON::stringify(&property(release, "site"))?
        || property(base, "about_markdown") != property(release, "about_markdown")
    {
        return Ok(());
    }
    let prior = read_json(storage, &manifest_key(&attribute(base, "id"))).await?;
    let sizes = property(&prior, "sizes");
    if !sizes.is_truthy() {
        return Ok(());
    }
    let files = generated_files(state);
    let mut changed = HashSet::from(["_release.json".to_owned()]);
    let earlier = property(base, "markdown_posts");
    let current = property(release, "markdown_posts");
    let altered: Vec<_> = entries(&earlier)
        .chain(entries(&current))
        .map(|(slug, _)| slug)
        .filter(|slug| property(&earlier, slug) != property(&current, slug))
        .collect();
    if !altered.is_empty() {
        changed.extend(
            [
                "index.html",
                "post/index.html",
                "archive/index.html",
                "search_index.json",
            ]
            .map(str::to_owned),
        );
        changed.extend(
            altered
                .iter()
                .map(|slug| format!("posts/{slug}/index.html")),
        );
        changed.extend(
            files
                .iter()
                .filter(|page| page.starts_with("post/page/"))
                .cloned(),
        );
    }
    let earlier = copy(&property(base, "markdown_shorts"));
    let current = copy(&property(release, "markdown_shorts"));
    if JSON::stringify(&earlier)? != JSON::stringify(&current)? {
        changed.extend(["index.html".to_owned(), "shorts/index.html".to_owned()]);
        changed.extend(
            files
                .iter()
                .filter(|page| page.starts_with("shorts/page/"))
                .cloned(),
        );
    }
    let prior_pages = property(&prior, "pages");
    let files: Vec<_> = files
        .into_iter()
        .filter(|path| {
            changed.contains(path)
                || !is_hash(&property(&prior_pages, path))
                || !property(&sizes, path)
                    .as_f64()
                    .is_some_and(nonnegative_integer)
        })
        .collect();
    set(state, "render_files", string_array(&files))
}

async fn claim(storage: &R2Bucket, state: &JsValue) -> JsResult<()> {
    let pointer = get(storage, PUBLISHED).await?;
    let conflict = || error(409, "线上版本已经变化，请重新发布。");
    if !pointer.is_truthy() {
        return Err(conflict());
    }
    let current = parse_object(&pointer).await?;
    if property(&current, "id") != property(state, "previous_id") {
        return Err(conflict());
    }
    let claimed = copy(&current);
    set(&claimed, "publishing", property(state, "release_id"))?;
    if !write_state(storage, PUBLISHED, &claimed, &pointer)
        .await?
        .is_truthy()
    {
        return Err(conflict());
    }
    Ok(())
}

async fn put_json(storage: &R2Bucket, key: &str, value: &JsValue) -> JsResult<JsValue> {
    JsFuture::from(storage.put(
        key.to_owned(),
        JSON::stringify(value)?.into(),
        JsValue::UNDEFINED,
    )?)
    .await
}

pub fn check_slug(slug: &str) -> JsResult<()> {
    if valid_slug(slug) {
        Ok(())
    } else {
        Err(error(
            400,
            "文章地址只能使用英文字母、数字、短横线和下划线（最多 100 个字符）。",
        ))
    }
}

pub fn busy(state: &JsValue) -> bool {
    matches!(
        attribute(state, "status").as_str(),
        "queued" | "building" | "built"
    )
}
