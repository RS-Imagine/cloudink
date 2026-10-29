import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { largeImage } from './image-optimizer.browser.mjs';

export async function verifyImagePerformance(browser, context, page, mf, origin) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const png = await largeImage(page);
  assert.ok(
    png.length > 5_000_000 && png.length < 10 * 1024 * 1024,
    'representative 5–10 MB source',
  );
  await page
    .locator('#image-library-files')
    .setInputFiles({ name: 'Landscape.png', mimeType: 'image/png', buffer: png });
  const card = page.locator('.image-card').filter({ hasText: 'Landscape.png' });
  await expect(card).toBeVisible({ timeout: 45000 });
  await expect(card.locator('.muted')).toContainText('网页');
  const key = await card.getAttribute('data-key'),
    bucket = await mf.getR2Bucket('STORAGE');
  const family = [key, ...[640, 1280, 1920].map((w) => key + '.w' + w + '.webp')];
  for (const item of family) assert.ok(await bucket.head(item), item);
  assert.match(await card.locator('img').getAttribute('src'), /\.w640\.webp/);
  const sourceBytes = (await bucket.head(key)).size;
  const session = await (await context.request.get(origin + '/api/session')).json();
  const headers = { Origin: origin, 'X-CSRF-Token': session.csrf };
  // Use Markdown links, so publishing itself must supply responsive attributes and dimensions.
  await page.locator('#new-post').click();
  await page.locator('#title').fill('Image performance fixture');
  const later = (
    await (
      await bucket.list({ prefix: 'uploads/' })
    ).objects.find((x) => x.key !== key && x.size < 100)
  ).key;
  await page
    .locator('#body')
    .fill(
      '![Landscape](/images/' +
        key +
        ')\n\n' +
        'A paragraph below the photograph.\n\n'.repeat(220) +
        '![Later](/images/' +
        later +
        ')',
    );
  await page.locator('#save-post').click();
  await expect(page.locator('#notice')).toContainText('草稿已保存');
  await page.locator('#publish-post').click();
  await expect(page.locator('#notice')).toContainText('发布', { timeout: 60000 });
  await expect
    .poll(
      async () => {
        const pointer = await bucket.get('state/published.json');
        if (!pointer) return false;
        const state = await pointer.json();
        return !!(await bucket.head('public/' + state.id + '/index.html'));
      },
      { timeout: 60000 },
    )
    .toBe(true);
  const posts = await (await context.request.get(origin + '/api/posts')).json();
  const post = posts.posts.find((p) => p.title === 'Image performance fixture');
  assert.ok(post?.published);
  const path = '/posts/' + post.slug + '/',
    published = await (await context.request.get(origin + path)).text();
  assert.match(published, /srcset="[^"]*\.w640\.webp 640w/);
  assert.match(published, /data-full-src=/);
  const metrics = [];
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    for (let repeat = 0; repeat < 3; repeat++)
      for (const mode of ['before', 'after']) {
        const reader = await browser.newContext({
          viewport,
          deviceScaleFactor: 1,
          serviceWorkers: 'block',
        });
        const tab = await reader.newPage(),
          client = await reader.newCDPSession(tab);
        try {
          await client.send('Network.enable');
          await client.send('Network.setCacheDisabled', { cacheDisabled: true });
          await client.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 80,
            downloadThroughput: 400000,
            uploadThroughput: 400000,
          });
          await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
          await tab.route('https://cdn.jsdelivr.net/**', (route) =>
            route.fulfill({ contentType: 'text/css', body: '' }),
          );
          await tab.route(origin + path, async (route) => {
            let body = published;
            if (mode === 'before')
              body = body.replace(/<img\b[^>]*>/g, (tag) =>
                tag.includes('Landscape')
                  ? tag
                      .replace(/ srcset="[^"]*"| sizes="[^"]*"| data-full-src="[^"]*"/g, '')
                      .replace(/ src="[^"]*"/, ' src="/images/' + key + '"')
                  : tag,
              );
            await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
          });
          await tab.addInitScript(() => {
            window.imageMetrics = { lcp: 0, cls: 0 };
            new PerformanceObserver((list) => {
              for (const item of list.getEntries()) window.imageMetrics.lcp = item.startTime;
            }).observe({ type: 'largest-contentful-paint', buffered: true });
            new PerformanceObserver((list) => {
              for (const item of list.getEntries())
                if (!item.hadRecentInput) window.imageMetrics.cls += item.value;
            }).observe({ type: 'layout-shift', buffered: true });
          });
          const requested = [];
          tab.on('request', (request) => {
            if (request.resourceType() === 'image') requested.push(request.url());
          });
          await tab.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
          const first = tab.locator('.article-body img').first();
          await expect(first).toBeVisible();
          await first.evaluate(async (img) => {
            await img.decode();
            window.imageReady = performance.now();
          });
          await tab.waitForTimeout(150);
          const sample = await first.evaluate((img) => {
            const resource = performance.getEntriesByName(img.currentSrc).at(-1);
            return {
              ...window.imageMetrics,
              imageReadyMs: window.imageReady,
              imageBytes: resource?.encodedBodySize,
              currentSrc: img.currentSrc,
              naturalWidth: img.naturalWidth,
            };
          });
          assert.ok(!requested.some((url) => url.includes(later)), 'distant image must stay lazy');
          if (mode === 'after') {
            assert.ok(sample.imageBytes < sourceBytes * 0.5);
            assert.match(
              sample.currentSrc,
              viewport.width === 390 ? /\.w640\.webp/ : /\.w1280\.webp/,
            );
            if (repeat === 0) {
              await tab.screenshot({
                path: 'cloud-web/dist/image-after-' + viewport.width + '.png',
              });
              await first.click();
              await expect(tab.locator('.image-lightbox a')).toHaveAttribute(
                'href',
                origin + '/images/' + key,
              );
              await tab.keyboard.press('Escape');
            }
          } else if (repeat === 0)
            await tab.screenshot({
              path: 'cloud-web/dist/image-before-' + viewport.width + '.png',
            });
          console.log('IMAGE_LAYOUT_SAMPLE ' + JSON.stringify({ mode, viewport: viewport.width, repeat, ...sample }));
          assert.ok(sample.cls < 0.02);
          metrics.push({ mode, viewport: viewport.width, repeat, ...sample });
        } finally {
          await reader.close();
        }
      }
  }
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const comparison = [390, 1440].map((width) => {
    const data = {};
    for (const mode of ['before', 'after']) {
      const samples = metrics.filter((item) => item.viewport === width && item.mode === mode);
      data[mode] = {
        imageBytes: median(samples.map((x) => x.imageBytes)),
        imageReadyMs: median(samples.map((x) => x.imageReadyMs)),
        lcpMs: median(samples.map((x) => x.lcp)),
        cls: Math.max(...samples.map((x) => x.cls)),
      };
    }
    assert.ok(
      data.after.imageReadyMs < data.before.imageReadyMs * 0.8,
      'image-ready improvement at fixed throughput',
    );
    return { width, ...data };
  });
  const report = {
    sourceBytes,
    source: 'fixed-seed 2048×1536 textured synthetic landscape PNG; not a real user photo',
    method:
      'same published article and image content; baseline uses the original without srcset; cold Chromium, 80ms latency, 400000 B/s, CPU 4×, DPR 1, 3 interleaved samples per viewport; lab results, not field CWV',
    comparison,
    samples: metrics,
  };
  await writeFile('cloud-web/dist/image-performance.json', JSON.stringify(report, null, 2));
  console.log('IMAGE_PERFORMANCE ' + JSON.stringify(report));
  // Backups retain all family objects. Restoring into an empty bucket reconstructs dimensions.
  const backup = await (await context.request.get(origin + '/api/backup')).json();
  assert.ok(family.every((item) => backup.images.some((image) => image.key === item)));
  const images = await (await context.request.get(origin + '/api/images')).json();
  const record = images.images.find((image) => image.key === key);
  assert.equal(images.images.filter((image) => family.includes(image.key)).length, 1);
  assert.equal(
    (await context.request.delete(origin + '/api/images', { headers, data: record })).status(),
    409,
  );
  assert.equal(
    (
      await context.request.delete(origin + '/api/images', {
        headers,
        data: { key: family[1], etag: (await bucket.head(family[1])).etag },
      })
    ).status(),
    400,
  );
  return report;
}
