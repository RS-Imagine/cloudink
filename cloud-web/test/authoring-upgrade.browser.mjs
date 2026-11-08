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

export async function verifyAuthoringControls(browser, origin) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => localStorage.setItem('cloudink-split-percent', '35'));
  const page = await context.newPage();
  try {
    await page.goto(origin + '/admin');
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    await page.locator('#new-post').click();
    await page.locator('#title').fill('Authoring controls');
    const body = page.locator('#body');
    await body.fill('alpha\nbeta\ngamma');
    await body.evaluate((node) => node.setSelectionRange(0, 11));
    await body.press('Tab');
    await expect(body).toHaveValue('  alpha\n  beta\ngamma');
    await body.press('Shift+Tab');
    await expect(body).toHaveValue('alpha\nbeta\ngamma');
    for (const [format, expected] of [
      ['quote', '> alpha\n> beta'],
      ['ul', '- alpha\n- beta'],
      ['ol', '1. alpha\n2. beta'],
      ['link', '[alpha\nbeta](https://)'],
    ]) {
      await body.fill('alpha\nbeta');
      await body.evaluate((node) => node.setSelectionRange(0, node.value.length));
      await page.locator(`[data-format="${format}"]`).click();
      await expect(body).toHaveValue(expected);
    }
    await body.fill('2. second');
    await body.press('End');
    await body.press('Enter');
    await expect(body).toHaveValue('2. second\n3. ');
    await body.press('Enter');
    await expect(body).toHaveValue('2. second\n');
    await body.fill('- 中文输入');
    await body.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(body).toHaveValue('- 中文输入');
    await body.press('Control+/');
    await expect(page.locator('#shortcuts-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#shortcuts-dialog')).toBeHidden();
    await body.press('Control+p');
    await expect(page.locator('#show-preview')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Control+p');
    await expect(page.locator('#show-split')).toHaveAttribute('aria-pressed', 'true');
    await body.press('Control+Shift+F');
    await expect(page.locator('#app-view')).toHaveClass(/zen-mode/);
    await body.press('Escape');
    await expect(page.locator('#app-view')).not.toHaveClass(/zen-mode/);
    await body.press('Control+Enter');
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await expect(page.locator('#confirmation-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation-dialog')).toBeHidden();
    const panes = page.locator('#editor-panes'),
      splitter = page.locator('#editor-splitter');
    let bounds = await panes.boundingBox();
    const initial = await splitter.boundingBox();
    assert.ok(Math.abs(initial.x + initial.width / 2 - bounds.x - bounds.width * 0.35) < 4);
    await page.mouse.move(initial.x + initial.width / 2, initial.y + 20);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.6, initial.y + 20);
    await page.mouse.up();
    const resized = await splitter.boundingBox();
    bounds = await panes.boundingBox();
    assert.ok(Math.abs(resized.x + resized.width / 2 - bounds.x - bounds.width * 0.6) < 4);
    const text =
      '## Start\n\n```md\n# Literal code heading\n```\n\n' +
      Array.from(
        { length: 100 },
        (_, i) => `Paragraph ${i} ${'Long content '.repeat(12)}\n\n`,
      ).join('') +
      '## End marker';
    await body.fill(text);
    await expect(page.frameLocator('#preview-frame').locator('.article-body h2').last()).toHaveText(
      'End marker',
    );
    for (const fraction of [0.5, 1, 0]) {
      await body.evaluate((node, value) => {
        node.scrollTop = value * (node.scrollHeight - node.clientHeight);
        node.dispatchEvent(new Event('scroll'));
      }, fraction);
      await expect
        .poll(() =>
          page.evaluate((value) => {
            const frame = document.querySelector('#preview-frame'),
              max =
                frame.contentDocument.documentElement.scrollHeight -
                frame.contentWindow.innerHeight;
            return Math.abs(frame.contentWindow.scrollY / max - value);
          }, fraction),
        )
        .toBeLessThan(0.02);
    }
    await page.locator('#save-post').click();
    await expect(page.locator('#notice')).toContainText('草稿已保存');
  } finally {
    await context.close();
  }
}
