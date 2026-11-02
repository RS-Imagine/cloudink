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
