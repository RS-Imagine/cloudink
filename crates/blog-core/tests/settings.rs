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
    assert!(render::render_index(&site, &[], "test").contains("<html lang=\"en\" data-palette=\"ink\">"));
}

#[test]
fn shared_tokens_and_foundations_are_in_the_rust_stylesheet() {
    let css = render::stylesheet();
    assert!(css.contains(include_str!("../../../assets/design-tokens.css")));
    assert!(css.contains(include_str!("../../../assets/design-foundation.css")));
}
