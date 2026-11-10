import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

// Exercise effects with normal motion: reduced-motion checks never enter the glass branch.
export async function verifyReaderLayout(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ...(engine === 'chromium' ? { isMobile: true } : {}),
    hasTouch: true,
    reducedMotion: 'no-preference',
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  try {
    await context.route('https://cdn.jsdelivr.net/**', (route) =>
      route.fulfill({ contentType: 'text/css', body: '' }),
    );
    const page = await context.newPage();
    const index = await (await context.request.get(origin + '/search_index.json')).json();
    assert.ok(index.length, 'The fixture needs one published article');
    for (const path of ['/', '/posts/' + index[0].slug + '/']) {
      await page.goto(origin + path);
      for (const width of [320, 390, 980, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((value) => CloudInkTheme.setMode(value), theme);
          for (const effects of ['glass', 'solid']) {
            await page.evaluate((value) => {
              document.documentElement.dataset.effects = value;
            }, effects);
            const header = page.locator('.reader-header');
            await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await expect(header).toHaveCSS('box-shadow', 'none');
            await expect(header).toHaveCSS('backdrop-filter', 'none');
            const bounds = await header.boundingBox();
            assert.ok(bounds.width <= width, engine + '/' + path + '/' + width);
          }
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => CloudInkTheme.setMode('light'));
    await page.screenshot({
      path: resolve(output, 'reader-header-' + engine + '-390.png'),
      animations: 'disabled',
    });
    await verifyContentWidths(context, page, origin, output, engine, index[0].slug);
  } finally {
    await context.close();
  }
}

async function verifyContentWidths(context, page, origin, output, engine, slug) {
  const template = await (await context.request.get(origin + '/posts/' + slug + '/')).text();
  const builder = await context.newPage();
  await builder.goto(origin + '/admin');
  const fixtures = await builder.evaluate(async (template) => {
    const wasm = await import('/blog_wasm.js');
    await wasm.default({ module_or_path: '/blog_wasm_bg.wasm' });
    const address = 'https://example.net/' + 'long-configuration-path/'.repeat(30);
    const cases = {
      prose:
        '## 这是什么\n\n> Debian 13、niri 与 noctalia 的安装说明。\n\n中英文混排保持正常宽度。',
      code: '## 配置\n\n```bash\nsu -\nexport SOURCE="' + address + '"\necho "$SOURCE"\n```',
      image: '## 截图\n\n![3200px 大图](/layout-fixture-wide.svg)',
      table:
        '## 配置对照\n\n| 软件 | 配置 | 地址 |\n| --- | --- | --- |\n| niri | noctalia | ' +
        address +
        ' |',
      inline: '## 地址\n\n`' + address + '`\n\n' + address,
      math:
        '$$\nf(x) = ' +
        Array.from({ length: 40 }, (_, i) => 'x_{' + i + '}^2').join(' + ') +
        '\n$$',
    };
    cases.mixed = Object.values(cases).join('\n\n');
    const parser = new DOMParser();
    return Object.fromEntries(
      Object.entries(cases).map(([kind, body]) => {
        const rendered = parser.parseFromString(
          wasm.render_preview(
            JSON.stringify({
              config: { title: 'Imagine', subtitle: '', author: 'Qiulin', description: '' },
              draft: {
                front_matter: {
                  title: 'Debian 13 最小化安装 + niri + noctalia 完整教程',
                  slug: 'layout-' + kind,
                  date: '2026-11-01',
                },
                body_markdown: body,
              },
            }),
          ),
          'text/html',
        );
        const doc = parser.parseFromString(template, 'text/html');
        doc.querySelector('.article-shell').replaceWith(rendered.querySelector('.article-shell'));
        return [kind, '<!doctype html>' + doc.documentElement.outerHTML];
      }),
    );
  }, template);
  await builder.close();
  await context.route('**/layout-fixture-wide.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="1800"><rect width="3200" height="1800" fill="#dcc9a8"/></svg>',
    }),
  );
  await context.route('**/posts/layout-*/', (route) => {
    const kind = new URL(route.request().url()).pathname.split('/')[2].slice('layout-'.length);
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtures[kind] });
  });
  for (const width of [320, 390, 980, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const kind of Object.keys(fixtures)) {
      await page.goto(origin + '/posts/layout-' + kind + '/');
      if (kind === 'code' || kind === 'mixed')
        await expect(page.locator('.article-body .code-block')).toBeVisible();
      if (kind === 'table' || kind === 'mixed')
        await expect(page.locator('.article-body .table-scroll')).toBeVisible();
      if (kind === 'image' || kind === 'mixed')
        await expect
          .poll(() => page.locator('.article-body img').evaluate((img) => img.naturalWidth))
          .toBe(3200);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
        false,
        engine + '/' + width + '/' + kind + ' must fit without shrinking the page',
      );
      for (const selector of ['pre', '.table-scroll', '.katex-display']) {
        const scroller = page.locator('.article-body ' + selector);
        if (!(await scroller.count())) continue;
        assert.ok(
          await scroller.evaluate((node) => {
            const expected = node.scrollWidth - node.clientWidth;
            node.scrollLeft = expected;
            const reached = node.scrollLeft;
            node.scrollLeft = 0;
            return expected > 0 && Math.abs(reached - expected) <= 1;
          }),
          engine + '/' + width + '/' + kind + ': wide content must remain scrollable',
        );
      }
      if (kind === 'mixed') {
        const avatar = page.locator('.article-metadata .author-avatar');
        for (const initial of ['Q', '云']) {
          const offset = await avatar.evaluate((node, value) => {
            node.textContent = value;
            const box = node.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node);
            const text = range.getBoundingClientRect();
            return {
              x: Math.abs(text.left + text.width / 2 - (box.left + box.width / 2)),
              y: Math.abs(text.top + text.height / 2 - (box.top + box.height / 2)),
            };
          }, initial);
          assert.ok(
            offset.x <= 1 && offset.y <= 3,
            engine + '/' + width + ': author initial must be centered: ' + JSON.stringify(offset),
          );
        }
        await avatar.evaluate((node) => {
          node.textContent = 'Q';
        });
        for (const font of ['serif', 'sans']) {
          await page.evaluate((value) => {
            document.documentElement.dataset.readingFont = value;
          }, font);
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
            ),
            false,
          );
        }
        await page.screenshot({
          path: resolve(output, 'reader-content-' + engine + '-' + width + '.png'),
          animations: 'disabled',
        });
      }
    }
  }
  // Native HTML must already fit while enhancement scripts are unavailable.
  const noScript = await context.browser().newContext({
    viewport: { width: 390, height: 844 },
    javaScriptEnabled: false,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
  });
  try {
    await noScript.route('**/posts/layout-mixed/', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtures.mixed }),
    );
    await noScript.route('**/layout-fixture-wide.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="1800"/>',
      }),
    );
    await noScript.route('https://cdn.jsdelivr.net/**', (route) =>
      route.fulfill({ contentType: 'text/css', body: '' }),
    );
    const staticPage = await noScript.newPage();
    await staticPage.goto(origin + '/posts/layout-mixed/');
    assert.equal(
      await staticPage.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
      false,
      'Static article must fit before JavaScript runs',
    );
  } finally {
    await noScript.close();
  }
}
