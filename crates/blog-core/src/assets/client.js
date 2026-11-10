document.addEventListener('DOMContentLoaded', () => {
  const isZh = (document.documentElement.lang || 'zh').toLowerCase().startsWith('zh');
  const t = (zh, en) => (isZh ? zh : en);
  const motion = window.CloudInkMotion;
  motion?.mount();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const swup =
    typeof Swup === 'function'
      ? new Swup({
          containers: document.getElementById('reader-center-content')
            ? ['#reader-center-content', '#reader-context-content']
            : ['#swup'],
          animationSelector: reducedMotion.matches ? false : '[class*="transition-"]',
        })
      : null;
  reducedMotion.addEventListener('change', () => {
    if (swup)
      swup.options.animationSelector = reducedMotion.matches ? false : '[class*="transition-"]';
  });
  window.swup = swup;
  window.CloudInkReader?.attach(swup);
  let cleanupFunctions = [];

  const syncReaderNavigation = () => {
    const content = document.getElementById('reader-center-content');
    const shell = document.getElementById('swup');
    if (content && shell) {
      for (const key of ['page', 'palette', 'siteIcon', 'readingFont'])
        shell.dataset[key] = content.dataset[key] || '';
    }
    if (content)
      document.documentElement.dataset.readingFont =
        content.dataset.readingFont === 'sans' ? 'sans' : 'serif';
    const siteTitle = content?.dataset.siteTitle;
    if (siteTitle) {
      for (const node of document.querySelectorAll('.site-title,.reader-site-heading'))
        if (node.textContent !== siteTitle) node.textContent = siteTitle;
      for (const node of document.querySelectorAll('.site-brand,.reader-site-heading'))
        if (node.title !== siteTitle) node.title = siteTitle;
    }
    const kind = shell?.dataset.page;
    // Reading keeps the navigation state from the originating list.
    if (kind === 'post') return;
    for (const link of document.querySelectorAll('[data-reader-nav]')) {
      if (link.dataset.readerNav === kind) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };
  // Back-to-top: one persistent floating button for every page.
  const toTop = document.createElement('button');
  toTop.id = 'to-top';
  toTop.type = 'button';
  toTop.className = 'to-top';
  toTop.setAttribute('aria-label', t('回到顶部', 'Back to top'));
  toTop.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 11 6-6 6 6M12 5v14"/></svg>';
  toTop.hidden = true;
  document.body.append(toTop);
  const updateToTop = () => {
    const hidden = window.scrollY < 600;
    if (toTop.hidden !== hidden) toTop.hidden = hidden;
  };
  window.addEventListener('scroll', updateToTop, { passive: true });
  updateToTop();
  toTop.addEventListener('click', () => {
    document.getElementById('swup')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  });

  const searchBtn = document.getElementById('site-search-btn');
  const searchModal = document.getElementById('search-modal');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  let closeArticleContents = null;
  let searchIndex = null;
  let searchLoading = null;
  let loadPublicIndex = async () => null;

  if (searchBtn && searchModal) {
    const nativeSearch = typeof searchModal.showModal === 'function';
    let searchOverflow = null;
    let searchError = false;
    let searchReturnFocus = true;
    let searchStatus = document.getElementById('search-status');
    if (!searchStatus) {
      searchStatus = document.createElement('p');
      searchStatus.className = 'search-status';
      searchStatus.setAttribute('role', 'status');
      searchResults.before(searchStatus);
    }
    const finishSearch = () => {
      if (nativeSearch && searchModal.open) return;
      searchModal.style.transition = 'none';
      searchModal.classList.remove('active');
      searchModal.setAttribute('aria-hidden', 'true');
      searchModal.inert = true;
      if (searchOverflow !== null) document.body.style.overflow = searchOverflow;
      searchOverflow = null;
      if (searchReturnFocus) searchBtn.focus({ preventScroll: true });
    };
    const closeSearch = (immediate = false) => {
      if (!searchModal.classList.contains('active')) return;
      searchModal.style.transition = 'none';
      searchModal.classList.remove('active');
      if (immediate) searchReturnFocus = false;
      if (nativeSearch && searchModal.open) {
        if (motion && !immediate) motion.closeDialog(searchModal);
        else searchModal.close();
      } else finishSearch();
    };
    if (nativeSearch) {
      searchModal.addEventListener('close', finishSearch);
      // The shared motion controller owns cancel when present.
      if (!motion)
        searchModal.addEventListener('cancel', (event) => {
          event.preventDefault();
          closeSearch();
        });
    }
    const highlight = (node, text, query) => {
      if (!query) {
        node.textContent = text;
        return;
      }
      const lower = text.toLowerCase();
      let start = 0,
        found = lower.indexOf(query);
      while (found !== -1) {
        node.append(document.createTextNode(text.slice(start, found)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(found, found + query.length);
        node.append(mark);
        start = found + query.length;
        found = lower.indexOf(query, start);
      }
      node.append(document.createTextNode(text.slice(start)));
    };
    const renderSearch = () => {
      searchResults.replaceChildren();
      searchResults.setAttribute('aria-busy', String(!searchIndex && !searchError));
      if (!searchIndex) {
        searchStatus.textContent = searchError
          ? '暂时无法加载文章，请关闭搜索后重试。'
          : '正在加载文章…';
        return;
      }
      const query = searchInput.value.trim().toLowerCase();
      if (!query) {
        searchStatus.textContent = '输入关键词搜索文章…';
        return;
      }
      const results = searchIndex
        .filter(
          (post) =>
            post.title.toLowerCase().includes(query) ||
            post.description.toLowerCase().includes(query) ||
            post.body.toLowerCase().includes(query),
        )
        .slice(0, 10);
      searchStatus.textContent = results.length
        ? results.length === 10
          ? '显示前 10 篇匹配文章'
          : '找到 ' + results.length + ' 篇匹配文章'
        : '还没有找到匹配的文字，试试其他关键词。';
      const fragment = document.createDocumentFragment();
      for (const post of results) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'search-result-item';
        link.href = '/posts/' + encodeURIComponent(post.slug) + '/';
        const title = document.createElement('div');
        title.className = 'search-result-title';
        const excerpt = document.createElement('div');
        excerpt.className = 'search-result-excerpt';
        let text = post.description.slice(0, 220);
        const match = query ? post.body.toLowerCase().indexOf(query) : -1;
        if (
          match !== -1 &&
          !post.description.toLowerCase().includes(query) &&
          !post.title.toLowerCase().includes(query)
        ) {
          const start = Math.max(0, match - 40),
            end = Math.min(post.body.length, match + query.length + 80);
          text =
            (start ? '…' : '') + post.body.slice(start, end) + (end < post.body.length ? '…' : '');
        }
        // Author text always remains text, including HTML and punctuation.
        highlight(title, post.title, query);
        highlight(excerpt, text, query);
        link.append(title, excerpt);
        item.append(link);
        fragment.append(item);
      }
      searchResults.append(fragment);
    };
    const loadSearch = () => {
      if (!searchLoading)
        searchLoading = (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await fetch('/search_index.json', { signal: controller.signal });
            if (!response.ok) throw new Error('Search index unavailable');
            const posts = await response.json();
            if (
              !Array.isArray(posts) ||
              !posts.every(
                (post) =>
                  post &&
                  ['slug', 'title', 'description', 'body'].every(
                    (key) => typeof post[key] === 'string',
                  ),
              )
            )
              throw new Error('Invalid search index');
            searchIndex = posts;
            searchError = false;
          } catch {
            searchError = true;
          } finally {
            clearTimeout(timeout);
            searchLoading = null;
          }
        })();
      return searchLoading;
    };
    loadPublicIndex = async () => {
      if (!searchIndex) await loadSearch();
      return searchIndex;
    };
    const openSearch = async () => {
      searchReturnFocus = true;
      closeArticleContents?.();
      searchModal.inert = false;
      searchModal.setAttribute('aria-hidden', 'false');
      searchModal.classList.add('active');
      if (searchOverflow === null) searchOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      if (nativeSearch) {
        if (motion) motion.openDialog(searchModal);
        else if (!searchModal.open) searchModal.showModal();
      }
      searchInput.focus({ preventScroll: true });
      if (!searchIndex) searchError = false;
      renderSearch();
      if (!searchIndex) {
        await loadSearch();
        if (searchModal.classList.contains('active')) renderSearch();
      }
    };
    searchBtn.addEventListener('click', openSearch);
    searchInput.addEventListener('input', renderSearch);
    searchResults.addEventListener('click', (event) => {
      if (event.target.closest('a[href]')) closeSearch(true);
    });
    document.getElementById('search-close')?.addEventListener('click', () => closeSearch());
    searchModal.addEventListener('click', (event) => {
      if (event.target === searchModal) closeSearch();
    });
    searchModal.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch();
        return;
      }
      const links = [...searchResults.querySelectorAll('a[href]')];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (
          !links.length ||
          (document.activeElement !== searchInput && !links.includes(document.activeElement))
        )
          return;
        event.preventDefault();
        const index = links.indexOf(document.activeElement);
        const target =
          event.key === 'ArrowDown'
            ? links[index + 1]
            : index === -1
              ? links.at(-1)
              : links[index - 1];
        (target || searchInput).focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && document.activeElement === searchInput && links.length) {
        event.preventDefault();
        links[0].click();
      } else if (event.key === 'Tab' && !nativeSearch) {
        const focusable = [...searchModal.querySelectorAll('input,button,a[href]')];
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    document.addEventListener('keydown', (event) => {
      if (
        event.isComposing ||
        event.defaultPrevented ||
        event.altKey ||
        event.target.closest('input,textarea,select,[contenteditable],dialog[open]')
      )
        return;
      if (
        (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && !event.metaKey && !event.ctrlKey)
      ) {
        event.preventDefault();
        void openSearch();
      }
      if (!nativeSearch && event.key === 'Escape') closeSearch();
    });
    swup?.hooks.on('visit:start', () => {
      closeSearch(true);
      window.CloudInkMobile?.cancelAll();
      motion?.cancelWithin(document.body);
      document.querySelectorAll('.reader-dialog[open]').forEach((dialog) => dialog.close());
    });
  }

  function mountPostList() {
    const host = document.querySelector('.post-index');
    const list = host?.querySelector('.post-index-list');
    const next = host?.querySelector('#post-list-next');
    const footer = host?.querySelector('.post-index-pagination');
    const status = host?.querySelector('#post-list-status');
    if (!list || !next || next.hidden || !footer || !status) return;
    const listUrl = location.pathname + location.search;
    let loading = false,
      disposed = false,
      automatic = true,
      refreshRequired = false;
    let request = null,
      observer = null;
    async function load(manual = false) {
      if (loading || disposed || next.hidden || refreshRequired) return;
      const target = new URL(next.href, location.href);
      if (target.origin !== location.origin || !/^\/post\/page\/[1-9]\d*\/$/.test(target.pathname))
        return;
      loading = true;
      automatic = true;
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 12000);
      footer.setAttribute('aria-busy', 'true');
      next.setAttribute('aria-disabled', 'true');
      status.textContent = '正在加载下一批文章…';
      let changed = false;
      try {
        const response = await fetch(target, {
          headers: { Accept: 'text/html' },
          signal: request.signal,
        });
        if (!response.ok || new URL(response.url).origin !== location.origin) {
          await response.body?.cancel();
          throw new Error('Article batch unavailable');
        }
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (disposed || !host.isConnected) return;
        const batch = doc.querySelector('.post-index');
        const items = [...(batch?.querySelector('.post-index-list')?.children || [])];
        if (!batch || !items.length || items.length > 10) throw new Error('Invalid article batch');
        if (batch.dataset.postRevision !== host.dataset.postRevision) {
          automatic = false;
          refreshRequired = true;
          status.textContent = '文章列表已更新，请刷新后继续浏览。';
          next.href = listUrl;
          next.textContent = '刷新文章列表';
          return;
        }
        if (Number(batch.dataset.postStart) !== Number(host.dataset.postEnd) + 1)
          throw new Error('Out-of-order article batch');
        const added = items.map((item) => document.importNode(item, true));
        list.append(...added);
        host.dataset.postEnd = batch.dataset.postEnd;
        const following = batch.querySelector('#post-list-next');
        if (following) next.href = following.href;
        else {
          next.hidden = true;
          observer?.disconnect();
        }
        status.textContent =
          '已显示第 ' +
          host.dataset.postStart +
          '–' +
          host.dataset.postEnd +
          ' 篇，共 ' +
          host.dataset.postTotal +
          ' 篇。';
        next.textContent = '继续浏览';
        if (manual) added[0].querySelector('a')?.focus({ preventScroll: true });
        changed = true;
      } catch {
        if (!disposed && host.isConnected) {
          automatic = false;
          status.textContent = '加载暂时没有完成，当前文章仍可浏览。请点击重试。';
          next.textContent = '重试加载';
        }
      } finally {
        clearTimeout(timeout);
        loading = false;
        footer.removeAttribute('aria-busy');
        next.removeAttribute('aria-disabled');
        // Preserve expanded batches for the existing back/forward scroll restoration.
        if (changed && !disposed && host.isConnected)
          swup?.cache.update(listUrl, { html: document.documentElement.outerHTML });
      }
    }
    const click = (event) => {
      if (
        refreshRequired ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      void load(true);
    };
    next.addEventListener('click', click);
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        (entries) => {
          if (automatic && entries.some((entry) => entry.isIntersecting)) void load();
        },
        { rootMargin: '240px 0px' },
      );
      observer.observe(footer);
    }
    cleanupFunctions.push(() => {
      disposed = true;
      request?.abort();
      observer?.disconnect();
      next.removeEventListener('click', click);
    });
  }

  function initPageFeatures(visit) {
    cleanupFunctions.forEach((fn) => fn());
    cleanupFunctions = [];

    if (window.CloudInkReader) void window.CloudInkReader.activate();
    else if (typeof hljs !== 'undefined') hljs.highlightAll();
    const swupContainer = document.getElementById('swup');
    if (!swupContainer) return;
    syncReaderNavigation();
    mountPostList();
    window.CloudInkTheme?.setPalette(
      swupContainer.dataset.palette || document.documentElement.dataset.palette || 'ink',
    );
    const iconURL = swupContainer.dataset.siteIcon;
    if (
      iconURL === '/favicon.svg' ||
      /^\/site-icon\/[a-f0-9]{64}\.(?:svg|ico)$/.test(iconURL || '')
    ) {
      const favicon = document.querySelector('link[rel="icon"]');
      if (favicon) {
        favicon.setAttribute('href', iconURL);
        favicon.setAttribute('type', iconURL.endsWith('.ico') ? 'image/x-icon' : 'image/svg+xml');
      }
      document
        .querySelectorAll('.site-mark img')
        .forEach((image) => image.setAttribute('src', iconURL));
    }

    for (const card of swupContainer.querySelectorAll('.home-card')) {
      const onCardClick = (event) => {
        if (event.target.closest('a')) return;
        card.querySelector('h2 a,h3 a')?.click();
      };
      card.addEventListener('click', onCardClick);
      cleanupFunctions.push(() => card.removeEventListener('click', onCardClick));
    }

    if (motion && !reducedMotion.matches && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            motion.enter(entry.target, { kind: 'reveal' });
          }
        },
        { threshold: 0.08 },
      );
      for (const card of swupContainer.querySelectorAll('.home-card')) {
        if (card.getBoundingClientRect().top >= innerHeight) observer.observe(card);
      }
      cleanupFunctions.push(() => {
        observer.disconnect();
        motion.cancelWithin(swupContainer);
      });
    }

    const images = document.querySelectorAll('.article-body img');
    const dialogs = new Set();
    cleanupFunctions.push(() => {
      for (const dialog of dialogs) if (dialog.open) dialog.close();
    });
    const showDialog = (content, label, trigger, dispose = () => {}) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'reader-dialog';
      dialog.dataset.sheet = 'compact';
      dialog.setAttribute('aria-label', label);
      const close = document.createElement('button');
      close.className = 'reader-dialog-close reader-sr-only';
      close.textContent = t('关闭', 'Close');
      close.setAttribute('aria-label', t('关闭', 'Close'));
      dialog.append(close, content);
      document.body.append(dialog);
      const overflow = document.body.style.overflow;
      const finish = () => {
        dispose();
        document.body.style.overflow = overflow;
        dialog.remove();
        dialogs.delete(dialog);
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      };
      dialog.addEventListener('close', finish, { once: true });
      const requestClose = () => (motion ? motion.closeDialog(dialog) : dialog.close());
      close.addEventListener('click', requestClose);
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) requestClose();
      });
      document.body.style.overflow = 'hidden';
      if (motion) motion.openDialog(dialog);
      else dialog.showModal();
      close.focus();
      dialogs.add(dialog);
    };
    images.forEach((img) => {
      // Linked images retain their author's link action.
      if (img.closest('a,button')) return;
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute(
        'aria-label',
        t('放大图片', 'Enlarge image') + (img.alt ? ': ' + img.alt : ''),
      );
      const open = () => {
        const content = document.createElement('figure');
        content.className = 'image-lightbox';
        const clone = document.createElement('img');
        const preview = img.currentSrc || img.src;
        const fullUrl = new URL(img.dataset.fullSrc || preview, location.href);
        const full = /^https?:$/.test(fullUrl.protocol) ? fullUrl.href : preview;
        clone.src = preview;
        clone.alt = img.alt;
        const feedback = document.createElement('figcaption');
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        const message = document.createElement('span');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试原图';
        retry.hidden = true;
        const original = document.createElement('a');
        original.textContent = '打开原图';
        original.href = full;
        original.hidden = !/^https?:/.test(full);
        original.target = '_blank';
        original.rel = 'noopener';
        feedback.append(message, retry, original);
        content.append(clone, feedback);
        let loader = null,
          timer = 0,
          generation = 0,
          disposed = false;
        const cancel = () => {
          generation++;
          clearTimeout(timer);
          if (loader) {
            loader.onload = loader.onerror = null;
            loader.removeAttribute('src');
            loader = null;
          }
        };
        const load = () => {
          cancel();
          const current = generation;
          retry.hidden = true;
          message.textContent = '正在加载原图，当前显示预览…';
          content.setAttribute('aria-busy', 'true');
          const pending = new Image();
          loader = pending;
          const failed = () => {
            if (disposed || current !== generation) return;
            cancel();
            content.setAttribute('aria-busy', 'false');
            message.textContent = '原图暂时无法加载，预览仍可查看。';
            retry.hidden = false;
          };
          pending.onerror = failed;
          pending.onload = async () => {
            try {
              await pending.decode();
            } catch {
              failed();
              return;
            }
            if (disposed || current !== generation) return;
            clearTimeout(timer);
            clone.src =
              img.dataset.fullSrc && /^https?:$/.test(fullUrl.protocol)
                ? img.dataset.fullSrc
                : full;
            content.setAttribute('aria-busy', 'false');
            message.textContent = '原图已加载';
            pending.onload = pending.onerror = null;
            loader = null;
          };
          timer = setTimeout(failed, 60000);
          pending.src = full;
        };
        retry.addEventListener('click', load);
        const initialRect = img.getBoundingClientRect();
        showDialog(content, img.alt || t('图片预览', 'Image preview'), img, () => {
          disposed = true;
          cancel();
        });
        if (!reducedMotion.matches && typeof clone.animate === 'function') {
          requestAnimationFrame(() => {
            const finalRect = clone.getBoundingClientRect();
            if (finalRect.width > 0 && finalRect.height > 0) {
              const scaleX = initialRect.width / finalRect.width;
              const scaleY = initialRect.height / finalRect.height;
              const translateX =
                initialRect.left + initialRect.width / 2 - (finalRect.left + finalRect.width / 2);
              const translateY =
                initialRect.top + initialRect.height / 2 - (finalRect.top + finalRect.height / 2);
              clone.animate(
                [
                  {
                    transform: `translate(${translateX.toFixed(1)}px, ${translateY.toFixed(1)}px) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`,
                    opacity: 0.85,
                  },
                  { transform: 'none', opacity: 1 },
                ],
                {
                  duration: 260,
                  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                },
              );
            }
          });
        }
        if (full === new URL(preview, location.href).href) {
          message.textContent = '原图已加载';
        } else load();
      };
      img.addEventListener('click', open);
      img.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      cleanupFunctions.push(() => img.removeEventListener('click', open));
    });
    document.querySelectorAll('.article-body pre').forEach((pre) => {
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', t('代码块，可横向滚动', 'Code block, scroll horizontally'));
      if (pre.parentElement.classList.contains('code-block')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      pre.before(wrapper);
      wrapper.append(pre);

      // Language badge detection from code class (e.g. language-bash, lang-toml, etc.)
      const codeEl = pre.querySelector('code');
      const codeClass = codeEl ? codeEl.className : '';
      const langMatch = codeClass.match(/(?:language|lang)-([\w+-]+)/i);
      const langName = langMatch ? langMatch[1].toLowerCase() : 'text';

      // Build code header bar
      const header = document.createElement('div');
      header.className = 'code-header';

      const meta = document.createElement('div');
      meta.className = 'code-meta';

      const langBadge = document.createElement('span');
      langBadge.className = 'code-lang';
      langBadge.textContent = langName;
      meta.appendChild(langBadge);

      // If line count > 25, add a collapse/expand toggle
      const codeText = codeEl?.textContent ?? pre.textContent;
      const lineCount = codeText.replace(/\n$/, '').split('\n').length;
      if (lineCount > 25) {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'code-toggle-expand';
        toggleBtn.type = 'button';
        toggleBtn.textContent = t('折叠代码', 'Collapse');
        toggleBtn.addEventListener('click', () => {
          const isCollapsed = wrapper.classList.toggle('is-collapsed');
          toggleBtn.textContent = isCollapsed
            ? t(`展开代码 (${lineCount} 行)`, `Expand (${lineCount} lines)`)
            : t('折叠代码', 'Collapse');
        });
        meta.appendChild(toggleBtn);
      }

      const actions = document.createElement('div');
      actions.className = 'code-actions';

      const feedback = document.createElement('span');
      feedback.className = 'copy-status';
      feedback.setAttribute('role', 'status');

      const button = document.createElement('button');
      button.className = 'copy-code';
      button.type = 'button';
      button.setAttribute('aria-label', t('复制代码', 'Copy code'));
      button.innerHTML =
        '<svg class="copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span class="copy-label">复制</span>';

      actions.append(feedback, button);
      header.append(meta, actions);
      wrapper.prepend(header);

      // Line-number gutter: aria-hidden so it never pollutes copy or screen readers.
      if (lineCount > 1 && lineCount <= 5000) {
        wrapper.classList.add('has-gutter');
        const gutter = document.createElement('div');
        gutter.className = 'code-gutter';
        gutter.setAttribute('aria-hidden', 'true');
        gutter.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
        pre.before(gutter);
      }

      let resetTimer = null;
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeEl?.textContent || pre.textContent);
          feedback.textContent = '已复制';
          button.classList.add('copied');
          button.innerHTML =
            '<svg class="copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg><span class="copy-label">已复制</span>';
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            button.classList.remove('copied');
            feedback.textContent = '';
            button.innerHTML =
              '<svg class="copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span class="copy-label">复制</span>';
          }, 2000);
        } catch {
          feedback.textContent = '请选中代码复制';
        }
      });
    });
    document.querySelectorAll('.article-body table').forEach((table) => {
      if (table.parentElement.classList.contains('table-scroll')) return;
      const scroller = document.createElement('div');
      scroller.className = 'table-scroll';
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', t('表格，可横向滚动', 'Table, scroll horizontally'));
      table.before(scroller);
      scroller.append(table);
    });
    document.querySelectorAll('.article-body .katex-display').forEach((formula) => {
      formula.tabIndex = 0;
      formula.setAttribute('role', 'region');
      formula.setAttribute(
        'aria-label',
        t('公式，可横向滚动', 'Math formula, scroll horizontally'),
      );
    });
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        if (document.fonts?.ready) {
          try {
            await document.fonts.ready;
          } catch (_) {}
        }
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const palette = getComputedStyle(document.documentElement);
        const readingFont =
          palette.getPropertyValue('--reader-font-family').trim() ||
          palette.getPropertyValue('--ci-font-reading').trim() ||
          "'Iowan Old Style', 'Palatino Linotype', 'Noto Serif SC', 'Songti SC', serif";
        const uiFont =
          palette.getPropertyValue('--ci-font-ui').trim() ||
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif";

        const surfaceColor = palette.getPropertyValue('--ci-surface').trim() || '#fbf8f2';
        const primaryColor = palette.getPropertyValue('--ci-primary').trim() || '#784d2b';
        const textColor = palette.getPropertyValue('--ci-text').trim() || '#2c2520';
        const mutedColor = palette.getPropertyValue('--ci-muted').trim() || '#786e65';
        const dividerColor = palette.getPropertyValue('--ci-divider').trim() || '#e8e0d5';

        const nonLeading = /^[，。？！、；：”’）》\?!,.:;]+$/;
        function getLines(text, font, maxWidth) {
          ctx.font = font;
          let words = [];
          if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            const segmenter = new Intl.Segmenter(navigator.language || 'zh-CN', {
              granularity: 'word',
            });
            words = Array.from(segmenter.segment(text)).map((s) => s.segment);
          } else {
            words = text.split(/(\s+)/);
          }
          let lines = [];
          let currentLine = '';
          for (let n = 0; n < words.length; n++) {
            const word = words[n];
            const testLine = currentLine + word;
            if (ctx.measureText(testLine).width > maxWidth && currentLine.length > 0) {
              if (nonLeading.test(word)) {
                currentLine = testLine;
              } else {
                lines.push(currentLine);
                currentLine = word;
              }
            } else {
              currentLine = testLine;
            }
          }
          if (currentLine) lines.push(currentLine);
          return lines;
        }

        const title = (document.querySelector('article h1')?.innerText || document.title).trim();
        const desc = (
          document.querySelector('article p.article-description, article p.meta')?.innerText ||
          document.querySelector('meta[name="description"]')?.content ||
          ''
        ).trim();
        const paragraphs = Array.from(
          document.querySelectorAll('article .article-body p:not(.meta)'),
        );
        let bodyText = paragraphs
          .map((p) => p.innerText)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (bodyText.length > 130) bodyText = bodyText.substring(0, 130) + '……';

        const date = (document.querySelector('.article-details time')?.innerText || '').trim();
        const readTime = (document.querySelector('.article-details span')?.innerText || '').trim();
        const siteName = (
          document.querySelector('.site-brand .site-title')?.innerText || document.title
        ).trim();
        const author = (document.querySelector('.article-author-name')?.innerText || '').trim();
        const domain = window.location.host + window.location.pathname;

        const titleFont = `600 46px ${readingFont}`;
        const titleLines = getLines(title, titleFont, 630);

        const descFont = `500 24px ${readingFont}`;
        const descLines = desc ? getLines(desc, descFont, 630) : [];

        const bodyFont = `400 22px ${readingFont}`;
        const bodyLines =
          !desc && bodyText
            ? getLines(bodyText, bodyFont, 630)
            : bodyText
              ? getLines(bodyText, bodyFont, 630).slice(0, 4)
              : [];

        let contentHeight = 160;
        contentHeight += titleLines.length * 64;
        if (descLines.length > 0) contentHeight += 24 + descLines.length * 38;
        if (bodyLines.length > 0) contentHeight += 24 + bodyLines.length * 36;
        contentHeight += 120;

        const width = 800;
        const height = Math.max(480, contentHeight);

        canvas.width = width * 2;
        canvas.height = height * 2;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.scale(2, 2);

        ctx.fillStyle = surfaceColor;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(0, 0, width, height, 24);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = dividerColor;
          ctx.stroke();
        } else {
          ctx.fillRect(0, 0, width, height);
        }

        ctx.font = `600 20px ${uiFont}`;
        ctx.fillStyle = textColor;
        ctx.fillText(siteName, 64, 68);

        if (date || readTime) {
          const metaInfo = [date, readTime].filter(Boolean).join(' · ');
          ctx.font = `500 15px ${uiFont}`;
          ctx.fillStyle = mutedColor;
          const metaWidth = ctx.measureText(metaInfo).width;
          ctx.fillText(metaInfo, width - 64 - metaWidth, 68);
        }

        ctx.fillStyle = dividerColor;
        ctx.fillRect(64, 96, width - 128, 1);

        let drawY = 155;
        const accentStartY = drawY - 36;
        const accentHeight =
          titleLines.length * 64 + (descLines.length ? descLines.length * 38 + 20 : 0);
        ctx.fillStyle = primaryColor;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(64, accentStartY, 4, accentHeight, 2);
          ctx.fill();
        } else {
          ctx.fillRect(64, accentStartY, 4, accentHeight);
        }

        ctx.fillStyle = textColor;
        ctx.font = titleFont;
        for (const line of titleLines) {
          ctx.fillText(line, 84, drawY);
          drawY += 64;
        }

        if (descLines.length > 0) {
          drawY += 16;
          ctx.fillStyle = primaryColor;
          ctx.font = descFont;
          for (const line of descLines) {
            ctx.fillText(line, 84, drawY);
            drawY += 38;
          }
        }

        if (bodyLines.length > 0) {
          drawY += 20;
          ctx.fillStyle = mutedColor;
          ctx.font = bodyFont;
          for (const line of bodyLines) {
            ctx.fillText(line, 84, drawY);
            drawY += 36;
          }
        }

        const footerY = height - 90;
        ctx.fillStyle = dividerColor;
        ctx.fillRect(64, footerY, width - 128, 1);

        const authorText = author ? author + ' · ' + siteName : siteName;
        ctx.font = `600 16px ${uiFont}`;
        ctx.fillStyle = textColor;
        ctx.fillText(authorText, 64, footerY + 45);

        ctx.font = `500 14px ${uiFont}`;
        ctx.fillStyle = mutedColor;
        const domainWidth = ctx.measureText(domain).width;
        ctx.fillText(domain, width - 64 - domainWidth, footerY + 45);

        const dataUrl = canvas.toDataURL('image/png');

        const content = document.createElement('div');
        content.className = 'share-dialog-content';
        const imgElement = document.createElement('img');
        imgElement.src = dataUrl;
        imgElement.alt = title + ' — 分享卡片';

        const actions = document.createElement('div');
        actions.className = 'share-actions-row';

        const download = document.createElement('a');
        download.href = dataUrl;
        download.download = 'cloudink-share.png';
        download.className = 'share-download';
        download.textContent = '下载分享图片';
        actions.append(download);

        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
          const nativeBtn = document.createElement('button');
          nativeBtn.type = 'button';
          nativeBtn.className = 'share-native-btn';
          nativeBtn.textContent = t('系统分享', 'Share via system');
          nativeBtn.addEventListener('click', async () => {
            try {
              await navigator.share({
                title: title,
                text: desc || title,
                url: window.location.href,
              });
            } catch (err) {
              if (err && err.name !== 'AbortError') console.error(err);
            }
          });
          actions.append(nativeBtn);
        }

        content.append(imgElement, actions);
        showDialog(content, t('分享卡片', 'Share card'), shareBtn);
      });
    }

    const related = document.getElementById('related-stories');
    if (related)
      void loadPublicIndex()
        .then((posts) => {
          if (!related.isConnected || !posts) return;
          const fragment = document.createDocumentFragment();
          const stories = posts
            .filter(
              (post) =>
                /^[A-Za-z0-9_-]{1,100}$/.test(post.slug) &&
                location.pathname !== '/posts/' + post.slug + '/',
            )
            .slice(0, 2);
          if (!stories.length) return;
          for (const post of stories) {
            const link = document.createElement('a');
            link.className = 'related-story';
            link.href = '/posts/' + encodeURIComponent(post.slug) + '/';
            const title = document.createElement('span');
            title.textContent = post.title;
            link.append(title);
            if (typeof post.date === 'string') {
              const date = document.createElement('time');
              date.textContent = post.date;
              link.append(date);
            }
            fragment.append(link);
          }
          related.replaceChildren(fragment);
        })
        .catch(() => {});
    for (const button of document.querySelectorAll('.copy-article-link')) {
      const copy = async () => {
        const label = button.textContent;
        try {
          await navigator.clipboard.writeText(location.origin + location.pathname);
          button.lastChild.textContent = t('链接已复制', 'Link copied');
        } catch {
          button.lastChild.textContent = t(
            '复制失败，请复制地址栏链接',
            'Copy the address bar link',
          );
        }
        const timer = setTimeout(() => {
          if (button.isConnected) button.lastChild.textContent = label;
        }, 2500);
        cleanupFunctions.push(() => clearTimeout(timer));
      };
      button.addEventListener('click', copy);
      cleanupFunctions.push(() => button.removeEventListener('click', copy));
    }
    const article = document.querySelector('.article-shell article');
    if (article) {
      let progressBar = document.getElementById('reading-progress');
      if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.id = 'reading-progress';
        progressBar.className = 'reading-progress';
        progressBar.setAttribute('aria-hidden', 'true');
        document.body.prepend(progressBar);
      }
      cleanupFunctions.push(() => {
        progressBar?.remove();
      });
      const updateReadingProgress = () => {
        const total = document.documentElement.scrollHeight - window.innerHeight;
        const current = window.scrollY;
        const progress = total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;
        if (progressBar) progressBar.style.width = progress + '%';
        const label = document.getElementById('reading-percent');
        if (label) label.textContent = Math.round(progress) + '%';
      };
      window.addEventListener('scroll', updateReadingProgress, { passive: true });
      cleanupFunctions.push(() => window.removeEventListener('scroll', updateReadingProgress));
      updateReadingProgress();

      const headings = article.querySelectorAll(
        '.article-body h2, .article-body h3, .article-body h4',
      );
      if (headings.length > 0) {
        const tocContainer = document.createElement('nav');
        tocContainer.className = 'toc-container';
        tocContainer.id = 'article-contents';
        tocContainer.setAttribute('aria-label', '文章目录');

        const tocTitle = document.createElement('div');
        tocTitle.className = 'toc-title';
        tocTitle.innerText = '文章目录';
        tocContainer.appendChild(tocTitle);

        const headingSet = new Set(headings);
        const usedIds = new Set(
          [...document.querySelectorAll('[id]')]
            .filter((node) => !headingSet.has(node))
            .map((node) => node.id),
        );
        headings.forEach((heading, index) => {
          let id =
            heading.id ||
            heading.innerText
              .trim()
              .replace(/\s+/g, '-')
              .replace(/[^\w\u3400-\u9fff\-]+/g, '')
              .toLowerCase() ||
            'heading-' + index;
          const base = id;
          let suffix = 2;
          while (usedIds.has(id)) id = base + '-' + suffix++;
          usedIds.add(id);
          heading.id = id;
          heading.tabIndex = -1;

          const link = document.createElement('a');
          link.href = '#' + encodeURIComponent(id);
          link.className = 'toc-link toc-level-' + heading.tagName.charAt(1);
          link.innerText = heading.innerText;
          tocContainer.appendChild(link);
        });

        const tocHost =
          document.querySelector('#reader-context .reader-toc-slot') ||
          article.parentElement.querySelector('.reader-toc-slot') ||
          article.parentElement;
        tocHost.appendChild(tocContainer);
        cleanupFunctions.push(() => tocContainer.remove());

        // Mobile TOC Button & Drawer Logic
        const mobileTocBtn = document.createElement('button');
        mobileTocBtn.className = 'mobile-toc-btn';
        mobileTocBtn.setAttribute('aria-label', t('文章目录', 'Article contents'));
        mobileTocBtn.setAttribute('aria-controls', 'article-contents');
        mobileTocBtn.setAttribute('aria-expanded', 'false');
        mobileTocBtn.innerHTML =
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="3" cy="6" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="18" r="1"/></svg>';
        const tools = article.querySelector('.mobile-reader-tools');
        if (tools) {
          mobileTocBtn.append(document.createTextNode(t('文章目录', 'Contents')));
          tools.prepend(mobileTocBtn);
        } else document.body.appendChild(mobileTocBtn);
        cleanupFunctions.push(() => mobileTocBtn.remove());

        const tocDrawerOverlay = document.createElement('div');
        tocDrawerOverlay.className = 'zoom-overlay reader-toc-overlay';
        tocDrawerOverlay.style.zIndex = '998';
        document.body.appendChild(tocDrawerOverlay);
        cleanupFunctions.push(() => tocDrawerOverlay.remove());

        const narrowToc = matchMedia('(max-width: 1023px)');
        let tocOverflow = null;
        let tocBackground = [];
        let tocDisposed = false;
        const tocClose = document.createElement('button');
        tocClose.className = 'toc-close';
        tocClose.textContent = t('关闭目录', 'Close');
        tocContainer.append(tocClose);
        const syncToc = () => {
          if (tocDisposed) return;
          // Fixed drawers must live outside Swup's transformed content container.
          const host = narrowToc.matches ? document.body : tocHost;
          if (tocContainer.parentElement !== host) host.appendChild(tocContainer);
          const modal = narrowToc.matches && tocContainer.classList.contains('drawer-open');
          tocContainer.inert = narrowToc.matches && !modal;
          if (modal) {
            tocContainer.setAttribute('role', 'dialog');
            tocContainer.setAttribute('aria-modal', 'true');
          } else {
            tocContainer.removeAttribute('role');
            tocContainer.removeAttribute('aria-modal');
          }
        };
        syncToc();
        const resizeToc = () => {
          closeTocDrawer();
          syncToc();
        };
        narrowToc.addEventListener('change', resizeToc);
        cleanupFunctions.push(() => {
          tocDisposed = true;
          narrowToc.removeEventListener('change', resizeToc);
          closeTocDrawer();
          closeArticleContents = null;
        });
        tocContainer.dataset.sheet = 'list';
        const tocSheet = window.CloudInkMobile?.attach(tocContainer, {
          media: '(max-width:1023px)',
          onDismiss: () => {
            closeTocDrawer();
            mobileTocBtn.focus({ preventScroll: true });
          },
        });
        cleanupFunctions.push(() => tocSheet?.dispose());
        const requestTocClose = () => {
          if (!tocSheet?.close()) {
            closeTocDrawer();
            mobileTocBtn.focus({ preventScroll: true });
          }
        };
        tocClose.addEventListener('click', requestTocClose);
        function closeTocDrawer() {
          tocContainer.style.transition = 'none';
          tocContainer.classList.remove('drawer-open');
          tocSheet?.reset();
          void tocContainer.offsetHeight;
          tocContainer.style.transition = '';
          if (tocOverflow !== null) document.body.style.overflow = tocOverflow;
          tocOverflow = null;
          for (const [node, inert] of tocBackground) node.inert = inert;
          tocBackground = [];
          mobileTocBtn.setAttribute('aria-expanded', 'false');
          tocDrawerOverlay.classList.remove('active');
          syncToc();
        }

        closeArticleContents = closeTocDrawer;
        mobileTocBtn.addEventListener('click', () => {
          if (tocContainer.classList.contains('drawer-open')) {
            requestTocClose();
          } else {
            tocOverflow = document.body.style.overflow;
            tocBackground = [
              article,
              document.querySelector('.site-header'),
              document.querySelector('.site-footer'),
              document.getElementById('primary-nav'),
              document.querySelector('.reader-dock'),
            ]
              .filter(Boolean)
              .map((node) => [node, node.inert]);
            for (const [node] of tocBackground) node.inert = true;
            document.body.style.overflow = 'hidden';
            tocContainer.classList.add('drawer-open');
            syncToc();
            mobileTocBtn.setAttribute('aria-expanded', 'true');
            tocDrawerOverlay.classList.add('active');
            tocSheet?.open();
            tocContainer.querySelector('a')?.focus({ preventScroll: true });
          }
        });

        tocDrawerOverlay.addEventListener('click', requestTocClose);
        const tocKeyboard = (e) => {
          if (e.isComposing) return;
          if (e.key === 'Tab' && tocContainer.classList.contains('drawer-open')) {
            const first = tocContainer.hasAttribute('data-ci-sheet-active')
                ? tocSheet.handle
                : tocContainer.querySelector('a'),
              last = tocClose;
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
          if (e.key === 'Escape' && tocContainer.classList.contains('drawer-open')) {
            e.preventDefault();
            requestTocClose();
          }
        };
        document.addEventListener('keydown', tocKeyboard);
        cleanupFunctions.push(() => document.removeEventListener('keydown', tocKeyboard));

        // Cache heading positions when layout changes; scroll frames only search the cache.
        const tocLinks = Array.from(tocContainer.querySelectorAll('.toc-link'));
        const headingEls = Array.from(headings);
        let activeIndex = -1,
          tocFrame = 0,
          measurePending = true;
        const offsets = new Float64Array(headingEls.length);
        const updateToc = () => {
          tocFrame = 0;
          if (!tocContainer.isConnected) return;
          if (measurePending) {
            for (let i = 0; i < headingEls.length; i++)
              offsets[i] = headingEls[i].getBoundingClientRect().top + scrollY;
            measurePending = false;
          }
          let low = 0,
            high = offsets.length - 1;
          const position = scrollY + 120;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (offsets[middle] <= position) low = middle;
            else high = middle - 1;
          }
          if (low === activeIndex) return;
          if (activeIndex >= 0) {
            tocLinks[activeIndex].classList.remove('toc-active');
            tocLinks[activeIndex].removeAttribute('aria-current');
          }
          activeIndex = low;
          const link = tocLinks[low];
          link.classList.add('toc-active');
          link.setAttribute('aria-current', 'location');
          if (!narrowToc.matches || tocContainer.classList.contains('drawer-open')) {
            const containerRect = tocContainer.getBoundingClientRect(),
              linkRect = link.getBoundingClientRect();
            if (linkRect.top < containerRect.top + 20)
              tocContainer.scrollTop -= containerRect.top + 20 - linkRect.top;
            else if (linkRect.bottom > containerRect.bottom - 20)
              tocContainer.scrollTop += linkRect.bottom - containerRect.bottom + 20;
          }
        };
        const queueToc = (measure = false) => {
          measurePending = measurePending || measure;
          if (!tocFrame) tocFrame = requestAnimationFrame(updateToc);
        };
        const onScroll = () => queueToc();
        const onResize = () => queueToc(true);
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onResize, { passive: true });
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
        observer?.observe(article);
        article.addEventListener('load', onResize, true);
        document.fonts?.ready.then(() => {
          if (tocContainer.isConnected) queueToc(true);
        });
        cleanupFunctions.push(() => {
          cancelAnimationFrame(tocFrame);
          observer?.disconnect();
          article.removeEventListener('load', onResize, true);
          window.removeEventListener('scroll', onScroll);
          window.removeEventListener('resize', onResize);
        });
        tocLinks.forEach((link, index) =>
          link.addEventListener('click', () => {
            closeTocDrawer();
            headingEls[index].focus({ preventScroll: true });
          }),
        );
        queueToc(true);
        // Generated heading IDs must also resolve on an initial or cross-page deep link.
        if (location.hash && !visit?.history?.popstate) {
          let target;
          try {
            target = headingEls.find(
              (heading) => heading.id === decodeURIComponent(location.hash.slice(1)),
            );
          } catch {}
          if (target)
            requestAnimationFrame(() => {
              if (target.isConnected)
                target.scrollIntoView({ behavior: 'instant', block: 'start' });
            });
        }
      }
    }
  } // end initPageFeatures

  initPageFeatures();
  const initialHome = document.querySelector('.home-layout');
  if (initialHome) motion?.enter(initialHome, { kind: 'content' });
  swup?.hooks.on('page:view', (visit) => {
    initPageFeatures(visit);
    if (!visit.history.popstate) document.getElementById('swup')?.focus({ preventScroll: true });
  });

  // Restore only after AJAX content exists: native restoration can run before replacement.
  if (swup && 'scrollRestoration' in history) {
    const previousRestoration = history.scrollRestoration;
    const positions = new Map();
    const pathPositions = new Map();
    let currentIndex = history.state?.index ?? 0,
      busy = false,
      restoreFrame = 0;
    if (history.state == null || !Number.isInteger(history.state.index)) {
      try {
        history.replaceState({ ...history.state, index: 0 }, '');
      } catch {}
    }
    const remember = () => {
      if (busy) return;
      if (Number.isInteger(currentIndex)) {
        positions.set(currentIndex, { x: scrollX, y: scrollY });
        if (positions.size > 100) positions.delete(positions.keys().next().value);
      }
      pathPositions.set(location.pathname, { x: scrollX, y: scrollY });
    };
    history.scrollRestoration = 'manual';
    remember();
    window.addEventListener('scroll', remember, { passive: true });
    swup.hooks.on('visit:start', () => {
      remember();
      busy = true;
      cancelAnimationFrame(restoreFrame);
    });
    swup.hooks.on('page:view', (visit) => {
      currentIndex = history.state?.index ?? 0;
      let position = null;
      if (visit.history.popstate) {
        position = positions.get(currentIndex) || pathPositions.get(location.pathname);
      } else if (location.pathname === '/' || location.pathname === '') {
        position = pathPositions.get('/');
      }
      if (!visit.history.popstate && !position) positions.delete(currentIndex);
      const restore = () => {
        if (swup.visit.id !== visit.id) return;
        if (position) window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
        busy = false;
        remember();
      };
      if (position) window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
      // A second frame also covers Firefox's post-popstate layout.
      restoreFrame = requestAnimationFrame(restore);
    });
    swup.hooks.on('visit:abort', () => cancelAnimationFrame(restoreFrame));
    const nativeRestoration = () => {
      history.scrollRestoration = previousRestoration;
    };
    const managedRestoration = () => {
      history.scrollRestoration = 'manual';
    };
    swup.hooks.on('disable', () => {
      cancelAnimationFrame(restoreFrame);
      window.removeEventListener('pagehide', nativeRestoration);
      window.removeEventListener('pageshow', managedRestoration);
      window.removeEventListener('scroll', remember);
      history.scrollRestoration = previousRestoration;
    });
    window.addEventListener('pagehide', nativeRestoration);
    window.addEventListener('pageshow', managedRestoration);
  }
  if ('serviceWorker' in navigator && !location.pathname.startsWith('/admin')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
});
