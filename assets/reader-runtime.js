/* Public reader enhancements. All resources are compiled, same-origin assets. */
(() => {
  const styles = new Map();
  let highlighter = null;
  let retryMathFonts = false;
  const path = '/reader-assets/';
  function feedback(id) {
    let node = document.getElementById(id);
    if (node) return node;
    let stack = document.getElementById('reader-feedbacks');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'reader-feedbacks';
      document.body.append(stack);
    }
    node = document.createElement('div');
    node.id = id;
    node.className = 'reader-feedback';
    node.hidden = true;
    const message = document.createElement('span');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    node.append(message);
    stack.append(node);
    return node;
  }
  function show(id, message, retry, target) {
    const node = feedback(id);
    node.hidden = false;
    node.firstChild.textContent = message;
    while (node.childElementCount > 1) node.lastChild.remove();
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '重试';
      button.onclick = retry;
      node.append(button);
    }
    if (target) {
      const link = document.createElement('a');
      link.href = target;
      link.textContent = '普通方式打开';
      link.dataset.noSwup = '';
      node.append(link);
    }
    if (retry || target) {
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '关闭提示';
      close.onclick = () => {
        node.hidden = true;
      };
      node.append(close);
    }
  }
  function hide(id) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
  function promoteAsyncStyles(root = document) {
    for (const link of root.querySelectorAll?.('link[data-reader-async="style"]') || []) {
      const activateMedia = () => {
        if (link.media === 'print') link.media = 'all';
      };
      if (link.sheet) activateMedia();
      else link.addEventListener('load', activateMedia, { once: true });
    }
  }
  if (typeof document !== 'undefined') promoteAsyncStyles(document);
  function stylesheet(kind) {
    if (styles.has(kind)) return styles.get(kind);
    const promise = new Promise((resolve, reject) => {
      let link = document.querySelector(
        kind === 'reading'
          ? '#reader-font-styles,link[data-reader-style="reading"]'
          : 'link[data-reader-style="' + kind + '"]',
      );
      if (link?.sheet) {
        if (link.media === 'print') link.media = 'all';
        resolve();
        return;
      }
      const fresh = !link;
      if (fresh) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.readerStyle = kind;
        link.href =
          path + { math: 'katex.css', code: 'code.css', reading: 'editorial-font.css' }[kind];
      }
      const done = (error) => {
        clearTimeout(timer);
        link.removeEventListener('load', loaded);
        link.removeEventListener('error', failed);
        if (error) {
          link.remove();
          reject(error);
        } else {
          if (link.media === 'print') link.media = 'all';
          resolve();
        }
      };
      const loaded = () => done();
      const failed = () => done(new Error('阅读样式暂时无法加载。'));
      const timer = setTimeout(failed, 10000);
      link.addEventListener('load', loaded, { once: true });
      link.addEventListener('error', failed, { once: true });
      if (fresh) document.head.append(link);
    });
    styles.set(kind, promise);
    promise.catch(() => {
      if (styles.get(kind) === promise) styles.delete(kind);
    });
    return promise;
  }
  async function retryMathStyles() {
    const response = await fetch(path + 'katex.css', {
      cache: 'reload',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || !response.headers.get('Content-Type')?.includes('text/css'))
      throw new Error('公式样式暂时无法重新加载。');
    const css = await response.text();
    const token = crypto.randomUUID();
    const style = document.createElement('style');
    style.dataset.readerStyle = 'math';
    style.textContent = css.replace(
      /url\(fonts\/(KaTeX_[A-Za-z0-9_-]+\.woff2)\)/g,
      (_, name) => 'url("' + path + 'fonts/' + name + '?retry=' + token + '")',
    );
    const previous = document.querySelectorAll('head [data-reader-style="math"]');
    document.head.append(style);
    // Keep the last usable CSS until the replacement is attached.
    previous.forEach((node) => node.remove());
    styles.set('math', Promise.resolve());
  }
  async function prepare(doc, warm = false) {
    const math = doc.querySelector('.article-body .katex');
    const hasCode = Boolean(doc.querySelector('#swup pre code, .article-body pre code'));
    if (math && retryMathFonts) {
      await retryMathStyles();
      retryMathFonts = false;
    }
    // Reading font faces have system fallbacks; a font failure must not block navigation.
    if (doc.documentElement.dataset.readingFont === 'serif')
      void stylesheet('reading').catch(() => {});
    // Code blocks render immediately as readable monospace text while syntax styles and
    // Highlight.js load asynchronously; never block SPA DOM swap on code.css.
    if (hasCode) {
      if (warm) {
        void stylesheet('code').catch(() => {});
        void loadHighlighter().catch(() => {});
      } else {
        await Promise.all([...(math ? [stylesheet('math')] : []), stylesheet('code')]);
      }
    } else if (math) {
      await stylesheet('math');
    }
    if (math && warm && hasCode) await stylesheet('math');
    if (math && document.fonts) {
      let probe, timer;
      try {
        if (warm) {
          probe = document.createElement('div');
          probe.setAttribute('aria-hidden', 'true');
          probe.inert = true;
          probe.style.cssText =
            'position:fixed;left:-10000px;top:0;visibility:hidden;contain:layout style';
          for (const formula of [...doc.querySelectorAll('.article-body .katex')].slice(0, 30))
            probe.append(formula.cloneNode(true));
          document.body.append(probe);
          // Give the browser one layout before awaiting KaTeX font faces.
          probe.getBoundingClientRect();
        }
        const katexFonts = [...document.fonts].filter(
          (font) => font.family.includes('KaTeX_') && font.status === 'loading',
        );
        const fontWait = katexFonts.length
          ? Promise.allSettled(katexFonts.map((font) => font.loaded))
          : document.fonts.ready;
        await Promise.race([
          fontWait,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('公式字体加载超时。')), 10000);
          }),
        ]);
        for (const font of document.fonts)
          if (font.family.includes('KaTeX_') && font.status === 'error')
            throw new Error('公式字体暂时无法加载。');
      } catch (error) {
        // Keep usable layout CSS while retrying failed font faces on the next attempt.
        retryMathFonts = true;
        throw error;
      } finally {
        clearTimeout(timer);
        probe?.remove();
      }
    }
  }
  const codeBlockSelector = 'pre code:not(.hljs):not([data-highlighted])';
  function unhighlightedCodeBlocks(root = document.getElementById('swup')) {
    return [...(root?.querySelectorAll?.(codeBlockSelector) || [])];
  }
  function hasCodeBlocks(root = document.getElementById('swup')) {
    return Boolean(root?.querySelector?.('pre code'));
  }
  function loadHighlighter() {
    if (window.CloudInkHighlighter) return Promise.resolve(window.CloudInkHighlighter);
    if (highlighter) return highlighter;
    highlighter = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.async = true;
      script.dataset.readerScript = 'highlight';
      script.src = path + 'highlight.js';
      const timer = setTimeout(() => fail(), 10000);
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error('代码暂以纯文本显示，高亮资源加载失败。'));
      };
      script.onerror = fail;
      script.onload = () => {
        clearTimeout(timer);
        if (window.CloudInkHighlighter) resolve(window.CloudInkHighlighter);
        else fail();
      };
      document.head.append(script);
    });
    highlighter.catch(() => {
      highlighter = null;
    });
    return highlighter;
  }
  function nextHighlightSlice() {
    if (typeof globalThis.requestAnimationFrame === 'function')
      return new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  async function highlightBlocks(root, codes, hljs) {
    const CHUNK = 6;
    for (let i = 0; i < codes.length; i++) {
      if (root !== document.getElementById('swup')) return;
      const code = codes[i];
      if (!code.isConnected || code.dataset?.highlighted || code.classList?.contains('hljs'))
        continue;
      const match = code.className.match(/(?:^|\s)(?:language|lang)-([\w+-]+)/i);
      if (match && typeof hljs.getLanguage === 'function' && !hljs.getLanguage(match[1])) {
        code.dataset.highlighted = 'yes';
        code.classList.add('hljs');
      } else {
        hljs.highlightElement(code);
      }
      if ((i + 1) % CHUNK === 0 && i + 1 < codes.length) await nextHighlightSlice();
    }
  }
  async function activate() {
    const root = document.getElementById('swup');
    try {
      const codes = unhighlightedCodeBlocks(root);
      const [, hljs] = await Promise.all([
        prepare(document),
        codes.length ? loadHighlighter() : Promise.resolve(null),
      ]);
      if (root !== document.getElementById('swup')) return;
      if (codes.length && hljs) await highlightBlocks(root, codes, hljs);
      if (root === document.getElementById('swup')) hide('reader-resource-status');
    } catch (error) {
      if (root === document.getElementById('swup'))
        show('reader-resource-status', error.message, () => {
          void activate();
        });
    }
  }
  function untilAbort(work, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('请求已中断。'));
      work.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
  const metadataSelector =
    'meta[name="description"],meta[name="author"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"],script[type="application/ld+json"]';
  function pageMetadata(doc, target) {
    const nodes = [];
    let canonical = null;
    for (const source of doc.head.querySelectorAll(metadataSelector)) {
      if (source.tagName === 'LINK') {
        try {
          const url = new URL(source.getAttribute('href'), location.origin);
          if (url.origin === location.origin) {
            url.hash = '';
            url.search = '';
            canonical = url.href;
          }
        } catch {}
        continue;
      }
      if (source.tagName === 'SCRIPT') {
        try {
          const value = JSON.parse(source.textContent);
          if (!value || typeof value !== 'object') continue;
          const node = document.createElement('script');
          node.type = 'application/ld+json';
          node.textContent = JSON.stringify(value).replace(/</g, '\\u003c');
          nodes.push(node);
        } catch {}
        continue;
      }
      const node = document.createElement('meta');
      const key = source.hasAttribute('property') ? 'property' : 'name';
      node.setAttribute(key, source.getAttribute(key));
      node.content = source.getAttribute('content') || '';
      nodes.push(node);
    }
    const url = new URL(canonical || target, location.origin);
    url.hash = '';
    url.search = '';
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = url.href;
    nodes.push(link);
    return { title: doc.title, nodes };
  }
  function applyMetadata(metadata) {
    document.title = metadata.title;
    document.head.querySelectorAll(metadataSelector).forEach((node) => node.remove());
    document.head.append(...metadata.nodes);
  }
  function canPrefetch() {
    const nav = globalThis.navigator;
    if (nav?.onLine === false) return false;
    const connection = nav?.connection;
    if (connection?.saveData) return false;
    if (/^(?:slow-2g|2g)$/.test(connection?.effectiveType || '')) return false;
    return true;
  }
  function prefetchUrl(link, baseHref = globalThis.location?.href) {
    if (!link || !baseHref) return null;
    if (typeof link !== 'string') {
      if (
        link.hasAttribute?.('download') ||
        link.hasAttribute?.('data-no-swup') ||
        (link.target && link.target !== '_self')
      )
        return null;
      link = link.getAttribute?.('href') || '';
    }
    if (!link || link.startsWith('#')) return null;
    let url, current;
    try {
      current = new URL(baseHref);
      url = new URL(link, current);
    } catch {
      return null;
    }
    if (url.origin !== current.origin || !/^https?:$/.test(url.protocol)) return null;
    const path = url.pathname;
    if (
      path === '/admin' ||
      path.startsWith('/admin/') ||
      path.startsWith('/api/') ||
      path.startsWith('/images/') ||
      path.startsWith('/site-icon/') ||
      path.startsWith('/reader-assets/') ||
      ['/feed.xml', '/sitemap.xml', '/robots.txt', '/_release.json', '/sw.js'].includes(path)
    )
      return null;
    if (/\.[a-z0-9]{1,8}$/i.test(path) && !/\.html?$/i.test(path)) return null;
    const target = path + url.search;
    return target === current.pathname + current.search ? null : target;
  }
  function skeletonKind(target) {
    if (!target) return 'article';
    let pathname = String(target);
    try {
      pathname = new URL(pathname, globalThis.location?.origin || 'https://example.invalid')
        .pathname;
    } catch {}
    if (pathname === '/' || pathname === '') return 'home';
    if (pathname.startsWith('/shorts')) return 'shorts';
    if (pathname.startsWith('/archive')) return 'archive';
    if (pathname === '/post' || pathname === '/post/' || pathname.startsWith('/post/page/'))
      return 'posts';
    if (pathname.startsWith('/about')) return 'page';
    return 'article';
  }
  function skeletonMarkup(kind) {
    const authorPanel =
      '<section class="panel author-card ci-sk-panel" aria-hidden="true">' +
      '<div class="author-head"><span class="ci-sk ci-sk-avatar-lg"></span><div class="ci-sk-stack">' +
      '<span class="ci-sk ci-sk-line ci-sk-w-72"></span><span class="ci-sk ci-sk-meta ci-sk-w-92"></span></div></div>' +
      '<div class="ci-sk-para"><span class="ci-sk ci-sk-line"></span><span class="ci-sk ci-sk-line ci-sk-w-82"></span></div>' +
      '<span class="ci-sk ci-sk-btn"></span></section>';
    if (kind === 'shorts') {
      const card =
        '<article class="short-card ci-sk-short">' +
        '<span class="ci-sk ci-sk-meta ci-sk-w-meta-md"></span>' +
        '<div class="ci-sk-para"><span class="ci-sk ci-sk-line"></span><span class="ci-sk ci-sk-line ci-sk-w-92"></span><span class="ci-sk ci-sk-line ci-sk-w-64"></span></div>' +
        '</article>';
      return {
        center:
          '<div class="shorts-layout ci-sk-shell" aria-hidden="true">' +
          '<span class="ci-sk ci-sk-page-title"></span>' +
          '<div class="shorts-feed">' +
          card +
          card +
          card +
          '</div></div>',
        context: authorPanel,
      };
    }
    if (kind === 'posts') {
      const row =
        '<div class="blog-post ci-sk-list-row"><div class="post-copy">' +
        '<span class="ci-sk ci-sk-h3 ci-sk-w-76"></span>' +
        '<div class="ci-sk-meta-row"><span class="ci-sk ci-sk-meta ci-sk-w-meta-md"></span><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span></div>' +
        '</div></div>';
      return {
        center:
          '<section class="panel blog-feed post-index ci-sk-shell" aria-hidden="true">' +
          '<header class="blog-section-heading"><span class="ci-sk ci-sk-page-title"></span><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span></header>' +
          row +
          row +
          row +
          row +
          row +
          '</section>',
        context: authorPanel,
      };
    }
    if (kind === 'archive') {
      const item =
        '<div class="ci-sk-archive-row"><span class="ci-sk ci-sk-meta ci-sk-w-meta-xs"></span><span class="ci-sk ci-sk-line ci-sk-w-72"></span></div>';
      const group =
        '<section class="archive-group"><span class="ci-sk ci-sk-h3 ci-sk-w-45"></span>' +
        item +
        item +
        item +
        '</section>';
      return {
        center:
          '<div class="archive-layout ci-sk-shell" aria-hidden="true">' +
          '<span class="ci-sk ci-sk-page-title"></span>' +
          group +
          group +
          '</div>',
        context: authorPanel,
      };
    }
    if (kind === 'home') {
      const row =
        '<div class="blog-post ci-sk-list-row"><div class="post-copy">' +
        '<span class="ci-sk ci-sk-h3 ci-sk-w-76"></span>' +
        '<span class="ci-sk ci-sk-line ci-sk-w-92"></span>' +
        '<div class="ci-sk-meta-row"><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span><span class="ci-sk ci-sk-meta ci-sk-w-meta-md"></span></div>' +
        '</div></div>';
      return {
        center:
          '<div class="home-layout ci-sk-shell" aria-hidden="true">' +
          '<article class="panel featured-article ci-sk-feature"><div class="feature-copy ci-sk-stack">' +
          '<span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span>' +
          '<span class="ci-sk ci-sk-h1 ci-sk-w-88"></span><span class="ci-sk ci-sk-h1 ci-sk-w-64"></span>' +
          '<span class="ci-sk ci-sk-line ci-sk-w-96"></span><span class="ci-sk ci-sk-line ci-sk-w-76"></span>' +
          '<span class="ci-sk ci-sk-btn ci-sk-btn-inline"></span></div>' +
          '<span class="ci-sk ci-sk-cover"></span></article>' +
          '<section class="panel blog-feed">' +
          row +
          row +
          '</section></div>',
        context: authorPanel,
      };
    }
    if (kind === 'page') {
      return {
        center:
          '<section class="article-shell reader-article reader-page ci-sk-shell" aria-hidden="true">' +
          '<article class="panel"><span class="ci-sk ci-sk-h1 ci-sk-w-45"></span>' +
          '<div class="ci-sk-body">' +
          '<div class="ci-sk-para"><span class="ci-sk ci-sk-line"></span><span class="ci-sk ci-sk-line ci-sk-w-96"></span><span class="ci-sk ci-sk-line ci-sk-w-76"></span></div>' +
          '<div class="ci-sk-para"><span class="ci-sk ci-sk-line ci-sk-w-92"></span><span class="ci-sk ci-sk-line"></span><span class="ci-sk ci-sk-line ci-sk-w-64"></span></div>' +
          '</div></article></section>',
        context: authorPanel,
      };
    }
    return {
      center:
        '<section class="article-shell reader-article ci-sk-shell" aria-hidden="true">' +
        '<article class="panel article-reading"><div class="article-inner">' +
        '<div class="article-back-row"><span class="ci-sk ci-sk-back"></span></div>' +
        '<header class="article-headline">' +
        '<span class="ci-sk ci-sk-h1 ci-sk-w-88"></span>' +
        '<span class="ci-sk ci-sk-h1 ci-sk-w-60"></span>' +
        '<div class="ci-sk-deck-group">' +
        '<span class="ci-sk ci-sk-deck ci-sk-w-96"></span>' +
        '<span class="ci-sk ci-sk-deck ci-sk-w-72"></span></div>' +
        '<div class="article-metadata ci-sk-meta-row">' +
        '<span class="ci-sk ci-sk-avatar"></span>' +
        '<span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span>' +
        '<span class="ci-sk ci-sk-meta ci-sk-w-meta-md"></span>' +
        '<span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span>' +
        '</div></header>' +
        '<div class="article-body article-body-text ci-sk-body">' +
        '<div class="ci-sk-para">' +
        '<span class="ci-sk ci-sk-line"></span>' +
        '<span class="ci-sk ci-sk-line ci-sk-w-96"></span>' +
        '<span class="ci-sk ci-sk-line ci-sk-w-76"></span></div>' +
        '<span class="ci-sk ci-sk-h2 ci-sk-w-45"></span>' +
        '<div class="ci-sk-para">' +
        '<span class="ci-sk ci-sk-line ci-sk-w-96"></span>' +
        '<span class="ci-sk ci-sk-line"></span>' +
        '<span class="ci-sk ci-sk-line ci-sk-w-82"></span></div>' +
        '<span class="ci-sk ci-sk-block"></span>' +
        '<div class="ci-sk-para">' +
        '<span class="ci-sk ci-sk-line"></span>' +
        '<span class="ci-sk ci-sk-line ci-sk-w-92"></span>' +
        '<span class="ci-sk ci-sk-line ci-sk-w-64"></span></div>' +
        '</div></div></article></section>',
      context:
        '<section class="panel article-toc-panel ci-sk-panel" aria-hidden="true">' +
        '<span class="ci-sk ci-sk-panel-title"></span>' +
        '<div class="ci-sk-toc">' +
        '<span class="ci-sk ci-sk-toc-line ci-sk-w-88"></span>' +
        '<span class="ci-sk ci-sk-toc-line ci-sk-w-76"></span>' +
        '<span class="ci-sk ci-sk-toc-line ci-sk-indent ci-sk-w-64"></span>' +
        '<span class="ci-sk ci-sk-toc-line ci-sk-w-82"></span>' +
        '<span class="ci-sk ci-sk-toc-line ci-sk-indent ci-sk-w-60"></span></div>' +
        '<div class="reading-progress-widget">' +
        '<div class="ci-sk-row"><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span><span class="ci-sk ci-sk-meta ci-sk-w-meta-xs"></span></div>' +
        '<div class="reading-progress-track"></div></div></section>' +
        '<section class="panel article-info-panel ci-sk-panel" aria-hidden="true">' +
        '<span class="ci-sk ci-sk-panel-title ci-sk-w-45"></span>' +
        '<div class="ci-sk-dl">' +
        '<div class="ci-sk-row"><span class="ci-sk ci-sk-meta ci-sk-w-meta-xs"></span><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span></div>' +
        '<div class="ci-sk-row"><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span><span class="ci-sk ci-sk-meta ci-sk-w-meta-md"></span></div>' +
        '<div class="ci-sk-row"><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span><span class="ci-sk ci-sk-meta ci-sk-w-meta-sm"></span></div></div>' +
        '<span class="ci-sk ci-sk-btn"></span></section>',
    };
  }
  function attach(swup) {
    if (!swup) return;
    let controller = null,
      pending = null,
      delayed = 0,
      skeletonTimer = 0,
      revealTimer = 0,
      skeletonActive = false,
      hoverTimer = 0,
      idleHandle = 0,
      activePrefetches = 0;
    const inflight = new Map();
    const MAX_PREFETCHES = 2;
    const SKELETON_DELAY = 120;
    const mountSkeletonLayer = (host, html, kind) => {
      if (!host || typeof document.createElement !== 'function') return;
      let layer = host.querySelector?.(':scope > .reader-skeleton-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'reader-skeleton-layer';
        layer.setAttribute('aria-hidden', 'true');
        host.append(layer);
      }
      layer.dataset.skeletonKind = kind;
      layer.innerHTML = html;
      host.classList?.add('is-skeleton');
    };
    const showSkeleton = (targetUrl) => {
      const center = document.getElementById?.('reader-center');
      if (!center || typeof document.createElement !== 'function') return;
      const kind = skeletonKind(targetUrl);
      const markup = skeletonMarkup(kind);
      mountSkeletonLayer(center, markup.center, kind);
      const context = document.getElementById?.('reader-context');
      if (context && markup.context) mountSkeletonLayer(context, markup.context, kind);
      const shell = document.getElementById?.('swup');
      if (shell?.dataset) shell.dataset.skeletonKind = kind;
      skeletonActive = true;
    };
    const hideSkeleton = (reveal = false) => {
      clearTimeout(skeletonTimer);
      skeletonTimer = 0;
      const wasActive = skeletonActive;
      skeletonActive = false;
      const shell = document.getElementById?.('swup');
      if (shell?.dataset) delete shell.dataset.skeletonKind;
      for (const id of ['reader-center', 'reader-context']) {
        const host = document.getElementById?.(id);
        if (!host) continue;
        host.classList?.remove('is-skeleton');
        host.querySelector?.(':scope > .reader-skeleton-layer')?.remove();
      }
      if (reveal && wasActive) {
        clearTimeout(revealTimer);
        const targets = ['reader-center-content', 'reader-context-content']
          .map((id) => document.getElementById?.(id))
          .filter(Boolean);
        for (const node of targets) node.classList?.add('is-skeleton-reveal');
        revealTimer = setTimeout(() => {
          revealTimer = 0;
          for (const node of targets) node.classList?.remove('is-skeleton-reveal');
        }, 260);
      }
    };
    const clear = (reveal = false) => {
      clearTimeout(delayed);
      delayed = 0;
      hideSkeleton(reveal);
      document.getElementById?.('swup')?.removeAttribute('aria-busy');
      hide('reader-navigation-status');
    };
    const cancelHover = () => {
      clearTimeout(hoverTimer);
      hoverTimer = 0;
    };
    const cancelIdle = () => {
      if (!idleHandle) return;
      if (typeof globalThis.cancelIdleCallback === 'function')
        globalThis.cancelIdleCallback(idleHandle);
      else clearTimeout(idleHandle);
      idleHandle = 0;
    };
    function prefetch(targetUrl, { warmCode = false } = {}) {
      if (
        !targetUrl ||
        !canPrefetch() ||
        activePrefetches >= MAX_PREFETCHES ||
        swup.cache?.get?.(targetUrl) ||
        inflight.has(targetUrl) ||
        typeof globalThis.fetch !== 'function'
      )
        return null;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 8000);
      activePrefetches++;
      const promise = (async () => {
        try {
          const response = await fetch(targetUrl, {
            method: 'GET',
            headers: { ...(swup.options?.requestHeaders || {}), Purpose: 'prefetch' },
            signal: abort.signal,
            priority: 'low',
          });
          if (!response.ok || !response.headers.get('Content-Type')?.includes('text/html')) {
            await response.body?.cancel?.();
            return null;
          }
          const finalUrl = new URL(response.url, location.href);
          if (finalUrl.origin !== location.origin) return null;
          const html = await response.text();
          if (!html.includes('id="swup"')) return null;
          const resolved = finalUrl.pathname + finalUrl.search;
          const page = { url: resolved, html };
          if (resolved === targetUrl) swup.cache?.set?.(resolved, page);
          if (
            warmCode &&
            (html.includes('data-reader-style="code"') || /<pre[^>]*>\s*<code/i.test(html))
          )
            void stylesheet('code').catch(() => {});
          return page;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
          activePrefetches--;
          if (inflight.get(targetUrl)?.promise === promise) inflight.delete(targetUrl);
        }
      })();
      inflight.set(targetUrl, { promise, abort });
      return promise;
    }
    function scheduleIdleWarmup() {
      if (typeof document.querySelectorAll !== 'function' || !canPrefetch()) return;
      cancelIdle();
      const run = async () => {
        idleHandle = 0;
        if (!canPrefetch() || document.hidden || pending) return;
        const candidates = [];
        const add = (el) => {
          if (!el || el.id?.startsWith('reader-link-')) return;
          const url = prefetchUrl(el);
          if (url && !candidates.includes(url) && !swup.cache?.get?.(url)) candidates.push(url);
        };
        document
          .querySelectorAll(
            '[data-reader-nav="shorts"],[data-reader-nav="posts"],.blog-note a[href^="/shorts/"]',
          )
          .forEach(add);
        let posts = 0;
        for (const el of document.querySelectorAll(
          '.home-card h2 a[href^="/posts/"],.home-card h3 a[href^="/posts/"],.post-index-list a[href^="/posts/"]',
        )) {
          if (posts >= 3) break;
          const before = candidates.length;
          add(el);
          if (candidates.length > before) posts++;
        }
        // Fetch up to MAX_PREFETCHES routes in parallel instead of serializing with artificial delays.
        for (let i = 0; i < candidates.length; i += MAX_PREFETCHES) {
          if (!canPrefetch() || document.hidden || pending) break;
          const batch = candidates.slice(i, i + MAX_PREFETCHES);
          await Promise.all(batch.map((url) => prefetch(url, { warmCode: false })));
        }
      };
      idleHandle =
        typeof globalThis.requestIdleCallback === 'function'
          ? globalThis.requestIdleCallback(() => void run(), { timeout: 1500 })
          : setTimeout(() => void run(), 300);
    }
    if (typeof document.addEventListener === 'function') {
      const scheduleIntent = (event, delay) => {
        const anchor = event.target?.closest?.('a[href]');
        const url = prefetchUrl(anchor);
        if (!url) return;
        cancelHover();
        if (delay <= 0) {
          void prefetch(url, { warmCode: true });
          return;
        }
        hoverTimer = setTimeout(() => {
          hoverTimer = 0;
          void prefetch(url, { warmCode: true });
        }, delay);
      };
      document.addEventListener(
        'pointerover',
        (event) => {
          if (event.pointerType !== 'touch') scheduleIntent(event, 65);
        },
        { passive: true },
      );
      document.addEventListener(
        'pointerout',
        (event) => {
          if (event.target?.closest?.('a[href]')) cancelHover();
        },
        { passive: true },
      );
      document.addEventListener('touchstart', (event) => scheduleIntent(event, 0), {
        passive: true,
      });
      document.addEventListener('focusin', (event) => scheduleIntent(event, 65), { passive: true });
    }
    // Swup 4.10.0 catches errors from ordinary hooks. Prepare before its
    // navigation pipeline so failures cannot create an incomplete history entry.
    const perform = swup.performNavigation.bind(swup);
    swup.performNavigation = async (visit, options = {}) => {
      cancelHover();
      cancelIdle();
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      pending = visit;
      clear();
      const cache = options.cache;
      if (cache !== undefined) {
        visit.cache.read = typeof cache === 'object' ? (cache.read ?? visit.cache.read) : !!cache;
        visit.cache.write =
          typeof cache === 'object' ? (cache.write ?? visit.cache.write) : !!cache;
      }
      let page = visit.cache.read ? swup.cache?.get?.(visit.to.url) : null;
      if (!page) {
        skeletonTimer = setTimeout(() => {
          if (pending === visit) showSkeleton(visit.to.url);
        }, SKELETON_DELAY);
      }
      delayed = setTimeout(() => {
        if (pending === visit) show('reader-navigation-status', '正在打开文章，当前内容仍可阅读…');
      }, 500);
      document.getElementById?.('swup')?.setAttribute('aria-busy', 'true');
      const timeout = setTimeout(() => current.abort(), 12000);
      const target = visit.to.url + (visit.to.hash || '');
      const native = () => {
        clear();
        if (visit.history.popstate || options.history === 'replace') location.replace(target);
        else location.assign(target);
      };
      try {
        if (!page && visit.cache.read && inflight.has(visit.to.url)) {
          const shared = await untilAbort(inflight.get(visit.to.url).promise, current.signal);
          if (shared && shared.html) page = shared;
        }
        if (!page) {
          const response = await fetch(visit.to.url, {
            method: options.method || 'GET',
            body: options.body,
            headers: { ...swup.options.requestHeaders, ...options.headers },
            signal: current.signal,
          });
          if (!response.ok) throw new Error('文章暂时无法读取。');
          if (!response.headers.get('Content-Type')?.includes('text/html')) {
            await response.body?.cancel();
            if (pending === visit && !current.signal.aborted) native();
            return;
          }
          const url = new URL(response.url);
          if (url.origin !== location.origin) {
            native();
            return;
          }
          page = { url: url.pathname + url.search, html: await response.text() };
        }
        const doc = new DOMParser().parseFromString(page.html, 'text/html');
        if (!doc.getElementById('swup')) {
          if (pending === visit && !current.signal.aborted) native();
          return;
        }
        if (!swup.options.containers.every((selector) => doc.querySelector(selector))) {
          if (document.getElementById('swup')) {
            visit.containers = ['#swup'];
          } else {
            if (pending === visit && !current.signal.aborted) native();
            return;
          }
        }
        await untilAbort(prepare(doc, true), current.signal);
        if (pending !== visit || current.signal.aborted) throw new Error('请求已中断。');
        if (visit.cache.write && page.url === visit.to.url) swup.cache?.set?.(page.url, page);
        clearTimeout(skeletonTimer);
        skeletonTimer = 0;
        clearTimeout(delayed);
        delayed = 0;
        hide('reader-navigation-status');
        const hadSkeleton = skeletonActive;
        const result = await perform(visit, {
          ...options,
          meta: {
            ...options.meta,
            readerPage: page,
            readerHead: pageMetadata(doc, page.url),
            hadSkeleton,
          },
        });
        if (skeletonActive) clear(true);
        return result;
      } catch {
        if (pending !== visit) return;
        clear();
        visit.abort();
        if (visit.history.popstate) {
          native();
          return;
        }
        show(
          'reader-navigation-status',
          navigator.onLine
            ? '打开失败，当前文章已保留。可以重试或使用普通方式打开。'
            : '网络已断开，当前文章已保留；联网后可重试。',
          () => swup.navigate(target, { cache: { read: false, write: true } }),
          target,
        );
        visit.trigger.el?.focus({ preventScroll: true });
      } finally {
        clearTimeout(timeout);
        if (pending === visit) pending = null;
      }
    };
    swup.hooks.replace(
      'page:load',
      (visit, args, original) => visit.meta.readerPage || original(visit, args),
    );
    swup.hooks.on('page:view', (visit) => {
      if (swup.visit.id === visit.id && visit.meta.readerHead) applyMetadata(visit.meta.readerHead);
      clear(Boolean(visit.meta?.hadSkeleton));
      scheduleIdleWarmup();
    });
    swup.hooks.on('visit:abort', (visit) => {
      if (pending === visit) {
        controller?.abort();
        clear();
      }
    });
    swup.hooks.on('visit:end', () => {
      if (!swup.navigating || pending === swup.visit) clear();
    });
    window.addEventListener?.('online', () => {
      const node = document.getElementById?.('reader-navigation-status');
      if (node && !node.hidden && node.querySelector('button'))
        node.firstChild.textContent = '网络已恢复，可以重试打开文章。';
    });
    scheduleIdleWarmup();
  }
  window.CloudInkReader = Object.freeze({
    activate,
    attach,
    prepare,
    promoteAsyncStyles,
    hasCodeBlocks,
    unhighlightedCodeBlocks,
    prefetchUrl,
    canPrefetch,
    skeletonKind,
    skeletonMarkup,
  });
})();
