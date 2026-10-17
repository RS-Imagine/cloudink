document.addEventListener('DOMContentLoaded', () => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const swup = typeof Swup === 'function' ? new Swup({
        animationSelector: reducedMotion.matches ? false : '[class*="transition-"]'
      }) : null;
      reducedMotion.addEventListener('change', () => {
        if (swup) swup.options.animationSelector = reducedMotion.matches ? false : '[class*="transition-"]';
      });
      window.swup = swup;
      let cleanupFunctions = [];
      
      const themeToggleBtn = document.getElementById('theme-toggle-btn');
      if (themeToggleBtn) {
        const updateHljsTheme = (theme) => {
          const hljsLight = document.getElementById('hljs-light');
          const hljsDark  = document.getElementById('hljs-dark');
          if (hljsLight && hljsDark) {
            hljsLight.media = theme === 'dark' ? 'none' : 'all';
            hljsDark.media  = theme === 'dark' ? 'all'  : 'none';
          }
        };

        // hljs initial sync is handled by the blocking head script

        themeToggleBtn.addEventListener('click', () => {
          const currentTheme = document.documentElement.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
          const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', newTheme);
          try { localStorage.setItem('theme', newTheme); } catch { /* Storage may be disabled. */ }
          updateHljsTheme(newTheme);
        });
      }

      const searchBtn = document.getElementById('site-search-btn');
      const searchModal = document.getElementById('search-modal');
      const searchInput = document.getElementById('search-input');
      const searchResults = document.getElementById('search-results');
      let searchIndex = null;

      if (searchBtn && searchModal) {
        const closeSearch = () => {
          searchModal.classList.remove('active');
          searchModal.setAttribute('aria-hidden', 'true');
          searchModal.inert = true;
          document.body.style.overflow = '';
          searchBtn.focus();
        };

        const openSearch = async () => {
          searchModal.inert = false;
          searchModal.setAttribute('aria-hidden', 'false');
          searchModal.classList.add('active');
          document.body.style.overflow = 'hidden';
          requestAnimationFrame(() => {
            if (searchModal.classList.contains('active')) searchInput.focus();
          });
          
          if (!searchIndex) {
            try {
              const res = await fetch('/search_index.json');
              if (!res.ok) throw new Error('Search index unavailable');
              searchIndex = await res.json();
              // A reader may type before the first index download finishes.
              searchInput.dispatchEvent(new Event('input'));
            } catch (e) {
              const notice = document.createElement('li');
              notice.className = 'search-result-item';
              notice.textContent = 'Search is temporarily unavailable. Please try again.';
              searchResults.replaceChildren(notice);
            }
          }
        };

        searchBtn.addEventListener('click', openSearch);
        searchResults.addEventListener('click', (event) => {
          if (event.target.closest('a[href]')) closeSearch();
        });
        document.getElementById('search-close')?.addEventListener('click', closeSearch);
        swup?.hooks.on('visit:start', () => {
          if (searchModal.classList.contains('active')) closeSearch();
        });
        searchModal.addEventListener('keydown', (event) => {
          if (event.key !== 'Tab') return;
          const focusable = [...searchModal.querySelectorAll('input,button,a[href]')];
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });
        
        searchModal.addEventListener('click', (e) => {
          if (e.target === searchModal) closeSearch();
        });
        
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && searchModal.classList.contains('active')) {
            closeSearch();
          }
        });

        searchInput.addEventListener('input', (e) => {
          const query = e.target.value.trim().toLowerCase();
          searchResults.innerHTML = '';
          
          if (!query || !searchIndex) return;
          
          const results = searchIndex.filter(post => 
            post.title.toLowerCase().includes(query) ||
            post.description.toLowerCase().includes(query) ||
            post.body.toLowerCase().includes(query)
          ).slice(0, 10);
          
          if (results.length === 0) {
            searchResults.innerHTML = '<li style="padding: 16px 20px; color: var(--muted);">No results found.</li>';
            return;
          }
          
          results.forEach(post => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.className = 'search-result-item';
            a.href = `/posts/${post.slug}/`;
            
            const title = document.createElement('div');
            title.className = 'search-result-title';
            title.textContent = post.title;
            
            let excerptText = post.description;
            const bodyLower = post.body.toLowerCase();
            const matchIndex = bodyLower.indexOf(query);
            
            if (matchIndex !== -1 && !post.description.toLowerCase().includes(query) && !post.title.toLowerCase().includes(query)) {
              const start = Math.max(0, matchIndex - 40);
              const end = Math.min(post.body.length, matchIndex + query.length + 40);
              excerptText = (start > 0 ? '...' : '') + post.body.substring(start, end) + (end < post.body.length ? '...' : '');
            }
            
            const excerpt = document.createElement('div');
            excerpt.className = 'search-result-excerpt';
            
            // Highlight query
            const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            // Titles and Markdown excerpts are text, including raw HTML. Build
            // highlight nodes without interpreting an author's text as markup.
            const highlight = (node, text) => {
              let start = 0;
              for (const match of text.matchAll(regex)) {
                node.append(document.createTextNode(text.slice(start, match.index)));
                const mark = document.createElement('mark');mark.textContent = match[0];node.append(mark);
                start = match.index + match[0].length;
              }
              node.append(document.createTextNode(text.slice(start)));
            };
            title.replaceChildren();highlight(excerpt, excerptText);highlight(title, post.title);
            
            a.appendChild(title);
            a.appendChild(excerpt);
            li.appendChild(a);
            searchResults.appendChild(li);
          });
        });
      }
      
      function initPageFeatures() {
        cleanupFunctions.forEach(fn => fn());
        cleanupFunctions = [];

        if (typeof hljs !== 'undefined') { hljs.highlightAll(); }
        const swupContainer = document.getElementById('swup');
        if (!swupContainer) return;

        const images = document.querySelectorAll('.article-body img');
        const showDialog = (content, label, trigger) => {
          const dialog = document.createElement('dialog');
          dialog.className = 'reader-dialog';
          dialog.setAttribute('aria-label', label);
          const close = document.createElement('button');
          close.className = 'reader-dialog-close';
          close.textContent = 'Close / 关闭';
          close.setAttribute('aria-label', 'Close image / 关闭图片');
          dialog.append(close, content);
          document.body.append(dialog);
          const overflow = document.body.style.overflow;
          const finish = () => {
            document.body.style.overflow = overflow;
            dialog.remove();
            if (trigger?.isConnected) trigger.focus({ preventScroll: true });
          };
          dialog.addEventListener('close', finish, { once: true });
          close.addEventListener('click', () => dialog.close());
          dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
          document.body.style.overflow = 'hidden';
          dialog.showModal();
          close.focus();
          cleanupFunctions.push(() => { if (dialog.open) dialog.close(); });
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
          
          const siteName = document.querySelector('.site-brand h1').innerText;
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
        const headings = article.querySelectorAll('h2, h3, h4');
        if (headings.length > 0) {
          const tocContainer = document.createElement('div');
          tocContainer.className = 'toc-container';
          tocContainer.id = 'article-contents';
          tocContainer.setAttribute('aria-label', 'Article contents');
          
          const tocTitle = document.createElement('div');
          tocTitle.className = 'toc-title';
          tocTitle.innerText = 'Contents';
          tocContainer.appendChild(tocTitle);
          
          headings.forEach((heading, index) => {
            let id = heading.id;
            if (!id) {
                id = heading.innerText.replace(/[\s]+/g, '-').replace(/[^\w\u4e00-\u9fa5\-]+/g, '').toLowerCase();
                if (!id) id = 'heading-' + index;
                const base = id;
                let suffix = 2;
                while (document.getElementById(id)) id = base + '-' + suffix++;
                heading.id = id;
            }
            
            const link = document.createElement('a');
            link.href = '#' + encodeURIComponent(id);
            link.className = 'toc-link toc-level-' + heading.tagName.charAt(1);
            link.innerText = heading.innerText;
            tocContainer.appendChild(link);
          });
          
          document.body.appendChild(tocContainer);
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

          const narrowToc = matchMedia('(max-width: 1300px)');
          let tocOverflow = null;
          const tocClose = document.createElement('button');
          tocClose.className = 'toc-close';
          tocClose.textContent = 'Close / 关闭目录';
          tocContainer.append(tocClose);
          const syncToc = () => { tocContainer.inert = narrowToc.matches && !tocContainer.classList.contains('drawer-open'); };
          syncToc();
          const resizeToc = () => { closeTocDrawer(); syncToc(); };
          narrowToc.addEventListener('change', resizeToc);
          cleanupFunctions.push(() => {
            narrowToc.removeEventListener('change', resizeToc);
            if (tocOverflow !== null) document.body.style.overflow = tocOverflow;
          });
          tocClose.addEventListener('click', () => { closeTocDrawer(); mobileTocBtn.focus(); });
          function closeTocDrawer() {
             if (tocOverflow !== null) document.body.style.overflow = tocOverflow;
             tocOverflow = null;
             tocContainer.classList.remove('drawer-open');
             mobileTocBtn.setAttribute('aria-expanded', 'false');
             tocDrawerOverlay.classList.remove('active');
             syncToc();
          }

          mobileTocBtn.addEventListener('click', () => {
            if (tocContainer.classList.contains('drawer-open')) {
              closeTocDrawer();
            } else {
              tocOverflow = document.body.style.overflow;
              document.body.style.overflow = 'hidden';
              tocContainer.classList.add('drawer-open');
              syncToc();
              mobileTocBtn.setAttribute('aria-expanded', 'true');
              tocDrawerOverlay.classList.add('active');
              tocContainer.querySelector('a')?.focus({ preventScroll: true });
            }
          });

          tocDrawerOverlay.addEventListener('click', closeTocDrawer);
          const tocKeyboard = e => {
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

          // Highlight active TOC entry on scroll
          const tocLinks = tocContainer.querySelectorAll('.toc-link');
          tocLinks.forEach(l => l.addEventListener('click', closeTocDrawer));
          const headingEls = Array.from(headings);

          function setActive(id) {
            tocLinks.forEach(l => {
              if (l.getAttribute('href') === '#' + encodeURIComponent(id)) {
                l.classList.add('toc-active');
                // Scroll the TOC so the active item stays visible
                const containerRect = tocContainer.getBoundingClientRect();
                const linkRect = l.getBoundingClientRect();
                if (linkRect.top < containerRect.top + 20) {
                  tocContainer.scrollTop -= (containerRect.top + 20 - linkRect.top);
                } else if (linkRect.bottom > containerRect.bottom - 20) {
                  tocContainer.scrollTop += (linkRect.bottom - containerRect.bottom + 20);
                }
              } else {
                l.classList.remove('toc-active');
              }
            });
          }

          const observer = new IntersectionObserver(
            (entries) => {
              // Find the topmost heading that is intersecting or has passed
              let best = null;
              let bestTop = Infinity;
              entries.forEach(entry => {
                if (entry.isIntersecting) {
                  const top = entry.boundingClientRect.top;
                  if (top < bestTop) {
                    bestTop = top;
                    best = entry.target;
                  }
                }
              });
              if (best) {
                setActive(best.id);
              }
            },
            {
              rootMargin: '0px 0px -60% 0px',
              threshold: 0,
            }
          );

          headingEls.forEach(h => observer.observe(h));
          cleanupFunctions.push(() => observer.disconnect());

          // Fallback: on scroll, find the heading closest to viewport top
          let ticking = false;
          const tocScrollHandler = () => {
            if (!ticking) {
              requestAnimationFrame(() => {
                const scrollY = window.scrollY + 100;
                let active = headingEls[0];
                for (const h of headingEls) {
                  if (h.offsetTop <= scrollY) active = h;
                  else break;
                }
                if (active) setActive(active.id);
                ticking = false;
              });
              ticking = true;
            }
          };
          window.addEventListener('scroll', tocScrollHandler);
          cleanupFunctions.push(() => window.removeEventListener('scroll', tocScrollHandler));

          // Set initial active on load
          if (headingEls[0]) setActive(headingEls[0].id);
        }
      }
      } // end initPageFeatures

      initPageFeatures();
      swup?.hooks.on('page:view', initPageFeatures);
    });
