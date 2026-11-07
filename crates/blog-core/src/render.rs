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
        include_str!("assets/home.css"),
        "\n",
        include_str!("assets/reader.css"),
        "\n",
        include_str!("../../../assets/mobile.css"),
        "\n",
        include_str!("../../../assets/expressive.css")
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
        return String::from(
            r#"<figure class="home-illustration" aria-hidden="true"><img src="/editorial-botanical.webp" width="360" height="420" alt="" decoding="async"></figure>"#,
        );
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

fn home_subtitle_class(text: &str) -> &'static str {
    let is_cjk = |c: char| matches!(c as u32, 0x2e80..=0x9fff | 0xac00..=0xd7af);
    if text.chars().any(is_cjk) {
        "home-subtitle"
    } else {
        "home-subtitle subtitle-italic"
    }
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

/// Renders the blog index page listing all published posts and shorts.
pub fn render_index_with_shorts(
    config: &SiteConfig,
    posts: &[Post],
    shorts: &[Short],
    css_hash: &str,
) -> String {
    let mut cards = String::new();
    let mut count = 0;
    let mut unique_tags = std::collections::BTreeSet::new();
    for post in posts.iter().filter(|post| !post.draft()) {
        let featured = count == 0;
        count += 1;
        for tag in &post.front_matter.tags {
            if !tag.trim().is_empty() {
                unique_tags.insert(tag.clone());
            }
        }
        let updated = post
            .updated()
            .filter(|date| *date != post.date())
            .map(|date| {
                format!(
                    "<span>更新 <time datetime=\"{date}\">{date}</time></span>",
                    date = escape_html(date)
                )
            })
            .unwrap_or_default();
        let art = post_thumbnail(post, featured);
        let art_link = if art.is_empty() {
            String::new()
        } else {
            format!(
                r#"<a href="/posts/{slug}/" class="home-card-art-link" aria-hidden="true" tabindex="-1">{art}</a>"#,
                slug = escape_html(post.slug()),
                art = art
            )
        };
        let tags_html = if !post.front_matter.tags.is_empty() {
            let mut s = String::from(r#"<div class="home-card-tags">"#);
            for tag in &post.front_matter.tags {
                s.push_str(&format!(
                    r#"<span class="flclash-tag-pill">{}</span>"#,
                    escape_html(tag)
                ));
            }
            s.push_str("</div>");
            s
        } else {
            String::new()
        };
        let reading_time = ((post.body_plain_text.chars().count() / 300) + 1).max(5);
        cards.push_str(&format!(
            r#"<article class="post-card home-card{featured_class}">
  <div class="home-card-copy">
    <h2><a href="/posts/{slug}/">{title}</a></h2>
    <p>{description}</p>
    {tags_html}
    <div class="home-card-meta meta"><time datetime="{date}">{date}</time><span class="reading-time">⏱️ {reading_time} 分钟阅读</span>{updated}<span class="post-arrow" aria-hidden="true">&rarr;</span></div>
  </div>{art_link}
</article>"#,
            featured_class = if featured { " home-feature" } else { "" },
            slug = escape_html(post.slug()),
            title = escape_html(post.title()),
            description = escape_html(post.description()),
            date = escape_html(post.date()),
            tags_html = tags_html,
            reading_time = reading_time,
            updated = updated,
            art_link = art_link,
        ));
    }
    let title = config
        .big_title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&config.title);

    let about_btn = if config
        .about
        .as_deref()
        .is_none_or(|value| !value.trim().is_empty())
    {
        r#"<a href="/about/" class="flclash-btn-outline">了解更多关于我 &rarr;</a>"#
    } else {
        ""
    };

    let archive_heading_link = if count > 0 {
        r#"<a href="/archive/" class="flclash-more-link">查看全部文章 &rarr;</a>"#
    } else {
        ""
    };

    // Build real published shorts list for right sidebar
    let active_shorts: Vec<_> = shorts.iter().filter(|s| !s.draft()).collect();
    let shorts_count = active_shorts.len();
    let tags_count = unique_tags.len();

    let mut shorts_list_html = String::new();
    if active_shorts.is_empty() {
        shorts_list_html.push_str(r#"<li class="flclash-empty-short"><p style="color:var(--ci-muted);font-size:13px;margin:0;">暂无短记发布</p></li>"#);
    } else {
        for short in active_shorts.iter().take(5) {
            let raw = short.body_plain_text.trim();
            let snippet = if raw.chars().count() > 60 {
                format!("{}…", raw.chars().take(60).collect::<String>())
            } else {
                raw.to_string()
            };
            shorts_list_html.push_str(&format!(
                r#"<li>
  <span class="flclash-short-dot"></span>
  <div class="flclash-short-body">
    <p><a href="/shorts/#{slug}">{snippet}</a></p>
    <time datetime="{date}">{date}</time>
  </div>
</li>"#,
                slug = escape_html(short.slug()),
                snippet = escape_html(&snippet),
                date = escape_html(short.date()),
            ));
        }
    }

    let tag_link_target = if count > 0 { "/archive/" } else { "/#posts" };
    // Build real tag cloud from published articles
    let mut tag_cloud_html = String::new();
    if unique_tags.is_empty() {
        tag_cloud_html.push_str(r#"<p style="color:var(--ci-muted);font-size:12px;margin:0;">暂无常用标签</p>"#);
    } else {
        for tag in &unique_tags {
            tag_cloud_html.push_str(&format!(
                r#"<a href="{tag_link_target}" class="flclash-tag-pill">{}</a>"#,
                escape_html(tag)
            ));
        }
    }

    let avatar_content = if let Some(ref icon) = config.site_icon {
        format!(
            r#"<img src="{icon}" width="42" height="42" alt="" style="width:42px;height:42px;border-radius:50%;object-fit:cover;">"#,
            icon = escape_html(icon)
        )
    } else {
        r#"<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>"#.to_string()
    };

    page(
        &config.title,
        &config.description,
        &config.title,
        &config.description,
        &format!(
            r#"<div class="home-layout flclash-home-layout">
<aside class="flclash-sidebar-left" aria-label="个人简介与统计">
  <div class="flclash-card flclash-profile-card">
    <div class="flclash-avatar" aria-hidden="true">
      {avatar_content}
    </div>
    <h2 class="flclash-profile-name">{author}</h2>
    <p class="flclash-profile-subtitle">{subtitle}</p>
    <p class="flclash-profile-bio">{description}</p>
    {about_btn}
  </div>
  <div class="flclash-card flclash-stats-card">
    <div class="flclash-stat-item">
      <span class="flclash-stat-num">{count}</span>
      <span class="flclash-stat-label">文章</span>
    </div>
    <div class="flclash-stat-item">
      <span class="flclash-stat-num">{shorts_count}</span>
      <span class="flclash-stat-label">短记</span>
    </div>
    <div class="flclash-stat-item">
      <span class="flclash-stat-num">{tags_count}</span>
      <span class="flclash-stat-label">标签</span>
    </div>
  </div>
</aside>
<div class="flclash-main-content">
  <section class="hero home-hero{illustrated}" aria-labelledby="home-title">
    <div class="home-intro">
      <div class="home-eyebrow"><span aria-hidden="true"></span> {author}</div>
      <h1 id="home-title">{title}</h1>
      <p class="{subtitle_class}">{subtitle}</p>
      <p class="home-description">{description}</p>
    </div>
    {illustration}
  </section>
  <section id="posts" aria-labelledby="posts-heading" class="flclash-posts-section">
    <div class="home-section-heading">
      <h2 id="posts-heading"><span class="heading-star">⭐</span> 精选文章</h2>
      {archive_heading_link}
    </div>
    <div class="grid home-post-grid">{cards}</div>
    {archive_link}
  </section>
</div>
<aside class="flclash-sidebar-right" id="tags" aria-label="微动态与常用标签">
  <div class="flclash-card flclash-shorts-card">
    <div class="flclash-card-header">
      <h3 class="flclash-card-title">📝 即时短记</h3>
      <a href="/shorts/" class="flclash-card-more">查看全部短记 &rarr;</a>
    </div>
    <ul class="flclash-shorts-list">
      {shorts_list_html}
    </ul>
  </div>
  <div class="flclash-card flclash-tags-card">
    <h3 class="flclash-card-title">🏷️ 常用标签</h3>
    <div class="flclash-tag-cloud">
      {tag_cloud_html}
    </div>
  </div>
</aside>
</div>"#,
            illustrated = if home_illustration(config).is_empty() {
                ""
            } else {
                " has-illustration"
            },
            illustration = home_illustration(config),
            author = escape_html(&config.author),
            title = display_title(title),
            subtitle = escape_html(&config.subtitle),
            subtitle_class = home_subtitle_class(&config.subtitle),
            description = escape_html(&config.description),
            about_btn = about_btn,
            archive_heading_link = archive_heading_link,
            count = count,
            shorts_count = shorts_count,
            tags_count = tags_count,
            avatar_content = avatar_content,
            shorts_list_html = shorts_list_html,
            tag_cloud_html = tag_cloud_html,
            cards = if cards.is_empty() {
                "<div class=\"home-empty\"><h3>文字，即将生长。</h3><p>这里还没有发布的文章，欢迎稍后再来。</p></div>".to_owned()
            } else {
                cards
            },
            archive_link = if count > 0 {
                "<p class=\"home-archive-link\"><a href=\"/archive/\">查看全部 &rarr;</a></p>"
            } else {
                ""
            },
        ),
        "",
        css_hash,
        config,
        "home",
    )
}

/// Renders the blog index page listing all published posts.
pub fn render_index(config: &SiteConfig, posts: &[Post], css_hash: &str) -> String {
    render_index_with_shorts(config, posts, &[], css_hash)
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
    )
}

/// Renders the shorts feed ("短记"): lightweight timestamped notes in a
/// reverse-chronological stream, newest first. No titles, no excerpts —
/// each card shows the minute-precision timestamp and the rendered body.
pub fn render_shorts(config: &SiteConfig, shorts: &[Short], css_hash: &str) -> String {
    let mut visible: Vec<&Short> = shorts.iter().filter(|short| !short.draft()).collect();
    visible.sort_by(|a, b| b.date().cmp(a.date()).then_with(|| b.slug().cmp(a.slug())));
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
    )
}

