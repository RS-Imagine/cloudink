use blog_core::{
    models::{FrontMatter, Post, SiteConfig},
    render,
};

fn article() -> Post {
    Post {
        front_matter: FrontMatter {
            title: "A title & a thought".into(),
            slug: "reading".into(),
            aliases: Vec::new(),
            date: "2026-10-01".into(),
            updated: Some("2026-10-02".into()),
            description: "A <description>".into(),
            draft: false,
        },
        body_markdown: String::new(),
        body_html: "<h2>Reading</h2><p>Words</p>".into(),
        body_plain_text: format!("{} {}", "字".repeat(800), "word ".repeat(400)),
    }
}

#[test]
fn reading_metadata_is_escaped_and_mixed_text_shows_word_count() {
    let mut site = SiteConfig::default();
    site.author = "<Writer & friends>".into();
    let post = article();
    let html = render::render_post(&site, &post, "test");
    assert_eq!(html.matches("<h1").count(), 1);
    assert!(html.contains("A title &amp; a thought"));
    assert!(html.contains("A &lt;description&gt;"));
    assert!(html.contains("&lt;Writer &amp; friends&gt;"));
    assert!(html.contains("全文 1,200 字"));
    assert!(html.contains("<dt>字数</dt><dd>1,200 字</dd>"));
    assert!(!html.contains("分钟阅读"));
    assert!(!html.contains("阅读时长"));
    assert!(html.contains("更新于 <time datetime=\"2026-10-02\">2026-10-02</time>"));
    assert!(html.contains("<h2>Reading</h2><p>Words</p>"));
    assert!(html.contains("href=\"/\""));
    assert!(html.contains("id=\"share-btn\""));

    let posts = std::slice::from_ref(&post);
    for list_html in [
        render::render_index(&site, posts, "test"),
        render::render_posts(&site, posts, "test"),
    ] {
        assert!(list_html.contains("全文 1,200 字"));
        assert!(!list_html.contains("分钟阅读"));
        assert!(!list_html.contains("阅读时长"));
    }
}

#[test]
fn empty_article_keeps_reading_tools_and_an_accessible_search_shell() {
    let mut post = article();
    post.body_plain_text.clear();
    post.front_matter.updated = None;
    let html = render::render_post(&SiteConfig::default(), &post, "test");
    assert!(html.contains("全文 0 字"));
    assert!(html.contains("<dt>字数</dt><dd>0 字</dd>"));
    assert!(!html.contains("更新于"));
    assert!(html.contains("<dialog id=\"search-modal\""));
    assert!(html.contains("aria-labelledby=\"search-heading\""));
    assert!(html.contains("for=\"search-input\""));
    assert!(html.contains("id=\"search-status\""));
    assert!(html.contains("class=\"reader-toc-slot\""));
}

#[test]
fn word_count_excludes_punctuation_and_formats_thousands() {
    let mut post = article();
    post.body_plain_text = "你好，世界！ — Hello, world! …… 2026。".into();
    let html = render::render_post(&SiteConfig::default(), &post, "test");
    assert!(html.contains("全文 7 字"));
    assert!(html.contains("<dt>字数</dt><dd>7 字</dd>"));

    post.body_plain_text = format!("{} {}", "字".repeat(1234), "，。！？……");
    let html = render::render_post(&SiteConfig::default(), &post, "test");
    assert!(html.contains("全文 1,234 字"));
    assert!(html.contains("<dt>字数</dt><dd>1,234 字</dd>"));
}

#[test]
fn grouped_display_titles_escape_each_clause_and_keep_plain_metadata() {
    let mut post = article();
    post.front_matter.title = "把日子，写成一封长信 <img src=x>".into();
    let html = render::render_post(&SiteConfig::default(), &post, "test");
    assert!(html.contains(r#"<span class="title-phrase">把日子，</span><wbr>"#));
    assert!(html.contains("写成一封长信 &lt;img src=x&gt;</span>"));
    assert!(!html.contains("<img src=x>"));
    assert!(html.contains("<title>把日子，写成一封长信 &lt;img src=x&gt;"));

    post.front_matter.title = "墨与纸，第一期 | Paper & ink".into();
    let site = SiteConfig::default();
    let posts = std::slice::from_ref(&post);
    for page in [
        render::render_post(&site, &post, "test"),
        render::render_index(&site, posts, "test"),
        render::render_posts(&site, posts, "test"),
        render::render_archive(&site, posts, "test"),
    ] {
        assert!(page.contains(
            r#"<span class="title-phrase">墨与纸，第一期</span> <wbr><span class="title-phrase">| Paper &amp; ink</span>"#
        ));
    }
}

#[test]
fn image_urls_decode_entities_and_commonmark_escapes() {
    for body in [
        "![Photo](/images/uploads/encoded&period;png)",
        r"![Photo](/images/uploads/encoded\.png)",
        "![Photo][ref]\n\n[ref]: /images/uploads/encoded.png",
    ] {
        let source = format!(
            "+++\ntitle = \"Image\"\nslug = \"image\"\ndate = \"2026-11-06\"\ndraft = false\n+++\n\n{body}"
        );
        let post = blog_core::content::parse_post(&source).unwrap();
        assert!(
            post.body_html
                .contains("src=\"/images/uploads/encoded.png\""),
            "{}",
            post.body_html
        );
    }
}
