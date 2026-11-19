import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import init, { render_release } from '../../cloud-admin/ui/wasm/blog_wasm.js';

export async function verifyReaderTypography(browser, origin, output, engine) {
  await init({
    module_or_path: await readFile(
      new URL('../../cloud-admin/ui/wasm/blog_wasm_bg.wasm', import.meta.url),
    ),
  });
  const prose =
    '# 内容一级\n\n## 内容二级\n\n### 内容三级\n\n#### 内容四级\n\n##### 内容五级\n\n###### 内容六级\n\n中英文阅读 Typography，包含 **强调**、*斜体* 和 `inline_code`。\n\n```rust\nlet text = "Cloudink";\n```';
  const posterTitle = '一个傍晚，旧书店门口听雷雨的人';
  const typography =
    prose +
    '\n\n> 一段引用。*署名保留强调。*\n\n| 按键 | 动作 |\n| --- | --- |\n| Super + T | ' +
    'VeryLongValue'.repeat(16) +
    ' |\n\n| 名称 | 值 |\n| --- | --- |\n| 小表 | 正常 |\n\n' +
    '```text\n' +
    'long-command'.repeat(17) +
    '\n```';
  const pages = {
    '/': '.featured-article h2,.feature-summary,.blog-post h3,.blog-post .post-copy > p,.reader-welcome h1,.blog-note p,.author-intro,.author-sub',
    '/post/': '.post-index h2',
    '/archive/': '.archive-group a',
    '/shorts/': '.short-body,.short-body p,.short-body :is(h1,h2,h3,h4,h5,h6)',
    '/about/':
      '.reader-page article > h1,.article-body,.article-body p,.article-body :is(h1,h2,h3,h4,h5,h6)',
    '/posts/font-primary/':
      '.article-headline h1,.article-deck,.article-body,.article-body p,.article-body :is(h1,h2,h3,h4,h5,h6),.related-story > span',
  };
  for (const font of ['default', 'serif', 'sans']) {
    const files = JSON.parse(
      render_release(
        JSON.stringify({
          schema_version: 1,
          id: 'reading-font-' + font,
          created_at: '2026-11-10',
          site: {
            title: 'Cloudink',
            author: '云砚',
            subtitle: '写技术，也写日常。',
            description: '保留阅读的节奏。',
            ...(font === 'default' ? {} : { readingFont: font }),
          },
          markdown_posts: Object.fromEntries(
            ['primary', 'second'].map((slug) => [
              'font-' + slug,
              '+++\ntitle = "' +
                (slug === 'primary' ? posterTitle : '中英文 Typography') +
                '"\nslug = "font-' +
                slug +
                '"\ndate = "2026-11-01"\ndescription = "摘要也遵循配置字体。"\n+++\n\n' +
                typography,
            ]),
          ),
          markdown_shorts: {
            note:
              '+++\nslug = "note"\ndate = "2026-11-01 12:00"\n+++\n\n' + (prose + '\n\n').repeat(3),
            swup: '+++\nslug = "swup"\ndate = "2026-10-30 12:00"\n+++\n\n一条有独立地址的短记。',
          },
          about_markdown:
            '+++\ntitle = "关于 Cloudink"\n+++\n\n' +
            prose +
            '\n\n写信到 hello@example.org，联系作者。',
        }),
      ),
    );
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      colorScheme: 'light',
      ...(engine === 'chromium' ? { isMobile: true, hasTouch: true } : {}),
    });
    try {
      await context.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ body: '' }));
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/search_index.json')
          return route.fulfill({
            contentType: 'application/json',
            body: files['search_index.json'],
          });
        if (url.origin !== origin || !Object.hasOwn(pages, url.pathname)) return route.fallback();
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: files[url.pathname === '/' ? 'index.html' : url.pathname.slice(1) + 'index.html'],
        });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const width of font === 'default' ? [390, 443, 1919] : [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [path, selector] of Object.entries(pages)) {
          await page.goto(origin + path);
          if (path === '/posts/font-primary/')
            await expect(page.locator('.related-story > span')).toHaveCount(1);
          await expect(page.locator('html')).toHaveAttribute(
            'data-reading-font',
            font === 'sans' ? 'sans' : 'serif',
          );
          await page.evaluate(() => document.fonts.ready);
          const mismatch = await page.evaluate(
            ({ selector, sans }) => {
              const probe = document.createElement('span');
              document.body.append(probe);
              const family = (variable) => {
                probe.style.fontFamily = 'var(' + variable + ')';
                return getComputedStyle(probe).fontFamily;
              };
              const reading = family(sans ? '--ci-font-ui' : '--ci-font-reading');
              const ui = family('--ci-font-ui');
              probe.remove();
              const differences = [];
              for (const rule of selector.split(/,(?![^()]*\))/)) {
                const nodes = [...document.querySelectorAll(rule)];
                if (!nodes.length) differences.push({ missing: rule });
                for (const node of nodes)
                  if (getComputedStyle(node).fontFamily !== reading)
                    differences.push({ rule, actual: getComputedStyle(node).fontFamily, reading });
              }
              for (const node of document.querySelectorAll(
                '.reader-side-nav a,.reader-dock a,.reader-tools button,.story-meta,.short-time,.archive-group time,.article-metadata,.plain-button',
              ))
                if (getComputedStyle(node).fontFamily !== ui)
                  differences.push({
                    ui: node.className,
                    actual: getComputedStyle(node).fontFamily,
                  });
              for (const node of document.querySelectorAll('.article-body code,.short-body code'))
                if (!getComputedStyle(node).fontFamily.includes('monospace'))
                  differences.push({ code: getComputedStyle(node).fontFamily });
              return differences;
            },
            { selector, sans: font === 'sans' },
          );
          assert.deepEqual(mismatch, [], engine + '/' + font + '/' + width + path);
          if (path === '/about/') {
            await expect(page.locator('.author-card a[href="/about/"]')).toHaveCount(0);
            await expect(page.getByRole('link', { name: 'hello@example.org' })).toHaveAttribute(
              'href',
              'mailto:hello@example.org',
            );
          }
          if (path === '/') {
            await page.locator('#site-search-btn').click();
            await page.locator('#search-input').fill('Typography');
            await expect(page.locator('.search-result-title')).toHaveCount(2);
            assert.ok(
              await page.evaluate(() => {
                const content = getComputedStyle(
                  document.querySelector('.featured-article h2'),
                ).fontFamily;
                return [
                  ...document.querySelectorAll('.search-result-title,.search-result-excerpt'),
                ].every((node) => getComputedStyle(node).fontFamily === content);
              }),
              'Search titles and excerpts must follow the reading preference',
            );
            await page.keyboard.press('Escape');
          }
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
            ),
            false,
          );
          if (font === 'default' && path === '/posts/font-primary/') {
            const article = page.locator('.reader-article article');
            await expect(article.locator('.article-back-row')).not.toContainText('文章阅读');
            await expect(article.locator('.article-end')).not.toContainText('感谢阅读');
            const controls = await article
              .locator('.article-back, .article-end .plain-button')
              .evaluateAll((buttons) =>
                buttons.map((button) => button.getBoundingClientRect().height),
              );
            assert.equal(controls.length, 3);
            assert.ok(
              controls.every((height) => height >= 44),
              JSON.stringify(controls),
            );
            const ratios = await article.evaluate((el) => {
              const style = (selector) => getComputedStyle(el.querySelector(selector));
              const body = parseFloat(style('.article-body').fontSize);
              return {
                quote: parseFloat(style('blockquote p').fontSize) / body,
                quoteStyle: style('blockquote p').fontStyle,
                quoteEmStyle: style('blockquote em').fontStyle,
                heading: parseFloat(style('.article-body h3').fontSize) / body,
                table: parseFloat(style('table').fontSize) / body,
                lead: parseFloat(style('.article-deck').fontSize) / body,
                key: style('kbd').fontFamily,
              };
            });
            assert.ok(
              Math.abs(ratios.quote - 0.9) < 0.01 &&
                ratios.quoteStyle === 'normal' &&
                ratios.quoteEmStyle === 'italic' &&
                ratios.heading >= 1.24 &&
                ratios.table < 1 &&
                ratios.lead >= 1.05 &&
                ratios.key.includes('monospace'),
              JSON.stringify(ratios),
            );
            const wideCode = article.locator('.code-block pre').last();
            await expect(wideCode).toHaveCSS('white-space', 'pre');
            for (const scroll of [wideCode, article.locator('.table-scroll').first()]) {
              const frame = scroll.locator('..');
              const more = () =>
                frame.evaluate((el) => getComputedStyle(el, '::after').content !== 'none');
              await expect.poll(more).toBe(width < 768);
              const end = await scroll.evaluate((el) => {
                el.scrollLeft = el.scrollWidth;
                return [el.scrollWidth - el.clientWidth, el.scrollLeft];
              });
              assert.ok(end[0] > 0 && Math.abs(end[0] - end[1]) < 2, JSON.stringify(end));
              await expect.poll(more).toBe(false);
              await scroll.evaluate((el) => (el.scrollLeft = 0));
              await expect.poll(more).toBe(width < 768);
            }
            assert.equal(
              await article
                .locator('.table-scroll')
                .last()
                .locator('..')
                .getAttribute('data-scroll-more'),
              null,
            );
          }
          if ((width === 390 || font === 'default') && path === '/posts/font-primary/') {
            await page.evaluate(() => {
              window.posterFonts = [];
              window.posterTitleLines = [];
              const fillText = CanvasRenderingContext2D.prototype.fillText;
              CanvasRenderingContext2D.prototype.fillText = function (...args) {
                window.posterFonts.push(this.font);
                if (this.font.includes('46px')) window.posterTitleLines.push(args[0]);
                return fillText.apply(this, args);
              };
            });
            await page.locator('#share-btn').click();
            await expect(page.locator('.share-dialog-content img')).toBeVisible();
            assert.ok(
              await page.evaluate(() => {
                const ctx = document.createElement('canvas').getContext('2d');
                ctx.font =
                  '600 46px ' +
                  getComputedStyle(document.querySelector('.article-headline h1')).fontFamily;
                return window.posterFonts.includes(ctx.font);
              }),
              'The share card must use the configured reading font',
            );
            const lines = await page.evaluate(() => window.posterTitleLines);
            assert.equal(lines.join(''), posterTitle);
            assert.ok(
              lines.every((line) => Array.from(line.matchAll(/\p{Script=Han}/gu)).length >= 2),
              lines,
            );
            if (lines.length > 1) assert.equal(lines[0], '一个傍晚，');
            await page.keyboard.press('Escape');
          }
          if (font !== 'sans' && ['/archive/', '/shorts/'].includes(path))
            await page.screenshot({
              path: resolve(
                output,
                'typography-' +
                  engine +
                  '-' +
                  font +
                  '-' +
                  width +
                  path.replaceAll('/', '-') +
                  '.png',
              ),
            });
        }
        // Navigation must retain the preference while replacing only the content columns.
        await page
          .locator(
            width < 768
              ? '.reader-dock [data-reader-nav="shorts"]'
              : '.reader-side-nav [data-reader-nav="shorts"]',
          )
          .click();
        await expect(page.locator('#reader-center-content')).toHaveAttribute('data-page', 'shorts');
        await expect(page.locator('html')).toHaveAttribute(
          'data-reading-font',
          font === 'sans' ? 'sans' : 'serif',
        );
      }
      if (font === 'default') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(origin + '/');
        const cardInsets = await page.locator('.blog-feed,.blog-notes').evaluateAll((cards) =>
          cards.map((card) => {
            const heading = card.querySelector('.blog-section-heading');
            const box = card.getBoundingClientRect();
            return [
              heading.querySelector('h2').getBoundingClientRect().left - box.left,
              box.right - heading.querySelector('a').getBoundingClientRect().right,
            ];
          }),
        );
        assert.equal(cardInsets.length, 2);
        assert.deepEqual(cardInsets[0], cardInsets[1]);
        const excerpt = page.locator('.blog-note a[href="/shorts/#note:swup"]');
        await excerpt.focus();
        await excerpt.press('Enter');
        const note = page.locator('article[id="note:swup"]');
        await expect(note).toBeFocused();
        await expect(note).toBeInViewport();
        await page.reload();
        await expect(note).toBeInViewport();
        await page.goto(origin + '/');
        await page.goto(origin + '/shorts/#swup');
        await expect(page).toHaveURL(origin + '/shorts/#note:swup');
        await expect(note).toBeFocused();
        await expect(note).toBeInViewport();
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}
