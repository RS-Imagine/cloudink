import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password, draft } from './fixture.mjs';

export async function verifyPostAddresses(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(origin + '/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#home-view')).toBeVisible();
  const csrf = (await (await page.request.get(origin + '/api/session')).json()).csrf;
  async function api(path, method = 'GET', data) {
    const response = await page.request.fetch(origin + path, {
      method,
      headers: { Origin: origin, 'X-CSRF-Token': csrf },
      ...(data === undefined ? {} : { data }),
    });
    assert.ok(response.ok(), method + ' ' + path + ': ' + await response.text());
    return response.json();
  }
  const first = 'address-' + engine + '-draft';
  const second = 'address-' + engine + '-saved';
  const live = 'address-' + engine + '-live';
  const occupied = 'address-' + engine + '-occupied';
  const title = '地址修改检查 · ' + engine;
  const sample = await api('/api/posts/slow-days');
  const image = sample.draft.body_markdown.match(/\/images\/uploads\/[A-Za-z0-9_./-]+/)?.[0];
  assert.ok(image, 'The isolated fixture supplies an existing managed image');
  const body = '## 保留正文\n\n地址更改后保留这段文字。\n\n![图片保持原地址](' + image + ')';
  const collision = await api('/api/posts/' + occupied, 'PUT', {
    draft: draft(occupied, 'Another private article'), etag: null,
  });
  await page.locator('#new-post').click();
  await page.locator('#editor-view').waitFor();
  await page.locator('.post-details').evaluate((node) => { node.open = true; });
  await page.locator('#slug').fill(first);
  await page.locator('#title').fill(title);
  await page.locator('#body').fill(body);
  await page.locator('#save-post').click();
  await expect(page.locator('#save-state')).toHaveAttribute('data-tone', 'success');
  await expect(page.locator('#slug')).toHaveAttribute('readonly', '');
  await page.locator('#change-post-address').click();
  const dialog = page.locator('#post-address-dialog');
  const input = page.locator('#post-address-input');
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill(occupied);
  await page.locator('#post-address-submit').click();
  await expect(page.locator('#post-address-status')).toContainText('占用');
  await expect(page.locator('#body')).toHaveValue(body);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#change-post-address')).toBeFocused();
  await page.locator('#change-post-address').click();
  await input.fill(second);
  await page.evaluate(() => CloudInkTheme.setPalette('brown'));
  await page.screenshot({ path: resolve(output, 'post-address-' + engine + '-390-light.png'), fullPage: true });
  await page.locator('#post-address-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#slug')).toHaveValue(second);
  await expect(page.locator('#body')).toHaveValue(body);
  assert.equal((await page.request.get(origin + '/posts/' + second + '/')).status(), 404);
  await page.locator('#publish-post').click();
  await expect(page.locator('#publish-post')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#publish-banner')).toContainText('已上线');
  const updated = body + '\n\n这段刚保存的文字随改址发布。';
  await page.locator('#body').fill(updated);
  await page.locator('#change-post-address').click();
  await expect(page.locator('#post-address-submit')).toHaveText('修改地址并发布');
  await expect(page.locator('#post-address-help')).toContainText('保存并发布');
  await input.fill(live);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => { CloudInkTheme.setMode('dark'); CloudInkTheme.setPalette('brown'); });
  await page.screenshot({ path: resolve(output, 'post-address-' + engine + '-390-dark.png'), fullPage: true });
  await page.locator('#post-address-submit').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#slug')).toHaveValue(live);
  await expect(page.locator('#body')).toHaveValue(updated);
  await expect(page.locator('#slug')).toHaveAttribute('readonly', '');
  assert.equal((await page.request.get(origin + '/posts/' + first + '/')).status(), 404);
  for (const slug of [second]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await page.request.fetch(origin + '/posts/' + slug + '/?from=old', {
        method, maxRedirects: 0,
      });
      assert.equal(response.status(), 301);
      assert.equal(response.headers().location, origin + '/posts/' + live + '/?from=old');
    }
  }
  const home = await (await page.request.get(origin + '/')).text();
  assert.ok(home.includes('/posts/' + live + '/'));
  assert.ok(!home.includes('href="/posts/' + second + '/"'));
  const search = await (await page.request.get(origin + '/search_index.json')).json();
  assert.ok(search.some((post) => post.slug === live));
  assert.ok(!search.some((post) => [first, second, occupied].includes(post.slug)));
  const reader = await context.newPage();
  await reader.goto(origin + '/posts/' + second + '/');
  await expect(reader).toHaveURL(origin + '/posts/' + live + '/');
  await expect(reader.locator('article h1')).toHaveText(title);
  await expect(reader.locator('.article-body')).toContainText('这段刚保存的文字随改址发布');
  await expect(reader.locator('.article-body img')).toHaveCount(1);
  await reader.locator('.article-body img').scrollIntoViewIfNeeded();
  await expect.poll(() => reader.locator('.article-body img').evaluate((node) => node.naturalWidth)).toBeGreaterThan(0);
  await reader.close();
  const backup = await api('/api/backup');
  assert.ok(backup.files['published/' + live + '.md'].includes('aliases'));
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download-post').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), live + '.md');
  await page.locator('#unpublish-post').click();
  await expect(page.locator('#confirmation-dialog')).toBeVisible();
  await page.locator('#confirmation-accept').click();
  await expect.poll(async () => (await api('/api/posts')).posts.find((post) => post.slug === live)?.published).toBe(false);
  const saved = await api('/api/posts/' + live);
  assert.equal(saved.draft.body_markdown, updated);
  await api('/api/posts/' + live, 'DELETE', { etag: saved.etag });
  await api('/api/posts/' + occupied, 'DELETE', { etag: collision.etag });
  await context.close();
  assert.deepEqual(errors, [], engine + ' post address workflow has no uncaught errors');
}
