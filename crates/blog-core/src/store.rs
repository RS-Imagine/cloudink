use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

use crate::markdown::{markdown_to_html, markdown_to_plain_text};
use crate::models::{
    FrontMatter, Page, PageFrontMatter, Post, PostDraft, Short, ShortDraft, ShortFrontMatter,
    SiteConfig,
};

// ---------------------------------------------------------------------------
// Site config
// ---------------------------------------------------------------------------

/// Loads `site.toml` from `content_root`.  Falls back to [`SiteConfig::default`]
/// if the file does not exist.
pub fn load_site_config(content_root: impl AsRef<Path>) -> Result<SiteConfig> {
    let path = content_root.as_ref().join("site.toml");
    if !path.exists() {
        return Ok(SiteConfig::default());
    }

    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let config = toml::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    Ok(config)
}

// ---------------------------------------------------------------------------
// Post loading
// ---------------------------------------------------------------------------

/// Loads and renders all Markdown files from `content_root/posts/`.
///
/// Posts are sorted by `updated` date (falling back to `date`), newest first.
/// Files without a `.md` extension are silently ignored.
pub fn load_posts(content_root: impl AsRef<Path>) -> Result<Vec<Post>> {
    let posts_dir = content_root.as_ref().join("posts");
    let mut posts = Vec::new();

    if !posts_dir.exists() {
        return Ok(posts);
    }

    for entry in
        fs::read_dir(&posts_dir).with_context(|| format!("read {}", posts_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) != Some("md") {
            continue;
        }
        posts.push(load_post_file(&path)?);
    }

    posts.sort_by(|l, r| {
        let l_time = l.updated().unwrap_or(l.date());
        let r_time = r.updated().unwrap_or(r.date());
        r_time.cmp(l_time).then_with(|| r.slug().cmp(l.slug()))
    });

    Ok(posts)
}

/// Parses and renders a single post file.
pub fn load_post_file(path: impl AsRef<Path>) -> Result<Post> {
    let path = path.as_ref();
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    parse_post(&raw).with_context(|| format!("parse {}", path.display()))
}

/// Parses an original Markdown document without filesystem access.
pub fn parse_post(raw: &str) -> Result<Post> {
    let (front_matter_src, body_markdown) = split_front_matter(raw)?;
    let front_matter: FrontMatter =
        toml::from_str(&front_matter_src).context("parse post front matter")?;
    validate_slug(&front_matter.slug)?;
    let body_html = markdown_to_html(&body_markdown);
    let body_plain_text = markdown_to_plain_text(&body_markdown);

    Ok(Post {
        front_matter,
        body_markdown,
        body_html,
        body_plain_text,
    })
}

/// Returns the parsed post for the given slug, or `None` if it does not exist.
pub fn load_post_by_slug(content_root: impl AsRef<Path>, slug: &str) -> Result<Option<Post>> {
    validate_slug(slug)?;
    let path = post_path(content_root, slug);
    if !path.exists() {
        return Ok(None);
    }
    load_post_file(path).map(Some)
}

// ---------------------------------------------------------------------------
// Page loading
// ---------------------------------------------------------------------------

/// Parses and renders a standalone Markdown page (e.g. `about.md`).
pub fn load_page_file(path: impl AsRef<Path>) -> Result<Page> {
    let path = path.as_ref();
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    parse_page(&raw).with_context(|| format!("parse {}", path.display()))
}

