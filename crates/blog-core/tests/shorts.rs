use blog_core::{build_site, content};
use std::fs;

#[test]
fn shorts_feed_renders() {
    let root = std::env::temp_dir().join(format!(
        "cloudink-shorttest-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let shorts = root.join("shorts");
    fs::create_dir_all(&shorts).unwrap();
    fs::write(
        shorts.join("short-20261102-1443.md"),
        "+++\ndate = \"2026-11-02 14:43\"\nslug = \"short-20261102-1443\"\ndraft = false\n+++\n\n第一条短记。\n",
    )
    .unwrap();
    fs::write(
        shorts.join("short-20261102-1515.md"),
        "+++\ndate = \"2026-11-02 15:15\"\nslug = \"short-20261102-1515\"\ndraft = false\n+++\n\n第二条短记，应该排前面。\n",
    )
    .unwrap();
    fs::write(
        shorts.join("short-20261102-1600.md"),
        "+++\ndate = \"2026-11-02 16:00\"\nslug = \"short-20261102-1600\"\ndraft = true\n+++\n\n草稿不该出现。\n",
    )
    .unwrap();
    // 非法时间格式必须报错
    fs::write(
        shorts.join("bad.md"),
        "+++\ndate = \"2026-11-02\"\nslug = \"bad\"\ndraft = false\n+++\n\n坏时间。\n",
    )
    .unwrap();
    let out = root.join("out");
    let err = build_site(&root, &out).unwrap_err();
    assert!(
        format!("{err:?}").contains("short date must be"),
        "unexpected error: {err:?}"
    );
    fs::remove_file(shorts.join("bad.md")).unwrap();
    build_site(&root, &out).unwrap();
    let html = fs::read_to_string(out.join("shorts").join("index.html")).unwrap();
    let home = fs::read_to_string(out.join("index.html")).unwrap();
    for slug in ["short-20261102-1443", "short-20261102-1515"] {
        assert!(home.contains(&format!("href=\"/shorts/#note:{slug}\"")));
        assert!(html.contains(&format!("id=\"note:{slug}\"")));
    }
    assert_eq!(html.matches("short-card").count(), 2, "应渲染 2 条公开短记");
    assert!(!html.contains("草稿不该出现"), "草稿必须过滤");
    let pos1515 = html.find("2026-11-02 15:15").unwrap();
    let pos1443 = html.find("2026-11-02 14:43").unwrap();
    assert!(pos1515 < pos1443, "应按分钟倒序排列");
    assert!(
        html.contains("datetime=\"2026-11-02 15:15\""),
        "时间应精确到分钟"
    );
    assert!(html.contains("href=\"/shorts/\""), "导航应有短记链接");
    // 空库情况
    fs::remove_dir_all(&shorts).unwrap();
    build_site(&root, &out).unwrap();
    let empty = fs::read_to_string(out.join("shorts").join("index.html")).unwrap();
    assert!(empty.contains("还没有短记"), "空库应显示空状态");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn parse_short_validates_datetime() {
    let ok = content::parse_short("+++\ndate = \"2026-11-02 14:43\"\nslug = \"s\"\n+++\n\nx\n");
    assert!(ok.is_ok());
    for bad in [
        "2026-11-02",
        "2026-11-02 14:43:00",
        "2026-1-2 3:4",
        "2026-13-02 14:43",
        "2026-11-32 14:43",
        "2026-11-02 24:00",
        "2026-11-02 14:60",
        "not-a-date",
    ] {
        let raw = format!("+++\ndate = \"{bad}\"\nslug = \"s\"\n+++\n\nx\n");
        assert!(content::parse_short(&raw).is_err(), "应拒绝非法时间: {bad}");
    }
}

#[test]
fn shorts_calendar_data_and_scoping() {
    let root = std::env::temp_dir().join(format!(
        "cloudink-shortcal-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let shorts = root.join("shorts");
    let posts = root.join("posts");
    fs::create_dir_all(&shorts).unwrap();
    fs::create_dir_all(&posts).unwrap();
    fs::write(
        posts.join("hello.md"),
        "+++\ntitle = \"Hello\"\ndate = \"2026-11-01\"\nslug = \"hello\"\n+++\n\n正文。\n",
    )
    .unwrap();
    // 5 published shorts across 2 months + 1 draft, spanning multiple pages (> SHORTS_PER_PAGE)
    for (slug, date, draft) in [
        ("short-20261121-2120", "2026-11-21 21:20", false),
        ("short-20261121-0915", "2026-11-21 09:15", false),
        ("short-20261121-0700", "2026-11-21 07:00", true),
        ("short-20261110-1200", "2026-11-10 12:00", false),
        ("short-20261015-0830", "2026-10-15 08:30", false),
        ("short-20261015-1845", "2026-10-15 18:45", false),
    ] {
        fs::write(
            shorts.join(format!("{slug}.md")),
            format!(
                "+++\ndate = \"{date}\"\nslug = \"{slug}\"\ndraft = {draft}\n+++\n\n内容 {slug}。\n"
            ),
        )
        .unwrap();
    }
    let out = root.join("out");
    build_site(&root, &out).unwrap();

    let shorts_html = fs::read_to_string(out.join("shorts").join("index.html")).unwrap();
    let author_pos = shorts_html.find("author-card").expect("author-card exists");
    let cal_pos = shorts_html
        .find("shorts-cal-panel")
        .expect("shorts-cal-panel exists");
    assert!(cal_pos > author_pos, "日历应位于作者卡片下方");

    let (_, widget) = shorts_html
        .split_once(r#" data-shorts-cal-root data-shorts-cal=""#)
        .expect("embedded calendar data attribute");
    let (escaped_json, _) = widget.split_once('"').expect("closing attribute quote");
    assert!(escaped_json.contains("&quot;firstId&quot;"));
    assert!(!shorts_html.contains("shorts-cal-data"));
    let parsed: serde_json::Value = serde_json::from_str(&escaped_json.replace("&quot;", "\""))
        .expect("valid calendar JSON in the attribute");
    assert_eq!(
        parsed.as_object().unwrap().len(),
        3,
        "只应包含有公开短记的 3 天"
    );
    assert_eq!(parsed["2026-11-21"]["count"], 2);
    assert_eq!(
        parsed["2026-11-21"]["firstId"], "note:short-20261121-0915",
        "同一天应指向最早一条公开短记"
    );
    assert_eq!(parsed["2026-11-10"]["count"], 1);
    assert_eq!(parsed["2026-11-10"]["firstId"], "note:short-20261110-1200");
    assert_eq!(parsed["2026-10-15"]["count"], 2);
    assert_eq!(
        parsed["2026-10-15"]["firstId"], "note:short-20261015-0830",
        "跨分页的早期月份数据也必须完整内嵌"
    );

    // Must not appear on any non-shorts page
    for rel in [
        "index.html",
        "post/index.html",
        "posts/hello/index.html",
        "archive/index.html",
        "about/index.html",
    ] {
        let p = out.join(rel);
        if p.exists() {
            let html = fs::read_to_string(&p).unwrap();
            assert!(
                !html.contains("shorts-cal-"),
                "{rel} 不应包含任何 shorts-cal- 标记"
            );
        }
    }

    fs::remove_dir_all(&root).ok();
}
