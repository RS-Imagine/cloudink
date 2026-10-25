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
  function stylesheet(kind) {
    if (styles.has(kind)) return styles.get(kind);
    const promise = new Promise((resolve, reject) => {
      let link = document.querySelector('link[data-reader-style="' + kind + '"]');
      if (link?.sheet) {
        resolve();
        return;
      }
      const fresh = !link;
      if (fresh) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.readerStyle = kind;
        link.href = path + (kind === 'math' ? 'katex.css' : 'code.css');
      }
      const done = (error) => {
        clearTimeout(timer);
        link.removeEventListener('load', loaded);
        link.removeEventListener('error', failed);
        if (error) {
          link.remove();
          reject(error);
        } else resolve();
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
  async function prepare(doc, warm = false) {
    const math = doc.querySelector('.article-body .katex');
    if (math && retryMathFonts) {
      const previous = document.querySelector('link[data-reader-style="math"]');
      if (previous) {
        previous.setAttribute('data-reader-math-stale', '');
        previous.removeAttribute('data-reader-style');
      }
      styles.delete('math');
      retryMathFonts = false;
    }
    await Promise.all([
      ...(math ? [stylesheet('math')] : []),
      ...(doc.querySelector('.article-body pre code') ? [stylesheet('code')] : []),
    ]);
    if (math)
      document.querySelectorAll('link[data-reader-math-stale]').forEach((node) => node.remove());
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
          // Give the browser one layout before awaiting its newly used font faces.
          probe.getBoundingClientRect();
        }
        await Promise.race([
          document.fonts.ready,
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
  function loadHighlighter() {
    if (window.CloudInkHighlighter) return Promise.resolve(window.CloudInkHighlighter);
    if (highlighter) return highlighter;
    highlighter = new Promise((resolve, reject) => {
      const script = document.createElement('script');
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
  async function activate() {
    const root = document.getElementById('swup');
    try {
      await prepare(document);
      const codes = [
        ...(root?.querySelectorAll('pre code:not(.hljs):not([data-highlighted])') || []),
      ];
      if (codes.length) {
        const hljs = await loadHighlighter();
        if (root !== document.getElementById('swup')) return;
        for (const code of codes) if (code.isConnected) hljs.highlightElement(code);
      }
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
  function attach(swup) {
    if (!swup) return;
    let controller = null,
      pending = null,
      delayed = 0;
    const clear = () => {
      clearTimeout(delayed);
      document.getElementById('swup')?.removeAttribute('aria-busy');
      hide('reader-navigation-status');
    };
    // Swup 4.10.0 catches errors from ordinary hooks. Prepare before its
    // navigation pipeline so failures cannot create an incomplete history entry.
    const perform = swup.performNavigation.bind(swup);
    swup.performNavigation = async (visit, options = {}) => {
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      pending = visit;
      clear();
      delayed = setTimeout(() => {
        if (pending === visit) show('reader-navigation-status', '正在打开文章，当前内容仍可阅读…');
      }, 500);
      document.getElementById('swup')?.setAttribute('aria-busy', 'true');
      const timeout = setTimeout(() => current.abort(), 12000);
      const target = visit.to.url + (visit.to.hash || '');
      const native = () => {
        clear();
        if (visit.history.popstate || options.history === 'replace') location.replace(target);
        else location.assign(target);
      };
      try {
        const cache = options.cache;
        if (cache !== undefined) {
          visit.cache.read = typeof cache === 'object' ? (cache.read ?? visit.cache.read) : !!cache;
          visit.cache.write =
            typeof cache === 'object' ? (cache.write ?? visit.cache.write) : !!cache;
        }
        let page = visit.cache.read ? swup.cache.get(visit.to.url) : null;
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
        await untilAbort(prepare(doc, true), current.signal);
        if (pending !== visit || current.signal.aborted) throw new Error('请求已中断。');
        visit.meta.readerPage = page;
        if (visit.cache.write && page.url === visit.to.url) swup.cache.set(page.url, page);
        clear();
        return perform(visit, options);
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
      }
    };
    swup.hooks.replace(
      'page:load',
      (visit, args, original) => visit.meta.readerPage || original(visit, args),
    );
    swup.hooks.on('visit:abort', (visit) => {
      if (pending === visit) {
        controller?.abort();
        clear();
      }
    });
    swup.hooks.on('visit:end', () => {
      if (!swup.navigating || pending === swup.visit) clear();
    });
    window.addEventListener('online', () => {
      const node = document.getElementById('reader-navigation-status');
      if (node && !node.hidden && node.querySelector('button'))
        node.firstChild.textContent = '网络已恢复，可以重试打开文章。';
    });
  }
  window.CloudInkReader = Object.freeze({ activate, attach });
})();