pub fn parse_page(raw: &str) -> Result<Page> {
    let (front_matter_src, body_markdown) = split_front_matter(raw)?;
    let front_matter: PageFrontMatter =
        toml::from_str(&front_matter_src).context("parse page front matter")?;
    let body_html = markdown_to_html(&body_markdown);

    Ok(Page {
        front_matter,
        body_markdown,
        body_html,
    })
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Serialises `draft` to disk as a `.md` file under `content_root/posts/`.
///
/// The function takes a shared reference so callers can keep using `draft`
/// afterwards; the previous clone-per-field pattern is eliminated because
/// `PostDraft` now embeds `FrontMatter` directly.
pub fn save_post(content_root: impl AsRef<Path>, draft: &PostDraft) -> Result<PathBuf> {
    validate_slug(&draft.front_matter.slug)?;
    let content_root = content_root.as_ref();
    let posts_dir = content_root.join("posts");
    fs::create_dir_all(&posts_dir)?;

    let file_path = posts_dir.join(format!("{}.md", draft.front_matter.slug));
    let serialized = toml::to_string_pretty(&draft.front_matter)?;
    let file_content = format!(
        "+++\n{}\n+++\n\n{}\n",
        serialized.trim(),
        draft.body_markdown.trim_start()
    );
    fs::write(&file_path, file_content)
        .with_context(|| format!("write {}", file_path.display()))?;
    Ok(file_path)
}

/// Deletes the Markdown file for `slug`.  Returns `false` if the file did not
/// exist (so the caller can decide whether to treat that as an error).
pub fn delete_post(content_root: impl AsRef<Path>, slug: &str) -> Result<bool> {
    validate_slug(slug)?;
    let path = post_path(content_root, slug);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).with_context(|| format!("delete {}", path.display()))?;
    Ok(true)
}

/// Returns the canonical filesystem path for a post with the given slug.
pub fn post_path(content_root: impl AsRef<Path>, slug: &str) -> PathBuf {
    content_root
        .as_ref()
        .join("posts")
        .join(format!("{}.md", slug))
}

// ---------------------------------------------------------------------------
// Short loading
// ---------------------------------------------------------------------------

/// Loads and renders all Markdown files from `content_root/shorts/`.
///
/// Shorts are sorted by `date` (minute precision), newest first. Files
/// without a `.md` extension are silently ignored.
pub fn load_shorts(content_root: impl AsRef<Path>) -> Result<Vec<Short>> {
    let shorts_dir = content_root.as_ref().join("shorts");
    let mut shorts = Vec::new();

    if !shorts_dir.exists() {
        return Ok(shorts);
    }

    for entry in
        fs::read_dir(&shorts_dir).with_context(|| format!("read {}", shorts_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) != Some("md") {
            continue;
        }
        shorts.push(load_short_file(&path)?);
    }

    shorts.sort_by(|l, r| r.date().cmp(l.date()).then_with(|| r.slug().cmp(l.slug())));

    Ok(shorts)
}

/// Parses and renders a single short file.
pub fn load_short_file(path: impl AsRef<Path>) -> Result<Short> {
    let path = path.as_ref();
    let raw = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    parse_short(&raw).with_context(|| format!("parse {}", path.display()))
}

/// Parses an original Markdown document without filesystem access.
pub fn parse_short(raw: &str) -> Result<Short> {
    let (front_matter_src, body_markdown) = split_front_matter(raw)?;
    let front_matter: ShortFrontMatter =
        toml::from_str(&front_matter_src).context("parse short front matter")?;
    validate_slug(&front_matter.slug)?;
    validate_short_datetime(&front_matter.date)?;
    let body_html = markdown_to_html(&body_markdown);
    let body_plain_text = markdown_to_plain_text(&body_markdown);

    Ok(Short {
        front_matter,
        body_markdown,
        body_html,
        body_plain_text,
    })
}

// ---------------------------------------------------------------------------
// Short persistence
// ---------------------------------------------------------------------------

/// Serialises `draft` to disk as a `.md` file under `content_root/shorts/`.
pub fn save_short(content_root: impl AsRef<Path>, draft: &ShortDraft) -> Result<PathBuf> {
    validate_slug(&draft.front_matter.slug)?;
    validate_short_datetime(&draft.front_matter.date)?;
    let content_root = content_root.as_ref();
    let shorts_dir = content_root.join("shorts");
    fs::create_dir_all(&shorts_dir)?;

    let file_path = shorts_dir.join(format!("{}.md", draft.front_matter.slug));
    let serialized = toml::to_string_pretty(&draft.front_matter)?;
    let file_content = format!(
        "+++\n{}\n+++\n\n{}\n",
        serialized.trim(),
        draft.body_markdown.trim_start()
    );
    fs::write(&file_path, file_content)
        .with_context(|| format!("write {}", file_path.display()))?;
    Ok(file_path)
}

