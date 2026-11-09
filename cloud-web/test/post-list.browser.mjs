// Exercise paginated HTML from the real renderer against the shipped reader script.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import init, { render_release } from '../../cloud-admin/ui/wasm/blog_wasm.js';

export async function verifyPostList(browser, origin) {
  await init({
    module_or_path: await readFile(
      new URL('../../cloud-admin/ui/wasm/blog_wasm_bg.wasm', import.meta.url),
    ),
  });
  const posts = {};
  for (let i = 0; i < 68; i++) {
    const slug = 'batch-' + String(i).padStart(2, '0');
    posts[slug] =
      '+++\ntitle = "文章 ' +
      i +
      '：分批浏览"\nslug = "' +
      slug +
      '"\ndate = "2026-11-09"\ndraft = false\n+++\n\n## 正文\n\nArticle body.';
  }
  const release = {
    schema_version: 1,
    id: 'batches',
    created_at: '2026-11-09',
    site: { title: 'Blog', subtitle: '', author: 'Writer', description: '' },
    markdown_posts: posts,
  };
  const files = JSON.parse(render_release(JSON.stringify(release)));
  release.markdown_posts['batch-67'] = release.markdown_posts['batch-67'].replace(
    '文章 67',
    '已更新的文章',
  );
  const updated = JSON.parse(render_release(JSON.stringify(release)));
  let fail = false,
    changed = false,
    delayed = null;
  const requests = [];
  async function fixture(context) {
    await context.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ body: '' }));
    await context.route('https://unpkg.com/**', (r) => r.fulfill({ body: '' }));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || !/^\/(?:post\/|posts\/batch-)/.test(url.pathname))
        return route.fallback();
      const key = url.pathname.slice(1) + 'index.html';
      if (url.pathname.startsWith('/post/page/')) {
        requests.push(url.pathname);
        if (delayed) await delayed;
        if (fail) {
          fail = false;
          return route.fulfill({ status: 503, body: 'Temporary failure' });
        }
      }
      return route.fulfill({
        status: (changed ? updated : files)[key] ? 200 : 404,
        contentType: 'text/html; charset=utf-8',
        body: (changed ? updated : files)[key] || files['404.html'],
      });
    });
  }
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 768 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    await fixture(context);
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      requests.length = 0;
      await page.goto(origin + '/post/');
      await expect(page.locator('.post-index-list > li')).toHaveCount(10);
      assert.equal(requests.length, 0);
      let releaseRequest;
      delayed = new Promise((resolve) => {
        releaseRequest = resolve;
      });
      await page.locator('#post-list-next').scrollIntoViewIfNeeded();
      await expect.poll(() => requests.length).toBe(1);
      await expect(page.locator('.post-index-pagination')).toHaveAttribute('aria-busy', 'true');
      const position = await page.evaluate(() => scrollY);
      await page.locator('#post-list-next').focus();
      await page.locator('#post-list-next').dispatchEvent('click', { button: 0 });
      assert.equal(requests.length, 1, 'Loading and clicking must not duplicate a batch');
      delayed = null;
      releaseRequest();
      await expect(page.locator('.post-index-list > li')).toHaveCount(20);
      assert(
        Math.abs((await page.evaluate(() => scrollY)) - position) < 3,
        'Appending a batch must preserve the visible reading position',
      );
      for (let expected = 30; expected <= 70; expected += 10) {
        await page.locator('#post-list-next').scrollIntoViewIfNeeded();
        await expect(page.locator('.post-index-list > li')).toHaveCount(Math.min(68, expected));
      }
      assert.equal(
        new Set(
          await page.locator('.post-index-list h2 a').evaluateAll((a) => a.map((n) => n.href)),
        ).size,
        68,
      );
      assert.equal(requests.length, 6);
      await expect(page.locator('#post-list-next')).toBeHidden();
      const lastPosition = await page.evaluate(() => scrollY);
      await page.locator('.post-index-list h2 a').last().click();
      await expect(page.locator('.article-body')).toBeVisible();
      await page.goBack();
      await expect(page.locator('.post-index-list > li')).toHaveCount(68);
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(lastPosition - 100);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.evaluate(() => scrollTo(0, 0));
      const reloaded = await page.reload();
      assert.equal(
        ((await reloaded.text()).match(/class="post-card blog-post"/g) || []).length,
        10,
      );
      await expect(page.locator('.post-index-list > li')).toHaveCount(10);
      fail = true;
      await page.locator('#post-list-next').scrollIntoViewIfNeeded();
      await expect(page.locator('#post-list-status')).toContainText('点击重试');
      await expect(page.locator('.post-index-list > li')).toHaveCount(10);
      await page.locator('#post-list-next').click();
      await expect(page.locator('.post-index-list > li')).toHaveCount(20);
      await page.goto(origin + '/post/');
      changed = true;
      await page.locator('#post-list-next').scrollIntoViewIfNeeded();
      await expect(page.locator('#post-list-next')).toHaveText('刷新文章列表');
      await expect(page.locator('.post-index-list > li')).toHaveCount(10);
      await page.locator('#post-list-next').click();
      await expect(page.locator('.post-index-list h2 a').first()).toHaveText(
        '已更新的文章：分批浏览',
      );
      changed = false;
      assert.deepEqual(errors, []);
    } finally {
      delayed = null;
      changed = false;
      await context.close();
    }
  }
  const native = await browser.newContext({ javaScriptEnabled: false });
  await fixture(native);
  try {
    const page = await native.newPage();
    await page.goto(origin + '/post/');
    await expect(page.locator('.post-index-list > li')).toHaveCount(10);
    await page.locator('#post-list-next').click();
    await expect(page).toHaveURL(origin + '/post/page/2/');
    await expect(page.locator('.post-index-list > li')).toHaveCount(10);
    await page.goto(origin + '/post/page/7/');
    await expect(page.locator('.post-index-list > li')).toHaveCount(8);
    await expect(page.locator('#post-list-next')).toHaveCount(0);
  } finally {
    await native.close();
  }
}
