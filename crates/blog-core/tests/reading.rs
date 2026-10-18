use blog_core::{models::{FrontMatter, Post, SiteConfig}, render};

fn article() -> Post {
    Post {
        front_matter: FrontMatter {
            title: "A title & a thought".into(), slug: "reading".into(), date: "2026-10-01".into(),
            updated: Some("2026-10-02".into()), description: "A <description>".into(), draft: false,
        },
        body_markdown: String::new(), body_html: "<h2>Reading</h2><p>Words</p>".into(),
        body_plain_text: format!("{} {}", "字".repeat(800), "word ".repeat(400)),
    }
}

#[test]
fn reading_metadata_is_escaped_and_mixed_text_has_an_estimate() {
    let mut site = SiteConfig::default();
    site.author = "<Writer & friends>".into();
    let html = render::render_post(&site, &article(), "test");
    assert_eq!(html.matches("<h1").count(), 1);
    assert!(html.contains("A title &amp; a thought"));
    assert!(html.contains("A &lt;description&gt;"));
    assert!(html.contains("&lt;Writer &amp; friends&gt;"));
    assert!(html.contains("约 4 分钟阅读"));
    assert!(html.contains("更新于 <time datetime=\"2026-10-02\">2026-10-02</time>"));
    assert!(html.contains("<h2>Reading</h2><p>Words</p>"));
    assert!(html.contains("href=\"/\""));
    assert!(html.contains("id=\"copy-link\"") && html.contains("id=\"share-btn\""));
}

#[test]
fn empty_article_keeps_reading_tools_and_an_accessible_search_shell() {
    let mut post = article();
    post.body_plain_text.clear();
    post.front_matter.updated = None;
    let html = render::render_post(&SiteConfig::default(), &post, "test");
    assert!(html.contains("约 1 分钟阅读"));
    assert!(!html.contains("更新于"));
    assert!(html.contains("<dialog id=\"search-modal\""));
    assert!(html.contains("aria-labelledby=\"search-heading\""));
    assert!(html.contains("for=\"search-input\""));
    assert!(html.contains("id=\"search-status\""));
    assert!(html.contains("class=\"reader-toc-slot\""));
}
