import { navigateStudio } from './studio-navigation.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function verifyUiStability(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [],
    releases = [];
  page.on('pageerror', (error) => errors.push(error.message));
  function gate() {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    releases.push(release);
    return { promise, release };
  }
  let galleryGate,
    thumbnailGate,
    uploadGate,
    saveGate,
    failGallery = false;
  let manifest, source;
  await context.route(
    (url) => url.pathname === '/api/images',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      if (galleryGate) await galleryGate.promise;
      return failGallery
        ? route.fulfill({ status: 503, json: { error: 'Temporary gallery refresh failure' } })
        : route.fulfill({ json: manifest });
    },
  );
  await context.route(
    (url) => url.pathname === '/api/image',
    async (route) => {
      if (thumbnailGate) await thumbnailGate.promise;
      return route.continue().catch(() => {});
    },
  );
  await context.route(
    (url) => url.pathname === '/api/upload',
    async (route) => {
      if (uploadGate) await uploadGate.promise;
      // Reuse the existing ephemeral photo instead of changing the shared image inventory.
      return route.fulfill({ json: source });
    },
  );
  await context.route(
    (url) => /^\/api\/posts\/[^/]+$/.test(url.pathname),
    async (route) => {
      if (saveGate && route.request().method() === 'PUT') await saveGate.promise;
      return route.continue().catch(() => {});
    },
  );
  async function bounds(id) {
    return page.locator('#' + id).evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const icon = button.querySelector('svg')?.getBoundingClientRect();
      return { width: rect.width, height: rect.height, icon: icon?.width };
    });
  }
  async function stable(id, before) {
    await expect(page.locator('#' + id)).toHaveAttribute('aria-busy', 'true');
    const after = await bounds(id);
    const labelFits = await page.locator('#' + id).evaluate((button) => {
      const label = button.querySelector('[data-action-label]');
      if (!label || getComputedStyle(label).display === 'none') return true;
      return label.getBoundingClientRect().right <= button.getBoundingClientRect().right + 1;
    });
    assert.ok(labelFits, id + ' keeps loading text inside the button');
    assert.ok(Math.abs(before.width - after.width) <= 1, id + ' keeps its width');
    assert.ok(Math.abs(before.height - after.height) <= 1, id + ' keeps its height');
    if (before.icon) assert.ok(Math.abs(before.icon - after.icon) <= 1, id + ' keeps its icon');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  try {
    await page.goto(origin + '/admin');
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    const response = await page.request.get(origin + '/api/images');
    source = (await response.json()).images[0];
    assert.ok(source, 'the isolated fixture supplies a real managed image');
    manifest = {
      images: Array.from({ length: 6 }, (_, index) => ({
        ...source,
        key: source.key + '-ui-' + index,
        thumbnailKey: source.thumbnailKey || source.key,
        name: index === 5 ? 'Long-Photo-Name-'.repeat(6) + '.png' : '照片 ' + (index + 1),
        width: source.width || 640,
        height: source.height || 480,
        references: index ? source.references : [],
      })),
      referencesChecked: true,
      referenceError: '',
      cursor: null,
    };
    galleryGate = gate();
    thumbnailGate = gate();
    const nav = await bounds('images');
    await navigateStudio(page, 'images');
    await stable('images', nav);
    await expect(page.locator('.image-skeleton')).toHaveCount(6);
    await expect(page.locator('#image-library-empty')).toBeHidden();
    assert.equal(await page.locator('.image-skeleton button').count(), 0);
    galleryGate.release();
    galleryGate = null;
    await expect(page.locator('#image-library-grid')).toHaveAttribute('aria-busy', 'false');
    const thumb = page.locator('.image-thumbnail').first();
    const placeholder = await thumb.boundingBox();
    await expect(thumb.locator('img')).toHaveAttribute('width', String(manifest.images[0].width));
    thumbnailGate.release();
    thumbnailGate = null;
    await expect(thumb.locator('img')).toHaveClass('is-ready');
    const loaded = await thumb.boundingBox();
    assert.equal(placeholder.height, loaded.height, 'decoding preserves thumbnail height');

    for (const width of [1440, 390, 360, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.locator('#image-library-refresh').scrollIntoViewIfNeeded();
      const before = await bounds('image-library-refresh');
      const upload = await bounds('image-library-upload');
      await page.evaluate(() => {
        window.__galleryCard = document.querySelector('.image-card');
      });
      galleryGate = gate();
      await page.locator('#image-library-refresh').click();
      await stable('image-library-refresh', before);
      assert.deepEqual(
        await bounds('image-library-upload'),
        upload,
        'refresh does not resize its neighbor',
      );
      assert.ok(
        await page.evaluate(() => window.__galleryCard === document.querySelector('.image-card')),
        'refresh preserves existing card DOM',
      );
      await expect(page.locator('.image-card')).toHaveCount(6);
      await expect(page.locator('.image-actions .danger').first()).toBeDisabled();
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: resolve(output, 'gallery-pending-' + engine + '-' + width + '.png'),
          fullPage: true,
        });
      galleryGate.release();
      galleryGate = null;
      await expect(page.locator('#image-library-grid')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('.image-actions .danger').first()).toBeEnabled();
      if (width < 760) {
        const columns = await page
          .locator('.image-card')
          .first()
          .evaluate((card) => getComputedStyle(card).gridTemplateColumns);
        assert.equal(
          columns.split(' ').length,
          2,
          'mobile card has a thumbnail and content column',
        );
        const image = await page.locator('.image-thumbnail').first().boundingBox();
        assert.ok(image.width <= 96 && image.height <= 96, 'mobile thumbnail stays compact');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    failGallery = true;
    await page.locator('#image-library-refresh').click();
    await expect(page.locator('#image-library-retry')).toBeVisible();
    await expect(page.locator('.image-card')).toHaveCount(6);
    await expect(page.locator('.image-actions .danger').first()).toBeDisabled();
    failGallery = false;
    await page.locator('#image-library-retry').click();
    await expect(page.locator('#image-library-grid')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.image-actions .danger').first()).toBeEnabled();

    await navigateStudio(page, 'articles-nav');
    await page.locator('#new-post').click();
    await page.locator('#title').fill('UI stability ' + engine);
    await page.locator('#body').fill('Keep this draft and its cursor.');
    await page.locator('#save-post').click();
    await expect(page.locator('#save-state')).toHaveAttribute('data-tone', 'success');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfYQAAAAASUVORK5CYII=',
      'base64',
    );
    for (const width of [1440, 390, 360, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.locator('#upload-image').scrollIntoViewIfNeeded();
      const before = await bounds('upload-image');
      const neighbor = await bounds('choose-library-image');
      uploadGate = gate();
      await page
        .locator('#image-files')
        .setInputFiles({ name: 'loading.png', mimeType: 'image/png', buffer: png });
      await stable('upload-image', before);
      assert.deepEqual(await bounds('choose-library-image'), neighbor);
      uploadGate.release();
      uploadGate = null;
      await expect(page.locator('#upload-image')).not.toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#upload-image svg')).toHaveCount(1);
      saveGate = gate();
      await page.locator('#body').fill('Retain unsaved editor content at ' + width);
      const choose = await bounds('choose-library-image');
      await page.locator('#choose-library-image').click();
      await stable('choose-library-image', choose);
      if (width === 390)
        await page.screenshot({
          path: resolve(output, 'toolbar-pending-' + engine + '-390.png'),
          fullPage: true,
        });
      saveGate.release();
      saveGate = null;
      await expect(page.locator('#images-view')).toBeVisible();
      await expect(page.locator('#image-library-grid')).toHaveAttribute('aria-busy', 'false');
      await page.locator('#image-library-back').click();
      await expect(page.locator('#body')).toHaveValue('Retain unsaved editor content at ' + width);
    }
    await page.locator('#delete-post').click();
    await page.locator('#confirmation-accept').click();
    await expect(page.locator('#home-view')).toBeVisible();
    assert.deepEqual(errors, []);
  } finally {
    for (const release of releases) release();
    await context.close();
  }
}
