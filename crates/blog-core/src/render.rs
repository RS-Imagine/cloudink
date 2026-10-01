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
    include_str!("assets/styles.css")
}

/// Returns the inline SVG favicon source.
pub fn favicon_svg() -> &'static str {
    r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#805030"/>
      <stop offset="100%" stop-color="#502010"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bg)"/>
  <text x="64" y="96" text-anchor="middle" font-family="Georgia, serif" font-size="92" font-weight="700" fill="#E0E0D0">Q</text>
</svg>"##
}

// ---------------------------------------------------------------------------
// Public page renderers
// ---------------------------------------------------------------------------

/// Renders the blog index page listing all published posts.
pub fn render_index(config: &SiteConfig, posts: &[Post], css_hash: &str) -> String {
    let cards: String = posts
        .iter()
        .filter(|post| !post.draft())
        .map(|post| {
            let date_str = match post.updated() {
                Some(u) => format!("{} (Updated: {})", post.date(), u),
                None => post.date().to_string(),
            };
            format!(
                r#"<article class="post-card">
  <div class="meta">{date}</div>
  <h2><a href="/posts/{slug}/">{title}</a></h2>
  <p>{description}</p>
</article>"#,
                date = escape_html(&date_str),
                slug = escape_html(post.slug()),
                title = escape_html(post.title()),
                description = escape_html(post.description()),
            )
        })
        .collect();

    page(
        &config.title,
        &config.description,
        &config.title,
        &config.description,
        &format!(
            r#"<section class="hero">
  <span class="tag">{author}</span>
  <h1>{title}</h1>
  <p>{subtitle}</p>
</section>
<section class="grid">
  {cards}
</section>"#,
            author = escape_html(&config.author),
            title = escape_html(config.big_title.as_deref().unwrap_or(&config.title)),
            subtitle = escape_html(&config.subtitle),
            cards = cards,
        ),
        "",
        css_hash,
        config,
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
  <div>{body}</div>
  <div class="share-container" style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-soft); display: flex; justify-content: space-between; align-items: center;">
    <a class="back-link" href="/">&larr; Back to posts</a>
    <button id="share-btn" style="background: var(--accent); color: var(--bg); border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.95rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;">
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
    )
}

/// Renders a standalone content page (e.g. the About page).
pub fn render_page(config: &SiteConfig, page_content: &Page, css_hash: &str) -> String {
    let body = format!(
        r#"<section class="article-shell">
  <article>
  <h1>{title}</h1>
  <div>{body}</div>
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
    site_description: &str,
    body: &str,
    extra_head: &str,
    css_hash: &str,
    config: &SiteConfig,
) -> String {
    // Build the document in segments to avoid a 500-line format! string with
    // escaped braces.  Each segment is a distinct format! call or a raw push.
    let mut html = String::with_capacity(16_384);

    // ---- <head> -------------------------------------------------------------
    html.push_str(&format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{description}">
  <title>{title}</title>
  <link rel="stylesheet" href="/styles.css?v={css_hash}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css" media="none" id="hljs-light">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css" media="none" id="hljs-dark">
  {extra_head}
  <script>
    (function() {{
      // 1. 优先读取用户手动设置的主题，否则跟随系统
      var stored = localStorage.getItem('theme');
      var theme = (stored === 'dark' || stored === 'light')
        ? stored
        : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      // 2. 在任何渲染发生前设置 data-theme，彻底消除背景色 FOUC
      document.documentElement.setAttribute('data-theme', theme);
      // 3. 同步激活正确的 highlight.js 主题
      var hljsLight = document.getElementById('hljs-light');
      var hljsDark  = document.getElementById('hljs-dark');
      if (hljsLight && hljsDark) {{
        hljsLight.media = theme === 'dark' ? 'none' : 'all';
        hljsDark.media  = theme === 'dark' ? 'all'  : 'none';
      }}
    }})();
  </script>
"#,
        description = escape_html(description),
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

    // ---- <body> -------------------------------------------------------------
    html.push_str(&format!(
        r#"<body>
  <div class="wrapper">
    <header class="site-header">
      <div class="site-brand">
        <h1>{site_title}</h1>
        <p>{site_description}</p>
      </div>
      <nav class="site-nav" aria-label="Primary">
        <a href="/">Home</a>
        <button id="site-search-btn" class="search-btn" aria-label="Search">Search</button>
        <a href="/about/">About</a>
        <button id="theme-toggle-btn" class="search-btn theme-btn" aria-label="Toggle Theme">
          <svg class="sun-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
          <svg class="moon-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>
      </nav>
    </header>
    <main id="swup" class="transition-fade">
      {body}
    </main>
    <footer>{footer}</footer>
  </div>
  <div id="search-modal" class="search-modal">
    <div class="search-content">
      <div class="search-input-wrapper">
        <input type="text" id="search-input" class="search-input" placeholder="Search posts..." autocomplete="off">
      </div>
      <ul id="search-results" class="search-results"></ul>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
  <script src="https://unpkg.com/swup@4"></script>
  <script>
"#,
        site_title = escape_html(site_title),
        site_description = escape_html(site_description),
        body = body,
        footer = escape_html(&footer),
    ));

    // Embed client-side JavaScript from the separate asset file.
    // Because we use push_str rather than format!, the JS braces are NOT
    // interpreted as Rust format placeholders.
    html.push_str(include_str!("assets/client.js"));

    html.push_str(
        r#"  </script>
</body>
</html>"#,
    );

    html
}
