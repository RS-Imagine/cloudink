const bootCloudInkClient = () => {
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
          animationSelector: motion || reducedMotion.matches ? false : '[class*="transition-"]',
        })
      : null;
  reducedMotion.addEventListener('change', () => {
    if (swup)
      swup.options.animationSelector =
        motion || reducedMotion.matches ? false : '[class*="transition-"]';
  });
  window.swup = swup;
  window.CloudInkReader?.attach(swup);
  let cleanupFunctions = [];

  const syncReaderNavigation = () => {
    const content = document.getElementById('reader-center-content');
    const shell = document.getElementById('swup');
    if (content && shell) {
      for (const key of [
        'page',
        'palette',
        'siteIcon',
        'siteIconAvatar',
        'siteIconApple',
        'readingFont',
      ])
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
    for (const link of document.querySelectorAll('[data-reader-nav]')) {
      const dock = link.closest('.reader-dock');
      const section = kind === 'post' || (dock && kind === 'archive') ? 'posts' : kind;
      if (link.dataset.readerNav === section)
        link.setAttribute('aria-current', section === kind ? 'page' : 'location');
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
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 4h13"/><path d="M12 20v-9.5"/><path d="m6.8 15.2L12 10l5.2 5.2"/></svg>';
  toTop.hidden = true;
  document.body.append(toTop);
  const narrowReader = matchMedia('(max-width: 767px)');
  const footer = document.querySelector('.site-footer');
  let footerVisible = false;
  const updateToTop = () => {
    const hidden = window.scrollY < 600 || (narrowReader.matches && footerVisible);
    if (hidden && document.activeElement === toTop)
      document.getElementById('swup')?.focus({ preventScroll: true });
    if (toTop.hidden !== hidden) toTop.hidden = hidden;
  };
  if (footer && typeof IntersectionObserver === 'function')
    new IntersectionObserver(([entry]) => {
      footerVisible = entry.isIntersecting;
      updateToTop();
    }).observe(footer);
  narrowReader.addEventListener('change', updateToTop);
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
        } else if (!text.trim() && post.body.trim()) {
          const plain = post.body.trim();
          text = plain.slice(0, 140) + (plain.length > 140 ? '…' : '');
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
            const response = await fetch('/search_index.json', {
              signal: controller.signal,
            });
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
    const warmSearch = () => {
      if (!searchIndex && !searchLoading && !navigator.connection?.saveData) void loadSearch();
    };
    searchBtn.addEventListener('pointerenter', warmSearch, { passive: true });
    searchBtn.addEventListener('focus', warmSearch, { passive: true });
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

  const expandedPostLists = new Map();
  function mountPostList() {
    let host = document.querySelector('.post-index');
    if (!host) return;
    const listUrl = location.pathname + location.search;
    const expanded = expandedPostLists.get(listUrl);
    if (expanded && expanded.dataset.postRevision === host.dataset.postRevision) {
      const restored = expanded.cloneNode(true);
      host.replaceWith(restored);
      host = restored;
    } else {
      expandedPostLists.delete(listUrl);
    }
    const list = host.querySelector('.post-index-list');
    const next = host.querySelector('#post-list-next');
    const footer = host.querySelector('.post-index-pagination');
    const status = host.querySelector('#post-list-status');
    if (!list || !next || next.hidden || !footer || !status) return;
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
          headers: {
            Accept: 'text/html',
            'X-CloudInk-List-Revision': host.dataset.postRevision || '',
          },
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
        if (changed && !disposed && host.isConnected && host.dataset.postRevision)
          expandedPostLists.set(listUrl, host.cloneNode(true));
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

  function mountShortsFeed(visit) {
    const host = document.querySelector('.shorts-layout');
    const feed = host?.querySelector('#shorts-feed');
    if (!host || !feed) return;
    const expandWrap = host.querySelector('.shorts-expand-wrap');
    const expandBtn = host.querySelector('#shorts-expand-btn');
    const nextLink = host.querySelector('#shorts-list-next');
    const pagination = host.querySelector('.shorts-pagination');
    const status = host.querySelector('#shorts-list-status');
    const reader = window.CloudInkReader;
    const total = Number(host.dataset.shortsTotal || 0);
    const start = Math.max(1, Number(host.dataset.shortsStart || 1));
    const batchSize = Math.max(
      1,
      Number(host.dataset.shortsBatch || reader?.SHORTS_BATCH_SIZE || 3),
    );
    const revision = host.dataset.shortsRevision || '';
    const batchHeaders = { Accept: 'text/html', 'X-CloudInk-List-Revision': revision };
    const storageKey = 'cloudink:shorts-state:' + location.pathname;

    host.classList.add('shorts-enhanced');

    const normalizePath = (href) => {
      if (!href) return '';
      try {
        const target = new URL(href, location.href);
        if (target.origin !== location.origin) return '';
        if (!/^\/shorts\/page\/[1-9]\d*\/$/.test(target.pathname)) return '';
        return target.pathname;
      } catch {
        return '';
      }
    };

    const getCards = () => [...feed.querySelectorAll(':scope > .short-card')];
    const getPeekCard = () => feed.querySelector(':scope > .short-card.shorts-peek');
    const getFullCount = () => {
      const cards = getCards();
      return cards.length - (getPeekCard() ? 1 : 0);
    };

    const nextPageForRendered = () => {
      const absoluteRendered = start - 1 + getCards().length;
      if (absoluteRendered >= total) return '';
      const pageNum = Math.floor(absoluteRendered / batchSize) + 1;
      return pageNum > 1 ? '/shorts/page/' + pageNum + '/' : '';
    };

    let nextUrl =
      host.dataset.shortsNextUrl !== undefined
        ? normalizePath(nextPageForRendered())
        : normalizePath(nextLink?.getAttribute('href') || nextPageForRendered());
    const bufferedCards = [];
    const prefetchedBatches = new Map();
    const activeSprings = new Set();
    const hasIntersectionObserver = 'IntersectionObserver' in window;
    let loading = false,
      disposed = false,
      automatic = true,
      refreshRequired = false,
      lastExpandScrollY = window.scrollY,
      lastObservedScrollY = window.scrollY,
      scrolledAfterExpand = false,
      peekIntersecting = false,
      peekIntersectionRatio = 0,
      peekSeenLocked = false,
      peekSeenScrollY = null,
      peekSeenAt = 0,
      wheelDownAccum = 0,
      touchStartY = null,
      suppressScrollUntil = 0;
    let request = null,
      observer = null,
      observeFrame = 0;

    const stripPeekAttrs = (card) => {
      card.classList.remove('shorts-peek', 'shorts-expanding');
      card.removeAttribute('data-shorts-peek');
      card.removeAttribute('aria-hidden');
      card.style.removeProperty('--shorts-peek-height');
      card.style.height = '';
      card.style.maxHeight = '';
      card.style.overflow = '';
      const body = card.querySelector('.short-body');
      if (body) {
        body.inert = false;
        body.removeAttribute('inert');
      }
    };

    const markAsPeek = (card) => {
      card.classList.add('shorts-peek');
      card.dataset.shortsPeek = 'true';
      card.setAttribute('aria-hidden', 'true');
      const body = card.querySelector('.short-body');
      if (body) {
        body.inert = true;
        body.setAttribute('inert', '');
      }
    };

    const preserveCardImageRatios = (card) => {
      for (const img of card.querySelectorAll('img')) {
        const w = Number(img.getAttribute('width'));
        const h = Number(img.getAttribute('height'));
        if (w > 0 && h > 0 && !img.style.aspectRatio) {
          img.style.aspectRatio = w + ' / ' + h;
        }
      }
    };

    const settleSprings = () => {
      for (const entry of [...activeSprings]) entry.finish();
    };

    const resetPeekSeen = () => {
      peekSeenLocked = false;
      peekSeenScrollY = null;
      peekSeenAt = 0;
    };

    const disarmAuto = () => {
      lastExpandScrollY = window.scrollY;
      lastObservedScrollY = window.scrollY;
      scrolledAfterExpand = false;
      peekIntersecting = false;
      peekIntersectionRatio = 0;
      resetPeekSeen();
      wheelDownAccum = 0;
      touchStartY = null;
      observer?.disconnect();
    };

    const saveState = () => {
      const fullCount = getFullCount();
      const end = Math.min(total, start - 1 + fullCount);
      host.dataset.shortsEnd = String(end);
      host.dataset.shortsNextUrl = nextUrl || '';
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ revision, end, scrollY: window.scrollY }),
        );
      } catch {}
    };

    const syncControls = () => {
      const fullCount = getFullCount();
      const end = Math.min(total, start - 1 + fullCount);
      const remaining = end < total || Boolean(getPeekCard());
      saveState();
      if (expandWrap && expandBtn) {
        if (remaining || refreshRequired) {
          expandWrap.hidden = false;
          expandBtn.setAttribute('aria-expanded', 'false');
          expandBtn.disabled = false;
          if (loading) expandBtn.setAttribute('aria-disabled', 'true');
          else expandBtn.removeAttribute('aria-disabled');
          if (!loading && !refreshRequired && automatic) expandBtn.textContent = '展开更多';
        } else {
          expandWrap.hidden = true;
          expandBtn.setAttribute('aria-expanded', 'true');
          expandBtn.disabled = false;
          expandBtn.removeAttribute('aria-disabled');
        }
      }
      if (nextLink) {
        if (nextUrl) nextLink.setAttribute('href', nextUrl);
        else nextLink.hidden = true;
      }
      if (status && !loading && !refreshRequired && automatic) {
        status.textContent =
          !remaining && start === 1
            ? '已显示全部 ' + total + ' 条短记。'
            : '已显示第 ' + start + '–' + end + ' 条，共 ' + total + ' 条。';
      }
      if (pagination) {
        const hasPrev = Boolean(pagination.querySelector('a:not([data-shorts-next-link])'));
        pagination.hidden = !remaining && !hasPrev && !refreshRequired;
      }
    };

    const measureNaturalHeight = (card) => {
      const prevMax = card.style.maxHeight;
      const prevHeight = card.style.height;
      card.style.maxHeight = 'none';
      card.style.height = 'auto';
      const height = Math.round(card.getBoundingClientRect().height);
      card.style.maxHeight = prevMax;
      card.style.height = prevHeight;
      return height;
    };

    const computePeekMetrics = (naturalHeight) =>
      reader?.computeShortPeek
        ? reader.computeShortPeek(naturalHeight)
        : {
            shouldPeek: naturalHeight >= 64,
            height: Math.min(Math.round(naturalHeight * 0.5), 120),
          };

    const unpeekCard = (card, instant = false) => {
      if (!card) return Promise.resolve();
      const fromHeight = card.getBoundingClientRect().height;
      stripPeekAttrs(card);
      if (instant || reducedMotion.matches || !motion) return Promise.resolve();
      const toHeight = card.getBoundingClientRect().height;
      if (toHeight <= fromHeight + 0.5) return Promise.resolve();
      card.style.height = fromHeight.toFixed(2) + 'px';
      card.style.maxHeight = 'none';
      card.style.overflow = 'hidden';
      card.classList.add('shorts-expanding');
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          activeSprings.delete(entry);
          springHandle.stop();
          card.style.height = '';
          card.style.maxHeight = '';
          card.style.overflow = '';
          card.classList.remove('shorts-expanding');
          resolve();
        };
        const springHandle = motion.spring({
          from: fromHeight,
          stiffness: 420,
          dampingRatio: 0.96,
          onUpdate(value) {
            if (Math.abs(value - toHeight) < 0.5) {
              finish();
              return;
            }
            card.style.height = Math.max(fromHeight, value).toFixed(2) + 'px';
          },
          onComplete: finish,
        });
        const entry = { finish };
        activeSprings.add(entry);
        springHandle.to(toHeight);
      });
    };

    const warmNextBatch = () => {
      if (
        !nextUrl ||
        prefetchedBatches.has(nextUrl) ||
        loading ||
        disposed ||
        refreshRequired ||
        (reader?.canPrefetch && !reader.canPrefetch())
      )
        return;
      const targetPath = nextUrl;
      const pending = fetch(targetPath, { headers: batchHeaders })
        .then(async (response) => {
          if (!response.ok || new URL(response.url).origin !== location.origin) {
            await response.body?.cancel();
            throw new Error('Prefetch failed');
          }
          return response.text();
        })
        .catch(() => {
          prefetchedBatches.delete(targetPath);
          return null;
        });
      prefetchedBatches.set(targetPath, pending);
    };

    const fetchNextBatch = async () => {
      const targetPath = normalizePath(nextUrl);
      if (!targetPath) return false;
      const prefetched = prefetchedBatches.get(targetPath);
      prefetchedBatches.delete(targetPath);
      let html = prefetched ? await prefetched : null;
      if (disposed || !host.isConnected) return false;
      if (html === null) {
        request = new AbortController();
        const timeout = setTimeout(() => request?.abort(), 12000);
        try {
          const response = await fetch(targetPath, {
            headers: batchHeaders,
            signal: request.signal,
          });
          if (!response.ok || new URL(response.url).origin !== location.origin) {
            await response.body?.cancel();
            throw new Error('Shorts batch unavailable');
          }
          html = await response.text();
        } finally {
          clearTimeout(timeout);
          request = null;
        }
      }
      if (disposed || !host.isConnected) return false;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const batch = doc.querySelector('.shorts-layout');
      const incoming = [...(batch?.querySelectorAll('#shorts-feed > .short-card') || [])];
      if (!batch || !incoming.length) throw new Error('Invalid shorts batch');
      if (revision && batch.dataset.shortsRevision !== revision) {
        automatic = false;
        refreshRequired = true;
        if (status) status.textContent = '短记列表已更新，请刷新后继续浏览。';
        if (expandBtn) expandBtn.textContent = '刷新短记列表';
        return false;
      }
      const seen = new Set([
        ...getCards().map((card) => card.id),
        ...bufferedCards.map((card) => card.id),
      ]);
      for (const card of incoming) {
        if (!card.id || seen.has(card.id)) continue;
        seen.add(card.id);
        stripPeekAttrs(card);
        bufferedCards.push(card);
      }
      const following = batch.querySelector('#shorts-list-next')?.getAttribute('href') || '';
      nextUrl = normalizePath(following);
      return true;
    };

    const ensurePeekFit = async () => {
      let guard = 0;
      while (!disposed && host.isConnected && guard < total + 2) {
        guard++;
        const peek = getPeekCard();
        if (!peek) return;
        const naturalHeight = measureNaturalHeight(peek);
        const metrics = computePeekMetrics(naturalHeight);
        if (metrics.shouldPeek) {
          peek.style.setProperty('--shorts-peek-height', metrics.height + 'px');
          for (const image of peek.querySelectorAll('img')) {
            if (!image.complete) {
              image.addEventListener(
                'load',
                () => {
                  if (!disposed && peek.isConnected && peek.classList.contains('shorts-peek')) {
                    void ensurePeekFit();
                  }
                },
                { once: true },
              );
            }
          }
          return;
        }
        // Short card is too brief to clip meaningfully: promote it to full and shift peek forward.
        stripPeekAttrs(peek);
        const absoluteFull = start - 1 + getFullCount();
        if (absoluteFull >= total) return;
        if (!bufferedCards.length && nextUrl) {
          const ok = await fetchNextBatch();
          if (!ok || disposed || !host.isConnected) return;
        }
        const nextCardNode = bufferedCards.shift();
        if (!nextCardNode) return;
        const imported = document.importNode(nextCardNode, true);
        preserveCardImageRatios(imported);
        markAsPeek(imported);
        feed.append(imported);
      }
    };

    const isPeekAtBottom = (peek, rect = null, observedRatio = null) => {
      if (!peek || !peek.isConnected) return false;
      if (hasIntersectionObserver && (!peekIntersecting || peekIntersectionRatio < 0.9)) {
        return false;
      }
      const box = rect || peek.getBoundingClientRect();
      const ratio =
        observedRatio !== null
          ? observedRatio
          : hasIntersectionObserver
            ? peekIntersectionRatio
            : null;
      if (reader?.isShortPeekAtBottom) {
        return reader.isShortPeekAtBottom({
          scrollY: window.scrollY,
          viewportHeight: window.innerHeight,
          peekTop: box.top,
          peekBottom: box.bottom,
          observedRatio: ratio,
        });
      }
      const height = box.bottom - box.top;
      if (height <= 0 || window.scrollY + window.innerHeight < window.scrollY + box.bottom - 8) {
        return false;
      }
      const visible = Math.max(0, Math.min(window.innerHeight, box.bottom) - Math.max(0, box.top));
      const effectiveRatio = Number.isFinite(ratio)
        ? Math.min(ratio, visible / height)
        : visible / height;
      return effectiveRatio >= 0.9;
    };

    const canTriggerAutoExpand = (peek, observedRatio = null) => {
      const peekAtBottom = isPeekAtBottom(peek, null, observedRatio);
      if (!peekAtBottom) {
        resetPeekSeen();
        return false;
      }
      const currentY = window.scrollY;
      if (!peekSeenLocked) {
        peekSeenLocked = true;
        peekSeenScrollY = currentY;
        peekSeenAt = performance.now();
        return false;
      }
      return reader?.canAutoExpandShorts
        ? reader.canAutoExpandShorts({
            scrolledAfterExpand,
            scrollY: currentY,
            lastExpandScrollY,
            peekSeenLocked,
            peekSeenScrollY,
            peekAtBottom,
          })
        : scrolledAfterExpand &&
            currentY - lastExpandScrollY >= 40 &&
            peekSeenLocked &&
            Number.isFinite(peekSeenScrollY) &&
            currentY - peekSeenScrollY >= 40 &&
            peekAtBottom;
    };

    const evaluateAutoExpand = (peek, observedRatio = null) => {
      if (disposed || !host.isConnected || loading || refreshRequired || !automatic || !peek)
        return;
      if (!canTriggerAutoExpand(peek, observedRatio)) return;
      disarmAuto();
      void expand({ manual: false });
    };

    const observePeek = () => {
      observer?.disconnect();
      peekIntersecting = false;
      peekIntersectionRatio = 0;
      if (disposed || !host.isConnected || refreshRequired || !hasIntersectionObserver) return;
      const peek = getPeekCard();
      if (!peek) return;
      observer = new IntersectionObserver(
        (entries) => {
          if (disposed || !host.isConnected || loading || refreshRequired || !automatic) return;
          const entry = entries[entries.length - 1];
          if (!entry) return;
          const activePeek = getPeekCard();
          if (!activePeek || entry.target !== activePeek) return;
          peekIntersecting = Boolean(entry.isIntersecting);
          peekIntersectionRatio = entry.isIntersecting ? entry.intersectionRatio : 0;
          if (!peekIntersecting || peekIntersectionRatio < 0.9) {
            resetPeekSeen();
            return;
          }
          evaluateAutoExpand(activePeek, peekIntersectionRatio);
        },
        { rootMargin: '0px', threshold: [0.9, 1] },
      );
      observer.observe(peek);
    };

    const scheduleObservePeek = () => {
      cancelAnimationFrame(observeFrame);
      observeFrame = requestAnimationFrame(() => {
        observeFrame = 0;
        observePeek();
      });
    };

    const captureViewportAnchor = () => {
      const cards = getCards().filter((card) => !card.classList.contains('shorts-peek'));
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        if (rect.bottom > 8) return { el: card, top: rect.top };
      }
      return null;
    };

    const restoreViewportAnchor = (anchor) => {
      if (!anchor || !anchor.el.isConnected) return;
      const delta = anchor.el.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 0.5) {
        suppressScrollUntil = performance.now() + 140;
        window.scrollBy(0, delta);
        lastObservedScrollY = window.scrollY;
        if (!scrolledAfterExpand) lastExpandScrollY = window.scrollY;
      }
    };

    async function expand({ manual = false, instant = false, allowChain = false } = {}) {
      if (refreshRequired) {
        if (manual) location.reload();
        return false;
      }
      if (loading || disposed || !host.isConnected) return false;
      const fullCount = getFullCount();
      const renderedCount = getCards().length;
      const absoluteFull = start - 1 + fullCount;
      const absoluteRendered = start - 1 + renderedCount;
      if (absoluteFull >= total && !getPeekCard()) {
        syncControls();
        return false;
      }
      const plan = reader?.planShortsExpand
        ? reader.planShortsExpand({
            fullCount: absoluteFull,
            renderedCount: absoluteRendered,
            total,
            batchSize,
          })
        : {
            targetFull: Math.min(total, absoluteFull + batchSize),
            targetRendered: Math.min(total, absoluteFull + batchSize + 1),
            hasNextPeek: Math.min(total, absoluteFull + batchSize) < total,
            neededNewCards: Math.max(
              0,
              Math.min(total, absoluteFull + batchSize + 1) - absoluteRendered,
            ),
          };

      if (!allowChain) disarmAuto();
      loading = true;
      automatic = true;
      observer?.disconnect();
      expandBtn?.setAttribute('aria-busy', 'true');
      expandBtn?.setAttribute('aria-disabled', 'true');
      if (expandBtn && !refreshRequired) expandBtn.textContent = '正在加载…';
      if (status) status.textContent = '正在加载更多短记…';

      let changed = false;
      let animPromise = Promise.resolve();
      const neededNewCards =
        typeof plan.neededNewCards === 'number'
          ? plan.neededNewCards
          : Math.max(0, plan.targetRendered - absoluteRendered);
      try {
        while (bufferedCards.length < neededNewCards && nextUrl) {
          const ok = await fetchNextBatch();
          if (!ok) {
            if (refreshRequired) {
              syncControls();
              return false;
            }
            break;
          }
        }
        if (disposed || !host.isConnected) return false;

        const peek = getPeekCard();
        const targetLocalFull = Math.min(total - (start - 1), plan.targetFull - (start - 1));
        const currentFullAfterPeek = fullCount + (peek ? 1 : 0);
        const additionalFullCount = Math.max(0, targetLocalFull - currentFullAfterPeek);

        const fragment = document.createDocumentFragment();
        const addedFull = [];
        for (let i = 0; i < additionalFullCount && bufferedCards.length; i++) {
          const imported = document.importNode(bufferedCards.shift(), true);
          stripPeekAttrs(imported);
          preserveCardImageRatios(imported);
          addedFull.push(imported);
          fragment.append(imported);
        }

        let nextPeek = null;
        if (plan.hasNextPeek && bufferedCards.length) {
          nextPeek = document.importNode(bufferedCards.shift(), true);
          preserveCardImageRatios(nextPeek);
          markAsPeek(nextPeek);
          fragment.append(nextPeek);
        }

        const anchor = instant || allowChain ? null : captureViewportAnchor();
        animPromise = peek ? unpeekCard(peek, instant) : Promise.resolve();
        if (fragment.childNodes.length) feed.append(fragment);
        restoreViewportAnchor(anchor);
        if (nextPeek) await ensurePeekFit();
        if (addedFull.some((card) => card.querySelector('pre code'))) {
          void reader?.activate?.();
        }
        changed = Boolean(peek || addedFull.length || nextPeek);
        await animPromise;
      } catch {
        if (!disposed && host.isConnected) {
          automatic = false;
          if (status) status.textContent = '加载暂时没有完成，当前短记仍可浏览。请点击重试。';
          if (expandBtn) expandBtn.textContent = '重试加载';
        }
        return false;
      } finally {
        loading = false;
        expandBtn?.removeAttribute('aria-busy');
        expandBtn?.removeAttribute('aria-disabled');
        if (!disposed && host.isConnected) {
          if (!allowChain) disarmAuto();
          syncControls();
          if (!allowChain && !refreshRequired && getPeekCard()) scheduleObservePeek();
        }
      }
      return changed;
    }

    let calHighlightTimer = null;
    let calHighlightedCard = null;
    const clearShortHighlight = () => {
      if (calHighlightTimer !== null) {
        clearTimeout(calHighlightTimer);
        calHighlightTimer = null;
      }
      if (calHighlightedCard) {
        calHighlightedCard.classList.remove('shorts-cal-highlight');
        calHighlightedCard = null;
      }
    };
    const highlightShortCard = (el) => {
      if (!el || disposed || !el.isConnected) return;
      clearShortHighlight();
      el.classList.add('shorts-cal-highlight');
      calHighlightedCard = el;
      calHighlightTimer = setTimeout(() => {
        el.classList.remove('shorts-cal-highlight');
        if (calHighlightedCard === el) calHighlightedCard = null;
        calHighlightTimer = null;
      }, 1500);
    };

    let jumpSeq = 0;
    const waitWhileLoading = async (seq) => {
      const deadline = performance.now() + 2500;
      while (loading && !disposed && host.isConnected && seq === jumpSeq && performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };

    const jumpToShortById = async (rawId, { smooth = false, updateHash = false } = {}) => {
      if (!rawId || disposed || !host.isConnected) return;
      const seq = ++jumpSeq;
      const findTarget = () => {
        const direct = document.getElementById(rawId);
        if (direct?.classList.contains('short-card')) return { el: direct, legacy: false };
        const legacy = document.getElementById('note:' + rawId);
        if (legacy?.classList.contains('short-card')) return { el: legacy, legacy: true };
        return null;
      };
      let found = findTarget();
      let guard = 0;
      while (
        !disposed &&
        host.isConnected &&
        seq === jumpSeq &&
        guard < Math.ceil(total / batchSize) + 2 &&
        (!found || found.el.classList.contains('shorts-peek'))
      ) {
        if (start - 1 + getFullCount() >= total && !getPeekCard()) break;
        if (loading) {
          await waitWhileLoading(seq);
          if (disposed || !host.isConnected || seq !== jumpSeq) return;
          found = findTarget();
          if (found && !found.el.classList.contains('shorts-peek')) break;
        }
        guard++;
        const ok = await expand({ manual: false, instant: true, allowChain: true });
        if (!ok) break;
        found = findTarget();
      }
      if (disposed || !host.isConnected || seq !== jumpSeq) return;
      if (!found || found.el.classList.contains('shorts-peek')) {
        if (updateHash && start > 1) {
          location.assign('/shorts/#' + encodeURIComponent(rawId));
          return;
        }
        disarmAuto();
        if (!refreshRequired && getPeekCard()) scheduleObservePeek();
        return;
      }
      if (updateHash || found.legacy) {
        const canonical = new URL(location.href);
        canonical.hash = found.el.id;
        history.replaceState(history.state, '', canonical);
      }
      requestAnimationFrame(() => {
        if (disposed || !found.el.isConnected || seq !== jumpSeq) return;
        const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        suppressScrollUntil = performance.now() + (smooth && !reducedMotion ? 700 : 140);
        found.el.scrollIntoView({
          behavior: smooth && !reducedMotion ? 'smooth' : 'instant',
          block: 'start',
        });
        if (!smooth) found.el.focus({ preventScroll: true });
        highlightShortCard(found.el);
        disarmAuto();
        if (!refreshRequired && getPeekCard()) scheduleObservePeek();
      });
    };

    const resolveShortDeepLink = async () => {
      if (!location.hash || disposed || !host.isConnected) return;
      let rawId;
      try {
        rawId = decodeURIComponent(location.hash.slice(1));
      } catch {
        return;
      }
      if (!rawId) return;
      await jumpToShortById(rawId, { smooth: false, updateHash: false });
    };

    const getShanghaiToday = () => {
      try {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          })
            .formatToParts(new Date())
            .map((part) => [part.type, part.value]),
        );
        const year = Number(parts.year);
        const month = Number(parts.month);
        const day = Number(parts.day);
        if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
          return {
            year,
            month,
            day,
            iso:
              String(year).padStart(4, '0') +
              '-' +
              String(month).padStart(2, '0') +
              '-' +
              String(day).padStart(2, '0'),
          };
        }
      } catch {}
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      return {
        year,
        month,
        day,
        iso:
          String(year).padStart(4, '0') +
          '-' +
          String(month).padStart(2, '0') +
          '-' +
          String(day).padStart(2, '0'),
      };
    };

    const mountShortsCalendar = () => {
      const panel = document.getElementById('shorts-cal-panel');
      const widget = panel?.querySelector('[data-shorts-cal-root]');
      if (!widget) return () => {};

      const rawData = (() => {
        try {
          const parsed = JSON.parse(widget.dataset.shortsCal || '{}');
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      })();
      const calendarData = Object.create(null);
      const dateKeys = [];
      for (const [key, value] of Object.entries(rawData)) {
        if (
          /^\d{4}-\d{2}-\d{2}$/.test(key) &&
          value &&
          typeof value === 'object' &&
          Number(value.count) >= 1 &&
          typeof value.firstId === 'string' &&
          value.firstId
        ) {
          calendarData[key] = { count: Math.floor(Number(value.count)), firstId: value.firstId };
          dateKeys.push(key);
        }
      }
      dateKeys.sort();

      const today = getShanghaiToday();
      const maxYM = today.year * 12 + (today.month - 1);
      let minYM = maxYM;
      if (dateKeys.length) {
        const [ey, em] = dateKeys[0].split('-').map(Number);
        if (Number.isFinite(ey) && Number.isFinite(em)) {
          minYM = Math.min(maxYM, ey * 12 + (em - 1));
        }
      }
      let currentYM = maxYM;

      const monthEl = widget.querySelector('[data-shorts-cal-month]');
      const prevBtn = widget.querySelector('[data-shorts-cal-prev]');
      const nextBtn = widget.querySelector('[data-shorts-cal-next]');
      const gridEl = widget.querySelector('[data-shorts-cal-grid]');
      if (!monthEl || !prevBtn || !nextBtn || !gridEl) return () => {};

      const renderMonth = () => {
        const year = Math.floor(currentYM / 12);
        const month = (currentYM % 12) + 1;
        monthEl.textContent = `${year} 年 ${month} 月`;
        prevBtn.disabled = currentYM <= minYM;
        nextBtn.disabled = currentYM >= maxYM;

        const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const frag = document.createDocumentFragment();
        for (let i = 0; i < firstWeekday; i++) {
          const spacer = document.createElement('span');
          spacer.className = 'shorts-cal-spacer';
          spacer.setAttribute('aria-hidden', 'true');
          frag.append(spacer);
        }
        for (let day = 1; day <= daysInMonth; day++) {
          const iso =
            String(year).padStart(4, '0') +
            '-' +
            String(month).padStart(2, '0') +
            '-' +
            String(day).padStart(2, '0');
          const isToday = iso === today.iso;
          const isFuture = iso > today.iso;
          const entry = isFuture ? null : calendarData[iso] || null;
          if (entry && entry.count > 0) {
            const level = Math.min(4, entry.count);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `shorts-cal-day shorts-cal-has shorts-cal-l${level}${isToday ? ' shorts-cal-today' : ''}`;
            btn.dataset.shortsCalDate = iso;
            btn.dataset.shortsCalTarget = entry.firstId;
            btn.textContent = String(day);
            btn.setAttribute(
              'aria-label',
              `${year} 年 ${month} 月 ${day} 日，共 ${entry.count} 条短记`,
            );
            frag.append(btn);
          } else {
            const cell = document.createElement('span');
            cell.className = `shorts-cal-day shorts-cal-empty${isToday ? ' shorts-cal-today' : ''}`;
            cell.setAttribute('aria-disabled', 'true');
            cell.textContent = String(day);
            frag.append(cell);
          }
        }
        gridEl.replaceChildren(frag);
      };

      // Mobile floating calendar FAB & drawer (reuses the exact same widget node)
      const calFab = document.createElement('button');
      calFab.type = 'button';
      calFab.className = 'shorts-cal-fab';
      calFab.setAttribute('aria-label', '短记日历');
      calFab.setAttribute('aria-controls', 'shorts-cal-drawer');
      calFab.setAttribute('aria-expanded', 'false');
      calFab.innerHTML =
        '<svg class="shorts-cal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3.2"/><path d="M8 2.8v3.6"/><path d="M16 2.8v3.6"/><path d="M3.5 10h17"/></svg>';

      const calBackdrop = document.createElement('div');
      calBackdrop.className = 'shorts-cal-backdrop';
      calBackdrop.hidden = true;

      const calDrawer = document.createElement('div');
      calDrawer.className = 'shorts-cal-drawer';
      calDrawer.id = 'shorts-cal-drawer';
      calDrawer.tabIndex = -1;
      calDrawer.setAttribute('role', 'dialog');
      calDrawer.setAttribute('aria-modal', 'true');
      calDrawer.setAttribute('aria-label', '短记日历');
      calDrawer.hidden = true;

      const drawerBar = document.createElement('div');
      drawerBar.className = 'shorts-cal-drawer-bar';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'shorts-cal-close';
      closeBtn.setAttribute('aria-label', '关闭短记日历');
      closeBtn.innerHTML =
        '<svg class="shorts-cal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/></svg>';
      drawerBar.append(closeBtn);
      calDrawer.append(drawerBar);

      document.body.append(calFab, calBackdrop, calDrawer);

      const narrowCal = matchMedia('(max-width: 1023px)');
      let drawerOpen = false;
      let lockedScrollY = 0;
      let savedBodyStyles = null;
      let lockedBackground = [];

      const unlockScrollAndBg = () => {
        if (savedBodyStyles) {
          document.body.style.overflow = savedBodyStyles.overflow;
          document.body.style.position = savedBodyStyles.position;
          document.body.style.top = savedBodyStyles.top;
          document.body.style.left = savedBodyStyles.left;
          document.body.style.right = savedBodyStyles.right;
          document.body.style.width = savedBodyStyles.width;
          savedBodyStyles = null;
          window.scrollTo({ top: lockedScrollY, behavior: 'instant' });
        }
        for (const [node, prevInert] of lockedBackground) {
          if (node) node.inert = prevInert;
        }
        lockedBackground = [];
      };

      const closeDrawer = ({ restoreFocus = false } = {}) => {
        if (!drawerOpen) return;
        drawerOpen = false;
        calBackdrop.hidden = true;
        calDrawer.hidden = true;
        calFab.classList.remove('shorts-cal-fab-hidden');
        calFab.setAttribute('aria-expanded', 'false');
        unlockScrollAndBg();
        if (restoreFocus && calFab.isConnected) {
          calFab.focus({ preventScroll: true });
        }
      };

      const syncWidgetHost = () => {
        if (narrowCal.matches) {
          if (widget.parentElement !== calDrawer) calDrawer.append(widget);
        } else {
          if (drawerOpen) closeDrawer({ restoreFocus: false });
          if (widget.parentElement !== panel) panel.prepend(widget);
        }
      };

      const openDrawer = () => {
        if (drawerOpen || !narrowCal.matches) return;
        syncWidgetHost();
        drawerOpen = true;
        lockedScrollY = window.scrollY;
        savedBodyStyles = {
          overflow: document.body.style.overflow,
          position: document.body.style.position,
          top: document.body.style.top,
          left: document.body.style.left,
          right: document.body.style.right,
          width: document.body.style.width,
        };
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${lockedScrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.width = '100%';
        lockedBackground = [
          document.getElementById('swup'),
          document.querySelector('.site-header'),
          document.querySelector('.site-footer'),
          document.getElementById('primary-nav'),
          document.querySelector('.reader-dock'),
          document.querySelector('.reader-skip'),
          document.getElementById('to-top'),
          calFab,
        ]
          .filter(Boolean)
          .map((node) => [node, node.inert]);
        for (const [node] of lockedBackground) node.inert = true;
        calBackdrop.hidden = false;
        calDrawer.hidden = false;
        calFab.classList.add('shorts-cal-fab-hidden');
        calFab.setAttribute('aria-expanded', 'true');
        calDrawer.focus({ preventScroll: true });
      };

      const onPrevClick = () => {
        if (currentYM <= minYM) return;
        currentYM -= 1;
        renderMonth();
      };
      const onNextClick = () => {
        if (currentYM >= maxYM) return;
        currentYM += 1;
        renderMonth();
      };
      const onGridClick = (event) => {
        const btn = event.target.closest?.('.shorts-cal-day.shorts-cal-has');
        if (!btn || !gridEl.contains(btn)) return;
        const targetId = btn.dataset.shortsCalTarget;
        if (!targetId) return;
        if (drawerOpen) {
          closeDrawer({ restoreFocus: false });
        }
        void jumpToShortById(targetId, { smooth: true, updateHash: true });
      };
      const onFabClick = () => {
        if (drawerOpen) closeDrawer({ restoreFocus: true });
        else openDrawer();
      };
      const onBackdropClick = () => closeDrawer({ restoreFocus: true });
      const onCloseClick = () => closeDrawer({ restoreFocus: true });
      const onCalKeyDown = (event) => {
        if (event.key === 'Escape' && drawerOpen) {
          event.preventDefault();
          closeDrawer({ restoreFocus: true });
        }
      };

      prevBtn.addEventListener('click', onPrevClick);
      nextBtn.addEventListener('click', onNextClick);
      gridEl.addEventListener('click', onGridClick);
      calFab.addEventListener('click', onFabClick);
      calBackdrop.addEventListener('click', onBackdropClick);
      closeBtn.addEventListener('click', onCloseClick);
      window.addEventListener('keydown', onCalKeyDown);
      narrowCal.addEventListener('change', syncWidgetHost);

      renderMonth();
      syncWidgetHost();

      return () => {
        closeDrawer({ restoreFocus: false });
        prevBtn.removeEventListener('click', onPrevClick);
        nextBtn.removeEventListener('click', onNextClick);
        gridEl.removeEventListener('click', onGridClick);
        calFab.removeEventListener('click', onFabClick);
        calBackdrop.removeEventListener('click', onBackdropClick);
        closeBtn.removeEventListener('click', onCloseClick);
        window.removeEventListener('keydown', onCalKeyDown);
        narrowCal.removeEventListener('change', syncWidgetHost);
        calFab.remove();
        calBackdrop.remove();
        calDrawer.remove();
      };
    };

    const cleanupCalendar = mountShortsCalendar();

    const restoreSavedBatches = async () => {
      if (location.hash) return;
      const navEntry = performance.getEntriesByType?.('navigation')?.[0];
      if (!visit && navEntry?.type !== 'back_forward') return;
      let saved = null;
      try {
        saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      } catch {}
      if (!saved || saved.revision !== revision) return;
      const targetEnd = Math.min(total, Number(saved.end) || 0);
      let guard = 0;
      while (
        !disposed &&
        host.isConnected &&
        start - 1 + getFullCount() < targetEnd &&
        guard < Math.ceil(total / batchSize) + 2
      ) {
        guard++;
        const ok = await expand({ manual: false, instant: true, allowChain: true });
        if (!ok) break;
      }
      if (Number.isFinite(saved.scrollY) && saved.scrollY > 0) {
        requestAnimationFrame(() => {
          if (disposed) return;
          suppressScrollUntil = performance.now() + 140;
          window.scrollTo({ top: saved.scrollY, behavior: 'instant' });
          disarmAuto();
          if (!refreshRequired && getPeekCard()) scheduleObservePeek();
        });
      } else {
        disarmAuto();
      }
    };

    const onManualIntent = () => {
      warmNextBatch();
    };

    const onExpandClick = (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      if (event.detail > 0) expandBtn?.blur();
      if (loading) return;
      disarmAuto();
      void expand({ manual: true });
    };

    const onFeedMouseDown = (event) => {
      const peek = event.target.closest?.('.short-card.shorts-peek');
      if (peek && feed.contains(peek)) event.preventDefault();
    };

    const onFeedClick = (event) => {
      const peek = event.target.closest?.('.short-card.shorts-peek');
      if (!peek || !feed.contains(peek)) return;
      event.preventDefault();
      if (loading) return;
      disarmAuto();
      void expand({ manual: true });
    };

    const onFeedWarm = (event) => {
      if (event.target.closest?.('.short-card.shorts-peek')) onManualIntent();
    };

    const onScroll = () => {
      if (disposed || !host.isConnected) return;
      const currentY = window.scrollY;
      const movedDown = currentY > lastObservedScrollY;
      lastObservedScrollY = currentY;
      saveState();
      if (performance.now() < suppressScrollUntil) {
        if (!scrolledAfterExpand) lastExpandScrollY = currentY;
        return;
      }
      if (loading || refreshRequired || !automatic) return;
      if (movedDown && currentY > lastExpandScrollY) {
        scrolledAfterExpand = true;
      }
      const peek = getPeekCard();
      if (!peek) return;
      evaluateAutoExpand(peek);
    };

    const canExpandAtBottomLimit = (peek) => {
      if (
        !scrolledAfterExpand ||
        window.scrollY - lastExpandScrollY < 40 ||
        !peekSeenLocked ||
        performance.now() - peekSeenAt < 260
      ) {
        return false;
      }
      const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      return window.scrollY >= maxScrollY - 4 && isPeekAtBottom(peek);
    };

    const onWheel = (event) => {
      if (disposed || !host.isConnected || loading || refreshRequired || !automatic) return;
      if (event.deltaY <= 0) {
        wheelDownAccum = 0;
        return;
      }
      const peek = getPeekCard();
      if (!peek || !canExpandAtBottomLimit(peek)) {
        wheelDownAccum = 0;
        return;
      }
      wheelDownAccum += event.deltaY;
      if (wheelDownAccum >= 40) {
        disarmAuto();
        void expand({ manual: false });
      }
    };

    const onTouchStart = (event) => {
      touchStartY = event.touches?.[0]?.clientY ?? null;
    };

    const onTouchMove = (event) => {
      if (
        touchStartY === null ||
        disposed ||
        !host.isConnected ||
        loading ||
        refreshRequired ||
        !automatic
      ) {
        return;
      }
      const currentTouchY = event.touches?.[0]?.clientY;
      if (!Number.isFinite(currentTouchY)) return;
      const dy = touchStartY - currentTouchY;
      if (dy < 40) return;
      const peek = getPeekCard();
      if (!peek || !canExpandAtBottomLimit(peek)) return;
      disarmAuto();
      void expand({ manual: false });
    };

    const onTouchEnd = () => {
      touchStartY = null;
    };

    const onKeyDown = (event) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        loading ||
        refreshRequired ||
        !automatic ||
        event.target?.closest?.('input,textarea,select,[contenteditable],dialog[open]')
      )
        return;
      if (
        event.key === 'PageDown' ||
        event.key === 'End' ||
        (event.key === ' ' && !event.shiftKey)
      ) {
        const peek = getPeekCard();
        if (peek && canExpandAtBottomLimit(peek)) {
          disarmAuto();
          void expand({ manual: false });
        }
      }
    };

    const onResize = () => {
      if (!disposed && host.isConnected && getPeekCard()) {
        void ensurePeekFit();
      }
    };

    const onHashChange = () => {
      void resolveShortDeepLink();
    };

    const onVisitStart = () => {
      if (disposed || !host.isConnected) return;
      settleSprings();
      saveState();
    };

    expandBtn?.addEventListener('click', onExpandClick);
    expandBtn?.addEventListener('pointerenter', onManualIntent, { passive: true });
    expandBtn?.addEventListener('pointerdown', onManualIntent, { passive: true });
    expandBtn?.addEventListener('touchstart', onManualIntent, { passive: true });
    feed.addEventListener('mousedown', onFeedMouseDown);
    feed.addEventListener('click', onFeedClick);
    feed.addEventListener('pointerenter', onFeedWarm, { passive: true, capture: true });
    feed.addEventListener('pointerdown', onFeedWarm, { passive: true, capture: true });
    feed.addEventListener('touchstart', onFeedWarm, { passive: true, capture: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    window.addEventListener('keydown', onKeyDown, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('hashchange', onHashChange);
    const removeVisitStart = swup?.hooks.on('visit:start', onVisitStart);

    // Measure initial peek (and promote if ultra-short), then sync controls & arm observer.
    void (async () => {
      for (const card of getCards()) preserveCardImageRatios(card);
      await restoreSavedBatches();
      if (disposed || !host.isConnected) return;
      if (getPeekCard()) await ensurePeekFit();
      if (disposed || !host.isConnected) return;
      syncControls();
      if (location.hash) await resolveShortDeepLink();
      if (!disposed && host.isConnected && getPeekCard()) {
        disarmAuto();
        scheduleObservePeek();
      }
    })();

    cleanupFunctions.push(() => {
      disposed = true;
      clearShortHighlight();
      cleanupCalendar();
      cancelAnimationFrame(observeFrame);
      settleSprings();
      request?.abort();
      observer?.disconnect();
      expandBtn?.removeEventListener('click', onExpandClick);
      expandBtn?.removeEventListener('pointerenter', onManualIntent);
      expandBtn?.removeEventListener('pointerdown', onManualIntent);
      expandBtn?.removeEventListener('touchstart', onManualIntent);
      feed.removeEventListener('mousedown', onFeedMouseDown);
      feed.removeEventListener('click', onFeedClick);
      feed.removeEventListener('pointerenter', onFeedWarm, true);
      feed.removeEventListener('pointerdown', onFeedWarm, true);
      feed.removeEventListener('touchstart', onFeedWarm, true);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('hashchange', onHashChange);
      if (typeof removeVisitStart === 'function') removeVisitStart();
      else if (typeof removeVisitStart?.off === 'function') removeVisitStart.off();
      else swup?.hooks.off?.('visit:start', onVisitStart);
    });
  }

  function siteIconMime(url) {
    const ext = (url.split('.').pop() || '').toLowerCase();
    return (
      {
        svg: 'image/svg+xml',
        ico: 'image/x-icon',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        avif: 'image/avif',
      }[ext] || 'image/svg+xml'
    );
  }

  function validSiteIconUrl(url) {
    return (
      url === '/favicon.svg' ||
      /^\/site-icon\/[a-f0-9]{64}(?:-(?:180|192|512|512-maskable))?\.(?:svg|ico|png|jpe?g|webp|gif|avif)$/.test(
        url || '',
      )
    );
  }

  function syncSiteAppearance(swupContainer) {
    window.CloudInkTheme?.setPalette(
      swupContainer.dataset.palette || document.documentElement.dataset.palette || 'ink',
    );
    const iconURL = swupContainer.dataset.siteIcon;
    if (validSiteIconUrl(iconURL)) {
      const favicon = document.querySelector('link[rel="icon"]');
      if (favicon) {
        favicon.setAttribute('href', iconURL);
        favicon.setAttribute('type', siteIconMime(iconURL));
      }
      const markURL = validSiteIconUrl(swupContainer.dataset.siteIconAvatar)
        ? swupContainer.dataset.siteIconAvatar
        : iconURL;
      document
        .querySelectorAll('.site-mark img')
        .forEach((image) => image.setAttribute('src', markURL));
    }
    const appleURL = swupContainer.dataset.siteIconApple || '';
    const existingApple = document.querySelector('link[rel="apple-touch-icon"]');
    if (/^\/site-icon\/[a-f0-9]{64}-180\.png$/.test(appleURL)) {
      const link = existingApple || document.createElement('link');
      link.setAttribute('rel', 'apple-touch-icon');
      link.setAttribute('sizes', '180x180');
      link.setAttribute('href', appleURL);
      if (!existingApple) document.head.append(link);
    } else if (existingApple && swupContainer.dataset.siteIconApple !== undefined) {
      existingApple.remove();
    }
  }

  function mountHomeCards(swupContainer) {
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
  }

  function createPageDialogManager() {
    const dialogs = new Set();
    cleanupFunctions.push(() => {
      for (const dialog of dialogs) if (dialog.open) dialog.close();
    });
    return (content, label, trigger, dispose = () => {}) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'reader-dialog';
      dialog.dataset.sheet = 'compact';
      dialog.setAttribute('aria-label', label);
      const header = document.createElement('div');
      header.className = 'reader-dialog-header';
      header.dataset.sheetHeader = '';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'reader-dialog-close';
      close.textContent = '×';
      close.setAttribute('aria-label', t('关闭', 'Close'));
      header.append(close);
      const body = document.createElement('div');
      body.className = 'reader-dialog-body';
      body.append(content);
      dialog.append(header, body);
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
      if (!dialog.hasAttribute('data-ci-sheet-active')) close.focus({ preventScroll: true });
      dialogs.add(dialog);
      return dialog;
    };
  }

  function mountImageLightbox(showDialog) {
    document.querySelectorAll('.article-body img').forEach((img) => {
      // Linked images retain their author's link action.
      if (img.closest('a,button')) return;
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute(
        'aria-label',
        t('放大图片', 'Enlarge image') + (img.alt ? ': ' + img.alt : ''),
      );
      const media = img.closest('picture') || img;
      if (!media.parentElement.classList.contains('reader-zoom-frame')) {
        const frame = document.createElement('span');
        frame.className = 'reader-zoom-frame';
        media.before(frame);
        frame.append(media);
      }
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
        const dialog = showDialog(content, img.alt || t('图片预览', 'Image preview'), img, () => {
          disposed = true;
          cancel();
        });
        if (
          motion &&
          !dialog.hasAttribute('data-ci-sheet-active') &&
          !reducedMotion.matches &&
          typeof clone.animate === 'function'
        ) {
          requestAnimationFrame(() => {
            const finalRect = clone.getBoundingClientRect();
            if (finalRect.width > 0 && finalRect.height > 0) {
              const scaleX = initialRect.width / finalRect.width;
              const scaleY = initialRect.height / finalRect.height;
              const translateX =
                initialRect.left + initialRect.width / 2 - (finalRect.left + finalRect.width / 2);
              const translateY =
                initialRect.top + initialRect.height / 2 - (finalRect.top + finalRect.height / 2);
              motion.animate(clone, [
                {
                  transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
                  opacity: 0.85,
                },
                { transform: 'none', opacity: 1 },
              ]);
            }
          });
        }
        if (full === new URL(preview, location.href).href) {
          message.textContent = '原图已加载';
        } else load();
      };
      img.addEventListener('click', open);
      const keydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      };
      img.addEventListener('keydown', keydown);
      cleanupFunctions.push(() => {
        img.removeEventListener('click', open);
        img.removeEventListener('keydown', keydown);
      });
    });
  }

  function mountCodeBlocksAndTables() {
    const scrollCues = [];
    function addScrollCue(scroller, label) {
      let frame = scroller.parentElement;
      if (!frame.classList.contains('scroll-cue')) {
        frame = document.createElement('div');
        frame.className = 'scroll-cue';
        scroller.before(frame);
        frame.append(scroller);
      }
      scrollCues.push({ scroller, frame, label });
    }
    document.querySelectorAll(':is(.article-body, .short-body) pre').forEach((pre) => {
      pre.tabIndex = 0;
      const scrollLabel = t('代码块', 'Code block');
      if (pre.closest('.code-block')) {
        addScrollCue(pre, scrollLabel);
        return;
      }
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
      button.innerHTML =
        '<svg class="copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11.5" height="11.5" rx="3.2"/><path d="M5.5 15h-.8a2.2 2.2 0 0 1-2.2-2.2V5A2.2 2.2 0 0 1 4.7 2.8h8A2.2 2.2 0 0 1 14.9 5v.8"/></svg><span class="copy-label"></span><span class="reader-sr-only"></span>';
      const label = button.querySelector('.copy-label');
      const copyLabel = t('复制', 'Copy');
      const copiedLabel = t('已复制', 'Copied');
      label.textContent = copyLabel;
      button.lastElementChild.textContent = t('代码', ' code');

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
      addScrollCue(pre, scrollLabel);

      let resetTimer = null;
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeText);
        } catch {
          clearTimeout(resetTimer);
          button.classList.remove('copied');
          label.textContent = copyLabel;
          feedback.classList.remove('reader-sr-only');
          feedback.textContent = t('请选中代码复制', 'Select the code to copy it');
          return;
        }
        clearTimeout(resetTimer);
        feedback.classList.add('reader-sr-only');
        feedback.textContent = copiedLabel;
        button.classList.add('copied');
        label.textContent = copiedLabel;
        resetTimer = setTimeout(() => {
          button.classList.remove('copied');
          feedback.textContent = '';
          label.textContent = copyLabel;
        }, 2000);
      });
    });
    document.querySelectorAll(':is(.article-body, .short-body) table').forEach((table) => {
      let scroller = table.parentElement;
      if (!scroller.classList.contains('table-scroll')) {
        scroller = document.createElement('div');
        scroller.className = 'table-scroll';
        table.before(scroller);
        scroller.append(table);
      }
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'region');
      addScrollCue(scroller, t('表格', 'Table'));
    });
    if (scrollCues.length) {
      const controller = new AbortController();
      const options = { passive: true, signal: controller.signal };
      const update = ({ scroller, frame, label }) => {
        const overflow = scroller.scrollWidth - scroller.clientWidth;
        const name = label + (overflow > 1 ? t('，可横向滚动', ', scroll horizontally') : '');
        if (scroller.getAttribute('aria-label') !== name) scroller.setAttribute('aria-label', name);
        frame.toggleAttribute(
          'data-scroll-more',
          scroller.clientHeight > 0 && overflow - scroller.scrollLeft > 1,
        );
      };
      const refresh = () => {
        if (!controller.signal.aborted) scrollCues.forEach(update);
      };
      const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
      for (const entry of scrollCues) {
        entry.scroller.addEventListener('scroll', () => update(entry), options);
        resize?.observe(entry.scroller);
        if (entry.scroller.firstElementChild) resize?.observe(entry.scroller.firstElementChild);
      }
      window.addEventListener('resize', refresh, options);
      document.fonts?.addEventListener('loadingdone', refresh, options);
      document.fonts?.ready.then(refresh);
      const initialRefreshFrame = requestAnimationFrame(refresh);
      cleanupFunctions.push(() => {
        cancelAnimationFrame(initialRefreshFrame);
        controller.abort();
        resize?.disconnect();
      });
    }
    document.querySelectorAll('.article-body .katex-display').forEach((formula) => {
      formula.tabIndex = 0;
      formula.setAttribute('role', 'region');
      formula.setAttribute(
        'aria-label',
        t('公式，可横向滚动', 'Math formula, scroll horizontally'),
      );
    });
  }

  let shareCardLoader = null;
  function mountShareCard(showDialog) {
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        if (shareBtn.dataset.loading === '1') return;
        shareBtn.dataset.loading = '1';
        const status = document.getElementById('share-status');
        try {
          shareCardLoader ||= import('/reader-assets/share-card.js').catch((err) => {
            shareCardLoader = null;
            throw err;
          });
          const { openShareCard } = await shareCardLoader;
          await openShareCard({ showDialog, shareBtn, t });
        } catch {
          if (status)
            status.textContent = t(
              '分享卡片组件加载失败，请重试。',
              'Could not load share card. Try again.',
            );
        } finally {
          delete shareBtn.dataset.loading;
        }
      });
    }
  }

  function mountCopyLinkButtons() {
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
  }

  function mountArticleReadingTools(visit) {
    const article = document.querySelector('.article-shell article');
    if (article) {
      let progressBar = document.getElementById('reading-progress');
      let createdProgressBar = false;
      if (!progressBar && !article.closest('.reader-page')) {
        progressBar = document.createElement('div');
        progressBar.id = 'reading-progress';
        progressBar.className = 'reading-progress';
        progressBar.setAttribute('aria-hidden', 'true');
        document.body.prepend(progressBar);
        createdProgressBar = true;
      }
      if (createdProgressBar) {
        cleanupFunctions.push(() => {
          progressBar?.remove();
        });
      }
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

        // Mobile TOC Buttons (inline + follow-along FAB) & Drawer Logic
        const tocButtonIcon =
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6.2h9.5"/><path d="M10 12h9.5"/><path d="M10 17.8h9.5"/><circle cx="4.6" cy="6.2" r="1.6" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="4.6" cy="17.8" r="1.6" fill="currentColor" stroke="none"/></svg>';
        const mobileTocBtn = document.createElement('button');
        mobileTocBtn.type = 'button';
        mobileTocBtn.className = 'mobile-toc-btn';
        mobileTocBtn.setAttribute('aria-label', t('文章目录', 'Article contents'));
        mobileTocBtn.setAttribute('aria-controls', 'article-contents');
        mobileTocBtn.setAttribute('aria-expanded', 'false');
        mobileTocBtn.innerHTML = tocButtonIcon;
        const tools = article.querySelector('.mobile-reader-tools');
        let floatingTocBtn = null;
        if (tools) {
          mobileTocBtn.append(document.createTextNode(t('文章目录', 'Contents')));
          tools.prepend(mobileTocBtn);

          floatingTocBtn = document.createElement('button');
          floatingTocBtn.type = 'button';
          floatingTocBtn.className = 'mobile-toc-fab';
          floatingTocBtn.setAttribute('aria-label', t('文章目录', 'Article contents'));
          floatingTocBtn.setAttribute('aria-controls', 'article-contents');
          floatingTocBtn.setAttribute('aria-expanded', 'false');
          floatingTocBtn.setAttribute('aria-hidden', 'true');
          floatingTocBtn.tabIndex = -1;
          floatingTocBtn.innerHTML = tocButtonIcon;
          document.body.appendChild(floatingTocBtn);
          cleanupFunctions.push(() => floatingTocBtn.remove());
        } else document.body.appendChild(mobileTocBtn);
        cleanupFunctions.push(() => mobileTocBtn.remove());

        const tocTriggers = floatingTocBtn ? [mobileTocBtn, floatingTocBtn] : [mobileTocBtn];
        let lastTocTrigger = mobileTocBtn;

        const tocDrawerOverlay = document.createElement('div');
        tocDrawerOverlay.className = 'zoom-overlay reader-toc-overlay';
        tocDrawerOverlay.style.zIndex = '998';
        document.body.appendChild(tocDrawerOverlay);
        cleanupFunctions.push(() => tocDrawerOverlay.remove());

        const narrowToc = matchMedia('(max-width: 1023px)');
        let toolsOutOfView = false;
        let tocOverflow = null;
        let tocBackground = [];
        let tocDisposed = false;
        const syncFloatingTocBtn = () => {
          if (!floatingTocBtn || tocDisposed) return;
          const visible =
            narrowToc.matches && toolsOutOfView && !tocContainer.classList.contains('drawer-open');
          floatingTocBtn.classList.toggle('is-visible', visible);
          floatingTocBtn.setAttribute('aria-hidden', visible ? 'false' : 'true');
          floatingTocBtn.tabIndex = visible ? 0 : -1;
        };
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
          syncFloatingTocBtn();
        };
        syncToc();
        let toolsObserver = null;
        if (tools && floatingTocBtn && typeof IntersectionObserver === 'function') {
          toolsObserver = new IntersectionObserver(
            (entries) => {
              const entry = entries[entries.length - 1];
              if (!entry) return;
              toolsOutOfView = !entry.isIntersecting && entry.boundingClientRect.bottom <= 0;
              syncFloatingTocBtn();
            },
            { threshold: 0 },
          );
          toolsObserver.observe(tools);
          cleanupFunctions.push(() => toolsObserver.disconnect());
        }
        const resizeToc = () => {
          closeTocDrawer();
          if (tools && floatingTocBtn) {
            toolsOutOfView = narrowToc.matches && tools.getBoundingClientRect().bottom <= 0;
          }
          syncToc();
        };
        narrowToc.addEventListener('change', resizeToc);
        cleanupFunctions.push(() => {
          tocDisposed = true;
          narrowToc.removeEventListener('change', resizeToc);
          closeTocDrawer();
          closeArticleContents = null;
        });
        const restoreTocFocus = () => {
          const target =
            lastTocTrigger?.isConnected && lastTocTrigger.tabIndex >= 0
              ? lastTocTrigger
              : mobileTocBtn;
          void target.offsetWidth;
          target.focus({ preventScroll: true });
        };
        tocContainer.dataset.sheet = 'list';
        const tocSheet = window.CloudInkMobile?.attach(tocContainer, {
          media: '(max-width:1023px)',
          dismissOnActivate: true,
          onDismiss: () => {
            closeTocDrawer();
            restoreTocFocus();
          },
        });
        cleanupFunctions.push(() => tocSheet?.dispose());
        const requestTocClose = () => {
          if (!tocSheet?.close()) {
            closeTocDrawer();
            restoreTocFocus();
          }
        };
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
          for (const trigger of tocTriggers) trigger.setAttribute('aria-expanded', 'false');
          tocDrawerOverlay.classList.remove('active');
          syncToc();
        }

        closeArticleContents = closeTocDrawer;
        const toggleTocDrawer = (trigger) => {
          if (tocContainer.classList.contains('drawer-open')) {
            requestTocClose();
          } else {
            lastTocTrigger = trigger;
            tocOverflow = document.body.style.overflow;
            tocBackground = [
              document.getElementById('swup'),
              document.querySelector('.site-header'),
              document.querySelector('.site-footer'),
              document.getElementById('primary-nav'),
              document.querySelector('.reader-dock'),
              document.querySelector('.reader-skip'),
              floatingTocBtn,
              toTop,
            ]
              .filter(Boolean)
              .map((node) => [node, node.inert]);
            for (const [node] of tocBackground) node.inert = true;
            document.body.style.overflow = 'hidden';
            tocContainer.classList.add('drawer-open');
            syncToc();
            for (const btn of tocTriggers) btn.setAttribute('aria-expanded', 'true');
            tocDrawerOverlay.classList.add('active');
            tocSheet?.open();
            tocContainer.scrollTop = 0;
            tocContainer.querySelector('a')?.focus({ preventScroll: true });
          }
        };
        for (const trigger of tocTriggers) {
          trigger.addEventListener('click', () => toggleTocDrawer(trigger));
        }

        const tocLinks = Array.from(tocContainer.querySelectorAll('.toc-link'));
        tocDrawerOverlay.addEventListener('click', requestTocClose);
        function revealFocusedTocLink() {
          const link = document.activeElement;
          if (!tocContainer.classList.contains('drawer-open') || !tocLinks.includes(link)) return;
          // Native focus scroll may count the part of a peeked sheet below the screen.
          const sheet = tocContainer.getBoundingClientRect();
          const top = sheet.top + (tocSheet?.handle.offsetHeight || 0);
          const bottom = Math.min(sheet.bottom, innerHeight);
          if (bottom <= top) return;
          const bounds = link.getBoundingClientRect();
          if (bounds.top < top) tocContainer.scrollTop += bounds.top - top;
          else if (bounds.bottom > bottom) tocContainer.scrollTop += bounds.bottom - bottom;
        }
        const tocKeyboard = (e) => {
          if (e.isComposing) return;
          if (e.key === 'Tab' && tocContainer.classList.contains('drawer-open')) {
            const first = tocContainer.hasAttribute('data-ci-sheet-active')
                ? tocSheet.handle
                : tocLinks[0],
              last = tocLinks.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus({ preventScroll: true });
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus({ preventScroll: true });
            }
            requestAnimationFrame(revealFocusedTocLink);
          }
          if (e.key === 'Escape' && tocContainer.classList.contains('drawer-open')) {
            e.preventDefault();
            requestTocClose();
          }
        };
        document.addEventListener('keydown', tocKeyboard);
        cleanupFunctions.push(() => document.removeEventListener('keydown', tocKeyboard));

        // Cache heading positions when layout changes; scroll frames only search the cache.
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
  }

  function initPageFeatures(visit) {
    cleanupFunctions.forEach((fn) => fn());
    cleanupFunctions = [];

    if (window.CloudInkReader) void window.CloudInkReader.activate();
    else if (typeof hljs !== 'undefined' && document.querySelector('#swup pre code'))
      hljs.highlightAll();
    const swupContainer = document.getElementById('swup');
    if (!swupContainer) return;

    syncReaderNavigation();
    mountPostList();
    mountShortsFeed(visit);
    syncSiteAppearance(swupContainer);
    mountHomeCards(swupContainer);

    const showDialog = createPageDialogManager();
    mountImageLightbox(showDialog);
    mountCodeBlocksAndTables();
    mountShareCard(showDialog);
    mountCopyLinkButtons();
    mountArticleReadingTools(visit);
  }

  function shortFragmentTarget() {
    if (!location.hash) return null;
    let id;
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      return null;
    }
    const target = document.getElementById(id);
    if (target?.classList.contains('short-card') && !target.classList.contains('shorts-peek'))
      return target;
    // Links in earlier publications used the bare slug.
    const legacy = document.getElementById('note:' + id);
    if (!legacy?.classList.contains('short-card') || legacy.classList.contains('shorts-peek'))
      return null;
    const canonical = new URL(location.href);
    canonical.hash = legacy.id;
    history.replaceState(history.state, '', canonical);
    legacy.scrollIntoView({ behavior: 'instant', block: 'start' });
    return legacy;
  }
  initPageFeatures();
  shortFragmentTarget()?.focus({ preventScroll: true });
  const enterPage = (direction = 1) => {
    for (const [index, id] of ['reader-center-content', 'reader-context-content'].entries()) {
      const content = document.getElementById(id);
      if (content?.getClientRects().length)
        motion?.enter(content, {
          kind: 'content',
          axis: index ? 'y' : 'x',
          direction,
          delay: index ? 35 : 0,
        });
    }
  };
  enterPage();
  swup?.hooks.on('page:view', (visit) => {
    const order = ['home', 'posts', 'shorts', 'archive', 'about'];
    const from = document.querySelector('[data-reader-nav][aria-current]')?.dataset.readerNav;
    initPageFeatures(visit);
    const to = document.querySelector('[data-reader-nav][aria-current]')?.dataset.readerNav;
    enterPage(order.indexOf(to) < order.indexOf(from) ? -1 : 1);
    if (!visit.history.popstate)
      (shortFragmentTarget() || document.getElementById('swup'))?.focus({ preventScroll: true });
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
      } else if (
        !location.hash &&
        (location.pathname === '/' ||
          location.pathname === '' ||
          /^\/post\/(?:page\/[1-9]\d*\/)?$/.test(location.pathname) ||
          /^\/shorts\/(?:page\/[1-9]\d*\/)?$/.test(location.pathname))
      ) {
        position = pathPositions.get(location.pathname || '/');
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
    const registerServiceWorker = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    };
    if (document.readyState === 'complete') registerServiceWorker();
    else window.addEventListener('load', registerServiceWorker, { once: true });
  }
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootCloudInkClient, { once: true });
} else {
  bootCloudInkClient();
}
