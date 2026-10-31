export async function readerEtag(etag: string, url: URL): Promise<string> {
  const input = new TextEncoder().encode('reader-v3:' + url.origin + url.pathname + etag);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return '"' + [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('') + '"';
}

// Response metadata uses the serving origin, so forks need no domain configuration.
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!;
  });

const decode = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[
      name.toLowerCase()
    ];
  });

export async function readerHtml(response: Response, url: URL): Promise<Response> {
  if (!response.headers.get('Content-Type')?.includes('text/html')) return response;
  const path = url.pathname.replace(/\/index\.html$/, '/');
  const canonical = new URL(path, url.origin);
  if (/^\/(about|posts\/[A-Za-z0-9_-]+)$/.test(path)) canonical.pathname += '/';
  const isPost = /^\/posts\/[A-Za-z0-9_-]+\/$/.test(canonical.pathname);
  let title = '',
    description = '',
    author = '',
    site = '',
    image = '',
    imageAlt = '';
  let images = 0,
    hasMath = false,
    hasCode = false;
  // The first image remains eager; later images do not compete with initial text.
  const html = await new HTMLRewriter()
    .on('.article-body .katex', {
      element() {
        hasMath = true;
      },
    })
    .on('.article-body pre code', {
      element() {
        hasCode = true;
      },
    })
    .on('head link', {
      element(el) {
        const href = el.getAttribute('href') || '';
        const id = el.getAttribute('id');
        if (
          el.hasAttribute('data-reader-style') ||
          id === 'hljs-light' ||
          id === 'hljs-dark' ||
          /^https:\/\/cdn\.jsdelivr\.net\/(?:npm\/katex@[^/]+\/dist\/katex(?:\.min)?\.css|gh\/highlightjs\/cdn-release@[^/]+\/build\/styles\/github(?:-dark)?(?:\.min)?\.css)(?:[?#]|$)/.test(
            href,
          ) ||
          (el.getAttribute('rel') === 'preconnect' && href === 'https://cdn.jsdelivr.net')
        )
          el.remove();
      },
    })
    .on('head title', {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on('head meta[name="description"]', {
      element(el) {
        description = el.getAttribute('content') || '';
      },
    })
    .on('head meta[name="author"]', {
      element(el) {
        author = el.getAttribute('content') || '';
      },
    })
    .on('.site-brand .site-title, .site-brand h1', {
      text(chunk) {
        site += chunk.text;
      },
    })
    .on('.article-body img', {
      element(el) {
        el.setAttribute('decoding', 'async');
        el.setAttribute('loading', images++ === 0 ? 'eager' : 'lazy');
        if (images === 1) el.setAttribute('fetchpriority', 'high');
        else el.removeAttribute('fetchpriority');
        if (!image) {
          try {
            const candidate = new URL(decode(el.getAttribute('src') || ''), url);
            if (el.getAttribute('src') && ['https:', 'http:'].includes(candidate.protocol)) {
              image = candidate.href;
              imageAlt = el.getAttribute('alt') || title;
            }
          } catch {
            /* Invalid image URLs are not shared. */
          }
        }
      },
    })
    .on(
      'head link[rel="canonical"],head meta[property^="og:"],head meta[name^="twitter:"],head script[type="application/ld+json"]',
      {
        element(el) {
          el.remove();
        },
      },
    )
    .transform(response)
    .text();
  title = decode(title);
  description = decode(description);
  author = decode(author);
  site = decode(site);
  imageAlt = decode(imageAlt);
  const tags = [
    ...(hasMath
      ? ['<link rel="stylesheet" data-reader-style="math" href="/reader-assets/katex.css">']
      : []),
    ...(hasCode
      ? ['<link rel="stylesheet" data-reader-style="code" href="/reader-assets/code.css">']
      : []),
    `<link rel="canonical" href="${escape(canonical.href)}">`,
    `<meta property="og:url" content="${escape(canonical.href)}">`,
    `<meta property="og:title" content="${escape(title.trim())}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    `<meta property="og:site_name" content="${escape(site.trim())}">`,
    `<meta property="og:type" content="${isPost ? 'article' : 'website'}">`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escape(title.trim())}">`,
    `<meta name="twitter:description" content="${escape(description)}">`,
  ];
  if (image)
    tags.push(
      `<meta property="og:image" content="${escape(image)}">`,
      `<meta property="og:image:alt" content="${escape(imageAlt)}">`,
      `<meta name="twitter:image" content="${escape(image)}">`,
      `<meta name="twitter:image:alt" content="${escape(imageAlt)}">`,
    );
  if (response.status === 200) {
    const data = {
      '@context': 'https://schema.org',
      '@type': isPost ? 'BlogPosting' : 'WebPage',
      url: canonical.href,
      name: title.trim(),
      headline: title.trim(),
      description,
      ...(author ? { author: { '@type': 'Person', name: author } } : {}),
      ...(image ? { image: [image] } : {}),
      mainEntityOfPage: canonical.href,
    };
    // Escape '<' so author text can never terminate the JSON data element.
    tags.push(
      '<script type="application/ld+json">' +
        JSON.stringify(data).replace(/</g, '\\u003c') +
        '</script>',
    );
  } else tags.push('<meta name="robots" content="noindex">');
  const headers = new Headers(response.headers);
  // Published HTML uses an origin/path/version-aware validator from the router.
  headers.delete('Content-Length');
  if (response.status !== 200) headers.set('X-Robots-Tag', 'noindex');
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(tags.join('\n'), { html: true });
      },
    })
    .transform(new Response(html, { status: response.status, headers }));
}

