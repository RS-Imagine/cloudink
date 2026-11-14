use crate::models::{Page, Post, Short, SiteConfig};
use crate::utils::escape_html;

// ---------------------------------------------------------------------------
// Static assets (compiled into the binary at build time)
// ---------------------------------------------------------------------------

/// Returns the site stylesheet.
///
/// The CSS source lives in `src/assets/styles.css` and is embedded at compile
/// time via [`include_str!`], so editing it does NOT require touching any Rust
/// code.  The returned `&'static str` is zero-copy.
pub fn stylesheet() -> &'static str {
    concat!(
        include_str!("../../../assets/design-tokens.css"),
        "\n",
        include_str!("assets/styles.css"),
        "\n",
        include_str!("../../../assets/design-foundation.css"),
        "\n",
        include_str!("../../../assets/motion.css"),
        "\n",
        include_str!("../../../assets/mobile.css"),
        "\n",
        include_str!("../../../assets/expressive.css"),
        "\n",
        include_str!("assets/home.css"),
        "\n",
        include_str!("assets/reader-tools.css"),
        "\n",
        include_str!("assets/reader.css")
    )
}

/// Returns the shared CloudInk SVG icon source.
pub fn favicon_svg() -> &'static str {
    include_str!("../../../assets/cloudink.svg")
}

/// Returns the shared CloudInk Web App Manifest source.
pub fn manifest_json() -> &'static str {
    include_str!("../../../assets/manifest.webmanifest")
}

/// Returns the CloudInk Service Worker source.
pub fn sw_js() -> &'static str {
    include_str!("../../../assets/sw.js")
}

fn site_icon(config: &SiteConfig) -> (String, &'static str) {
    if let Some(key) = config.site_icon.as_deref() {
        if let Some(name) = key.strip_prefix("uploads/icons/") {
            if let Some((hash, ext)) = name.rsplit_once('.') {
                if hash.len() == 64
                    && hash
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    && matches!(ext, "svg" | "ico")
                {
                    return (
                        format!("/site-icon/{name}"),
                        if ext == "ico" {
                            "image/x-icon"
                        } else {
                            "image/svg+xml"
                        },
                    );
                }
            }
        }
    }
    ("/favicon.svg".into(), "image/svg+xml")
}

pub fn client_script() -> &'static str {
    concat!(
        include_str!("../../../assets/motion.js"),
        "\n",
        include_str!("../../../assets/mobile.js"),
        "\n",
        include_str!("../../../assets/reader-runtime.js"),
        "\n",
        include_str!("assets/client.js")
    )
}

// ---------------------------------------------------------------------------
// Public page renderers
// ---------------------------------------------------------------------------

/// Render only managed image keys; direct Rust callers receive the same safe fallback.
fn home_illustration(config: &SiteConfig) -> String {
    let Some(key) = config.home_illustration.as_deref() else {
        return String::new();
    };
    if key == "default" {
        return String::from(concat!(
            r#"<figure class="home-illustration" aria-hidden="true">"#,
            include_str!("../../../assets/writing-illustration.svg"),
            "</figure>"
        ));
    }

    let svg = key
        .strip_prefix("uploads/icons/")
        .and_then(|name| name.strip_suffix(".svg"))
        .is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        });
    let raster = key.starts_with("uploads/")
        && [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]
            .iter()
            .any(|ext| key.ends_with(ext));
    if key.len() > 1024
        || !(svg || raster)
        || !key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c))
        || key
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return String::new();
    }
    format!("<figure class=\"home-illustration\" aria-hidden=\"true\"><img src=\"/images/{}\" width=\"360\" height=\"420\" alt=\"\" decoding=\"async\"></figure>", escape_html(key))
}

