use worker::js_sys::Object;
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Bucket, Response, Result};

use crate::{feed::append_element, public_response, valid_post_slug};

const SECTIONS: [&str; 4] = ["about", "post", "archive", "shorts"];

pub fn robots(origin: &str) -> Result<Response> {
    let body = format!(
        "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: {origin}/sitemap.xml\n"
    );
    public_response(Response::ok(body)?, "text/plain; charset=utf-8")
}

pub async fn sitemap(
    origin: &str,
    storage: &Bucket,
    release: Option<&str>,
    pages: &JsValue,
) -> Result<Response> {
    let mut paths = vec!["/".to_owned()];
    if pages.is_truthy() {
        let keys = Object::keys(pages.unchecked_ref::<Object>());
        for key in keys.iter().filter_map(|key| key.as_string()) {
            if let Some(path) = key
                .strip_suffix("/index.html")
                .filter(|path| mapped_path(path))
            {
                paths.push(format!("/{path}/"));
            }
        }
    } else if let Some(id) = release {
        let prefix = format!("public/{id}/");
        if storage.head(format!("{prefix}index.html")).await?.is_some() {
            for section in SECTIONS {
                if storage
                    .head(format!("{prefix}{section}/index.html"))
                    .await?
                    .is_some()
                {
                    paths.push(format!("/{section}/"));
                }
            }
            let post_prefix = format!("{prefix}posts/");
            let mut cursor = None;
            loop {
                let mut list = storage.list().prefix(&post_prefix).limit(1000);
                if let Some(token) = cursor.take() {
                    list = list.cursor(token);
                }
                let page = list.execute().await?;
                for object in page.objects() {
                    let key = object.key();
                    if let Some(slug) = key
                        .strip_prefix(&post_prefix)
                        .and_then(|key| key.strip_suffix("/index.html"))
                        .filter(|slug| valid_post_slug(slug))
                    {
                        paths.push(format!("/posts/{slug}/"));
                    }
                }
                if paths.len() > 50_000 {
                    return Response::builder()
                        .with_status(503)
                        .ok("Sitemap limit exceeded");
                }
                cursor = page
                    .truncated()
                    .then(|| page.cursor())
                    .flatten()
                    .filter(|cursor| !cursor.is_empty());
                if cursor.is_none() {
                    break;
                }
            }
        }
    }

    paths.sort_unstable();
    let mut body = String::from(concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
    ));
    for path in paths {
        body.push_str("<url>");
        append_element(&mut body, "loc", &format!("{origin}{path}"));
        body.push_str("</url>");
    }
    body.push_str("</urlset>");
    public_response(Response::ok(body)?, "application/xml; charset=utf-8")
}

fn mapped_path(path: &str) -> bool {
    SECTIONS.contains(&path)
        || path.strip_prefix("posts/").is_some_and(valid_post_slug)
        || path.split_once("/page/").is_some_and(|(section, page)| {
            matches!(section, "post" | "shorts")
                && !page.is_empty()
                && !page.starts_with('0')
                && page.bytes().all(|digit| digit.is_ascii_digit())
        })
}
