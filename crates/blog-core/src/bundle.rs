//! Generate the same static pages in a browser, without filesystem access.
use anyhow::{ensure, Result};
use serde::Deserialize;
use std::collections::{BTreeMap};
use crate::{content, content_hash, models::SiteConfig, render};

#[derive(Deserialize)]
pub struct ReleaseBundle {
    pub schema_version: u32,
    pub id: String,
    pub created_at: String,
    pub site: SiteConfig,
    pub markdown_posts: BTreeMap<String, String>,
    pub about_markdown: Option<String>,
}

pub fn render_release(input: &str) -> Result<BTreeMap<String, String>> {
    let release: ReleaseBundle = serde_json::from_str(input)?;
    ensure!(release.schema_version == 1, "Unsupported release schema");
    let mut posts = Vec::new();
    for (slug, source) in &release.markdown_posts {
        let post = content::parse_post(source)?;
        ensure!(post.slug() == slug, "Article slug does not match its source key");
        if !post.draft() { posts.push(post); }
    }
    posts.sort_by(|a,b| b.updated().unwrap_or(b.date()).cmp(a.updated().unwrap_or(a.date())).then_with(||b.slug().cmp(a.slug())));
    let css_hash = content_hash(render::stylesheet());
    let mut files = BTreeMap::new();
    files.insert("styles.css".into(), render::stylesheet().into());
    files.insert("client.js".into(), render::client_script().into());
    files.insert("favicon.svg".into(), render::favicon_svg().into());
    files.insert("index.html".into(), render::render_index(&release.site, &posts, &css_hash));
    files.insert("404.html".into(), render::render_404(&release.site, &css_hash));
    if let Some(source) = release.about_markdown {
        files.insert("about/index.html".into(), render::render_page(&release.site, &content::parse_page(&source)?, &css_hash));
    }
    for post in &posts {
        files.insert(format!("posts/{}/index.html", post.slug()), render::render_post(&release.site, post, &css_hash));
    }
    let index: Vec<_> = posts.iter().map(|post| serde_json::json!({"title":post.title(),"slug":post.slug(),"description":post.description(),"body":post.body_plain_text})).collect();
    files.insert("search_index.json".into(), serde_json::to_string(&index)?);
    files.insert("_release.json".into(), serde_json::json!({"id":release.id,"created_at":release.created_at}).to_string());
    Ok(files)
}
