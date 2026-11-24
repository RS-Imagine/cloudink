use std::cmp::Ordering;
use std::collections::HashMap;

use futures_util::try_join;
use worker::js_sys::{Array, JSON, JsString, Object};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;
use worker::web_sys::{Response, Url};
use worker::worker_sys::R2Bucket;

use crate::config::Config;
use crate::drafts::{Kind, deleted};
use crate::html_rewriter::JsResult;
use crate::http::error;
use crate::page_rendering::valid_slug;
use crate::runtime::{
    attribute, digest_text, js_number, json, list, object, own_property, property, read_json, set,
};

thread_local! {
    static LOCALE: (Array, Object) = (Array::new(), Object::new());
}

pub async fn posts(
    url: &Url,
    storage: &R2Bucket,
    config: &Config,
    session: &JsValue,
) -> JsResult<Response> {
    let pointer = published_pointer(storage).await?;
    let id = attribute(&pointer, "id");
    let status = crate::publishing::status(storage, false, &pointer);
    let index = crate::post_index::read(storage, &id);
    let (publishing, drafts, saved_site, index) = try_join!(
        status,
        list_active(storage, Kind::Post),
        read_json(storage, "draft-site.json"),
        index,
    )?;
    let index = if index.is_truthy() {
        index
    } else {
        build_index(storage, &pointer).await?
    };
    let released = property(&index, "site");
    let published = property(&index, "posts");
    let redirects = property(&pointer, "postRedirects");
    let pages = property(&pointer, "pages");
    let initialized = property(&pages, "index.html").is_truthy()
        || (!pages.is_truthy()
            && JsFuture::from(
                storage.head(format!("public/{}/index.html", attribute(&pointer, "id")))?,
            )
            .await?
            .is_truthy());
    let template_status = if !initialized {
        "unpublished"
    } else if property(&pointer, "templateVersion") == config.template_version
        && property(&pointer, "generationVersion") == config.generation_version
    {
        "current"
    } else {
        "outdated"
    };
    let mut rows = Rows::default();
    for (slug, post) in entries(&published) {
        let response = object(&[
            ("title", property(&post, "title")),
            ("slug", slug.clone().into()),
            ("date", property(&post, "date")),
            ("description", property(&post, "description")),
        ])?;
        let updated = property(&post, "updated");
        if updated.is_truthy() {
            set(&response, "updated", updated)?;
        }
        let aliases = property(&post, "aliases");
        if property(&aliases, "length").is_truthy() {
            set(&response, "aliases", aliases)?;
        }
        set(&response, "draft", property(&post, "draft"))?;
        set(&response, "published", true)?;
        set(&response, "has_draft", false)?;
        set(&response, "changed", false)?;
        rows.replace(slug, response);
    }
    for draft in &drafts {
        let slug = slug_from_key(draft);
        if !own_property(&redirects, &slug).is_undefined() {
            continue;
        }
        let meta = property(draft, "customMetadata");
        let released = own_property(&published, &slug);
        rows.replace(
            slug.clone(),
            object(&[
                ("slug", slug.clone().into()),
                ("title", value_or(property(&meta, "title"), slug.into())),
                ("date", value_or(property(&meta, "date"), "".into())),
                (
                    "description",
                    value_or(property(&meta, "description"), "".into()),
                ),
                ("published", (!released.is_undefined()).into()),
                ("has_draft", true.into()),
                (
                    "changed",
                    (property(&released, "digest") != property(&meta, "digest")).into(),
                ),
                ("etag", property(draft, "etag")),
            ])?,
        );
    }
    rows.sort(Kind::Post);
    let total = rows.values.len();
    let live = rows
        .values
        .iter()
        .filter(|row| property(row, "published").is_truthy())
        .count();
    let counts = object(&[
        ("total", total.into()),
        ("published", live.into()),
        ("draft", (total - live).into()),
    ])?;
    let params = url.search_params();
    let limit =
        limit(params.get("limit"), total).ok_or_else(|| error(400, "文章列表分页参数不正确。"))?;
    let query = JsString::from(params.get("q").unwrap_or_default())
        .trim()
        .to_lower_case();
    let filter = params
        .get("filter")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "all".to_owned());
    if query.length() > 300 || !matches!(filter.as_str(), "all" | "published" | "draft") {
        return Err(error(400, "文章列表分页参数不正确。"));
    }
    let query_text = query.as_string().unwrap_or_default();
    let selected: Vec<_> = rows
        .values
        .into_iter()
        .filter(|row| {
            let searchable = format!(
                "{} {} {}",
                attribute(row, "title"),
                attribute(row, "description"),
                attribute(row, "slug")
            );
            (query_text.is_empty()
                || JsString::from(searchable)
                    .to_lower_case()
                    .as_string()
                    .is_some_and(|text| text.contains(&query_text)))
                && (filter == "all"
                    || (filter == "published") == property(row, "published").is_truthy())
        })
        .collect();
    let snapshot = snapshot(id.into(), &drafts, Some((query, filter))).await?;
    let matching = selected.len();
    let cursor = params.get("cursor").filter(|value| !value.is_empty());
    let offset = read_cursor(cursor, &snapshot, matching, "文章列表已变化，请重新读取。")?;
    let page: Array = selected
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(JsValue::from)
        .collect();
    let appearance = if saved_site.is_truthy() {
        &saved_site
    } else {
        &released
    };
    let appearance = object(&[
        (
            "themePalette",
            value_or(property(appearance, "themePalette"), "ink".into()),
        ),
        (
            "readingFont",
            value_or(property(appearance, "readingFont"), "serif".into()),
        ),
        (
            "siteIcon",
            value_or(property(appearance, "siteIcon"), "".into()),
        ),
        (
            "siteIconSize",
            value_or(property(appearance, "siteIconSize"), 0.into()),
        ),
        (
            "homeIllustration",
            value_or(property(appearance, "homeIllustration"), "".into()),
        ),
    ])?;
    json(
        200,
        &[
            ("posts", page.into()),
            ("counts", counts.into()),
            ("matching", matching.into()),
            ("cursor", next_cursor(snapshot, offset, limit, matching)?),
            ("site", released),
            ("appearance", appearance.into()),
            ("publishing", publishing),
            ("email", property(session, "email")),
            ("csrf", property(session, "csrf")),
            ("publicInitialized", initialized.into()),
            ("templateStatus", template_status.into()),
        ],
    )
}