/// Renders a single blog post page.
pub fn render_post(config: &SiteConfig, post: &Post, css_hash: &str) -> String {
    let updated = post
        .updated()
        .filter(|value| *value != post.date())
        .map(|value| {
            format!(
                "<span>更新于 <time datetime=\"{date}\">{date}</time></span>",
                date = escape_html(value)
            )
        })
        .unwrap_or_default();
    // Approximate mixed Chinese/Japanese/Korean characters and space-separated words.
    let is_cjk = |c: char| matches!(c as u32, 0x3400..=0x9fff | 0x3040..=0x30ff | 0xac00..=0xd7af);
    let characters = post.body_plain_text.chars().filter(|c| is_cjk(*c)).count();
    let words = post
        .body_plain_text
        .split_whitespace()
        .filter(|word| word.chars().any(|c| c.is_alphanumeric() && !is_cjk(c)))
        .count();
    let minutes = (characters as f64 / 400.0 + words as f64 / 200.0)
        .ceil()
        .max(1.0) as usize;

    let body = format!(
        r#"<div id="reading-progress" class="reading-progress" aria-hidden="true"></div>
<section class="article-shell reader-article">
  <article>
    <header class="article-heading">
      <a class="back-link article-back" href="/">&larr; 所有文章</a>
      <h1>{title}</h1>
      <p class="meta article-description">{description}</p>
      <div class="article-author"><span class="home-avatar" aria-hidden="true">{initial}</span><div><span class="article-author-name">{author}</span><div class="meta article-details"><time datetime="{date}">{date}</time><span>约 {minutes} 分钟阅读</span>{updated}</div></div></div>
    </header>
    <div class="article-body">{body}</div>
    <div class="share-container article-end">
      <a class="back-link" href="/">&larr; 返回文章</a>
      <div class="article-share-actions">
        <button id="share-btn" class="share-button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8"/></svg>分享文章</button>
      </div>
      <span id="share-status" role="status"></span>
    </div>
  </article>
  <div class="reader-toc-slot"></div>
</section>"#,
        date = escape_html(post.date()),
        updated = updated,
        minutes = minutes,
        title = display_title(post.title()),
        description = escape_html(post.description()),
        author = escape_html(&config.author),
        initial = escape_html(&config.author.chars().next().unwrap_or(' ').to_string()),
        body = post.body_html,
    );

    let (icon_url, _) = site_icon(config);
    let extra_head = format!(
        r#"<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:type" content="article">
<meta property="og:image" content="{icon_url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{icon_url}">"#,
        title = escape_html(post.title()),
        description = escape_html(post.description()),
        icon_url = escape_html(&icon_url),
    );

    page(
        &post.front_matter.title,
        &post.front_matter.description,
        &config.title,
        &config.description,
        &body,
        &extra_head,
        css_hash,
        config,
        "post",
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
) -> String {
    // Build the document in segments to avoid a 500-line format! string with
    // escaped braces.  Each segment is a distinct format! call or a raw push.
    let mut html = String::with_capacity(16_384);
    let palette = match config.theme_palette.as_deref() {
        Some(value @ ("ink" | "neutral" | "brown" | "blue" | "violet" | "rose")) => value,
        _ => "ink",
    };

    let (icon_url, icon_type) = site_icon(config);

    // ---- <head> -------------------------------------------------------------
    html.push_str(&format!(
        r##"<!doctype html>
<html lang="en" data-palette="{palette}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{description}">
  <meta name="author" content="{author}">
  <title>{title}</title>
  <link rel="stylesheet" href="/styles.css?v={css_hash}">
  <link rel="stylesheet" href="/reader-assets/editorial-font.css">
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

    let navigation = format!(
        r#"<a href="/#posts" data-reader-nav="posts"{posts_current}>文章</a><a href="/shorts/" data-reader-nav="shorts"{shorts_current}>短记</a>{about}"#,
        posts_current = if page_kind == "home" {
            " aria-current=\"page\""
        } else {
            ""
        },
        shorts_current = if page_kind == "shorts" {
            " aria-current=\"page\""
        } else {
            ""
        },
        about = if config
            .about
            .as_deref()
            .is_none_or(|value| !value.trim().is_empty())
        {
            format!(
                "<a href=\"/about/\" data-reader-nav=\"about\"{}>关于</a>",
                if page_kind == "about" {
                    " aria-current=\"page\""
                } else {
                    ""
                }
            )
        } else {
            String::new()
        },
    );

    // ---- <body> -------------------------------------------------------------
    html.push_str(&format!(
        r##"<body>
  <a class="reader-skip" href="#swup" data-no-swup>跳到正文</a>
  <div class="wrapper reader-layout">
    <header class="site-header reader-header">
      <a class="site-brand" href="/" title="{site_title}">
        <span class="site-mark"><img src="{icon_url}" width="26" height="26" alt=""></span>
        <span class="site-title">{site_title}</span>
      </a>
      <div class="reader-navigation">
        <nav class="site-nav desktop-reader-nav" aria-label="博客导航">{navigation}</nav>
        <div class="reader-tools">
          <button id="site-search-btn" class="reader-icon search-btn flclash-search-btn" aria-label="搜索文章 / Search" aria-haspopup="dialog" aria-controls="search-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button>
          <details class="reader-menu" id="reader-menu">
            <summary class="reader-icon" aria-label="博客菜单"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg><span class="reader-sr-only">菜单</span></summary>
            <nav class="reader-menu-links" aria-label="手机博客导航">{navigation}</nav>
          </details>
        </div>
      </div>
    </header>
    <main id="swup" class="transition-fade" data-palette="{palette}" data-site-icon="{icon_url}" data-page="{page_kind}" tabindex="-1">
      {body}
    </main>
    <footer class="site-footer"><div class="site-footer-copy"><p>{footer}</p><a href="https://github.com/RS-Imagine/cloudink" rel="noopener">CloudInk · 云砚</a></div></footer>
  </div>
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
