import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function readerFixtures(context, origin) {
  const response = await context.request.get(origin + '/posts/slow-days/');
  assert.equal(response.status(), 200);
  const page = await context.newPage();
  await page.goto(origin + '/');
  const fixtures = await page.evaluate(
    (html) => {
      const parser = new DOMParser(),
        template = parser.parseFromString(html, 'text/html');
      const formula = template.querySelector('.katex').outerHTML;
      const outputs = {};
      for (const [kind, content] of Object.entries({
        plain: '<p>这是一篇只包含普通文字的文章。</p>'.repeat(20),
        code: '<pre><code class="language-javascript">const greeting = "hello";\nconsole.log(greeting);</code></pre>',
        math: '<p>公式阅读示例：</p>' + formula,
        'math-extra': '<span class="katex" style="font-family:KaTeX_Size4">()</span>',
      })) {
        const doc = template.cloneNode(true);
        doc.querySelector('.article-heading h1').textContent = 'Reader ' + kind;
        doc.querySelector('.article-body').innerHTML = content;
        doc.querySelectorAll('[data-reader-style]').forEach((node) => node.remove());
        for (const type of kind === 'plain' ? [] : [kind]) {
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.dataset.readerStyle = type.startsWith('math') ? 'math' : 'code';
          link.href = '/reader-assets/' + (type.startsWith('math') ? 'katex.css' : 'code.css');
          doc.head.append(link);
        }
        outputs[kind] = '<!doctype html>' + doc.documentElement.outerHTML;
      }
      return outputs;
    },
    await response.text(),
  );
  await page.close();
  return fixtures;
}
export async function verifyReaderLoading(browser, origin, output, engine) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const errors = [],
    requests = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  try {
    const fixtures = await readerFixtures(context, origin);
    let failPage = false,
      failScript = true,
      failFont = true,
      failExtraFont = false,
      holdStyle = false,
      releaseStyle,
      holdPage = false,
      releasePage;
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/native-json')
        return route.fulfill({ contentType: 'application/json', body: '{"native":true}' });
      if (url.pathname === '/native-page')
        return route.fulfill({
          contentType: 'text/html',
          body: '<html><body><h1>普通页面</h1></body></html>',
        });
      if (url.pathname === '/native-image.png')
        return route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
            'base64',
          ),
        });
      if (url.pathname.endsWith('KaTeX_Size4-Regular.woff2') && failExtraFont) {
        failExtraFont = false;
        return route.abort();
      }
      const match = url.pathname.match(/^\/posts\/reader-(plain|code|math|math-extra)\/$/);
      if (match) {
        if (holdPage)
          await new Promise((resolve) => {
            releasePage = resolve;
          });
        if (failPage)
          return route
            .fulfill({ status: 503, contentType: 'text/plain', body: 'Fixture failure' })
            .catch(() => {});
        return route
          .fulfill({ contentType: 'text/html', body: fixtures[match[1]] })
          .catch(() => {});
      }
      if (url.pathname.includes('/fonts/KaTeX_') && failFont) {
        failFont = false;
        return route.abort();
      }
      if (url.pathname === '/reader-assets/highlight.js' && failScript) {
        failScript = false;
        return route.abort();
      }
      if (url.pathname === '/reader-assets/katex.css' && holdStyle)
        await new Promise((resolve) => {
          releaseStyle = resolve;
        });
      await route.continue().catch(() => {});
    });
    const page = await context.newPage();
    page.on('request', (request) => requests.push(request.url()));
    const home = async () => {
      await page.goto(origin + '/');
      await page.evaluate(() => {
        window.readerNavigationToken = 'same-document';
        const nav = document.createElement('nav');
        for (const kind of ['plain', 'code', 'math']) {
          const link = document.createElement('a');
          link.id = 'reader-link-' + kind;
          link.href = '/posts/reader-' + kind + '/';
          link.textContent = kind;
          nav.append(link);
        }
        document.querySelector('#swup').prepend(nav);
      });
    };
    await home();
    assert.ok(
      !requests.some((url) =>
        /\/reader-assets\/(?:highlight\.js|code\.css|katex\.css|fonts\/KaTeX_)/.test(url),
      ),
      'home must not load code or math resources',
    );
    await page.locator('#reader-link-plain').click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');
    assert.equal(await page.evaluate(() => window.readerNavigationToken), 'same-document');
    assert.ok(
      !requests.some((url) =>
        /\/reader-assets\/(?:highlight\.js|code\.css|katex\.css|fonts\/KaTeX_)/.test(url),
      ),
      'ordinary prose must stay lightweight',
    );

    await home();
    await page.locator('#reader-link-code').click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader code');
    await expect(page.locator('#reader-resource-status')).toContainText('高亮资源加载失败');
    await expect(page.locator('.article-body pre')).toContainText('greeting');
    await page
      .locator('#reader-resource-status')
      .getByRole('button', { name: '重试', exact: true })
      .click();
    await expect(page.locator('.article-body code.hljs')).toBeVisible();
    assert.ok(!requests.some((url) => url.includes('katex.css') || url.includes('/fonts/KaTeX_')));
    const color = await page
      .locator('.hljs-string')
      .first()
      .evaluate((node) => getComputedStyle(node).color);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() =>
        page
          .locator('.hljs-string')
          .first()
          .evaluate((node) => getComputedStyle(node).color),
      )
      .not.toBe(color);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({
      path: resolve(output, 'reader-code-lazy-' + engine + '.png'),
      fullPage: true,
    });

    await home();
    holdStyle = true;
    await page.locator('#reader-link-math').click();
    await expect.poll(() => typeof releaseStyle).toBe('function');
    await expect(page.locator('.home-layout')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/');
    await expect(page.locator('#reader-navigation-status')).toContainText('当前内容仍可阅读');
    holdStyle = false;
    releaseStyle();
    await expect(page.locator('#reader-navigation-status')).toContainText('打开失败', {
      timeout: 15000,
    });
    assert.equal(
      await page.locator('link[data-reader-style="math"]').evaluate((link) => !!link.sheet),
      true,
      'font failure must retain usable formula CSS',
    );
    await page
      .locator('#reader-navigation-status')
      .getByRole('button', { name: '重试', exact: true })
      .click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader math', { timeout: 15000 });
    await expect(page.locator('.article-body .katex')).toBeVisible();
    assert.equal(await page.evaluate(() => window.readerNavigationToken), 'same-document');
    assert.ok(requests.some((url) => url.includes('/fonts/KaTeX_')));
    await page.screenshot({
      path: resolve(output, 'reader-math-local-' + engine + '.png'),
      fullPage: true,
    });

    failExtraFont = true;
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.id = 'math-next';
      link.href = '/posts/reader-math-extra/';
      link.textContent = '另一篇公式文章';
      document.querySelector('.article-body').prepend(link);
    });
    await page.locator('#math-next').click();
    await expect(page.locator('#reader-navigation-status')).toContainText('打开失败', {
      timeout: 15000,
    });
    await expect(page.locator('.article-heading h1')).toHaveText('Reader math');
    assert.match(
      await page
        .locator('.article-body .katex')
        .evaluate((node) => getComputedStyle(node).fontFamily),
      /KaTeX_Main/,
    );
    await page.screenshot({
      path: resolve(output, 'reader-math-font-retry-' + engine + '.png'),
      fullPage: true,
    });
    await page
      .locator('#reader-navigation-status')
      .getByRole('button', { name: '重试', exact: true })
      .click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader math-extra', {
      timeout: 15000,
    });

    await home();
    failPage = true;
    await page.locator('#reader-link-plain').click();
    await expect(page.locator('#reader-navigation-status')).toContainText('当前文章已保留');
    await expect(page.locator('.home-layout')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/');
    await expect(page.locator('#reader-navigation-status a')).toHaveAttribute('data-no-swup', '');
    failPage = false;
    const retryCount = requests.filter((url) => url.endsWith('/posts/reader-plain/')).length;
    await page
      .locator('#reader-navigation-status')
      .getByRole('button', { name: '重试', exact: true })
      .click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');
    assert.equal(
      requests.filter((url) => url.endsWith('/posts/reader-plain/')).length,
      retryCount + 1,
      'A retry must use the prepared response without a second request',
    );
    await page.goBack();
    await expect(page.locator('.home-layout')).toBeVisible();
    await page.goForward();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');

    await home();
    failPage = true;
    await context.setOffline(true);
    await page.locator('#reader-link-plain').click();
    await expect(page.locator('#reader-navigation-status')).toContainText('网络已断开');
    await expect(page.locator('.home-layout')).toBeVisible();
    await context.setOffline(false);
    failPage = false;
    await expect(page.locator('#reader-navigation-status')).toContainText('网络已恢复');
    await page.locator('#reader-navigation-status a').click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');
    assert.equal(
      await page.evaluate(() => window.readerNavigationToken),
      undefined,
      'ordinary navigation must use the browser',
    );

    await home();
    holdPage = true;
    await page.locator('#reader-link-code').click();
    await expect.poll(() => typeof releasePage).toBe('function');
    holdPage = false;
    await page.locator('#reader-link-plain').click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');
    releasePage();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');
    assert.equal(new URL(page.url()).pathname, '/posts/reader-plain/');

    await home();
    releasePage = undefined;
    holdPage = true;
    await page.locator('#reader-link-math').click();
    await expect.poll(() => typeof releasePage).toBe('function');
    await expect(page.locator('#reader-navigation-status')).toContainText('打开失败', {
      timeout: 15000,
    });
    await expect(page.locator('.home-layout')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/');
    holdPage = false;
    releasePage();
    await page.screenshot({
      path: resolve(output, 'reader-navigation-retry-' + engine + '.png'),
      fullPage: true,
    });
    for (const path of ['/native-json', '/native-page', '/native-image.png', '/admin']) {
      await home();
      await page.evaluate((path) => {
        const link = document.createElement('a');
        link.id = 'native-destination';
        link.href = path;
        link.textContent = '正常链接';
        document.querySelector('#swup').prepend(link);
      }, path);
      await page.locator('#native-destination').click();
      await page.waitForURL(origin + path);
      assert.equal(await page.evaluate(() => window.readerNavigationToken), undefined);
      if (path === '/admin') await expect(page.locator('#login-view')).toBeVisible();
    }
    assert.deepEqual(errors, [], 'reader loading and cancellation must not leak errors');
  } finally {
    await context.close();
  }
}
