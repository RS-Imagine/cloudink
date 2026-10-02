pub mod content;
pub mod bundle;
pub mod models;
pub mod render;
pub mod utils;

mod markdown;
mod math;
mod store;

use anyhow::Result;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

/// Computes a short, stable content fingerprint used for CSS cache-busting.
///
/// Uses BLAKE3 (a cryptographic hash guaranteed to be deterministic and
/// collision-resistant) instead of `DefaultHasher`, which is explicitly
/// documented as NOT stable across Rust versions or process invocations.
fn content_hash(s: &str) -> String {
    let hash = blake3::hash(s.as_bytes());
    // Take the first 8 hex characters (32 bits) – sufficient for cache busting.
    hash.to_hex()[..8].to_string()
}

/// Builds the complete static site from `content_root` into `output_root`.
///
/// Steps performed:
/// 1. Load `site.toml` and all posts.
/// 2. Copy any static assets from `content/static/`.
/// 3. Write `styles.css` and `favicon.svg` (skipped if unchanged).
/// 4. Render `index.html`, `about/index.html`, every post, and `404.html`.
/// 5. Delete output subdirs for posts that no longer exist in content.
/// 6. Write `search_index.json` for client-side search.
pub fn build_site(content_root: impl AsRef<Path>, output_root: impl AsRef<Path>) -> Result<()> {
    let content_root = content_root.as_ref();
    let output_root = output_root.as_ref();

    let config = content::load_site_config(content_root)?;
    let mut posts = content::load_posts(content_root)?;
    // Keep existing published articles available until their original Markdown
    // is imported. Imported sources take precedence over archived HTML.
    let legacy_path = content_root.join("legacy-posts.json");
    if legacy_path.exists() {
        let legacy: Vec<models::Post> = serde_json::from_slice(&fs::read(legacy_path)?)?;
        let source_slugs: HashSet<String> = posts.iter().map(|p| p.slug().to_owned()).collect();
        for post in legacy {
            content::validate_slug(post.slug())?;
            if !source_slugs.contains(post.slug()) { posts.push(post); }
        }
    }
    // Drafts must never be written to public output, including direct URLs.
    posts.retain(|post| !post.draft());
    posts.sort_by(|a, b| b.updated().unwrap_or(b.date()).cmp(a.updated().unwrap_or(a.date())).then_with(|| b.slug().cmp(a.slug())));

    fs::create_dir_all(output_root.join("posts"))?;

    // Copy user-provided static assets (images, fonts, …).
    let static_dir = content_root.join("static");
    if static_dir.exists() {
        copy_dir_all(&static_dir, output_root)?;
    }

    // CSS is embedded at compile time via include_str!; hash it for cache busting.
    let css = render::stylesheet();
    let css_hash = content_hash(css);
    write_if_changed(output_root.join("styles.css"), css)?;
    write_if_changed(output_root.join("favicon.svg"), render::favicon_svg())?;
    write_if_changed(output_root.join("client.js"), render::client_script())?;

    // Index page.
    write_if_changed(
        output_root.join("index.html"),
        render::render_index(&config, &posts, &css_hash),
    )?;

    // Optional about page.
    let about_path = content_root.join("about.md");
    let about_dir = output_root.join("about");
    if about_path.exists() {
        let about_page = content::load_page_file(&about_path)?;
            fs::create_dir_all(&about_dir)?;
            write_if_changed(
                about_dir.join("index.html"),
                render::render_page(&config, &about_page, &css_hash),
            )?;
    } else if content_root.join("about.html").exists() {
        fs::create_dir_all(&about_dir)?;
        write_if_changed(about_dir.join("index.html"), fs::read(content_root.join("about.html"))?)?;
    } else if about_dir.exists() {
        fs::remove_dir_all(&about_dir)?;
    }

    // Remove output directories for deleted posts.
    let posts_dir = output_root.join("posts");
    let valid_slugs: HashSet<_> = posts.iter().map(|p| p.slug()).collect();
    if posts_dir.exists() {
        for entry in fs::read_dir(&posts_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                if let Some(slug) = path.file_name().and_then(|n| n.to_str()) {
                    if !valid_slugs.contains(slug) {
                        fs::remove_dir_all(&path)?;
                    }
                }
            }
        }
    }

    // Render each post.
    for post in &posts {
        let post_dir = output_root.join("posts").join(post.slug());
        fs::create_dir_all(&post_dir)?;
        write_if_changed(
            post_dir.join("index.html"),
            render::render_post(&config, post, &css_hash),
        )?;
    }

    // 404 page.
    write_if_changed(output_root.join("404.html"), render::render_404(&config, &css_hash))?;

    // Client-side search index.
    let search_index: Vec<_> = posts
        .iter()
        .filter(|p| !p.draft())
        .map(|p| {
            serde_json::json!({
                "title": p.title(),
                "slug": p.slug(),
                "description": p.description(),
                "body": p.body_plain_text,
            })
        })
        .collect();
    let search_index_json = serde_json::to_string(&search_index)?;
    write_if_changed(output_root.join("search_index.json"), search_index_json)?;

    Ok(())
}

/// The browser preview and native generator share this exact Markdown pipeline.
pub fn render_preview(config: &models::SiteConfig, draft: &models::PostDraft) -> Result<String> {
    content::validate_slug(&draft.front_matter.slug)?;
    let post = models::Post {
        front_matter: draft.front_matter.clone(),
        body_markdown: draft.body_markdown.clone(),
        body_html: markdown::markdown_to_html(&draft.body_markdown),
        body_plain_text: markdown::markdown_to_plain_text(&draft.body_markdown),
    };
    Ok(render::render_post(config, &post, &content_hash(render::stylesheet())))
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Writes `content` to `path` only when it differs from the existing file,
/// avoiding unnecessary filesystem writes and preserving mtime on unchanged files.
fn write_if_changed(path: impl AsRef<Path>, content: impl AsRef<[u8]>) -> Result<()> {
    let path = path.as_ref();
    let content = content.as_ref();
    if path.exists() {
        if let Ok(existing) = fs::read(path) {
            if existing == content {
                return Ok(());
            }
        }
    }
    fs::write(path, content)?;
    Ok(())
}

/// Recursively copies `src` into `dst`, skipping files that appear unchanged
/// (same size and `dst_mtime >= src_mtime`).
fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> Result<()> {
    let src = src.as_ref();
    let dst = dst.as_ref();
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(entry.path(), dest_path)?;
        } else {
            if dest_path.exists() {
                let src_meta = entry.metadata()?;
                let dst_meta = fs::metadata(&dest_path)?;
                if src_meta.len() == dst_meta.len() {
                    if let (Ok(src_time), Ok(dst_time)) =
                        (src_meta.modified(), dst_meta.modified())
                    {
                        if dst_time >= src_time {
                            continue;
                        }
                    }
                }
            }
            fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}
