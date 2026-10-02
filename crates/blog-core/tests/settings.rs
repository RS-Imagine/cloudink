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
