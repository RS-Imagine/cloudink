import assert from 'node:assert/strict';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';
import { navigateStudio } from './studio-navigation.mjs';

export async function verifyAuthoringContent(browser, origin, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(origin + '/admin');
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    const { csrf } = await (await page.request.get(origin + '/api/posts')).json();
    const slug = 'conversion-' + engine;
    const note = (body) => ({
      front_matter: { slug, date: '2030-02-03 12:34', draft: true },
      body_markdown: body,
    });
    let response = await page.request.put(origin + '/api/shorts/' + slug, {
      headers: { Origin: origin, 'X-CSRF-Token': csrf },
      data: note('Cached original'),
    });
    assert.equal(response.status(), 200);
    const { etag } = await response.json();
    await navigateStudio(page, 'shorts');
    const card = page.locator('.short-admin-card').filter({
      has: page.locator('#short-publish-' + slug),
    });
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.locator('#short-body')).toHaveValue('Cached original');
    await page.locator('#short-cancel').click();
    const body = '转换保留完整原稿和换行。\n'.repeat(50) + '\n```js\nconst x = 123;\n```';
    response = await page.request.put(origin + '/api/shorts/' + slug, {
      headers: { Origin: origin, 'X-CSRF-Token': csrf },
      data: { ...note(body), etag },
    });
    assert.equal(response.status(), 200);
    await card.getByRole('button', { name: '转为文章', exact: true }).click();
    await expect(page.locator('#editor-view')).toBeVisible();
    await expect(page.locator('#body')).toHaveValue(body);
    await expect(page.locator('#date')).toHaveValue('2030-02-03');
    const postSlug = await page.locator('#slug').inputValue();
    await expect
      .poll(async () => (await page.request.get(origin + '/api/posts/' + postSlug)).status())
      .toBe(200);
    const saved = await (await page.request.get(origin + '/api/posts/' + postSlug)).json();
    assert.equal(saved.draft.body_markdown, body);
    assert.equal(saved.draft.front_matter.draft, true);
    await navigateStudio(page, 'shorts');
    await context.route('**/api/shorts/' + slug, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Conversion read failed' }),
      }),
    );
    await card.getByRole('button', { name: '转为文章', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('Conversion read failed');
    await expect(page.locator('#shorts-view')).toBeVisible();
    await context.unroute('**/api/shorts/' + slug);
    await page.locator('#new-post').click();
    const imagePostSlug = await page.locator('#slug').inputValue();
    await page.locator('#title').fill('Using <template>');
    const original = '12345 保留选中的正文';
    await page.locator('#body').fill(original);
    await page.locator('#body').evaluate((node) => node.setSelectionRange(0, node.value.length));
    await context.route('**/api/upload', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Upload failed without changing text' }),
      }),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
      'base64',
    );
    await page.locator('#image-files').setInputFiles([
      { name: 'first.png', mimeType: 'image/png', buffer: png },
      { name: 'second.png', mimeType: 'image/png', buffer: png },
    ]);
    await expect(page.locator('#notice')).toContainText('Upload failed without changing text');
    await expect(page.locator('#body')).toHaveValue(original);
    await context.unroute('**/api/upload');
    await page.locator('#save-post').click();
    await expect(page.locator('#notice')).toContainText('草稿已保存');
    await navigateStudio(page, 'articles-nav');
    await expect(page.locator(`.article-card[data-slug="${imagePostSlug}"] h3`)).toHaveText(
      'Using <template>',
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
