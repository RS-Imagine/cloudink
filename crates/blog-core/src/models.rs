use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Site configuration
// ---------------------------------------------------------------------------

/// Top-level site configuration loaded from `content/site.toml`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SiteConfig {
    pub title: String,
    /// Optional large display title for the hero section.
    #[serde(rename = "bigTitle", default)]
    pub big_title: Option<String>,
    pub subtitle: String,
    pub author: String,
    pub description: String,
    #[serde(default)]
    pub footer: Option<String>,
    #[serde(rename = "clarityId", default)]
    pub clarity_id: Option<String>,
    /// About page Markdown; an empty value disables its navigation entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
}

impl Default for SiteConfig {
    fn default() -> Self {
        Self {
            title: "CloudInk".to_string(),
            big_title: None,
            subtitle: "Rust, Markdown, and Cloudflare Workers".to_string(),
            author: "Your Name".to_string(),
            description: "A personal blog built from Markdown content.".to_string(),
            footer: None,
            clarity_id: None,
            about: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Post data model
// ---------------------------------------------------------------------------

/// Structured metadata parsed from a post's TOML front matter block.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FrontMatter {
    pub title: String,
    /// Original publication date in `YYYY-MM-DD` format.
    pub date: String,
    /// Last updated date, if different from `date`.
    #[serde(default)]
    pub updated: Option<String>,
    pub slug: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub draft: bool,
}

/// A fully parsed and rendered blog post.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Post {
    pub front_matter: FrontMatter,
    /// Raw Markdown source, preserved for the admin editor.
    pub body_markdown: String,
    /// Rendered HTML body (KaTeX math + highlight.js ready).
    pub body_html: String,
    /// Plain-text version of the body used for search indexing.
    pub body_plain_text: String,
}

impl Post {
    pub fn title(&self) -> &str {
        &self.front_matter.title
    }

    pub fn slug(&self) -> &str {
        &self.front_matter.slug
    }

    pub fn date(&self) -> &str {
        &self.front_matter.date
    }

    pub fn updated(&self) -> Option<&str> {
        self.front_matter.updated.as_deref()
    }

    pub fn description(&self) -> &str {
        &self.front_matter.description
    }

    pub fn draft(&self) -> bool {
        self.front_matter.draft
    }
}

/// Input type used when creating or updating a post via the admin UI.
///
/// Embeds [`FrontMatter`] directly to avoid duplicating its fields and
/// eliminates the clone-per-field pattern that was previously required in
/// `save_post`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PostDraft {
    /// All structured metadata for this post.
    #[serde(flatten)]
    pub front_matter: FrontMatter,
    /// Raw Markdown content of the post body.
    pub body_markdown: String,
}

// ---------------------------------------------------------------------------
// Page data model (e.g. about.md)
// ---------------------------------------------------------------------------

/// Front matter for a standalone page (no date or draft status).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PageFrontMatter {
    pub title: String,
    #[serde(default)]
    pub description: String,
}

/// A standalone content page (e.g. `about.md`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Page {
    pub front_matter: PageFrontMatter,
    pub body_markdown: String,
    pub body_html: String,
}
