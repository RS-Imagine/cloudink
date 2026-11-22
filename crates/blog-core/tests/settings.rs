use blog_core::{models::SiteConfig, render};

#[test]
fn about_navigation_follows_site_settings() {
    let mut site = SiteConfig::default();
    assert!(render::render_index(&site, &[], "test").contains("href=\"/about/\""));
    site.about = Some(String::new());
    assert!(!render::render_index(&site, &[], "test").contains("href=\"/about/\""));
    site.about = Some("About the author".into());
    assert!(render::render_index(&site, &[], "test").contains("href=\"/about/\""));
}

#[test]
fn optional_settings_can_be_omitted_from_minimal_configuration() {
    let site = SiteConfig::default();
    let serialized = serde_json::to_value(&site).unwrap();
    assert!(serialized.get("about").is_none());
    let mut managed = serialized;
    managed["about"] = serde_json::json!("");
    let parsed: SiteConfig = serde_json::from_value(managed).unwrap();
    assert_eq!(parsed.about.as_deref(), Some(""));
}

#[test]
fn author_palette_is_safe_and_shared_by_every_page() {
    let mut site = SiteConfig::default();
    let legacy = serde_json::to_value(&site).unwrap();
    assert!(legacy.get("themePalette").is_none());
    assert!(render::render_index(&site, &[], "test").contains("data-palette=\"ink\""));
    for palette in ["ink", "neutral", "brown", "blue", "violet", "rose"] {
        site.theme_palette = Some(palette.into());
        let marker = format!("data-palette=\"{palette}\"");
        assert!(render::render_index(&site, &[], "test").contains(&marker));
        assert!(render::render_404(&site, "test").contains(&marker));
    }
    site.theme_palette = Some("\"><script>bad()</script>".into());
    assert!(render::render_index(&site, &[], "test")
        .contains("<html lang=\"zh-CN\" data-palette=\"ink\""));
}

#[test]
fn shared_tokens_and_foundations_are_in_the_rust_stylesheet() {
    let css = render::stylesheet();
    assert!(css.contains(include_str!("../../../assets/design-tokens.css")));
    assert!(css.contains(include_str!("../../../assets/design-foundation.css")));
}

#[test]
fn custom_icons_use_only_valid_content_addresses_on_all_pages() {
    let mut site = SiteConfig::default();
    assert!(serde_json::to_value(&site)
        .unwrap()
        .get("siteIcon")
        .is_none());
    let default_html = render::render_index(&site, &[], "test");
    assert!(!default_html.contains("rel=\"apple-touch-icon\""));
    let default_manifest = render::manifest_json(&site);
    assert!(default_manifest.contains("/favicon.svg"));

    let hash = "a".repeat(64);
    for (ext, mime, raster) in [
        ("svg", "image/svg+xml", false),
        ("ico", "image/x-icon", false),
        ("png", "image/png", true),
        ("jpg", "image/jpeg", true),
        ("jpeg", "image/jpeg", true),
        ("webp", "image/webp", true),
        ("gif", "image/gif", true),
        ("avif", "image/avif", true),
    ] {
        let name = format!("{hash}.{ext}");
        site.site_icon = Some(format!("uploads/icons/{name}"));
        site.site_icon_size = None;
        let expected_avatar = if raster {
            format!("/site-icon/{hash}-192.png")
        } else {
            format!("/site-icon/{name}")
        };
        for html in [
            render::render_index(&site, &[], "test"),
            render::render_404(&site, "test"),
        ] {
            assert!(html.contains(&format!("type=\"{mime}\" href=\"/site-icon/{name}\"")));
            assert!(html.contains(&format!("<img src=\"{expected_avatar}\"")));
            assert!(html.contains(&format!(
                "<link rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"/site-icon/{hash}-180.png\">"
            )));
        }
    }

    // Large raster (> 128 KB) serves the derived 512px PNG for <link rel="icon">.
    site.site_icon = Some(format!("uploads/icons/{hash}.png"));
    site.site_icon_size = Some(512 * 1024);
    let large_html = render::render_index(&site, &[], "test");
    assert!(large_html.contains(&format!(
        "type=\"image/png\" href=\"/site-icon/{hash}-512.png\""
    )));
    assert!(large_html.contains(&format!("<img src=\"/site-icon/{hash}-192.png\"")));

    // Dynamic manifest uses configured title/description and derived PNG icon set.
    site.title = "My Studio".into();
    site.description = "Custom site manifest".into();
    let manifest: serde_json::Value = serde_json::from_str(&render::manifest_json(&site)).unwrap();
    assert_eq!(manifest["name"], "My Studio");
    assert_eq!(manifest["short_name"], "My Studio");
    assert_eq!(manifest["description"], "Custom site manifest");
    assert_eq!(
        manifest["icons"][0]["src"],
        format!("/site-icon/{hash}-192.png")
    );
    assert_eq!(
        manifest["icons"][1]["src"],
        format!("/site-icon/{hash}-512.png")
    );
    assert_eq!(
        manifest["icons"][2]["src"],
        format!("/site-icon/{hash}-512-maskable.png")
    );
    assert_eq!(manifest["icons"][2]["purpose"], "maskable");

    site.site_icon_size = None;
    for value in [
        "https://example.com/a.svg",
        "\"><script>alert(1)</script>",
        "uploads/icons/../auth/account.json",
        "uploads/icons/a.svg",
    ] {
        site.site_icon = Some(value.into());
        let html = render::render_index(&site, &[], "test");
        assert!(html.contains("type=\"image/svg+xml\" href=\"/favicon.svg\""));
        assert!(!html.contains("rel=\"apple-touch-icon\""));
        assert!(!html.contains("<script>alert"));
    }
}

#[test]
fn reading_fonts_default_to_master_serif_and_accept_the_v4_sans_family() {
    let mut site = SiteConfig::default();
    assert!(serde_json::to_value(&site)
        .unwrap()
        .get("readingFont")
        .is_none());
    let legacy = render::render_index(&site, &[], "test");
    assert!(legacy.contains("data-reading-font=\"serif\""));
    assert!(legacy.contains("id=\"reader-font-styles\""));
    site.reading_font = Some("sans".into());
    for html in [
        render::render_index(&site, &[], "test"),
        render::render_404(&site, "test"),
    ] {
        assert!(html.contains("data-reading-font=\"sans\""));
        assert!(!html.contains("id=\"reader-font-styles\""));
    }
    let serialized = serde_json::to_value(&site).unwrap();
    assert_eq!(serialized["readingFont"], "sans");
    site.reading_font = Some("\"><style>bad</style>".into());
    let safe = render::render_404(&site, "test");
    assert!(safe.contains("data-reading-font=\"serif\""));
    assert!(!safe.contains("<style>bad"));
}
