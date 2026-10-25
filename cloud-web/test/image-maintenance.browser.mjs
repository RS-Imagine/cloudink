import assert from 'node:assert/strict';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';

export async function verifyImageMaintenance(context, page, mf, origin) {
  const bucket = await mf.getR2Bucket('STORAGE');
  const source = (await bucket.list({ prefix: 'uploads/' })).objects.find(
    (item) => item.size > 5_000_000,
  );
  assert.ok(source);
  const bytes = await (await bucket.get(source.key)).arrayBuffer();
  const keys = ['uploads/legacy-a.png', 'uploads/legacy-b.png'];
  for (const key of keys)
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { name: key.split('/').pop() },
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#images').click();
  await page.locator('#image-maintenance > summary').click();
  let release;
  await page.route('**/api/images/optimize', async (route) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await page.locator('#image-library-optimize').click();
  await expect(page.locator('#confirmation-dialog')).toContainText('2 张待检查');
  await acceptConfirmation(page);
  await expect.poll(() => typeof release).toBe('function');
  await page.locator('#image-library-pause').click();
  release();
  await expect(page.locator('#image-optimize-status')).toContainText('已暂停', { timeout: 60000 });
  assert.equal(
    (await bucket.list({ prefix: 'uploads/legacy-' })).objects.filter((item) =>
      item.key.endsWith('.w640.webp'),
    ).length,
    1,
  );
  await page.unroute('**/api/images/optimize');
  await page.reload();
  await expect(page.locator('#home-view')).toBeVisible();
  await page.locator('#images').click();
  await page.locator('#image-maintenance > summary').click();
  let fail = true;
  await page.route('**/api/images/optimize', (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 503, json: { error: 'Fixture retry' } });
    }
    return route.continue();
  });
  await page.locator('#image-library-optimize').click();
  await expect(page.locator('#confirmation-dialog')).toContainText('1 张待检查');
  await acceptConfirmation(page);
  await expect(page.locator('#image-optimize-status')).toContainText('失败 1 张', {
    timeout: 60000,
  });
  await expect(page.locator('#image-optimize-errors')).toContainText('Fixture retry');
  await page.locator('#image-library-optimize').click();
  await acceptConfirmation(page);
  await expect(page.locator('#image-optimize-status')).toContainText('优化 1 张', {
    timeout: 60000,
  });
  for (const key of keys) {
    assert.deepEqual(Buffer.from(await (await bucket.get(key)).arrayBuffer()), Buffer.from(bytes));
    assert.ok(await bucket.head(key + '.w1280.webp'));
  }
  await page.locator('#image-library-republish').click();
  await expect(page.locator('#confirmation-dialog')).toContainText('草稿和未发布设置不会上线');
  await acceptConfirmation(page);
  await expect(page.locator('#image-optimize-status')).toContainText('已发布页面已更新', {
    timeout: 60000,
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
    false,
  );
  await page.screenshot({ path: 'cloud-web/dist/image-maintenance-mobile.png', fullPage: true });
  const library = await (await context.request.get(origin + '/api/images')).json();
  assert.equal(
    library.images.filter((image) => keys.includes(image.key) && image.canOptimize).length,
    0,
  );
  console.log(
    JSON.stringify({
      legacyOptimization: true,
      pauseResume: true,
      failedRetry: true,
      originalsPreserved: true,
      rebuildPublishedOnly: true,
    }),
  );
}