pub async fn shorts(url: &Url, storage: &R2Bucket) -> JsResult<Response> {
    let pointer = published_pointer(storage).await?;
    let id = attribute(&pointer, "id");
    let stored = crate::post_index::read(storage, &id).await?;
    let index = if property(&stored, "shorts").is_truthy() {
        stored
    } else {
        build_index(storage, &pointer).await?
    };
    let published = property(&index, "shorts");
    let mut rows = Rows::default();
    for (slug, short) in entries(&published) {
        rows.replace(
            slug.clone(),
            object(&[
                ("slug", slug.into()),
                ("date", property(&short, "date")),
                ("published", true.into()),
                ("has_draft", false.into()),
                ("snippet", property(&short, "snippet")),
            ])?,
        );
    }
    let drafts = list_active(storage, Kind::Short).await?;
    for draft in &drafts {
        let slug = slug_from_key(draft);
        if !valid_slug(&slug) {
            continue;
        }
        let meta = property(draft, "customMetadata");
        let released = own_property(&published, &slug);
        let date = value_or(
            property(&meta, "date"),
            value_or(property(&released, "date"), "".into()),
        );
        let snippet = property(&meta, "snippet");
        let snippet = if snippet.is_undefined() || snippet.is_null() {
            let published = property(&released, "snippet");
            if published.is_undefined() || published.is_null() {
                "".into()
            } else {
                published
            }
        } else {
            snippet
        };
        rows.replace(
            slug.clone(),
            object(&[
                ("slug", slug.into()),
                ("date", date),
                ("published", (!released.is_undefined()).into()),
                ("has_draft", true.into()),
                ("etag", property(draft, "etag")),
                ("snippet", snippet),
            ])?,
        );
    }
    rows.sort(Kind::Short);
    let total = rows.values.len();
    let params = url.search_params();
    let limit =
        limit(params.get("limit"), total).ok_or_else(|| error(400, "短记分页参数不正确。"))?;
    let snapshot = snapshot(id.into(), &drafts, None).await?;
    let offset = read_cursor(
        params.get("cursor"),
        &snapshot,
        total,
        "短记列表已变化，请重新读取。",
    )?;
    let page: Array = rows
        .values
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(JsValue::from)
        .collect();
    json(
        200,
        &[
            ("shorts", page.into()),
            ("total", total.into()),
            ("cursor", next_cursor(snapshot, offset, limit, total)?),
        ],
    )
}

async fn published_pointer(storage: &R2Bucket) -> JsResult<JsValue> {
    let pointer = read_json(storage, "state/published.json").await?;
    if pointer.is_truthy() {
        Ok(pointer)
    } else {
        Err(error(503, "网站内容尚未初始化。"))
    }
}

async fn build_index(storage: &R2Bucket, pointer: &JsValue) -> JsResult<JsValue> {
    let release = crate::publishing::current_release(storage, pointer).await?;
    crate::post_index::build(&release, &JsValue::UNDEFINED, &JsValue::UNDEFINED).await
}