/// Deletes the Markdown file for `slug`. Returns `false` if the file did not
/// exist (so the caller can decide whether to treat that as an error).
pub fn delete_short(content_root: impl AsRef<Path>, slug: &str) -> Result<bool> {
    validate_slug(slug)?;
    let path = short_path(content_root, slug);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).with_context(|| format!("delete {}", path.display()))?;
    Ok(true)
}

/// Returns the canonical filesystem path for a short with the given slug.
pub fn short_path(content_root: impl AsRef<Path>, slug: &str) -> PathBuf {
    content_root
        .as_ref()
        .join("shorts")
        .join(format!("{}.md", slug))
}

// ---------------------------------------------------------------------------
// Validation and front-matter parsing
// ---------------------------------------------------------------------------

/// Splits a Markdown file into its TOML front-matter block and body.
///
/// The file must begin with `+++`, followed by TOML lines, and then a closing
/// `+++`.  The body is everything after the closing fence.
pub fn validate_slug(slug: &str) -> Result<()> {
    if slug.is_empty()
        || slug.len() > 100
        || !slug
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        bail!("slug must contain 1–100 ASCII letters, digits, hyphens or underscores");
    }
    Ok(())
}

/// Validates a short-note datetime: `YYYY-MM-DD HH:MM` (24-hour), minute
/// precision. Rejects malformed input loudly instead of silently truncating.
pub fn validate_short_datetime(date: &str) -> Result<()> {
    const MSG: &str = "short date must be YYYY-MM-DD HH:MM (24-hour), e.g. 2026-11-02 14:43";
    let mut parts = date.split(' ');
    let (ymd, hm) = match (parts.next(), parts.next(), parts.next()) {
        (Some(ymd), Some(hm), None) => (ymd, hm),
        _ => bail!(MSG),
    };
    // Reject non-zero-padded forms like `2026-1-2 3:4`.
    if ymd.len() != 10 || hm.len() != 5 {
        bail!(MSG);
    }
    let parse3 = |s: &str| -> Option<(u32, u32, u32)> {
        let mut it = s.split('-');
        match (it.next(), it.next(), it.next(), it.next()) {
            (Some(a), Some(b), Some(c), None) => {
                Some((a.parse().ok()?, b.parse().ok()?, c.parse().ok()?))
            }
            _ => None,
        }
    };
    let parse2 = |s: &str| -> Option<(u32, u32)> {
        let mut it = s.split(':');
        match (it.next(), it.next(), it.next()) {
            (Some(a), Some(b), None) => Some((a.parse().ok()?, b.parse().ok()?)),
            _ => None,
        }
    };
    let (Some((y, m, d)), Some((hh, mm))) = (parse3(ymd), parse2(hm)) else {
        bail!(MSG);
    };
    if !(1..=9999).contains(&y) || !(1..=12).contains(&m) || hh > 23 || mm > 59 {
        bail!(MSG);
    }
    // Day-of-month bound (leap years accepted loosely: Feb allows 29).
    let max_day = match m {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if d < 1 || d > max_day {
        bail!(MSG);
    }
    Ok(())
}

fn split_front_matter(source: &str) -> Result<(String, String)> {
    let mut lines = source.lines();
    let first = lines.next().context("missing front matter start")?;
    if first.trim() != "+++" {
        bail!("front matter must start with +++");
    }

    let mut front_matter = String::new();
    let mut body = String::new();
    let mut in_front_matter = true;

    for line in lines {
        if in_front_matter && line.trim() == "+++" {
            in_front_matter = false;
            continue;
        }

        if in_front_matter {
            front_matter.push_str(line);
            front_matter.push('\n');
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }

    if in_front_matter {
        bail!("front matter must end with +++");
    }

    Ok((front_matter, body.trim_start_matches('\n').to_string()))
}
