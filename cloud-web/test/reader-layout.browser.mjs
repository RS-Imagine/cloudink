import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

// Exercise effects with normal motion: reduced-motion checks never enter the glass branch.
export async function verifyReaderLayout(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ...(engine === 'chromium' ? { isMobile: true } : {}),
    hasTouch: true,
    reducedMotion: 'no-preference',
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  try {
    await context.route('https://cdn.jsdelivr.net/**', (route) =>
      route.fulfill({ contentType: 'text/css', body: '' }),
    );
    const page = await context.newPage();
    const index = await (await context.request.get(origin + '/search_index.json')).json();
    assert.ok(index.length, 'The fixture needs one published article');
    for (const path of ['/', '/posts/' + index[0].slug + '/']) {
      await page.goto(origin + path);
      for (const width of [320, 390, 980, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((value) => CloudInkTheme.setMode(value), theme);
          for (const effects of ['glass', 'solid']) {
            await page.evaluate((value) => {
              document.documentElement.dataset.effects = value;
            }, effects);
            const header = page.locator('.reader-header');
            await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await expect(header).toHaveCSS('box-shadow', 'none');
            await expect(header).toHaveCSS('backdrop-filter', 'none');
            const bounds = await header.boundingBox();
            assert.ok(bounds.width <= width, engine + '/' + path + '/' + width);
          }
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => CloudInkTheme.setMode('light'));
    await page.screenshot({
      path: resolve(output, 'reader-header-' + engine + '-390.png'),
      animations: 'disabled',
    });
  } finally {
    await context.close();
  }
}