pub async fn list_active(storage: &R2Bucket, kind: Kind) -> JsResult<Vec<JsValue>> {
    let mut objects = Vec::new();
    let mut cursor = JsValue::UNDEFINED;
    let mut scanned = 0;
    loop {
        let page = list(
            storage,
            kind.storage_prefix(),
            cursor,
            1000,
            &["customMetadata"],
        )
        .await?;
        scanned += page.objects.length();
        if scanned > 10_000 {
            return Err(error(
                413,
                "原稿目录超过安全扫描上限，请联系维护者整理删除标记。",
            ));
        }
        objects.extend(page.objects.iter().filter(|item| !deleted(item)));
        if objects.len() > 2_000 {
            return Err(error(413, "有效原稿超过 2000 篇，暂时无法完整读取。"));
        }
        cursor = page.cursor;
        if !cursor.is_truthy() {
            return Ok(objects);
        }
    }
}

#[derive(Default)]
struct Rows {
    values: Vec<Object>,
    positions: HashMap<String, usize>,
}

impl Rows {
    fn replace(&mut self, slug: String, item: Object) {
        let position = *self.positions.entry(slug).or_insert(self.values.len());
        if position == self.values.len() {
            self.values.push(item);
        } else {
            self.values[position] = item;
        }
    }

    fn sort(&mut self, kind: Kind) {
        self.values.sort_by(|a, b| {
            compare(b, a, "date").then_with(|| {
                if kind == Kind::Post {
                    compare(b, a, "slug")
                } else {
                    compare(a, b, "slug")
                }
            })
        });
    }
}

fn compare(a: &Object, b: &Object, field: &str) -> Ordering {
    let left = JsString::from(attribute(a, field));
    let right = attribute(b, field);
    LOCALE.with(|(locales, options)| left.locale_compare(&right, locales, options).cmp(&0))
}

fn entries(value: &JsValue) -> impl Iterator<Item = (String, JsValue)> {
    let entries = if value.is_truthy() {
        Object::entries(value.unchecked_ref())
    } else {
        Array::new()
    };
    entries.to_vec().into_iter().map(|entry| {
        let entry: Array = entry.unchecked_into();
        (entry.get(0).as_string().unwrap_or_default(), entry.get(1))
    })
}

fn slug_from_key(draft: &JsValue) -> String {
    let key: JsString = property(draft, "key").unchecked_into();
    key.slice(7, key.length().saturating_sub(3))
        .as_string()
        .unwrap_or_default()
}

fn value_or(value: JsValue, fallback: JsValue) -> JsValue {
    if value.is_truthy() { value } else { fallback }
}

fn limit(raw: Option<String>, count: usize) -> Option<usize> {
    match raw {
        None => Some(count.max(1)),
        Some(raw) => {
            let limit = js_number(&raw.into());
            (limit.fract() == 0.0 && (1.0..=100.0).contains(&limit)).then_some(limit as usize)
        }
    }
}

async fn snapshot(
    id: JsValue,
    drafts: &[JsValue],
    filter: Option<(JsString, String)>,
) -> JsResult<String> {
    let keys: Array = drafts
        .iter()
        .map(|draft| {
            JsValue::from(
                [property(draft, "key"), property(draft, "etag")]
                    .into_iter()
                    .collect::<Array>(),
            )
        })
        .collect::<Array>();
    let input: Array = [id, keys.into()].into_iter().collect();
    if let Some((query, filter)) = filter {
        input.push(&query);
        input.push(&filter.into());
    }
    digest_text(&JSON::stringify(&input)?).await
}

fn read_cursor(
    cursor: Option<String>,
    snapshot: &str,
    count: usize,
    stale: &str,
) -> JsResult<usize> {
    let Some(cursor) = cursor else { return Ok(0) };
    let invalid = || error(400, "分页位置不正确。");
    let cursor = JSON::parse(&cursor).map_err(|_| invalid())?;
    if property(&cursor, "snapshot") != snapshot {
        return Err(error(409, stale));
    }
    property(&cursor, "offset")
        .as_f64()
        .filter(|offset| offset.fract() == 0.0 && *offset >= 0.0 && *offset <= count as f64)
        .map(|offset| offset as usize)
        .ok_or_else(invalid)
}

fn next_cursor(snapshot: String, offset: usize, limit: usize, count: usize) -> JsResult<JsValue> {
    let offset = offset + limit;
    if offset >= count {
        return Ok(JsValue::NULL);
    }
    let cursor = object(&[("snapshot", snapshot.into()), ("offset", offset.into())])?;
    Ok(JSON::stringify(&cursor)?.into())
}
