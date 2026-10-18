export async function readerEtag(etag: string, url: URL): Promise<string> {
  const input = new TextEncoder().encode('reader-v2:' + url.origin + url.pathname + etag);
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
  let images = 0;
  // The first image remains eager; later images do not compete with initial text.
  const html = await new HTMLRewriter()
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
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=0, must-revalidate' },
  });
}