interface FeedItem {
  title: string;
  slug: string;
  description?: string;
  date?: string;
  updated?: string | null;
}

const isFeedItem = (value: unknown): value is FeedItem => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FeedItem>;
  return (
    typeof item.title === 'string' &&
    item.title.length <= 300 &&
    typeof item.slug === 'string' &&
    /^[A-Za-z0-9_-]{1,100}$/.test(item.slug) &&
    (item.description === undefined ||
      (typeof item.description === 'string' && item.description.length <= 2000)) &&
    (item.date === undefined || typeof item.date === 'string') &&
    (item.updated == null || typeof item.updated === 'string')
  );
};

const toRfc822 = (value: string | undefined | null): string | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  return new Date(time).toUTCString();
};

const feedText = (value: string) =>
  escape(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ''));

// Only public, release-scoped metadata is read. Storage errors must not replace
// a previously populated subscription with a successful but empty response.
async function buildFeed(url: URL, bucket: R2Bucket, id: string | null): Promise<string> {
  let siteTitle = 'Blog';
  let siteDescription = '';
  let items: unknown = [];
  if (id) {
    const siteObj = await bucket.get(`public/${id}/site.json`);
    if (siteObj) {
      const site = await siteObj.json<{ title?: string; description?: string }>();
      if (site && typeof site.title === 'string' && site.title)
        siteTitle = site.title.slice(0, 300);
      if (site && typeof site.description === 'string')
        siteDescription = site.description.slice(0, 2000);
    }
    const indexObj = await bucket.get(`public/${id}/search_index.json`);
    if (indexObj) items = await indexObj.json();
  }
  if (!Array.isArray(items)) throw new Error('Published feed index is invalid');
  const selected = items.filter(isFeedItem).slice(0, 50);
  const lastBuildDate = selected
    .map((item) => toRfc822(item.updated || item.date))
    .filter((date): date is string => date !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const entries = selected
    .map((item) => {
      const link = url.origin + '/posts/' + item.slug + '/';
      const pubDate = toRfc822(item.date);
      return (
        '<item>' +
        `<title>${feedText(item.title)}</title>` +
        `<link>${escape(link)}</link>` +
        `<guid>${escape(link)}</guid>` +
        (pubDate ? `<pubDate>${pubDate}</pubDate>` : '') +
        `<description>${feedText(item.description || '')}</description>` +
        '</item>'
      );
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0"><channel>' +
    `<title>${feedText(siteTitle)}</title>` +
    `<link>${escape(url.origin + '/')}</link>` +
    `<description>${feedText(siteDescription)}</description>` +
    (lastBuildDate ? `<lastBuildDate>${lastBuildDate}</lastBuildDate>` : '') +
    entries +
    '</channel></rss>'
  );
}

export async function discovery(
  request: Request,
  bucket: R2Bucket,
  id: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  let body: string, type: string;
  if (url.pathname === '/robots.txt') {
    body = `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${url.origin}/sitemap.xml\n`;
    type = 'text/plain; charset=utf-8';
  } else if (url.pathname === '/feed.xml') {
    body = await buildFeed(url, bucket, id);
    type = 'application/rss+xml; charset=utf-8';
  } else {
    const paths = ['/'];
    if (id && (await bucket.head(`public/${id}/index.html`))) {
      if (await bucket.head(`public/${id}/about/index.html`)) paths.push('/about/');
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: `public/${id}/posts/`, cursor, limit: 1000 });
        for (const object of page.objects) {
          const match = object.key
            .slice(`public/${id}/`.length)
            .match(/^posts\/([A-Za-z0-9_-]{1,100})\/index\.html$/);
          if (match) paths.push(`/posts/${match[1]}/`);
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (paths.length > 50000) return new Response('Sitemap limit exceeded', { status: 503 });
      } while (cursor);
    }
    body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      paths
        .sort()
        .map((path) => '<url><loc>' + escape(url.origin + path) + '</loc></url>')
        .join('') +
      '</urlset>';
    type = 'application/xml; charset=utf-8';
  }
  const headers = new Headers({
    'Content-Type': type,
    'Cache-Control': 'public, max-age=0, must-revalidate',
  });
  if (url.pathname === '/feed.xml') {
    const etag = await readerEtag(body, url);
    headers.set('ETag', etag);
    if (
      request.headers
        .get('If-None-Match')
        ?.split(',')
        .some((tag) => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*')
    )
      return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}
