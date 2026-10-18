use crate::models::{Page, Post, SiteConfig};
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
        include_str!("../../../assets/design-tokens.css"), "\n",
        include_str!("assets/styles.css"), "\n",
        include_str!("../../../assets/design-foundation.css"), "\n",
        include_str!("../../../assets/motion.css"), "\n",
        include_str!("assets/home.css")
    )
}

/// Returns the shared CloudInk SVG icon source.
pub fn favicon_svg() -> &'static str {
    include_str!("../../../assets/cloudink.svg")
}

pub fn client_script() -> &'static str {
    concat!(include_str!("../../../assets/motion.js"), "\n", include_str!("assets/client.js"))
}

// ---------------------------------------------------------------------------
// Public page renderers
// ---------------------------------------------------------------------------

/// Renders the blog index page listing all published posts.
pub fn render_index(config: &SiteConfig, posts: &[Post], css_hash: &str) -> String {
    let mut cards = String::new();
    let mut count = 0;
    for post in posts.iter().filter(|post| !post.draft()) {
        let featured = count == 0;
        count += 1;
        let updated = post.updated().map(|date| format!(
            "<span>更新 <time datetime=\"{date}\">{date}</time></span>", date = escape_html(date)
        )).unwrap_or_default();
        let art = if featured {
            r#"<div class="home-feature-art" aria-hidden="true"><span class="landscape-sun"></span><span class="landscape-label">NOTES, NOT NOISE.</span></div>"#
        } else { "" };
        cards.push_str(&format!(
            r#"<article class="post-card home-card{featured_class}">
  <div class="home-card-copy">
    {badge}
    <h2><a href="/posts/{slug}/">{title}</a></h2>
    <p>{description}</p>
    <div class="home-card-meta meta"><time datetime="{date}">{date}</time>{updated}<span class="post-arrow" aria-hidden="true">&rarr;</span></div>
  </div>{art}
</article>"#,
            featured_class = if featured { " home-feature" } else { "" },
            badge = if featured { "<span class=\"home-badge\">最新文章</span>" } else { "" },
            slug = escape_html(post.slug()),
            title = escape_html(post.title()),
            description = escape_html(post.description()),
            date = escape_html(post.date()),
            updated = updated,
            art = art,
        ));
    }
    let title = config.big_title.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or(&config.title);
    page(
        &config.title,
        &config.description,
        &config.title,
        &config.description,
        &format!(
            r#"<div class="home-layout">
<section class="hero home-hero" aria-labelledby="home-title">
  <div class="home-intro">
    <div class="home-eyebrow"><span aria-hidden="true"></span> {site_title}</div>
    <h1 id="home-title">{title}</h1>
    <p>{subtitle}</p>
    <div class="home-author"><span class="home-avatar" aria-hidden="true">{initial}</span><span>{author}</span></div>
  </div>
  <aside class="home-note" aria-hidden="true"><span class="home-note-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m4 16 12-12 4 4L8 20H4Zm9-9 4 4"/></svg></span><p>让想法落笔，<br>让文字生长。</p><small>NOTES, NOT NOISE.</small></aside>
</section>
<section id="posts" aria-labelledby="posts-heading">
  <div class="home-section-heading"><h2 id="posts-heading">最近的文字</h2><span>{count} 篇文章</span></div>
  <div class="grid home-post-grid">{cards}</div>
</section>
</div>"#,
            site_title = escape_html(&config.title),
            title = escape_html(title),
            subtitle = escape_html(&config.subtitle),
            author = escape_html(&config.author),
            initial = escape_html(&config.author.chars().next().unwrap_or(' ').to_string()),
            cards = if cards.is_empty() {
                "<div class=\"home-empty\"><h3>文字，即将生长。</h3><p>这里还没有发布的文章，欢迎稍后再来。</p></div>".to_owned()
            } else { cards },
            count = count,
        ),
        "",
        css_hash,
        config,
        "home",
    )
}

