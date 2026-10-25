import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function readerFixtures(context, origin) {
  const response = await context.request.get(origin + '/posts/slow-days/');
  assert.equal(response.status(), 200);
  const page = await context.newPage();
  await page.goto(origin + '/');
  const fixtures = await page.evaluate((html) => {
    const parser = new DOMParser(), template = parser.parseFromString(html, 'text/html');
    const formula = template.querySelector('.katex').outerHTML;
    const outputs = {};
    for (const [kind, content] of Object.entries({
      plain: '<p>这是一篇只包含普通文字的文章。</p>'.repeat(20),
      code: '<pre><code class="language-javascript">const greeting = "hello";\nconsole.log(greeting);</code></pre>',
      math: '<p>公式阅读示例：</p>' + formula,
    })) {
      const doc = template.cloneNode(true);
      doc.querySelector('.article-heading h1').textContent = 'Reader ' + kind;
      doc.querySelector('.article-body').innerHTML = content;
      doc.querySelectorAll('[data-reader-style]').forEach((node) => node.remove());
      for (const type of kind === 'plain' ? [] : [kind]) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.readerStyle = type === 'math' ? 'math' : 'code';
        link.href = '/reader-assets/' + (type === 'math' ? 'katex.css' : 'code.css');
        doc.head.append(link);
      }
      outputs[kind] = '<!doctype html>' + doc.documentElement.outerHTML;
    }
    return outputs;
  }, await response.text());
  await page.close();
  return fixtures;
}
export async function verifyReaderLoading(browser, origin, output, engine) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const errors = [], requests = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  try {
    const fixtures = await readerFixtures(context, origin);
    let failPage = false, failScript = true, holdStyle = false, releaseStyle, holdPage = false, releasePage;
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const match = url.pathname.match(/^\/posts\/reader-(plain|code|math)\/$/);
      if (match) {
        if (holdPage) await new Promise((resolve) => { releasePage = resolve; });
        if (failPage) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Fixture failure' }).catch(() => {});
        return route.fulfill({ contentType: 'text/html', body: fixtures[match[1]] }).catch(() => {});
      }
      if (url.pathname === '/reader-assets/highlight.js' && failScript) {
        failScript = false;
        return route.abort();
      }
      if (url.pathname === '/reader-assets/katex.css' && holdStyle)
        await new Promise((resolve) => { releaseStyle = resolve; });
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
    assert.ok(!requests.some((url) => url.includes('/reader-assets/')), 'home must not load code or math resources');
    await page.locator('#reader-link-plain').click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');
    assert.equal(await page.evaluate(() => window.readerNavigationToken), 'same-document');
    assert.ok(!requests.some((url) => url.includes('/reader-assets/')), 'ordinary prose must stay lightweight');

    await home();
    await page.locator('#reader-link-code').click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader code');
    await expect(page.locator('#reader-resource-status')).toContainText('高亮资源加载失败');
    await expect(page.locator('.article-body pre')).toContainText('greeting');
    await page.locator('#reader-resource-status').getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('.article-body code.hljs')).toBeVisible();
    assert.ok(!requests.some((url) => url.includes('katex.css') || url.endsWith('.woff2')));
    await page.screenshot({ path: resolve(output, 'reader-code-lazy-' + engine + '.png'), fullPage: true });

    await home();
    holdStyle = true;
    await page.locator('#reader-link-math').click();
    await expect.poll(() => typeof releaseStyle).toBe('function');
    await expect(page.locator('.home-layout')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/');
    await expect(page.locator('#reader-navigation-status')).toContainText('当前内容仍可阅读');
    holdStyle = false; releaseStyle();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader math', { timeout: 15000 });
    await expect(page.locator('.article-body .katex')).toBeVisible();
    assert.equal(await page.evaluate(() => window.readerNavigationToken), 'same-document');
    assert.ok(requests.some((url) => url.endsWith('.woff2')));
    await page.screenshot({ path: resolve(output, 'reader-math-local-' + engine + '.png'), fullPage: true });

    await home();
    failPage = true;
    await page.locator('#reader-link-plain').click();
    await expect(page.locator('#reader-navigation-status')).toContainText('当前文章已保留');
    await expect(page.locator('.home-layout')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/');
    await expect(page.locator('#reader-navigation-status a')).toHaveAttribute('data-no-swup', '');
    failPage = false;
    await page.locator('#reader-navigation-status').getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('.article-heading h1')).toHaveText('Reader plain');
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
    assert.equal(await page.evaluate(() => window.readerNavigationToken), undefined, 'ordinary navigation must use the browser');

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
    releasePage = undefined; holdPage = true;
    await page.locator('#reader-link-math').click();
    await expect.poll(() => typeof releasePage).toBe('function');
    await expect(page.locator('#reader-navigation-status')).toContainText('打开失败', { timeout: 15000 });
    await expect(page.locator('.home-layout')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/');
    holdPage = false; releasePage();
    await page.screenshot({ path: resolve(output, 'reader-navigation-retry-' + engine + '.png'), fullPage: true });
    assert.deepEqual(errors, [], 'reader loading and cancellation must not leak errors');
  } finally { await context.close(); }
}
