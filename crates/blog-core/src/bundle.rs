//! Generate the same static pages in a browser, without filesystem access.
use crate::{content, content_hash, models::SiteConfig, render};
use anyhow::{ensure, Result};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
pub struct ReleaseBundle {
    pub schema_version: u32,
    pub id: String,
    pub created_at: String,
    pub site: SiteConfig,
    pub markdown_posts: BTreeMap<String, String>,
    #[serde(default)]
    pub markdown_shorts: BTreeMap<String, String>,
    pub about_markdown: Option<String>,
    #[serde(default)]
    pub render_paths: Option<Vec<String>>,
}

pub fn render_release(input: &str) -> Result<BTreeMap<String, String>> {
    let release: ReleaseBundle = serde_json::from_str(input)?;
    ensure!(release.schema_version == 1, "Unsupported release schema");
    let paths = release
        .render_paths
        .as_ref()
        .map(|paths| paths.iter().collect::<BTreeSet<_>>());
    let wants = |path: &str| {
        paths
            .as_ref()
            .is_none_or(|paths| paths.iter().any(|value| value.as_str() == path))
    };
    if let Some(paths) = &paths {
        ensure!(paths.len() <= 750, "Too many render paths");
        for path in paths {
            let post_slug = path
                .strip_prefix("posts/")
                .and_then(|path| path.strip_suffix("/index.html"));
            ensure!(
                matches!(
                    path.as_str(),
                    "index.html"
                        | "archive/index.html"
                        | "shorts/index.html"
                        | "404.html"
                        | "styles.css"
                        | "client.js"
                        | "favicon.svg"
                        | "search_index.json"
                        | "site.json"
                        | "_release.json"
                        | "about/index.html"
                ) || post_slug.is_some_and(|slug| release.markdown_posts.contains_key(slug)),
                "Unknown render path"
            );
        }
    }
    let aggregates =
        wants("index.html") || wants("archive/index.html") || wants("search_index.json");
    let mut posts = Vec::new();
    for (slug, source) in &release.markdown_posts {
        if !aggregates && !wants(&format!("posts/{slug}/index.html")) {
            continue;
        }
        let post = content::parse_post(source)?;
        ensure!(
            post.slug() == slug,
            "Article slug does not match its source key"
        );
        if !post.draft() {
            posts.push(post);
        }
    }
    posts.sort_by(|a, b| {
        b.updated()
            .unwrap_or(b.date())
            .cmp(a.updated().unwrap_or(a.date()))
            .then_with(|| b.slug().cmp(a.slug()))
    });
    let css_hash = content_hash(render::stylesheet());
    let mut files = BTreeMap::new();
    if wants("styles.css") {
        files.insert("styles.css".into(), render::stylesheet().into());
    }
    if wants("client.js") {
        files.insert("client.js".into(), render::client_script().into());
    }
    if wants("favicon.svg") {
        files.insert("favicon.svg".into(), render::favicon_svg().into());
    }
    if wants("manifest.webmanifest") {
        files.insert("manifest.webmanifest".into(), render::manifest_json().into());
    }
    if wants("index.html") {
        files.insert(
            "index.html".into(),
            render::render_index(&release.site, &posts, &css_hash),
        );
    }
    if wants("archive/index.html") {
        files.insert(
            "archive/index.html".into(),
            render::render_archive(&release.site, &posts, &css_hash),
        );
    }
    if wants("404.html") {
        files.insert(
            "404.html".into(),
            render::render_404(&release.site, &css_hash),
        );
    }
    if let Some(source) = release.about_markdown {
        if wants("about/index.html") {
            files.insert(
                "about/index.html".into(),
                render::render_page(&release.site, &content::parse_page(&source)?, &css_hash),
            );
        }
    }
    for post in &posts {
        if wants(&format!("posts/{}/index.html", post.slug())) {
            files.insert(
                format!("posts/{}/index.html", post.slug()),
                render::render_post(&release.site, post, &css_hash),
            );
        }
    }
    let mut shorts = Vec::new();
    for (slug, source) in &release.markdown_shorts {
        if !wants("shorts/index.html") {
            break;
        }
        let short = content::parse_short(source)?;
        ensure!(
            short.slug() == slug,
            "Short slug does not match its source key"
        );
        if !short.draft() {
            shorts.push(short);
        }
    }
    shorts.sort_by(|a, b| b.date().cmp(a.date()).then_with(|| b.slug().cmp(a.slug())));
    if wants("shorts/index.html") {
        files.insert(
            "shorts/index.html".into(),
            render::render_shorts(&release.site, &shorts, &css_hash),
        );
    }
    let index: Vec<_> = posts.iter().map(|post| serde_json::json!({"title":post.title(),"slug":post.slug(),"description":post.description(),"date":post.date(),"updated":post.updated(),"body":post.body_plain_text})).collect();
    if wants("search_index.json") {
        files.insert("search_index.json".into(), serde_json::to_string(&index)?);
    }
    if wants("site.json") {
        files.insert(
            "site.json".into(),
            serde_json::json!({"title":release.site.title,"description":release.site.description,"author":release.site.author,"template_version":crate::template_version()})
                .to_string(),
        );
    }
    if wants("_release.json") {
        files.insert(
            "_release.json".into(),
            serde_json::json!({"id":release.id,"created_at":release.created_at,"template_version":crate::template_version()}).to_string(),
        );
    }
    Ok(files)
}