/// Renders a single blog post page.
pub fn render_post(config: &SiteConfig, post: &Post, css_hash: &str) -> String {
    let date_str = match post.updated() {
        Some(u) => format!("{} (Updated: {})", post.date(), u),
        None => post.date().to_string(),
    };

    let body = format!(
        r#"<section class="article-shell">
  <a class="back-link" href="/">&larr; Back to posts</a>
  <article>
  <div class="meta">{date}</div>
  <h1>{title}</h1>
  <p class="meta">{description}</p>
  <div class="article-body">{body}</div>
  <div class="share-container">
    <a class="back-link" href="/">&larr; Back to posts</a>
    <button id="copy-link" class="share-button">Copy link / 复制链接</button>
    <span id="share-status" role="status"></span>
    <button id="share-btn" class="share-button">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
        <path d="M13.5 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 2.5a2.5 2.5 0 1 1 .603 1.628l-6.718 3.12a2.499 2.499 0 0 1 0 1.504l6.718 3.12a2.5 2.5 0 1 1-.488.876l-6.718-3.12a2.5 2.5 0 1 1 0-3.256l6.718-3.12A2.5 2.5 0 0 1 11 2.5zm-8.5 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm11 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>
      </svg>
      Share
    </button>
  </div>
</article></section>"#,
        date = escape_html(&date_str),
        title = escape_html(post.title()),
        description = escape_html(post.description()),
        body = post.body_html,
    );

    let extra_head = format!(
        r#"<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:type" content="article">"#,
        title = escape_html(post.title()),
        description = escape_html(post.description()),
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
        r#"<section class="article-shell">
  <article>
  <h1>{title}</h1>
  <div class="article-body">{body}</div>
</article></section>"#,
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
    let palette = if config.theme_palette.as_deref() == Some("neutral") { "neutral" } else { "ink" };

    // ---- <head> -------------------------------------------------------------
    html.push_str(&format!(
        r#"<!doctype html>
<html lang="en" data-palette="{palette}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{description}">
  <meta name="author" content="{author}">
  <title>{title}</title>
  <link rel="stylesheet" href="/styles.css?v={css_hash}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css" media="none" id="hljs-light">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css" media="none" id="hljs-dark">
  {extra_head}
  <script>{theme_bootstrap}</script>
"#,
        palette = palette,
        theme_bootstrap = include_str!("../../../assets/theme.js"),
        description = escape_html(description),
        author = escape_html(&config.author),
        title = escape_html(title),
        css_hash = css_hash,
        extra_head = extra_head,
    ));

    // Analytics is opt-in per deployment; never inherit another author's account.
    if let Some(id) = config.clarity_id.as_deref().filter(|id| !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric())) {
        html.push_str(&format!(r#"  <script type="text/javascript">
    (function(c,l,a,r,i,t,y){{
        c[a]=c[a]||function(){{(c[a].q=c[a].q||[]).push(arguments)}};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    }})(window, document, "clarity", "script", "{id}");
  </script>
"#));
    }
    html.push_str("</head>\n");
    let footer = config.footer.as_deref().filter(|text| !text.is_empty()).map(str::to_owned)
        .unwrap_or_else(|| format!("{} built this website using Rust.", config.author));

    let navigation = format!(
        r#"<a href="/#posts" data-reader-nav="posts"{posts_current}>文章</a>{about}"#,
        posts_current = if page_kind == "home" { " aria-current=\"page\"" } else { "" },
        about = if config.about.as_deref().is_none_or(|value| !value.trim().is_empty()) {
            format!("<a href=\"/about/\" data-reader-nav=\"about\"{}>关于</a>",
                if page_kind == "about" { " aria-current=\"page\"" } else { "" })
        } else { String::new() },
    );

    // ---- <body> -------------------------------------------------------------
    html.push_str(&format!(
        r#"<body>
  <a class="reader-skip" href="#swup" data-no-swup>跳到正文</a>
  <div class="wrapper reader-layout">
    <header class="site-header reader-header">
      <a class="site-brand" href="/" title="{site_title}">
        <span class="site-mark"><img src="/favicon.svg" width="26" height="26" alt=""></span>
        <span class="site-title">{site_title}</span>
      </a>
      <div class="reader-navigation">
        <nav class="site-nav desktop-reader-nav" aria-label="博客导航">{navigation}</nav>
        <div class="reader-tools">
          <button id="site-search-btn" class="reader-icon search-btn" aria-label="搜索文章 / Search" aria-haspopup="dialog" aria-controls="search-modal"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button>
          <button id="theme-toggle-btn" class="reader-icon theme-btn" aria-label="切换明暗主题">
            <svg class="sun-icon" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
            <svg class="moon-icon" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/></svg>
          </button>
          <details class="reader-menu" id="reader-menu">
            <summary class="reader-icon" aria-label="博客菜单"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span class="reader-sr-only">菜单</span></summary>
            <nav class="reader-menu-links" aria-label="手机博客导航">{navigation}</nav>
          </details>
        </div>
      </div>
    </header>
    <main id="swup" class="transition-fade" data-palette="{palette}" data-page="{page_kind}" tabindex="-1">
      {body}
    </main>
    <footer class="site-footer"><div class="site-footer-copy"><p>{footer}</p><a href="https://github.com/RS-Imagine/cloudink" rel="noopener">CloudInk · 云砚</a></div><label class="theme-mode">外观<select data-theme-mode aria-label="Appearance / 阅读外观"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></footer>
  </div>
  <div id="search-modal" class="search-modal" role="dialog" aria-modal="true" aria-label="Search articles" aria-hidden="true" inert>
    <div class="search-content">
      <div class="search-input-wrapper">
        <input type="text" id="search-input" class="search-input" placeholder="Search posts..." aria-label="Search posts" autocomplete="off">
        <button id="search-close" class="search-close" aria-label="Close search">&times;</button>
      </div>
      <ul id="search-results" class="search-results" aria-live="polite"></ul>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
  <script src="https://unpkg.com/swup@4"></script>
  <script src="/client.js?v={client_hash}"></script>
"#,
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
