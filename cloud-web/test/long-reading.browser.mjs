// Long reading uses Rust/WASM output and temporary HTML routes, never production storage.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { draft } from './fixture.mjs';

export async function verifyLongReading(browser, origin, output, engine) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const samples = [];
  try {
    const template = await (await context.request.get(origin + '/posts/slow-days/')).text();
    const builder = await context.newPage();
    await builder.goto(origin + '/admin');
    const paragraph =
      '长文章应该保持舒适的阅读节奏。图片、代码和公式各自占据合适的空间，阅读位置不会因为切换页面而丢失。';
    const markdown = [
      '## 阅读与排版',
      ...Array(8).fill(paragraph),
      'https://example.net/' + 'a-long-address-'.repeat(20),
      '## 代码与表格',
      '```javascript\nconst article = "' + 'A'.repeat(240) + '";\nconsole.log(article);\n```',
      '| ' + Array.from({ length: 6 }, (_, i) => 'Column ' + i).join(' | ') + ' |',
      '| ' + Array(6).fill('---').join(' | ') + ' |',
      '| ' +
        Array(6)
          .fill('identifier_' + 'x'.repeat(36))
          .join(' | ') +
        ' |',
      '## 公式与继续阅读',
      '$$\nf(x) = ' + Array.from({ length: 48 }, (_, i) => 'x_{' + i + '}^2').join(' + ') + '\n$$',
      '$$\nx^2 + y^2\n$$',
      ...Array(12).fill(paragraph),
    ]
      .join('\n\n')
      .replace(/\|\n\n\|/g, '|\n|');
    const html = await builder.evaluate(
      async ({ template, value }) => {
        const wasm = await import('/blog_wasm.js');
        await wasm.default({ module_or_path: '/blog_wasm_bg.wasm' });
        const rendered = wasm.render_preview(
          JSON.stringify({
            config: { title: 'CloudInk', subtitle: '', author: 'Reader', description: '' },
            draft: value,
          }),
        );
        const parser = new DOMParser();
        const doc = parser.parseFromString(template, 'text/html');
        const preview = parser.parseFromString(rendered, 'text/html');
        doc.querySelector('.article-body').replaceWith(preview.querySelector('.article-body'));
        doc.querySelector('.article-heading h1').textContent =
          '长文章阅读 · ' + 'AReadableLongTitle'.repeat(5);
        for (const kind of ['math', 'code']) {
          if (doc.querySelector('[data-reader-style="' + kind + '"]')) continue;
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.dataset.readerStyle = kind;
          link.href = '/reader-assets/' + (kind === 'math' ? 'katex.css' : 'code.css');
          doc.head.append(link);
        }
        return '<!doctype html>' + doc.documentElement.outerHTML;
      },
      { template, value: draft('long-reading-check', markdown) },
    );
    await builder.close();
    const css = await readFile('build-work/web-public/styles.css', 'utf8');
    const beforeCSS = css.replace(
      /\/\* Wide content reading:[\s\S]*?\/\* End wide content reading\. \*\//,
      '',
    );
    assert.notEqual(beforeCSS, css, 'The comparison must remove exactly the new wide-content CSS');
    let baseline = false;
    await context.route('**/styles.css*', (route) =>
      route.fulfill({ contentType: 'text/css', body: baseline ? beforeCSS : css }),
    );
    await context.route('**/posts/long-reading-check/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    const page = await context.newPage();
    const measure = () =>
      page
        .locator('.katex-display')
        .first()
        .evaluate((node) => {
          node.scrollLeft = 0;
          const first = node.querySelector('.katex-html > .base').getBoundingClientRect();
          const left = node.getBoundingClientRect().left;
          const start = first.left - left;
          node.scrollLeft = node.scrollWidth;
          const last = [...node.querySelectorAll('.katex-html > .base')]
            .at(-1)
            .getBoundingClientRect();
          const end = node.getBoundingClientRect().right - last.right;
          node.scrollLeft = 0;
          const table = document.querySelector('.article-body table');
          return {
            start,
            end,
            width: node.clientWidth,
            scrollWidth: node.scrollWidth,
            tableHeight: table.clientHeight,
            columnWidth: table.querySelector('td').getBoundingClientRect().width,
            preWidth: document.querySelector('.article-body pre').clientWidth,
            preScrollWidth: document.querySelector('.article-body pre').scrollWidth,
            codeScrollWidth: document.querySelector('.article-body pre code').scrollWidth,
          };
        });
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['light', 'dark']) {
        await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
        baseline = true;
        await page.goto(origin + '/posts/long-reading-check/');
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('.article-body code.hljs')).toBeVisible();
        const before = await measure();
        if (width === 390 && theme === 'light')
          await page.screenshot({
            path: resolve(output, 'long-reading-before-' + engine + '.png'),
            fullPage: true,
          });
        baseline = false;
        await page.reload();
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('.article-body code.hljs')).toBeVisible();
        await expect(page.locator('.katex-display')).toHaveCount(2);
        const after = await measure();
        assert.ok(
          after.scrollWidth > after.width + 100,
          JSON.stringify({ engine, width, theme, before, after }),
        );
        assert.ok(
          after.start >= -2 && after.end >= -2,
          JSON.stringify({ engine, width, theme, after }),
        );
        console.log(JSON.stringify({ readerCase: true, engine, width, theme, before, after }));
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        const typography = await page.locator('.article-body').evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            size: parseFloat(style.fontSize),
            leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
          };
        });
        assert.ok(typography.size >= 17 && typography.leading >= 1.7);
        for (const selector of ['pre', 'table', '.katex-display']) {
          const region = page.locator('.article-body ' + selector).first();
          await expect(region).toHaveAttribute('tabindex', '0');
          await region.focus();
          const scrollArea = await region.evaluate((node) => ({
            client: node.clientWidth,
            content: node.scrollWidth,
            focused: node === document.activeElement,
          }));
          assert.ok(
            scrollArea.content > scrollArea.client && scrollArea.focused,
            JSON.stringify({ engine, width, theme, selector, scrollArea }),
          );
          await region.evaluate((node) => {
            node.scrollLeft = 0;
          });
          await page.keyboard.press('ArrowRight');
          await expect.poll(() => region.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
          await region.evaluate((node) => {
            node.scrollLeft = 0;
          });
        }
        const short = page.locator('.katex-display').last();
        const centered = await short.evaluate((node) => {
          const a = node.getBoundingClientRect(),
            b = node.querySelector('.base').getBoundingClientRect();
          return Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2);
        });
        assert.ok(centered < 3, 'A fitting formula must remain centered');
        samples.push({ engine, width, theme, before, after, typography });
        await page.screenshot({
          path: resolve(
            output,
            'long-reading-after-' + engine + '-' + width + '-' + theme + '.png',
          ),
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.mobile-toc-btn').click();
    await page.locator('.toc-link').last().click();
    const heading = page.locator('.article-body h2').last();
    await expect(heading).toBeFocused();
    await expect
      .poll(() => heading.evaluate((node) => Math.abs(node.getBoundingClientRect().top - 32)))
      .toBeLessThan(50);
    const savedY = await page.evaluate(() => scrollY);
    await page.evaluate(() => {
      void window.swup.navigate('/posts/white-space/');
    });
    await expect(page.locator('.article-heading h1')).toHaveText('给生活留一点空白');
    await page.goBack();
    await expect(page.locator('.article-heading h1')).toContainText('长文章阅读');
    await expect.poll(() => page.evaluate((y) => Math.abs(scrollY - y), savedY)).toBeLessThan(30);
    assert.deepEqual(errors, [], engine + ' long reading must not leak errors');
    await writeFile(
      resolve(output, 'long-reading-' + engine + '.json'),
      JSON.stringify(samples, null, 2),
    );
    console.log('LONG_READING ' + JSON.stringify(samples));
    return samples;
  } finally {
    await context.close();
  }
}
