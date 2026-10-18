document.addEventListener('DOMContentLoaded', () => {
      const motion = window.CloudInkMotion;
      motion?.mount();
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const swup = typeof Swup === 'function' ? new Swup({
        animationSelector: reducedMotion.matches ? false : '[class*="transition-"]'
      }) : null;
      reducedMotion.addEventListener('change', () => {
        if (swup) swup.options.animationSelector = reducedMotion.matches ? false : '[class*="transition-"]';
      });
      window.swup = swup;
      let cleanupFunctions = [];
      
      const readerMenu = document.getElementById('reader-menu');
      const menuSummary = readerMenu?.querySelector('summary');
      const closeReaderMenu = (focus = false) => {
        if (!readerMenu?.open) return;
        readerMenu.open = false;
        if (focus) menuSummary.focus({ preventScroll: true });
      };
      readerMenu?.addEventListener('click', event => {
        if (event.target.closest('a[href]')) closeReaderMenu();
      });
      document.addEventListener('click', event => {
        if (readerMenu && !readerMenu.contains(event.target)) closeReaderMenu();
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && readerMenu?.open) {
          event.preventDefault();
          closeReaderMenu(true);
        }
      });
      const wideNavigation = matchMedia('(min-width: 760px)');
      wideNavigation.addEventListener('change', () => {
        if (wideNavigation.matches) closeReaderMenu();
      });
      const syncReaderNavigation = () => {
        const kind = document.getElementById('swup')?.dataset.page;
        for (const link of document.querySelectorAll('[data-reader-nav]')) {
          const active = link.dataset.readerNav === (kind === 'home' ? 'posts' : kind === 'about' ? 'about' : '');
          if (active) link.setAttribute('aria-current', 'page');
          else link.removeAttribute('aria-current');
        }
      };

      const searchBtn = document.getElementById('site-search-btn');
      const searchModal = document.getElementById('search-modal');
      const searchInput = document.getElementById('search-input');
      const searchResults = document.getElementById('search-results');
      let closeArticleContents = null;
      let searchIndex = null;
      let searchLoading = null;

      if (searchBtn && searchModal) {
        const nativeSearch = typeof searchModal.showModal === 'function';
        let searchOverflow = null;
        let searchError = false;
        let searchStatus = document.getElementById('search-status');
        if (!searchStatus) {
          searchStatus = document.createElement('p');
          searchStatus.className = 'search-status';
          searchStatus.setAttribute('role', 'status');
          searchResults.before(searchStatus);
        }
        const finishSearch = () => {
          if (nativeSearch && searchModal.open) return;
          searchModal.classList.remove('active');
          searchModal.setAttribute('aria-hidden', 'true');
          searchModal.inert = true;
          if (searchOverflow !== null) document.body.style.overflow = searchOverflow;
          searchOverflow = null;
          searchBtn.focus({ preventScroll: true });
        };
        const closeSearch = (immediate = false) => {
          if (!searchModal.classList.contains('active')) return;
          if (nativeSearch && searchModal.open) {
            if (motion && !immediate) motion.closeDialog(searchModal);
            else searchModal.close();
          } else finishSearch();
        };
        if (nativeSearch) {
          searchModal.addEventListener('close', finishSearch);
          // The shared motion controller owns cancel when present.
          if (!motion) searchModal.addEventListener('cancel', event => {
            event.preventDefault();
            closeSearch();
          });
        }
        const highlight = (node, text, query) => {
          if (!query) { node.textContent = text; return; }
          const lower = text.toLowerCase();
          let start = 0, found = lower.indexOf(query);
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
          const results = (query ? searchIndex.filter(post =>
            (post.title + '\n' + post.description + '\n' + post.body).toLowerCase().includes(query)
          ) : searchIndex).slice(0, query ? 10 : 5);
          searchStatus.textContent = results.length
            ? (query ? '找到 ' + results.length + (results.length === 10 ? ' 篇匹配文章（最多显示 10 篇）' : ' 篇匹配文章') : '最近发布的文章')
            : (query ? '还没有找到匹配的文字，试试其他关键词。' : '这里还没有发布的文章。');
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
            if (match !== -1 && !post.description.toLowerCase().includes(query) && !post.title.toLowerCase().includes(query)) {
              const start = Math.max(0, match - 40), end = Math.min(post.body.length, match + query.length + 80);
              text = (start ? '…' : '') + post.body.slice(start, end) + (end < post.body.length ? '…' : '');
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
          if (!searchLoading) searchLoading = (async () => {
            try {
              const response = await fetch('/search_index.json');
              if (!response.ok) throw new Error('Search index unavailable');
              const posts = await response.json();
              if (!Array.isArray(posts) || !posts.every(post => post && ['slug', 'title', 'description', 'body'].every(key => typeof post[key] === 'string')))
                throw new Error('Invalid search index');
              searchIndex = posts;
              searchError = false;
            } catch { searchError = true; }
            finally { searchLoading = null; }
          })();
          return searchLoading;
        };
        const openSearch = async () => {
          closeReaderMenu();
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
        searchResults.addEventListener('click', event => {
          if (event.target.closest('a[href]')) closeSearch(true);
        });
        document.getElementById('search-close')?.addEventListener('click', () => closeSearch());
        searchModal.addEventListener('click', event => {
          if (event.target === searchModal) closeSearch();
        });
        searchModal.addEventListener('keydown', event => {
          if (event.isComposing) return;
          if (event.key === 'Escape') {
            if (!nativeSearch) { event.preventDefault(); closeSearch(); }
            return;
          }
          const links = [...searchResults.querySelectorAll('a[href]')];
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!links.length || (document.activeElement !== searchInput && !links.includes(document.activeElement))) return;
            event.preventDefault();
            const index = links.indexOf(document.activeElement);
            const target = event.key === 'ArrowDown' ? links[index + 1] : (index === -1 ? links.at(-1) : links[index - 1]);
            (target || searchInput).focus({ preventScroll: true });
            target?.scrollIntoView({ block: 'nearest' });
          } else if (event.key === 'Enter' && document.activeElement === searchInput && links.length) {
            event.preventDefault();
            links[0].click();
          } else if (event.key === 'Tab' && !nativeSearch) {
            const focusable = [...searchModal.querySelectorAll('input,button,a[href]')];
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        });
        document.addEventListener('keydown', event => {
          if (event.isComposing || event.defaultPrevented || event.altKey || event.target.closest('input,textarea,select,[contenteditable],dialog[open]')) return;
          if ((event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !event.metaKey && !event.ctrlKey)) {
            event.preventDefault();
            void openSearch();
          }
          if (!nativeSearch && event.key === 'Escape') closeSearch();
        });
        swup?.hooks.on('visit:start', () => {
          closeReaderMenu();
          closeSearch(true);
          motion?.cancelWithin(document.body);
          document.querySelectorAll('.reader-dialog[open]').forEach(dialog => dialog.close());
        });
      }

      function initPageFeatures(visit) {
        cleanupFunctions.forEach(fn => fn());
        cleanupFunctions = [];

        if (typeof hljs !== 'undefined') { hljs.highlightAll(); }
        const swupContainer = document.getElementById('swup');
        if (!swupContainer) return;
        syncReaderNavigation();
        window.CloudInkTheme?.setPalette(swupContainer.dataset.palette || document.documentElement.dataset.palette || 'ink');

        const images = document.querySelectorAll('.article-body img');
        const dialogs = new Set();
        cleanupFunctions.push(() => {
          for (const dialog of dialogs) if (dialog.open) dialog.close();
        });
        const showDialog = (content, label, trigger) => {
          const dialog = document.createElement('dialog');
          dialog.className = 'reader-dialog';
          dialog.setAttribute('aria-label', label);
          const close = document.createElement('button');
          close.className = 'reader-dialog-close';
          close.textContent = 'Close / 关闭';
          close.setAttribute('aria-label', '关闭预览');
          dialog.append(close, content);
          document.body.append(dialog);
          const overflow = document.body.style.overflow;
          const finish = () => {
            document.body.style.overflow = overflow;
            dialog.remove();
            dialogs.delete(dialog);
            if (trigger?.isConnected) trigger.focus({ preventScroll: true });
          };
          dialog.addEventListener('close', finish, { once: true });
          const requestClose = () => motion ? motion.closeDialog(dialog) : dialog.close();
          close.addEventListener('click', requestClose);
          dialog.addEventListener('click', e => { if (e.target === dialog) requestClose(); });
          document.body.style.overflow = 'hidden';
          if (motion) motion.openDialog(dialog);
          else dialog.showModal();
          close.focus();
          dialogs.add(dialog);
        };
        images.forEach(img => {
          // Linked images retain their author's link action.
          if (img.closest('a,button')) return;
          img.tabIndex = 0;
          img.setAttribute('role', 'button');
          img.setAttribute('aria-label', 'Enlarge image / 放大图片' + (img.alt ? ': ' + img.alt : ''));
          const open = () => {
            const clone = document.createElement('img');
            clone.src = img.currentSrc || img.src;
            clone.alt = img.alt;
            showDialog(clone, img.alt || 'Image preview / 图片预览', img);
          };
          img.addEventListener('click', open);
          img.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
          });
          cleanupFunctions.push(() => img.removeEventListener('click', open));
        });
        document.querySelectorAll('.article-body pre').forEach(pre => {
          pre.tabIndex = 0;
          pre.setAttribute('aria-label', 'Code block, scroll horizontally / 代码块，可横向滚动');
          if (pre.parentElement.classList.contains('code-block')) return;
          const wrapper = document.createElement('div');
          wrapper.className = 'code-block';
          pre.before(wrapper);
          wrapper.append(pre);
          const button = document.createElement('button');
          button.className = 'copy-code';
          button.textContent = 'Copy / 复制';
          const feedback = document.createElement('span');
          feedback.className = 'copy-status';
          feedback.setAttribute('role', 'status');
          wrapper.prepend(button, feedback);
          button.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent);
              feedback.textContent = 'Copied / 已复制';
            } catch {
              feedback.textContent = 'Select code to copy / 请选中代码复制';
            }
          });
        });
        document.querySelectorAll('.article-body table').forEach(table => {
          table.tabIndex = 0;
          table.setAttribute('aria-label', 'Table, scroll horizontally / 表格，可横向滚动');
        });
        const copyLink = document.getElementById('copy-link');
        copyLink?.addEventListener('click', async () => {
          const status = document.getElementById('share-status');
          try {
            const url = new URL(location.pathname, location.origin).href;
            await navigator.clipboard.writeText(url);
            status.textContent = 'Link copied / 链接已复制';
          } catch { status.textContent = 'Copy the address from your browser / 请复制浏览器地址栏链接'; }
        });
      
      const shareBtn = document.getElementById('share-btn');
      if (shareBtn) {
        shareBtn.addEventListener('click', () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const palette = getComputedStyle(document.documentElement);
          const fontStack = palette.getPropertyValue('--font-body').trim();
          const segmenter = new Intl.Segmenter(navigator.language || 'zh-CN', { granularity: 'word' });
          
          function getLines(text, font, maxWidth) {
             ctx.font = font;
             const words = Array.from(segmenter.segment(text)).map(s => s.segment);
             let lines = [];
             let currentLine = '';
             for (let n = 0; n < words.length; n++) {
                 const testLine = currentLine + words[n];
                 if (ctx.measureText(testLine).width > maxWidth && n > 0) {
                     lines.push(currentLine);
                     currentLine = words[n];
                 } else {
                     currentLine = testLine;
                 }
             }
             if (currentLine) lines.push(currentLine);
             return lines;
          }

          const title = document.querySelector('article h1').innerText;
          const titleFont = `bold 56px ${fontStack}`;
          const titleLines = getLines(title, titleFont, 600);
          
          const desc = document.querySelector('article p.meta')?.innerText ||
            document.querySelector('meta[name="description"]')?.content || '';
          const descFont = `bold 32px ${fontStack}`;
          const descLines = desc ? getLines(desc, descFont, 600) : [];
          
          const paragraphs = Array.from(document.querySelectorAll('article p:not(.meta)'));
          let bodyText = paragraphs.map(p => p.innerText).join(' ').replace(/\s+/g, ' ').trim();
          if (bodyText.length > 100) bodyText = bodyText.substring(0, 100) + '......';
          const bodyFont = `26px ${fontStack}`;
          const bodyLines = bodyText ? getLines(bodyText, bodyFont, 600) : [];
          
          let contentHeight = 140; 
          contentHeight += titleLines.length * 76;
          contentHeight += 20; 
          
          if (descLines.length > 0) {
              contentHeight += descLines.length * 48;
              contentHeight += 40;
          }
          
          if (bodyLines.length > 0) {
              contentHeight += bodyLines.length * 42;
              contentHeight += 60;
          }
          
          const footerHeight = 160;
          const height = contentHeight + footerHeight;
          const width = 800;
          
          canvas.width = width * 2;
          canvas.height = height * 2;
          canvas.style.width = width + 'px';
          canvas.style.height = height + 'px';
          ctx.scale(2, 2);

          ctx.fillStyle = palette.getPropertyValue('--bg').trim();
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = palette.getPropertyValue('--accent').trim();
          ctx.fillRect(64, 96, 3, height - 192);

          let drawY = 140;
          
          ctx.fillStyle = palette.getPropertyValue('--text').trim();
          ctx.font = titleFont;
          for (let line of titleLines) {
              ctx.fillText(line, 100, drawY);
              drawY += 76;
          }
          drawY += 20;
          
          if (descLines.length > 0) {
              ctx.fillStyle = palette.getPropertyValue('--accent').trim();
              ctx.font = descFont;
              for (let line of descLines) {
                  ctx.fillText(line, 100, drawY);
                  drawY += 48;
              }
              drawY += 40;
          }
          
          if (bodyLines.length > 0) {
              ctx.fillStyle = palette.getPropertyValue('--muted').trim();
              ctx.font = bodyFont;
              for (let line of bodyLines) {
                  ctx.fillText(line, 100, drawY);
                  drawY += 42;
              }
              drawY += 60;
          }
          
          const siteName = document.querySelector('.site-brand .site-title, .site-brand h1')?.innerText || document.title;
          const domain = window.location.host + window.location.pathname;
          
          ctx.fillStyle = palette.getPropertyValue('--border').trim();
          ctx.fillRect(100, height - 150, 600, 2);

          ctx.font = `bold 28px ${fontStack}`;
          ctx.fillStyle = palette.getPropertyValue('--text').trim();
          ctx.fillText(siteName, 100, height - 100);
          
          ctx.font = `italic 24px ${fontStack}`;
          ctx.fillStyle = palette.getPropertyValue('--muted').trim();
          ctx.fillText(domain, 100, height - 60);

          const dataUrl = canvas.toDataURL('image/png');
          
          const content = document.createElement('div');
          const imgElement = document.createElement('img');
          imgElement.src = dataUrl;
          imgElement.alt = title + ' — share card';
          const download = document.createElement('a');
          download.href = dataUrl;
          download.download = 'cloudink-share.png';
          download.className = 'share-download';
          download.textContent = 'Download image / 下载分享图片';
          content.append(imgElement, download);
          showDialog(content, 'Share card / 分享卡片', shareBtn);
        });
      }
      
      const article = document.querySelector('.article-shell article');
      if (article) {
        const headings = article.querySelectorAll('.article-body h2, .article-body h3, .article-body h4');
        if (headings.length > 0) {
          const tocContainer = document.createElement('nav');
          tocContainer.className = 'toc-container';
          tocContainer.id = 'article-contents';
          tocContainer.setAttribute('aria-label', '文章目录');
          
          const tocTitle = document.createElement('div');
          tocTitle.className = 'toc-title';
          tocTitle.innerText = '这篇文章';
          tocContainer.appendChild(tocTitle);
          
          const headingSet = new Set(headings);
          const usedIds = new Set([...document.querySelectorAll('[id]')].filter(node => !headingSet.has(node)).map(node => node.id));
          headings.forEach((heading, index) => {
            let id = heading.id || heading.innerText.trim().replace(/\s+/g, '-').replace(/[^\w\u3400-\u9fff\-]+/g, '').toLowerCase() || 'heading-' + index;
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
          
          (article.parentElement.querySelector('.reader-toc-slot') || article.parentElement).appendChild(tocContainer);
          cleanupFunctions.push(() => tocContainer.remove());

          // Mobile TOC Button & Drawer Logic
          const mobileTocBtn = document.createElement('button');
          mobileTocBtn.className = 'mobile-toc-btn';
          mobileTocBtn.setAttribute('aria-label', 'Article contents');
          mobileTocBtn.setAttribute('aria-controls', 'article-contents');
          mobileTocBtn.setAttribute('aria-expanded', 'false');
          mobileTocBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"/></svg>';
          document.body.appendChild(mobileTocBtn);
          cleanupFunctions.push(() => mobileTocBtn.remove());

          const tocDrawerOverlay = document.createElement('div');
          tocDrawerOverlay.className = 'zoom-overlay';
          tocDrawerOverlay.style.zIndex = '998';
          document.body.appendChild(tocDrawerOverlay);
          cleanupFunctions.push(() => tocDrawerOverlay.remove());

          const narrowToc = matchMedia('(max-width: 1099px)');
          let tocOverflow = null;
          let tocBackground = [];
          const tocClose = document.createElement('button');
          tocClose.className = 'toc-close';
          tocClose.textContent = 'Close / 关闭目录';
          tocContainer.append(tocClose);
          const syncToc = () => {
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
          const resizeToc = () => { closeTocDrawer(); syncToc(); };
          narrowToc.addEventListener('change', resizeToc);
          cleanupFunctions.push(() => {
            narrowToc.removeEventListener('change', resizeToc);
            closeTocDrawer();
            closeArticleContents = null;
          });
          tocClose.addEventListener('click', () => { closeTocDrawer(); mobileTocBtn.focus(); });
          function closeTocDrawer() {
             if (tocOverflow !== null) document.body.style.overflow = tocOverflow;
             tocOverflow = null;
             for (const [node, inert] of tocBackground) node.inert = inert;
             tocBackground = [];
             tocContainer.classList.remove('drawer-open');
             mobileTocBtn.setAttribute('aria-expanded', 'false');
             tocDrawerOverlay.classList.remove('active');
             syncToc();
          }

          closeArticleContents = closeTocDrawer;
          mobileTocBtn.addEventListener('click', () => {
            if (tocContainer.classList.contains('drawer-open')) {
              closeTocDrawer();
            } else {
              tocOverflow = document.body.style.overflow;
              tocBackground = [article, document.querySelector('.site-header'), document.querySelector('.site-footer')].filter(Boolean).map(node => [node, node.inert]);
              for (const [node] of tocBackground) node.inert = true;
              document.body.style.overflow = 'hidden';
              tocContainer.classList.add('drawer-open');
              syncToc();
              mobileTocBtn.setAttribute('aria-expanded', 'true');
              tocDrawerOverlay.classList.add('active');
              tocContainer.querySelector('a')?.focus({ preventScroll: true });
            }
          });

          tocDrawerOverlay.addEventListener('click', () => { closeTocDrawer(); mobileTocBtn.focus(); });
          const tocKeyboard = e => {
            if (e.isComposing) return;
            if (e.key === 'Tab' && tocContainer.classList.contains('drawer-open')) {
              const first = tocContainer.querySelector('a'), last = tocClose;
              if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
              else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
            if (e.key === 'Escape' && tocContainer.classList.contains('drawer-open')) {
              closeTocDrawer();
              mobileTocBtn.focus();
            }
          };
          document.addEventListener('keydown', tocKeyboard);
          cleanupFunctions.push(() => document.removeEventListener('keydown', tocKeyboard));

          // Cache heading positions when layout changes; scroll frames only search the cache.
          const tocLinks = Array.from(tocContainer.querySelectorAll('.toc-link'));
          const headingEls = Array.from(headings);
          let activeIndex = -1, tocFrame = 0, measurePending = true;
          const offsets = new Float64Array(headingEls.length);
          const updateToc = () => {
            tocFrame = 0;
            if (!tocContainer.isConnected) return;
            if (measurePending) {
              for (let i = 0; i < headingEls.length; i++) offsets[i] = headingEls[i].getBoundingClientRect().top + scrollY;
              measurePending = false;
            }
            let low = 0, high = offsets.length - 1;
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
              const containerRect = tocContainer.getBoundingClientRect(), linkRect = link.getBoundingClientRect();
              if (linkRect.top < containerRect.top + 20) tocContainer.scrollTop -= containerRect.top + 20 - linkRect.top;
              else if (linkRect.bottom > containerRect.bottom - 20) tocContainer.scrollTop += linkRect.bottom - containerRect.bottom + 20;
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
          document.fonts?.ready.then(() => { if (tocContainer.isConnected) queueToc(true); });
          cleanupFunctions.push(() => {
            cancelAnimationFrame(tocFrame);
            observer?.disconnect();
            article.removeEventListener('load', onResize, true);
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onResize);
          });
          tocLinks.forEach((link, index) => link.addEventListener('click', () => {
            closeTocDrawer();
            headingEls[index].focus({ preventScroll: true });
          }));
          queueToc(true);
          // Generated heading IDs must also resolve on an initial or cross-page deep link.
          if (location.hash && !visit?.history?.popstate) {
            let target;
            try { target = headingEls.find(heading => heading.id === decodeURIComponent(location.hash.slice(1))); } catch {}
            if (target) requestAnimationFrame(() => {
              if (target.isConnected) target.scrollIntoView({ behavior: 'instant', block: 'start' });
            });
          }

        }
      }
      } // end initPageFeatures

      initPageFeatures();
      const initialHome = document.querySelector('.home-layout');
      if (initialHome) motion?.enter(initialHome, { kind: 'content' });
      swup?.hooks.on('page:view', visit => {
        initPageFeatures(visit);
        if (!visit.history.popstate) document.getElementById('swup')?.focus({ preventScroll: true });
      });
    });
