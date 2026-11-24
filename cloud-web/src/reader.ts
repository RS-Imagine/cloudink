import { PUBLIC_RESPONSE_VERSION } from '../../cloud-admin/src/assets.generated';
import { CURRENT_TEMPLATE_VERSION } from '../../cloud-admin/src/template-version.generated';
import { sha256Hex } from '../../cloud-admin/src/crypto';
import { legacyImagePath } from '../../cloud-admin/src/media';
import { siteIconDerivedKeys } from '../../cloud-admin/src/models';
export async function readerEtag(etag: string, url: URL, siteIcon = ''): Promise<string> {
  const hash = await sha256Hex(
    'reader-v5:' +
      PUBLIC_RESPONSE_VERSION +
      ':' +
      CURRENT_TEMPLATE_VERSION +
      ':' +
      url.origin +
      url.pathname +
      etag +
      ':' +
      siteIcon,
  );
  return '"' + hash + '"';
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

export async function readerHtml(
  response: Response,
  url: URL,
  analytics = false,
  siteIcon = '',
): Promise<Response> {
  if (!response.headers.get('Content-Type')?.includes('text/html')) return response;
  const path = url.pathname.replace(/\/index\.html$/, '/');
  const canonical = new URL(path, url.origin);
  if (/^\/(about|archive|post|post\/page\/[1-9]\d*|posts\/[A-Za-z0-9_-]+)$/.test(path))
    canonical.pathname += '/';
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
    .on('img, source', {
      element(el) {
        for (const attribute of ['src', 'data-full-src']) {
          const path = legacyImagePath(decode(el.getAttribute(attribute) || ''), url.origin);
          if (path) el.setAttribute(attribute, path);
        }
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          const normalized = srcset
            .split(',')
            .map((candidate) => {
              const [src, ...descriptor] = candidate.trim().split(/\s+/);
              const path = legacyImagePath(decode(src), url.origin);
              return path ? [path, ...descriptor].join(' ') : candidate;
            })
            .join(',');
          if (normalized !== srcset) el.setAttribute('srcset', normalized);
        }
      },
    })
    .on('script[src="/analytics.js"]', {
      element(el) {
        if (!analytics) el.remove();
      },
    })
    .on('script[src]', {
      element(el) {
        const src = el.getAttribute('src') || '';
        if (
          /^https:\/\/cdn\.jsdelivr\.net\/gh\/highlightjs\/cdn-release@[^/]+\/build\/highlight(?:\.min)?\.js(?:[?#]|$)/.test(
            src,
          )
        )
          el.remove();
      },
    })
    .on('.article-body .katex', {
      element() {
        hasMath = true;
      },
    })
    .on('.article-body pre code, #swup pre code', {
      element() {
        hasCode = true;
      },
    })
    .on('head link', {
      element(el) {
        const href = el.getAttribute('href') || '';
        const id = el.getAttribute('id');
        if (
          id === 'reader-font-styles' &&
          href === '/reader-assets/editorial-font.css' &&
          el.getAttribute('rel') === 'stylesheet'
        ) {
          el.setAttribute('media', 'print');
          el.setAttribute('data-reader-async', 'style');
          return;
        }
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
      'head link[rel="canonical"],head link[rel="apple-touch-icon"],head meta[property^="og:"],head meta[name^="twitter:"],head script[type="application/ld+json"]',
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
  const derivedIcon = siteIconDerivedKeys(siteIcon);
  const fallbackImage = derivedIcon
    ? new URL('/site-icon/' + derivedIcon.icon512.slice('uploads/icons/'.length), url.origin).href
    : '';
  const hasArticleImage = !!image;
  const shareImage = image || fallbackImage;
  const shareImageAlt = image ? imageAlt : site.trim() || title.trim();
  const tags = [
    ...(hasMath
      ? ['<link rel="stylesheet" data-reader-style="math" href="/reader-assets/katex.css">']
      : []),
    ...(hasCode
      ? [
          '<link rel="stylesheet" media="print" data-reader-style="code" data-reader-async="style" href="/reader-assets/code.css">',
        ]
      : []),
    ...(derivedIcon
      ? [
          `<link rel="apple-touch-icon" sizes="180x180" href="/site-icon/${derivedIcon.apple.slice('uploads/icons/'.length)}">`,
        ]
      : []),
    `<link rel="canonical" href="${escape(canonical.href)}">`,
    `<meta property="og:url" content="${escape(canonical.href)}">`,
    `<meta property="og:title" content="${escape(title.trim())}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    `<meta property="og:site_name" content="${escape(site.trim())}">`,
    `<meta property="og:type" content="${isPost ? 'article' : 'website'}">`,
    `<meta name="twitter:card" content="${hasArticleImage ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escape(title.trim())}">`,
    `<meta name="twitter:description" content="${escape(description)}">`,
  ];
  if (shareImage)
    tags.push(
      `<meta property="og:image" content="${escape(shareImage)}">`,
      `<meta property="og:image:alt" content="${escape(shareImageAlt)}">`,
      `<meta name="twitter:image" content="${escape(shareImage)}">`,
      `<meta name="twitter:image:alt" content="${escape(shareImageAlt)}">`,
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
      ...(shareImage ? { image: [shareImage] } : {}),
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
  const injected = tags.join('\n');
  const headClosings = html.match(/<\/head\s*>/gi);
  if (headClosings && headClosings.length === 1) {
    const output = html.replace(/<\/head\s*>/i, (closing) => injected + closing);
    return new Response(output, { status: response.status, headers });
  }
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(injected, { html: true });
      },
    })
    .transform(new Response(html, { status: response.status, headers }));
}
