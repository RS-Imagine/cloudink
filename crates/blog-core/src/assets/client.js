document.addEventListener('DOMContentLoaded', () => {
      const swup = new Swup({
        animationSelector: '[class*="transition-"]'
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
          searchInput.blur();
        };

        const openSearch = async () => {
          searchModal.classList.add('active');
          searchInput.focus();
          
          if (!searchIndex) {
            try {
              const res = await fetch('/search_index.json');
              searchIndex = await res.json();
              // A reader may type before the first index download finishes.
              searchInput.dispatchEvent(new Event('input'));
            } catch (e) {
              console.error('Failed to load search index:', e);
            }
          }
        };

        searchBtn.addEventListener('click', openSearch);
        
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

        const images = document.querySelectorAll('article img');
        let currentZoomedOverlay = null;

        function openZoom(img) {
          if (currentZoomedOverlay) return;
          const ov = document.createElement('div');
          ov.className = 'zoom-overlay active';
          ov.style.display = 'flex';
          ov.style.alignItems = 'center';
          ov.style.justifyContent = 'center';
          ov.style.cursor = 'zoom-out';
          
          const clone = document.createElement('img');
          clone.src = img.src;
          clone.alt = img.alt;
          clone.style.maxWidth = '90vw';
          clone.style.maxHeight = '90vh';
          clone.style.objectFit = 'contain';
          clone.style.borderRadius = '12px';
          clone.style.boxShadow = '0 32px 80px rgba(0,0,0,0.5)';
          clone.style.cursor = 'zoom-out';
          clone.style.opacity = '0';
          clone.style.transform = 'scale(0.92)';
          clone.style.transition = 'opacity 0.3s ease, transform 0.3s cubic-bezier(0.4,0,0.2,1)';
          
          ov.appendChild(clone);
          document.body.appendChild(ov);
          currentZoomedOverlay = ov;
          cleanupFunctions.push(() => { if (currentZoomedOverlay) { currentZoomedOverlay.remove(); currentZoomedOverlay = null; } });
          
          // Animate in
          requestAnimationFrame(() => {
            clone.style.opacity = '1';
            clone.style.transform = 'scale(1)';
          });
          
          function closeZoom() {
            clone.style.opacity = '0';
            clone.style.transform = 'scale(0.92)';
            setTimeout(() => {
              ov.remove();
              if (currentZoomedOverlay === ov) currentZoomedOverlay = null;
            }, 300);
          }
          
          ov.addEventListener('click', closeZoom);
        }

        images.forEach(img => {
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', () => openZoom(img));
        });

      
      const shareBtn = document.getElementById('share-btn');
      if (shareBtn) {
        shareBtn.addEventListener('click', () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const fontStack = "'Times New Roman', 'Noto Serif SC', 'Songti SC', serif";
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

          const isDark = document.documentElement.getAttribute('data-theme') === 'dark' || (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
          ctx.fillStyle = isDark ? '#2C201A' : '#DDD6C1';
          ctx.fillRect(0, 0, width, height);

          ctx.fillStyle = isDark ? 'rgba(229, 160, 128, 0.09)' : 'rgba(128, 80, 48, 0.09)';
          ctx.beginPath();
          ctx.arc(0, 0, 300, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.fillStyle = isDark ? 'rgba(229, 160, 128, 0.06)' : 'rgba(128, 80, 48, 0.06)';
          ctx.beginPath();
          ctx.arc(width, 0, 400, 0, Math.PI * 2);
          ctx.fill();
          
          let drawY = 140;
          
          ctx.fillStyle = isDark ? '#F0E6D8' : '#502010';
          ctx.font = titleFont;
          for (let line of titleLines) {
              ctx.fillText(line, 100, drawY);
              drawY += 76;
          }
          drawY += 20;
          
          if (descLines.length > 0) {
              ctx.fillStyle = isDark ? '#E5A080' : '#805030';
              ctx.font = descFont;
              for (let line of descLines) {
                  ctx.fillText(line, 100, drawY);
                  drawY += 48;
              }
              drawY += 40;
          }
          
          if (bodyLines.length > 0) {
              ctx.fillStyle = isDark ? '#B8A89A' : '#807565';
              ctx.font = bodyFont;
              for (let line of bodyLines) {
                  ctx.fillText(line, 100, drawY);
                  drawY += 42;
              }
              drawY += 60;
          }
          
          const siteName = document.querySelector('.site-brand h1').innerText;
          const domain = window.location.host + window.location.pathname;
          
          ctx.fillStyle = isDark ? '#5A453A' : '#C4BCA8';
          ctx.fillRect(100, height - 150, 600, 2);

          ctx.font = `bold 28px ${fontStack}`;
          ctx.fillStyle = isDark ? '#F0E6D8' : '#502010';
          ctx.fillText(siteName, 100, height - 100);
          
          ctx.font = `italic 24px ${fontStack}`;
          ctx.fillStyle = isDark ? '#B8A89A' : '#807565';
          ctx.fillText(domain, 100, height - 60);

          const dataUrl = canvas.toDataURL('image/png');
          
          const cardOverlay = document.createElement('div');
          cardOverlay.className = 'zoom-overlay active';
          cardOverlay.style.display = 'flex';
          cardOverlay.style.flexDirection = 'column';
          cardOverlay.style.alignItems = 'center';
          cardOverlay.style.justifyContent = 'center';
          
          const imgElement = document.createElement('img');
          imgElement.src = dataUrl;
          imgElement.style.maxWidth = '85%';
          imgElement.style.maxHeight = '75vh';
          imgElement.style.borderRadius = '16px';
          imgElement.style.boxShadow = 'var(--shadow-strong)';
          
          const tip = document.createElement('p');
          tip.innerText = '长按或右键保存图片 (Long press or right click to save)';
          tip.style.color = 'var(--text)';
          tip.style.marginTop = '20px';
          tip.style.background = 'var(--paper)';
          tip.style.padding = '8px 16px';
          tip.style.borderRadius = '8px';
          tip.style.fontSize = '0.9rem';
          
          cardOverlay.appendChild(imgElement);
          cardOverlay.appendChild(tip);
          document.body.appendChild(cardOverlay);
          cleanupFunctions.push(() => cardOverlay.remove());
          
          cardOverlay.addEventListener('click', (e) => {
              if(e.target === cardOverlay) {
                  cardOverlay.remove();
              }
          });
        });
      }
      
      const article = document.querySelector('.article-shell article');
      if (article) {
        const headings = article.querySelectorAll('h2, h3, h4');
        if (headings.length > 0) {
          const tocContainer = document.createElement('div');
          tocContainer.className = 'toc-container';
          
          const tocTitle = document.createElement('div');
          tocTitle.className = 'toc-title';
          tocTitle.innerText = 'Contents';
          tocContainer.appendChild(tocTitle);
          
          headings.forEach((heading, index) => {
            let id = heading.id;
            if (!id) {
                id = heading.innerText.replace(/[\s]+/g, '-').replace(/[^\w\u4e00-\u9fa5\-]+/g, '').toLowerCase();
                if (!id) id = 'heading-' + index;
                heading.id = id;
            }
            
            const link = document.createElement('a');
            link.href = '#' + id;
            link.className = 'toc-link toc-level-' + heading.tagName.charAt(1);
            link.innerText = heading.innerText;
            tocContainer.appendChild(link);
          });
          
          document.body.appendChild(tocContainer);
          cleanupFunctions.push(() => tocContainer.remove());

          // Mobile TOC Button & Drawer Logic
          const mobileTocBtn = document.createElement('button');
          mobileTocBtn.className = 'mobile-toc-btn';
          mobileTocBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"/></svg>';
          document.body.appendChild(mobileTocBtn);
          cleanupFunctions.push(() => mobileTocBtn.remove());

          const tocDrawerOverlay = document.createElement('div');
          tocDrawerOverlay.className = 'zoom-overlay';
          tocDrawerOverlay.style.zIndex = '998';
          document.body.appendChild(tocDrawerOverlay);
          cleanupFunctions.push(() => tocDrawerOverlay.remove());

          function closeTocDrawer() {
             tocContainer.classList.remove('drawer-open');
             tocDrawerOverlay.classList.remove('active');
          }

          mobileTocBtn.addEventListener('click', () => {
            if (tocContainer.classList.contains('drawer-open')) {
              closeTocDrawer();
            } else {
              tocContainer.classList.add('drawer-open');
              tocDrawerOverlay.classList.add('active');
            }
          });

          tocDrawerOverlay.addEventListener('click', closeTocDrawer);

          // Highlight active TOC entry on scroll
          const tocLinks = tocContainer.querySelectorAll('.toc-link');
          tocLinks.forEach(l => l.addEventListener('click', closeTocDrawer));
          const headingEls = Array.from(headings);

          function setActive(id) {
            tocLinks.forEach(l => {
              if (l.getAttribute('href') === '#' + id) {
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
      swup.hooks.on('page:view', initPageFeatures);
    });
