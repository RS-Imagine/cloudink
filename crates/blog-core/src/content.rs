/// Re-exports the complete public API of the `content` namespace.
///
/// This module is intentionally thin: it exists only to provide backward
/// compatibility for callers that use `blog_core::content::*` paths.
/// All implementations now live in purpose-specific modules:
///
/// | Type / function                | Source module     |
/// |-------------------------------|-------------------|
/// | `SiteConfig`, `FrontMatter`, `Post`, `PostDraft`, `Page`, `PageFrontMatter` | [`crate::models`] |
/// | `load_*`, `save_post`, `delete_post`, `post_path` | [`crate::store`]  |
/// | `slugify`                      | [`crate::utils`]  |
pub use crate::models::{FrontMatter, Page, PageFrontMatter, Post, PostDraft, SiteConfig};
pub use crate::store::{
    delete_post, load_page_file, load_post_by_slug, load_post_file, load_posts,
    load_site_config, parse_post, parse_page, post_path, save_post, validate_slug,
};
pub use crate::utils::slugify;
