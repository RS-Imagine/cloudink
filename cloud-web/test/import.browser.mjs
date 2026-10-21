// Real browser uploads against an isolated test bucket; never a deployed site.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function verifyMarkdownImport(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Shanghai',
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  const created = new Set();
  try {
    await page.goto(origin + '/admin');
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    const initial = await (await context.request.get(origin + '/api/posts')).json();
    const initialKeys = new Set(initial.posts.map((p) => p.slug));
    const publicBefore = await (await context.request.get(origin + '/')).text();
    const file = (name, text) => ({
      name,
      mimeType: 'text/markdown',
      buffer: Buffer.isBuffer(text) ? text : Buffer.from(text),
    });
    const input = page.locator('#import-files');
    const source = '# 我的文章\n\n正文 **格式** $x^2$\n\n~~~js\nconst n = 1;\n~~~\n\n---\n\n尾声\n';
    await input.setInputFiles(file('hello.md', source));
    await expect(page.locator('#notice')).toContainText('已导入 1 篇');
    await expect(page.locator('#title')).toHaveValue('我的文章');
    await expect(page.locator('#body')).toHaveValue(source.slice(source.indexOf('\n') + 1));
    const first = await page.locator('#slug').inputValue();
    created.add(first);
    const today = await page.evaluate(() => {
      const d = new Date();
      return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ].join('-');
    });
    await expect(page.locator('#date')).toHaveValue(today);
    const original = await (await context.request.get(origin + '/api/posts/' + first)).json();
    const legacy =
      '+++\ntitle = "旧原稿副本"\nslug = "' +
      first +
      '"\ndate = "2024-02-29"\ndraft = false\n+++\n\n原稿正文';
    await page.route('**/api/posts/post-*', async (route) => {
      if (
        route.request().method() === 'PUT' &&
        route.request().postDataJSON().draft.front_matter.title === '网络失败'
      )
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '模拟保存失败' }),
        });
      return route.continue();
    });
    await input.setInputFiles([
      file('旧原稿.md', legacy),
      file('坏头信息.md', '+++\ntitle = [\n+++\nbody'),
      file('坏编码.md', Buffer.from([255, 254, 0])),
      file('网络失败.md', '正文'),
      file('普通文件.MARKDOWN', '---\n\n无头信息正文\n\n## 小标题\n'),
    ]);
    await expect(page.locator('#markdown-import-status')).toContainText(
      '已导入 2 篇草稿，失败 3 个',
    );
    await expect(page.locator('#markdown-import-results')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#markdown-import-results [data-state=success]')).toHaveCount(2);
    await expect(page.locator('#markdown-import-results [data-state=error]')).toHaveCount(3);
    const after = await (await context.request.get(origin + '/api/posts')).json();
    const added = after.posts.filter((p) => !initialKeys.has(p.slug));
    added.forEach((p) => created.add(p.slug));
    assert.equal(added.length, 3);
    const copied = added.find((p) => p.title === '旧原稿副本');
    assert.notEqual(copied.slug, first);
    assert.equal(copied.date, '2024-02-29');
    assert.equal(copied.published, false);
    assert.equal(
      (await (await context.request.get(origin + '/api/posts/' + first)).json()).source,
      original.source,
    );
    assert.equal(
      await (await context.request.get(origin + '/')).text(),
      publicBefore,
      'Import never publishes',
    );
    await page.screenshot({
      path: resolve(output, 'markdown-import-results-1440-' + engine + '.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.CloudInkTheme.setMode('dark'));
    await expect(page.locator('#markdown-import-close')).toBeInViewport();
    await expect(page.locator('#markdown-import-status')).toBeInViewport();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: resolve(output, 'markdown-import-results-390-' + engine + '.png'),
      fullPage: true,
    });
    await page.locator('#markdown-import-results [data-state=success] button').first().click();
    await expect(page.locator('#markdown-import-dialog')).toBeHidden();
    await expect(page.locator('#title')).toHaveValue('旧原稿副本');
    await expect(page.locator('#title')).toBeFocused();
    await page.unroute('**/api/posts/post-*');

    // Cancellation waits for an in-flight write, then skips the next file.
    let release,
      entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/posts/post-*', async (route) => {
      if (route.request().method() === 'PUT') {
        entered = true;
        await gate;
      }
      return route.continue();
    });
    await input.setInputFiles([
      file('cancel-first.md', '第一份'),
      file('cancel-second.md', '第二份'),
    ]);
    await expect.poll(() => entered).toBe(true);
    await page.locator('#markdown-import-close').click();
    release();
    await expect(page.locator('#markdown-import-status')).toContainText(
      '已导入 1 篇草稿，失败 0 个，跳过 1 个',
    );
    await page.locator('#markdown-import-close').click();
    await expect(page.locator('#markdown-import-dialog')).toBeHidden();
    await page.unroute('**/api/posts/post-*');
    const final = await (await context.request.get(origin + '/api/posts')).json();
    final.posts.filter((p) => !initialKeys.has(p.slug)).forEach((p) => created.add(p.slug));
    assert.equal(created.size, 4);

    // A conflict in the open editor must block the entire import before any writes.
    await page.route('**/api/posts/' + copied.slug, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: '原稿冲突，请先处理' }),
          })
        : route.continue(),
    );
    await page.locator('#body').fill('不要丢失当前原稿');
    await input.setInputFiles(file('must-not-import.md', '不会导入'));
    await expect(page.locator('#markdown-import-status')).toContainText('尚未开始导入');
    await expect(page.locator('#body')).toHaveValue('不要丢失当前原稿');
    await expect(page.locator('#markdown-import-results')).not.toHaveAttribute('aria-busy', 'true');
    const blocked = await (await context.request.get(origin + '/api/posts')).json();
    assert.equal(blocked.posts.filter((p) => !initialKeys.has(p.slug)).length, 4);
    await page.locator('#markdown-import-close').click();
    await expect(page.locator('#body')).toBeEditable();
    assert.deepEqual(errors, []);
  } finally {
    const sessionResponse = await context.request.get(origin + '/api/session');
    if (sessionResponse.ok()) {
      const session = await sessionResponse.json();
      for (const slug of created) {
        const response = await context.request.get(origin + '/api/posts/' + slug);
        if (!response.ok()) continue;
        const item = await response.json();
        const deleted = await context.request.delete(origin + '/api/posts/' + slug, {
          headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
          data: { etag: item.etag },
        });
        assert.equal(deleted.status(), 200);
      }
    }
    await context.close();
  }
}
