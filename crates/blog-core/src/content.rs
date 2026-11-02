/// Re-exports the complete public API of the `content` namespace.
///
/// This module is intentionally thin: it exists only to provide backward
/// compatibility for callers that use `blog_core::content::*` paths.
/// All implementations now live in purpose-specific modules:
///
/// | Type / function                | Source module     |
/// |-------------------------------|-------------------|
/// | `SiteConfig`, `FrontMatter`, `Post`, `PostDraft`, `Page`, `PageFrontMatter`, | [`crate::models`] |
/// | `Short`, `ShortDraft`, `ShortFrontMatter` | [`crate::models`] |
/// | `load_*`, `save_post`, `delete_post`, `post_path` | [`crate::store`]  |
/// | `save_short`, `delete_short`, `short_path`, `parse_short`, `load_shorts` | [`crate::store`] |
/// | `slugify`                      | [`crate::utils`]  |
pub use crate::models::{
    FrontMatter, Page, PageFrontMatter, Post, PostDraft, Short, ShortDraft, ShortFrontMatter,
    SiteConfig,
};
pub use crate::store::{
    delete_post, delete_short, load_page_file, load_post_by_slug, load_post_file, load_posts,
    load_shorts, load_site_config, parse_page, parse_post, parse_short, post_path, save_post,
    save_short, short_path, validate_short_datetime, validate_slug,
};
pub use crate::utils::slugify;