/// The first managed Markdown image is a quiet, optional index thumbnail.
/// External URLs and raw HTML are not fetched just to decorate an index.
fn post_thumbnail(post: &Post, featured: bool) -> String {
    use pulldown_cmark::{Event, Options, Parser, Tag};

    for event in Parser::new_ext(&post.body_markdown, Options::all()) {
        let source = match event {
            Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.into_string()),
            // The editor writes this exact shape when image dimensions are known.
            // Do not copy author HTML or its attributes into the index.
            Event::Html(html) | Event::InlineHtml(html) => html
                .trim_start()
                .strip_prefix("<img src=\"")
                .and_then(|value| value.split_once('"'))
                .map(|(source, _)| source.to_owned()),
            _ => None,
        };
        let Some(dest_url) = source else {
            continue;
        };
        let Some(key) = dest_url.strip_prefix("/images/uploads/") else {
            continue;
        };
        if key.len() > 1000
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c))
            || key
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || ![".jpg", ".jpeg", ".png", ".webp", ".avif"]
                .iter()
                .any(|ext| key.ends_with(ext))
        {
            continue;
        }
        let sizes = if featured {
            "(max-width: 759px) calc(100vw - 48px), (max-width: 1199px) 36vw, 400px"
        } else {
            "(max-width: 759px) 88px, 180px"
        };
        return format!(
            r#"<figure class="home-thumbnail"><img src="{}" alt="" width="180" height="110" loading="lazy" decoding="async" sizes="{sizes}"></figure>"#,
            escape_html(&dest_url)
        );
    }
    String::new()
}

