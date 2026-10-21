use blog_core::import::import_markdown;
fn import(source: &str) -> blog_core::models::PostDraft {
    import_markdown(source, "普通文章.md", "2026-10-21", "post-new-id").unwrap()
}
#[test]
fn ordinary_markdown_needs_no_metadata_and_preserves_content() {
    let source =
        "正文\n\n---\n\n## 小标题\n\n~~~js\nconst n = 1;\n~~~\n\n$x^2$\n\n|a|b|\n|-|-|\n|1|2|\n";
    let result = import(source);
    assert_eq!(result.front_matter.title, "普通文章");
    assert_eq!(result.front_matter.date, "2026-10-21");
    assert_eq!(result.front_matter.description, "");
    assert!(result.front_matter.draft);
    assert_eq!(result.body_markdown, source);
}
#[test]
fn only_a_leading_real_h1_moves_to_the_title() {
    let result = import("\u{feff}\r\n# Hello **world** `code`\r\n\r\n正文\r\n");
    assert_eq!(result.front_matter.title, "Hello world code");
    assert_eq!(result.body_markdown.trim(), "正文");
    let result = import("Setext title\n====\n\nbody");
    assert_eq!(result.front_matter.title, "Setext title");
    assert_eq!(result.body_markdown.trim(), "body");
    for source in [
        "~~~md\n# code heading\n~~~\n",
        "> # quoted\n",
        "intro\n\n# later\n",
        "---\n\n# after rule\n",
        "## h2\n",
    ] {
        let result = import(source);
        assert_eq!(result.front_matter.title, "普通文章", "{source}");
        assert_eq!(result.body_markdown, source);
    }
}
#[test]
fn optional_toml_fills_missing_fields_and_never_reuses_an_imported_address() {
    let result = import("+++\ntitle = 'Imported'\nslug = 'existing'\ndate = 2024-02-29\ndraft = false\n+++\n\n# keep explicit title body\n");
    assert_eq!(result.front_matter.title, "Imported");
    assert_eq!(result.front_matter.date, "2024-02-29");
    assert_eq!(result.front_matter.slug, "post-new-id");
    assert!(result.front_matter.draft);
    assert_eq!(result.body_markdown, "# keep explicit title body\n");
    let result = import("+++\ndescription = 'Summary'\n+++\n\n# Inferred\n\nrest");
    assert_eq!(result.front_matter.title, "Inferred");
    assert_eq!(result.front_matter.date, "2026-10-21");
    assert_eq!(result.front_matter.description, "Summary");
}
#[test]
fn malformed_metadata_is_reported_without_consuming_body_separators() {
    for source in [
        "+++\ntitle = 'oops",
        "+++\ntitle = [\n+++\nbody",
        "+++\ndate = '2025-02-29'\n+++\nbody",
        "+++\ntitle = 1\n+++\nbody",
        "+++\nupdated = '2026-99-01'\n+++\nbody",
        " \n",
    ] {
        assert!(
            import_markdown(source, "file.md", "2026-10-21", "new").is_err(),
            "{source}"
        );
    }
    for source in ["---\ntext\n---\n\nbody", "before\n\n+++\n\nbody"] {
        assert_eq!(import(source).body_markdown, source);
    }
}
#[test]
fn bounded_titles_files_and_unicode_filenames() {
    let result = import_markdown("body", "中文.MARKDOWN", "2026-10-21", "new").unwrap();
    assert_eq!(result.front_matter.title, "中文");
    let result = import_markdown(
        "body",
        &format!("{}.md", "🌱".repeat(200)),
        "2026-10-21",
        "new",
    )
    .unwrap();
    assert_eq!(result.front_matter.title.encode_utf16().count(), 300);
    assert!(import_markdown(&"a".repeat(1_000_001), "file.md", "2026-10-21", "new").is_err());
    assert!(import_markdown("body", "file.md", "2026-10-21", "../bad").is_err());
}

#[test]
fn rich_or_oversized_headings_are_not_silently_discarded() {
    for source in [
        "# ![logo](logo.png) Title\n\nbody",
        "# [Link](https://example.com)\n\nbody",
        "# <span>HTML</span>\n\nbody",
        "# $x^2$ Formula\n\nbody",
        "# Title[^note]\n\n[^note]: Footnote\n",
        "# Anchored {#intro}\n\n[Jump](#intro)\n",
    ]
    .into_iter()
    .map(str::to_string)
    .chain(std::iter::once(format!("# {}\n\nbody", "x".repeat(301))))
    {
        let result = import(&source);
        assert_eq!(result.front_matter.title, "普通文章");
        assert_eq!(result.body_markdown, source);
    }
}
