use blog_core::{models::{FrontMatter, Page, PageFrontMatter, Post, SiteConfig}, render};

fn post(slug: &str, title: &str, draft: bool) -> Post {
    Post {
        front_matter: FrontMatter {
            title: title.into(), slug: slug.into(), date: "2026-10-01".into(),
            updated: None, description: "A description & a thought".into(), draft,
        },
        body_markdown: String::new(), body_html: "<p>Article</p>".into(), body_plain_text: "Article".into(),
    }
}

#[test]
fn home_keeps_each_published_url_once_and_features_first_visible_post() {
    let html = render::render_index(&SiteConfig::default(), &[
        post("private", "PRIVATE", true), post("first", "First", false), post("next", "Next", false),
    ], "test");
    assert!(!html.contains("/posts/private/"));
    assert_eq!(html.matches("href=\"/posts/first/\"").count(), 1);
    assert_eq!(html.matches("href=\"/posts/next/\"").count(), 1);
    assert_eq!(html.matches("post-card home-card home-feature").count(), 1);
    assert!(html.find("/posts/first/").unwrap() < html.find("/posts/next/").unwrap());
    assert!(html.contains("2 篇文章"));
    assert_eq!(html.matches("<h1").count(), 1);
    assert!(html.contains("href=\"/#posts\""));
}

#[test]
fn empty_home_and_disabled_about_are_complete_without_fake_content() {
    let mut site = SiteConfig::default();
    site.about = Some(String::new());
    let html = render::render_index(&site, &[], "test");
    assert!(html.contains("home-empty"));
    assert!(html.contains("0 篇文章"));
    assert!(!html.contains("home-feature-art"));
    assert!(!html.contains("href=\"/about/\""));
    assert!(html.contains("<details class=\"reader-menu\""));
    assert!(html.contains("href=\"#swup\""));
}

#[test]
fn home_escapes_author_text_and_uses_configured_title_without_html_injection() {
    let mut site = SiteConfig::default();
    site.title = "Notes & ideas".into();
    site.big_title = Some("<img src=x onerror=BAD>\n第二行".into());
    site.author = "<Writer>".into();
    let html = render::render_index(&site, &[post("safe", "<script>BAD</script>", false)], "test");
    assert!(html.contains("&lt;img src=x onerror=BAD&gt;"));
    assert!(html.contains("&lt;script&gt;BAD&lt;/script&gt;"));
    assert!(html.contains("&lt;Writer&gt;"));
    assert!(html.contains("<span class=\"site-title\">Notes &amp; ideas</span>"));
    assert!(!html.contains("<img src=x"));
    assert!(!html.contains("<script>BAD"));
}

#[test]
fn navigation_state_is_present_in_ssr_on_every_page_kind() {
    let site = SiteConfig::default();
    let home = render::render_index(&site, &[], "test");
    assert!(home.contains("data-reader-nav=\"posts\" aria-current=\"page\""));
    let article = render::render_post(&site, &post("safe", "Post", false), "test");
    assert!(article.contains("data-page=\"post\""));
    assert!(!article.contains("data-reader-nav=\"posts\" aria-current="));
    let about = render::render_page(&site, &Page {
        front_matter: PageFrontMatter { title: "About".into(), description: String::new() },
        body_markdown: String::new(), body_html: "<p>About</p>".into(),
    }, "test");
    assert!(about.contains("data-reader-nav=\"about\" aria-current=\"page\""));
    assert!(render::render_404(&site, "test").contains("data-page=\"not-found\""));
}