/// Keep short clauses together, while allowing long clauses to wrap normally.
fn display_title(title: &str) -> String {
    title
        .split_inclusive(['，', '。', '；', '：', '！', '？', ',', ';', ':', '!', '?'])
        .map(|part| {
            let text = escape_html(part);
            format!(r#"<span class="title-phrase">{text}</span>"#)
        })
        .collect::<Vec<_>>()
        .join("<wbr>")
}

fn icon(name: &str) -> String {
    let path = match name {
        "home" => {
            r#"<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>"#
        }
        "article" => r#"<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>"#,
        "shorts" => r#"<path d="M4 4h16v14H9l-5 3V4Z"/><path d="M8 9h8M8 13h5"/>"#,
        "archive" => r#"<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>"#,
        "about" => r#"<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>"#,
        "link" => {
            r#"<path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>"#
        }
        _ => r#"<path d="M4 12h16m-6-6 6 6-6 6"/>"#,
    };
    format!(
        r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{path}</svg>"#
    )
}

fn author_context(config: &SiteConfig) -> String {
    let about = if config.about.as_deref().is_none_or(|s| !s.trim().is_empty()) {
        format!(
            r#"<a class="plain-button" href="/about/">{}更多关于我</a>"#,
            icon("about")
        )
    } else {
        String::new()
    };
    let avatar = if config.site_icon.is_some() {
        format!(
            r#"<img src="{}" width="42" height="42" alt="">"#,
            escape_html(&site_icon(config).0)
        )
    } else {
        escape_html(&config.author.chars().next().unwrap_or(' ').to_string())
    };
    format!(
        r#"<section class="panel author-card"><div class="author-head"><span class="author-avatar" aria-hidden="true">{initial}</span><div><h2>你好，我是{author}。</h2><p class="author-sub">{subtitle}</p></div></div><p class="author-intro">{description}</p>{about}</section>"#,
        initial = avatar,
        author = escape_html(&config.author),
        subtitle = escape_html(&config.subtitle),
        description = escape_html(&config.description)
    )
}

fn home_context(config: &SiteConfig, shorts: &[Short]) -> String {
    let entries = shorts.iter().filter(|s| !s.draft()).take(2).map(|short| {
        let text = short.body_plain_text.trim();
        let excerpt: String = text.chars().take(100).collect();
        format!(r#"<article class="blog-note"><time datetime="{date}">{date}</time><p><a href="/shorts/#{slug}">{text}{more}</a></p></article>"#,
            date = escape_html(short.date()), slug = escape_html(short.slug()), text = escape_html(&excerpt), more = if text.chars().count() > 100 { "…" } else { "" })
    }).collect::<String>();
    format!(
        r#"{}<section class="panel blog-notes"><div class="blog-section-heading"><h2>短记</h2><a class="blog-text-link" href="/shorts/">更多 ↗</a></div>{}</section><section class="panel archive-card"><p class="note-kicker">文字，留在时间里</p><h2>旧文章，也值得再读一次。</h2><p>按时间翻翻以前写下的内容，也许能找到此刻需要的那一篇。</p><a class="plain-button" href="/archive/">{}浏览文章归档</a></section>"#,
        author_context(config),
        if entries.is_empty() {
            "<p class=\"muted\">还没有发布短记。</p>"
        } else {
            &entries
        },
        icon("archive")
    )
}

fn reading_minutes(post: &Post) -> usize {
    let cjk = |c: char| matches!(c as u32, 0x3400..=0x9fff | 0x3040..=0x30ff | 0xac00..=0xd7af);
    let characters = post.body_plain_text.chars().filter(|c| cjk(*c)).count();
    let words = post
        .body_plain_text
        .split_whitespace()
        .filter(|word| word.chars().any(|c| c.is_alphanumeric() && !cjk(c)))
        .count();
    (characters as f64 / 400.0 + words as f64 / 200.0)
        .ceil()
        .max(1.0) as usize
}

/// Published content only; the first post is featured once and never repeated.
pub fn render_index_with_shorts(
    config: &SiteConfig,
    posts: &[Post],
    shorts: &[Short],
    css_hash: &str,
) -> String {
    let mut visible: Vec<_> = posts.iter().filter(|p| !p.draft()).collect();
    visible.sort_by(|a, b| b.date().cmp(a.date()));
    let mut cards = String::new();
    for (index, post) in visible.iter().take(POSTS_PER_PAGE).enumerate() {
        let featured = index == 0;
        let mut art = post_thumbnail(post, featured);
        if featured && art.is_empty() {
            art = home_illustration(config);
        }
        let cover = if art.is_empty() {
            String::new()
        } else {
            format!(
                r#"<a class="{class}" href="/posts/{slug}/" aria-hidden="true" tabindex="-1">{art}</a>"#,
                class = if featured {
                    "feature-cover"
                } else {
                    "blog-post-cover"
                },
                slug = escape_html(post.slug())
            )
        };
        let meta = format!(
            r#"<div class="story-meta"><span>{author}</span><time datetime="{date}">{date}</time><span>{minutes} 分钟阅读</span>{updated}</div>"#,
            author = escape_html(&config.author),
            date = escape_html(post.date()),
            minutes = reading_minutes(post),
            updated = post
                .updated()
                .filter(|date| *date != post.date())
                .map(|date| format!("<span>更新 {}</span>", escape_html(date)))
                .unwrap_or_default()
        );
        if featured {
            cards.push_str(&format!(r#"<article class="post-card home-card home-feature panel featured-article{without_cover}"><div class="feature-copy"><div class="story-eyebrow">{document}<span>最近发布</span></div><h2><a href="/posts/{slug}/">{title}</a></h2>{meta}<p class="feature-summary">{description}</p><a class="plain-button primary feature-read" href="/posts/{slug}/">{document}阅读全文</a></div>{cover}</article>"#,
                without_cover = if cover.is_empty() { " without-cover" } else { "" }, document = icon("article"), slug = escape_html(post.slug()), title = escape_html(post.title()), description = escape_html(post.description())));
            cards.push_str(r#"<section id="posts" class="panel blog-feed" aria-labelledby="posts-heading"><div class="blog-section-heading"><h2 id="posts-heading">更多文章</h2><a class="blog-text-link" href="/archive/">浏览归档 ↗</a></div>"#);
        } else {
            cards.push_str(&format!(r#"<article class="post-card home-card blog-post"><div class="post-copy"><h3><a href="/posts/{slug}/">{title}</a></h3><p>{description}</p>{meta}</div>{cover}</article>"#,
                slug = escape_html(post.slug()), title = escape_html(post.title()), description = escape_html(post.description())));
        }
    }
    if visible.is_empty() {
        cards.push_str(&format!(r#"<section id="posts" class="panel home-empty"><h2>文字，即将生长。</h2><p>这里还没有发布的文章，欢迎稍后再来。</p>{}</section>"#, home_illustration(config)));
    } else {
        cards.push_str(r#"<div class="blog-feed-end"><span>慢慢写，认真记。</span><a class="blog-text-link" href="/post/">查看全部文章 →</a></div></section>"#);
    }
    let title = config
        .big_title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if config.subtitle.trim().is_empty() {
            &config.title
        } else {
            &config.subtitle
        });
    let welcome = if config
        .big_title
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        &config.subtitle
    } else {
        "欢迎来到我的一小块写作空间。"
    };
    let body = format!(
        r#"<div class="reader-welcome"><h1>{title}<span>{subtitle}</span></h1></div><div class="home-layout">{cards}</div>"#,
        title = escape_html(title),
        subtitle = escape_html(welcome)
    );
    page(
        &config.title,
        &config.description,
        &config.title,
        &config.description,
        &body,
        "",
        css_hash,
        config,
        "home",
        &home_context(config, shorts),
    )
}

/// Renders the blog index page listing all published posts.
pub fn render_index(config: &SiteConfig, posts: &[Post], css_hash: &str) -> String {
    render_index_with_shorts(config, posts, &[], css_hash)
}

pub const POSTS_PER_PAGE: usize = 10;

/// The first article batch; subsequent batches also work as ordinary HTML pages.
pub fn render_posts(config: &SiteConfig, posts: &[Post], css_hash: &str) -> String {
    render_posts_page(config, posts, css_hash, 1)
}

pub fn render_posts_page(
    config: &SiteConfig,
    posts: &[Post],
    css_hash: &str,
    page_number: usize,
) -> String {
    let mut visible: Vec<_> = posts.iter().filter(|post| !post.draft()).collect();
    visible.sort_by(|a, b| b.date().cmp(a.date()).then_with(|| b.slug().cmp(a.slug())));
    let revision = crate::content_hash(
        &serde_json::to_string(
            &visible
                .iter()
                .map(|p| (p.slug(), p.title(), p.date(), reading_minutes(p)))
                .collect::<Vec<_>>(),
        )
        .expect("article metadata is serializable"),
    );
    let page_number = page_number.max(1);
    let start = (page_number - 1)
        .saturating_mul(POSTS_PER_PAGE)
        .min(visible.len());
    let end = start.saturating_add(POSTS_PER_PAGE).min(visible.len());
    let mut items = String::new();
    for post in &visible[start..end] {
        items.push_str(&format!(
            r#"<li><article class="post-card blog-post"><div class="post-copy"><h2><a href="/posts/{slug}/">{title}</a></h2><div class="story-meta"><time datetime="{date}">{date}</time><span>{minutes} 分钟阅读</span></div></div></article></li>"#,
            slug = escape_html(post.slug()),
            title = escape_html(post.title()),
            date = escape_html(post.date()),
            minutes = reading_minutes(post),
        ));
    }
    let contents = if visible.is_empty() {
        String::from("<p class=\"post-index-empty\">这里还没有发布的文章，欢迎稍后再来。</p>")
    } else {
        let previous = if page_number > 1 {
            format!(
                r#"<a class="blog-text-link" href="{}">← 上一页</a>"#,
                if page_number == 2 {
                    "/post/".into()
                } else {
                    format!("/post/page/{}/", page_number - 1)
                }
            )
        } else {
            String::new()
        };
        let next = if end < visible.len() {
            format!(
                r#"<a class="plain-button" id="post-list-next" href="/post/page/{}/" data-no-swup>继续浏览</a>"#,
                page_number + 1
            )
        } else {
            String::new()
        };
        format!(
            r#"<ol class="post-index-list" id="post-index-list" start="{first}">{items}</ol><nav class="post-index-pagination" aria-label="文章分页"><p id="post-list-status" role="status" aria-live="polite">已显示第 {first}–{end} 篇，共 {total} 篇。</p><div>{previous}{next}<a class="blog-text-link" href="/archive/">按时间归档 →</a></div></nav>"#,
            first = start + 1,
            total = visible.len(),
        )
    };
    let body = format!(
        r#"<section class="panel blog-feed post-index" aria-labelledby="post-index-heading" data-post-revision="{revision}" data-post-start="{start}" data-post-end="{end}" data-post-total="{count}"><header class="blog-section-heading"><h1 id="post-index-heading">文章</h1><p class="post-index-count">共 {count} 篇</p></header>{contents}</section>"#,
        count = visible.len(),
        start = start + 1,
    );
    page(
        &format!("文章 · {}", config.title),
        &config.description,
        &config.title,
        &config.description,
        &body,
        "",
        css_hash,
        config,
        "posts",
        &author_context(config),
    )
}

/// Renders the archive page: every published post grouped by month, newest first.
pub fn render_archive(config: &SiteConfig, posts: &[Post], css_hash: &str) -> String {
    let mut visible: Vec<&Post> = posts.iter().filter(|post| !post.draft()).collect();
    visible.sort_by(|a, b| b.date().cmp(a.date()));
    let mut groups: Vec<(String, Vec<&Post>)> = Vec::new();
    for post in visible {
        let key = post.date().get(..7).unwrap_or(post.date()).to_owned();
        match groups.last_mut() {
            Some((last_key, list)) if *last_key == key => list.push(post),
            _ => groups.push((key, vec![post])),
        }
    }
    let mut sections = String::new();
    for (ym, list) in &groups {
        let year = ym.get(..4).unwrap_or(ym);
        let month = ym.get(5..7).unwrap_or("").trim_start_matches('0');
        let mut items = String::new();
        for post in list {
            items.push_str(&format!(
                "<li><time datetime=\"{date}\">{day}</time><a href=\"/posts/{slug}/\">{title}</a></li>",
                date = escape_html(post.date()),
                day = escape_html(post.date().get(5..).unwrap_or(post.date())),
                slug = escape_html(post.slug()),
                title = escape_html(post.title()),
            ));
        }
        sections.push_str(&format!(
            "<section class=\"archive-group\" aria-label=\"{year} 年 {month} 月\"><h2>{year} 年 {month} 月</h2><ul>{items}</ul></section>",
            year = escape_html(year),
            month = escape_html(month),
            items = items,
        ));
    }
    if sections.is_empty() {
        sections.push_str("<p class=\"archive-empty\">这里还没有发布的文章，欢迎稍后再来。</p>");
    }
    let body = format!(
        "<div class=\"archive-layout\"><h1 id=\"archive-title\">文章归档</h1>{sections}</div>",
        sections = sections,
    );
    page(
        "文章归档",
        &config.description,
        &config.title,
        &config.description,
        &body,
        "",
        css_hash,
        config,
        "archive",
        &author_context(config),
    )
}

/// Renders the shorts feed ("短记"): lightweight timestamped notes in a
/// reverse-chronological stream, newest first. No titles, no excerpts —
/// each card shows the minute-precision timestamp and the rendered body.
pub fn render_shorts(config: &SiteConfig, shorts: &[Short], css_hash: &str) -> String {
    let mut visible: Vec<&Short> = shorts.iter().filter(|short| !short.draft()).collect();
    visible.sort_by(|a, b| b.date().cmp(a.date()));
    let mut items = String::new();
    for short in visible {
        items.push_str(&format!(
            "<article class=\"short-card\"><time class=\"short-time\" datetime=\"{date}\">{date}</time><div class=\"short-body\">{body}</div></article>",
            date = escape_html(short.date()),
            body = short.body_html,
        ));
    }
    if items.is_empty() {
        items.push_str("<p class=\"shorts-empty\">还没有短记，去写第一条吧。</p>");
    }
    let body = format!(
        "<div class=\"shorts-layout\"><h1 id=\"shorts-title\">短记</h1><div class=\"shorts-feed\">{items}</div></div>",
        items = items,
    );
    page(
        "短记",
        &config.description,
        &config.title,
        &config.description,
        &body,
        "",
        css_hash,
        config,
        "shorts",
        &author_context(config),
    )
}

/// Renders a single article. Related links use the existing public index so
/// incremental publishing does not need to regenerate every other article.
pub fn render_post(config: &SiteConfig, post: &Post, css_hash: &str) -> String {
    let minutes = reading_minutes(post);
    let updated = post
        .updated()
        .filter(|date| *date != post.date())
        .map(|date| {
            format!(
                "<span>更新于 <time datetime=\"{date}\">{date}</time></span>",
                date = escape_html(date)
            )
        })
        .unwrap_or_default();
    let body = format!(
        r#"<section class="article-shell reader-article"><article class="panel article-reading"><div class="article-inner"><div class="article-back-row"><a class="back-link article-back" href="/post/">← 返回列表</a><span>文章阅读</span></div><header class="article-heading article-headline"><h1 id="article-title">{title}</h1><p class="article-description article-deck">{description}</p><div class="article-author article-metadata"><span class="author-avatar" aria-hidden="true">{initial}</span><span class="article-author-name">{author}</span><div class="article-details"><time datetime="{date}">{date}</time><span>约 {minutes} 分钟阅读</span>{updated}</div></div><div class="mobile-reader-tools"><button type="button" class="copy-article-link plain-button">{link}复制链接</button></div></header><div class="article-body article-body-text">{body}</div><footer class="article-end share-container"><p>感谢阅读。</p><a class="back-link" href="/post/">← 返回文章列表</a><button id="share-btn" class="plain-button share-button">{link}分享文章</button><span id="share-status" role="status"></span></footer></div></article></section>"#,
        title = display_title(post.title()),
        description = escape_html(post.description()),
        initial = escape_html(&config.author.chars().next().unwrap_or(' ').to_string()),
        author = escape_html(&config.author),
        date = escape_html(post.date()),
        link = icon("link"),
        body = post.body_html
    );
    let context = format!(
        r#"<section class="panel article-toc-panel"><h2>文章目录</h2><div class="reader-toc-slot"></div><div class="reading-progress-widget"><div><span>阅读进度</span><strong id="reading-percent">0%</strong></div><div class="reading-progress-track"><div id="reading-progress" class="reading-progress" aria-hidden="true"></div></div></div></section><section class="panel article-info-panel"><h2>关于这篇文章</h2><dl><div><dt>作者</dt><dd>{author}</dd></div><div><dt>发布日期</dt><dd>{date}</dd></div><div><dt>阅读时长</dt><dd>约 {minutes} 分钟</dd></div></dl><button class="plain-button copy-article-link" type="button">{link}复制文章链接</button></section>{related}"#,
        author = escape_html(&config.author),
        date = escape_html(post.date()),
        link = icon("link"),
        related = r#"<section class="panel related-panel"><h2>继续阅读</h2><div id="related-stories"><a class="related-story" href="/post/">浏览全部文章 →</a></div></section>"#
    );
    let (icon_url, _) = site_icon(config);
    let extra_head = format!(
        r#"<meta property="og:title" content="{title}"><meta property="og:description" content="{description}"><meta property="og:type" content="article"><meta property="og:image" content="{icon_url}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="{title}"><meta name="twitter:description" content="{description}"><meta name="twitter:image" content="{icon_url}">"#,
        title = escape_html(post.title()),
        description = escape_html(post.description()),
        icon_url = escape_html(&icon_url)
    );
    page(
        post.title(),
        post.description(),
        &config.title,
        &config.description,
        &body,
        &extra_head,
        css_hash,
        config,
        "post",
        &context,
    )
}

/// Renders a standalone content page (e.g. the About page).
pub fn render_page(config: &SiteConfig, page_content: &Page, css_hash: &str) -> String {
    let body = format!(
        r#"<section class="article-shell reader-article reader-page">
  <article>
  <h1>{title}</h1>
  <div class="article-body">{body}</div>
</article><div class="reader-toc-slot"></div></section>"#,
        title = escape_html(&page_content.front_matter.title),
        body = page_content.body_html,
    );

    let extra_head = format!(
        r#"<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:type" content="website">"#,
        title = escape_html(&page_content.front_matter.title),
        description = escape_html(&page_content.front_matter.description),
    );

    page(
        &page_content.front_matter.title,
        &page_content.front_matter.description,
        &config.title,
        &config.description,
        &body,
        &extra_head,
        css_hash,
        config,
        "about",
        &author_context(config),
    )
}

/// Renders the 404 error page.
pub fn render_404(config: &SiteConfig, css_hash: &str) -> String {
    page(
        "Not Found",
        &config.description,
        &config.title,
        &config.description,
        r#"<article>
  <h1>404</h1>
  <p>The page you are looking for does not exist.</p>
  <a href="/">Go back home</a>
</article>"#,
        "",
        css_hash,
        config,
        "not-found",
        &author_context(config),
    )
}

// ---------------------------------------------------------------------------
// Private: full-page HTML shell
// ---------------------------------------------------------------------------

/// Assembles a complete HTML document from its parts.
///
/// The CSS is inlined via `styles.css?v={css_hash}` for cache busting.
/// The main client JavaScript lives in `src/assets/client.js` and is embedded
/// at compile time via `include_str!`, avoiding the `{{`/`}}` escape noise
/// that previously made the Rust source hard to read.
fn page(
    title: &str,
    description: &str,
    site_title: &str,
    _site_description: &str,
    body: &str,
    extra_head: &str,
    css_hash: &str,
    config: &SiteConfig,
    page_kind: &str,
    context: &str,
) -> String {
    // Build the document in segments to avoid a 500-line format! string with
    // escaped braces.  Each segment is a distinct format! call or a raw push.
    let mut html = String::with_capacity(16_384);
    let palette = match config.theme_palette.as_deref() {
        Some(value @ ("ink" | "neutral" | "brown" | "blue" | "violet" | "rose")) => value,
        _ => "ink",
    };

    let reading_font = if config.reading_font.as_deref() == Some("sans") {
        "sans"
    } else {
        "serif"
    };
    let reading_font_style = if reading_font == "serif" {
        r#"<link id="reader-font-styles" rel="stylesheet" href="/reader-assets/editorial-font.css">"#
    } else {
        ""
    };
    let (icon_url, icon_type) = site_icon(config);

    // ---- <head> -------------------------------------------------------------
    html.push_str(&format!(
        r##"<!doctype html>
<html lang="zh-CN" data-palette="{palette}" data-reading-font="{reading_font}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{description}">
  <meta name="author" content="{author}">
  <title>{title}</title>
  <link rel="stylesheet" href="/styles.css?v={css_hash}">
  {reading_font_style}
  <link rel="icon" type="{icon_type}" href="{icon_url}">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#6d4327">
  <link rel="alternate" type="application/rss+xml" title="{site_title}" href="/feed.xml">
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css" media="none" id="hljs-light">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css" media="none" id="hljs-dark">
  {extra_head}
  <script>{theme_bootstrap}</script>
"##,
        palette = palette,
        reading_font = reading_font,
        reading_font_style = reading_font_style,
        theme_bootstrap = include_str!("../../../assets/theme.js"),
        description = escape_html(description),
        author = escape_html(&config.author),
        title = escape_html(title),
        site_title = escape_html(site_title),
        css_hash = css_hash,
        extra_head = extra_head,
    ));

    // Analytics is opt-in per deployment; never inherit another author's account.
    if let Some(id) = config.clarity_id.as_deref().filter(|id| {
        !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric())
    }) {
        html.push_str(&format!(
            r#"  <script type="text/javascript">
    (function(c,l,a,r,i,t,y){{
        c[a]=c[a]||function(){{(c[a].q=c[a].q||[]).push(arguments)}};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    }})(window, document, "clarity", "script", "{id}");
  </script>
"#
        ));
    }
    html.push_str("</head>\n");
    let footer = config
        .footer
        .as_deref()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{} built this website using Rust.", config.author));

    let about_available = config.about.as_deref().is_none_or(|s| !s.trim().is_empty());
    let navigation = [
        ("home", "/", "首页"),
        ("posts", "/post/", "文章"),
        ("shorts", "/shorts/", "短记"),
        ("archive", "/archive/", "归档"),
        ("about", "/about/", "关于"),
    ]
    .into_iter()
    .filter(|(key, _, _)| *key != "about" || about_available)
    .map(|(key, href, label)| {
        let active = if page_kind == "post" {
            key == "posts"
        } else {
            key == page_kind
        };
        format!(
            r#"<a href="{href}" data-reader-nav="{key}"{current}>{icon}<span>{label}</span></a>"#,
            icon = icon(if key == "posts" { "article" } else { key }),
            current = if active { " aria-current=\"page\"" } else { "" }
        )
    })
    .collect::<String>();

    // ---- <body> -------------------------------------------------------------
    html.push_str(&format!(
        r##"<body class="reader-shell">
  <a class="reader-skip" href="#swup" data-no-swup>跳到正文</a>
  <aside class="reader-sidebar" id="primary-nav" aria-label="站点导航">
    <a class="site-brand" href="/" title="{site_title}"><span class="site-mark"><img src="{icon_url}" width="24" height="24" alt=""></span><span class="site-title">{site_title}</span></a>
    <nav class="reader-side-nav" aria-label="博客导航">{navigation}</nav>
    <p class="reader-sidebar-note">{subtitle}</p>
  </aside>
  <div class="wrapper reader-layout">
    <header class="site-header reader-header"><p class="reader-site-heading" title="{site_title}">{site_title}</p><div class="reader-tools"><button id="site-search-btn" class="reader-icon search-btn" aria-label="搜索文章 / Search" aria-haspopup="dialog" aria-controls="search-modal"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button><button id="theme-toggle-btn" class="reader-icon" data-reader-theme data-theme-toggle data-icon-only aria-label="切换明暗主题"><svg class="theme-moon" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/></svg><svg class="theme-sun" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/></svg></button></div></header>
    <main id="swup" class="blog-layout" data-palette="{palette}" data-site-icon="{icon_url}" data-page="{page_kind}" tabindex="-1">
      <div id="reader-center" class="blog-main"><div id="reader-center-content" class="transition-fade" data-page="{page_kind}" data-palette="{palette}" data-site-icon="{icon_url}" data-reading-font="{reading_font}" data-site-title="{site_title}">{body}</div></div>
      <aside id="reader-context" class="blog-aside" aria-label="相关内容"><div id="reader-context-content" class="transition-fade">{context}</div></aside>
    </main>
    <footer class="site-footer"><p>{footer}</p><a href="https://github.com/RS-Imagine/cloudink" rel="noopener">CloudInk · 云砚</a></footer>
  </div>
  <nav class="reader-dock" aria-label="手机博客导航">{navigation}</nav>
  <dialog id="search-modal" class="search-modal" role="dialog" aria-modal="true" aria-labelledby="search-heading" aria-describedby="search-status" aria-hidden="true" inert>
    <div class="search-content">
      <div class="search-heading"><h2 id="search-heading">搜索文章</h2><button id="search-close" class="search-close" aria-label="关闭搜索">&times;</button></div>
      <label class="search-input-wrapper" for="search-input"><span>标题、摘要或正文</span><input type="search" id="search-input" class="search-input" placeholder="寻找一段文字…" autocomplete="off" enterkeyhint="search" aria-controls="search-results"></label>
      <p id="search-status" class="search-status" role="status" aria-live="polite">输入关键词搜索文章…</p>
      <ul id="search-results" class="search-results"></ul>
      <p class="search-hint"><span>↑ ↓ 选择 · Enter 打开</span><span>Esc 关闭</span></p>
    </div>
  </dialog>
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
  <script src="https://unpkg.com/swup@4"></script>
  <script src="/client.js?v={client_hash}"></script>
"##,
        palette = palette,
        site_title = escape_html(site_title),
        body = body,
        navigation = navigation,
        subtitle = escape_html(&config.subtitle),
        context = context,
        page_kind = page_kind,
        footer = escape_html(&footer),
        client_hash = crate::content_hash(client_script()),
    ));

    html.push_str(
        r#"</body>
</html>"#,
    );

    html
}
