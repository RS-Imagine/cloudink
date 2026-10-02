use blog_core::{build_site, content, models::{FrontMatter, PostDraft, SiteConfig}, render_preview};
use std::{fs, path::PathBuf};

fn temp() -> PathBuf { let p=std::env::temp_dir().join(format!("cloudink-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(&p).unwrap();p }
fn draft(slug:&str, unpublished:bool) -> PostDraft { PostDraft{front_matter:FrontMatter{title:"中文与数学".into(),date:"2026-10-01".into(),updated:None,slug:slug.into(),description:"测试".into(),draft:unpublished},body_markdown:"# 小节\n\n公式 $x^2$\n\n```rust\nlet x = 1;\n```".into()} }

// KaTeX stores CSS declarations in a HashMap; their order has no visual effect.
fn normalized_styles(html: &str) -> String {
    let mut parts=html.split("style=\"");
    let mut result=parts.next().unwrap().to_owned();
    for part in parts {
        let (style,rest)=part.split_once('"').unwrap();
        let mut declarations:Vec<_>=style.split(';').filter(|v|!v.is_empty()).collect();
        declarations.sort_unstable();
        result.push_str("style=\"");result.push_str(&declarations.join(";"));result.push('"');result.push_str(rest);
    }
    result
}

#[test]
fn drafts_are_absent_from_direct_urls_and_stale_output() {
    let p=temp();let input=p.join("content");let output=p.join("public");
    content::save_post(&input,&draft("visible",false)).unwrap();
    content::save_post(&input,&draft("private",false)).unwrap();
    build_site(&input,&output).unwrap();assert!(output.join("posts/private/index.html").exists());
    content::save_post(&input,&draft("private",true)).unwrap();
    build_site(&input,&output).unwrap();
    assert!(!output.join("posts/private").exists());
    assert!(!fs::read_to_string(output.join("index.html")).unwrap().contains("/posts/private/"));
    assert!(!fs::read_to_string(output.join("search_index.json")).unwrap().contains("private"));
    fs::remove_dir_all(p).unwrap();
}
#[test]
fn preview_matches_the_native_published_page() {
    let p=temp();let input=p.join("content");let output=p.join("public");let post=draft("match",false);
    content::save_post(&input,&post).unwrap();build_site(&input,&output).unwrap();
    let preview=normalized_styles(&render_preview(&SiteConfig::default(),&post).unwrap());
    let native=normalized_styles(&fs::read_to_string(output.join("posts/match/index.html")).unwrap());
    let offset=preview.bytes().zip(native.bytes()).position(|(a,b)|a!=b).unwrap_or(preview.len().min(native.len()));
    assert!(preview==native,"preview differs near byte {offset}: {:?} / {:?}",preview.get(offset.saturating_sub(40)..(offset+120).min(preview.len())),native.get(offset.saturating_sub(40)..(offset+120).min(native.len())));
    assert!(preview.contains("katex"));fs::remove_dir_all(p).unwrap();
}
#[test]
fn paths_cannot_escape_the_content_directory() {
    let p=temp();assert!(content::save_post(&p,&draft("../escape",false)).is_err());
    assert!(content::load_post_by_slug(&p,"../escape").is_err());assert!(content::delete_post(&p,"../escape").is_err());fs::remove_dir_all(p).unwrap();
}
#[test]
fn imported_markdown_supersedes_archived_html() {
    let p=temp();let input=p.join("content");let output=p.join("public");
    content::save_post(&input,&draft("old",false)).unwrap();
    let mut legacy=content::load_post_by_slug(&input,"old").unwrap().unwrap();legacy.body_html="OLD ARCHIVE".into();
    fs::write(input.join("legacy-posts.json"),serde_json::to_vec(&vec![legacy]).unwrap()).unwrap();
    build_site(&input,&output).unwrap();let html=fs::read_to_string(output.join("posts/old/index.html")).unwrap();assert!(!html.contains("OLD ARCHIVE"));fs::remove_dir_all(p).unwrap();
}

#[test]
fn a_fork_does_not_inherit_identity_or_analytics() {
    let mut config=SiteConfig::default();config.author="Reader".into();
    let html=render_preview(&config,&draft("fork",false)).unwrap();
    assert!(html.contains("Reader built this website using Rust."));
    assert!(!html.contains("clarity.ms"));
    config.footer=Some("Reader & <friends>".into());config.clarity_id=Some("reader123".into());
    let html=render_preview(&config,&draft("fork",false)).unwrap();
    assert!(html.contains("Reader &amp; &lt;friends&gt;"));assert!(html.contains("reader123"));
    config.clarity_id=Some("invalid\"<script>".into());
    assert!(!render_preview(&config,&draft("fork",false)).unwrap().contains("clarity.ms"));
}

#[test]
fn a_new_blog_about_page_uses_the_shared_site_template() {
    let p=temp();let input=p.join("content");let output=p.join("public");fs::create_dir_all(&input).unwrap();
    fs::write(input.join("about.md"),"+++\ntitle = \"About\"\ndescription = \"\"\n+++\n\nReader").unwrap();
    build_site(&input,&output).unwrap();let html=fs::read_to_string(output.join("about/index.html")).unwrap();
    assert!(html.contains("<html"));assert!(html.contains("site-header"));assert!(html.contains("Reader"));
    fs::remove_dir_all(p).unwrap();
}

#[test]
fn browser_release_matches_native_pages_and_excludes_drafts() {
    let p=temp();let input=p.join("content");let output=p.join("public");
    content::save_post(&input,&draft("visible",false)).unwrap();
    content::save_post(&input,&draft("private",true)).unwrap();
    let about="+++\ntitle = \"About\"\n+++\n\nShared $x^2$";
    fs::write(input.join("about.md"),about).unwrap();
    build_site(&input,&output).unwrap();
    let bundle=serde_json::json!({"schema_version":1,"id":"release","created_at":"2026-10-01T00:00:00Z","site":SiteConfig::default(),"markdown_posts":{
        "visible":fs::read_to_string(input.join("posts/visible.md")).unwrap(),
        "private":fs::read_to_string(input.join("posts/private.md")).unwrap()
    },"legacy_posts":[],"about_markdown":about});
    let files=blog_core::bundle::render_release(&bundle.to_string()).unwrap();
    for name in ["index.html","404.html","about/index.html","posts/visible/index.html","search_index.json","client.js","styles.css","favicon.svg"] {
        assert_eq!(normalized_styles(&files[name]),normalized_styles(&fs::read_to_string(output.join(name)).unwrap()),"{name}");
    }
    assert!(!files.contains_key("posts/private/index.html"));assert!(!files["search_index.json"].contains("private"));
    let mut invalid=bundle;invalid["markdown_posts"]["visible"]=invalid["markdown_posts"]["private"].clone();
    assert!(blog_core::bundle::render_release(&invalid.to_string()).is_err());
    fs::remove_dir_all(p).unwrap();
}
