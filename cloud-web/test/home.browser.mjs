// V4 public-shell regression: actual pages, real URLs, and native-navigation fallback.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

export async function verifyHome(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(origin + '/');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('.home-feature')).toHaveCount(1);
    await expect(page.locator('.reader-side-nav [aria-current]')).toHaveAttribute(
      'data-reader-nav',
      'home',
    );
    assert.equal(await page.locator('a[href^="/admin"]').count(), 0);
    const target = await page.locator('.home-feature h2 a').getAttribute('href');
    await page.evaluate(() => {
      window.v4Nodes = {
        left: document.getElementById('primary-nav'),
        html: document.getElementById('primary-nav').outerHTML,
        center: document.getElementById('reader-center'),
        right: document.getElementById('reader-context'),
      };
    });
    await page.screenshot({ path: resolve(output, 'v4-home-' + engine + '-1440.png') });
    await page.locator('.home-feature h2 a').click();
    await expect(page.locator('.article-body')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('#reader-context .article-info-panel')).toBeVisible();
    assert.equal(new URL(page.url()).pathname, target);
    assert(
      await page.evaluate(
        () =>
          v4Nodes.left === document.getElementById('primary-nav') &&
          v4Nodes.center === document.getElementById('reader-center') &&
          v4Nodes.right === document.getElementById('reader-context') &&
          v4Nodes.html === document.getElementById('primary-nav').outerHTML,
      ),
    );
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('a[href^="/admin"]').count(), 0);
    await page.screenshot({ path: resolve(output, 'v4-reading-' + engine + '-1440.png') });
    await page.goBack();
    await expect(page.locator('.home-feature')).toBeVisible();
    await page.goForward();
    await expect(page.locator('.article-body')).toBeVisible();
    await page.reload();
    await expect(page.locator('.article-body')).toBeVisible();
    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (width < 1024) {
        await expect(page.locator('#reader-context')).toBeHidden();
        if (await page.locator('.mobile-toc-btn').count()) {
          await page.locator('.mobile-toc-btn').click();
          await expect(page.locator('.toc-container')).toHaveAttribute('aria-modal', 'true');
          await page.keyboard.press('Escape');
          await expect(page.locator('.mobile-toc-btn')).toHaveAttribute('aria-expanded', 'false');
        }
      }
      if (width === 390)
        await page.screenshot({ path: resolve(output, 'v4-reading-' + engine + '-390.png') });
    }
    await page.goto(origin + '/');
    await page.locator('#site-search-btn').click();
    await expect(page.locator('#search-input')).toBeFocused();
    const index = await (await page.request.get(origin + '/search_index.json')).json();
    const sample = index
      .map((post) => {
        const metadata = (post.title + ' ' + post.description).toLowerCase();
        const keyword = (post.body.match(/[\p{L}\p{N}_]{6,}/gu) || [])
          .map((word) => word.slice(0, 24))
          .find((word) => !metadata.includes(word.toLowerCase()));
        return keyword ? { post, keyword } : null;
      })
      .find(Boolean);
    assert(sample, 'The fixture must contain a searchable body-only keyword');
    await page.locator('#search-input').fill(sample.keyword);
    await expect(
      page.locator('#search-results a[href="/posts/' + sample.post.slug + '/"]'),
    ).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#site-search-btn')).toBeFocused();
    await page.locator('#theme-toggle-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: resolve(output, 'v4-home-' + engine + '-320-dark.png') });
    // Both navigation surfaces open a real, complete list, including direct reloads.
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(origin + '/');
      const navigation = page.locator(width >= 768 ? '.reader-side-nav' : '.reader-dock');
      await navigation.locator('[data-reader-nav="posts"]').click();
      await expect(page).toHaveURL(origin + '/post/');
      await expect(page.locator('.post-index')).toBeVisible();
      await expect(navigation.locator('[data-reader-nav="posts"]')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.locator('.post-index-list h2 a')).toHaveCount(Math.min(10, index.length));
      const last = page.locator('.post-index-list h2 a').last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.reload();
      await expect(page.locator('.post-index-list h2 a')).toHaveCount(Math.min(10, index.length));
      await page.locator('.post-index-list h2 a').first().click();
      await expect(page.locator('.article-body')).toBeVisible();
      await page.locator('.article-back').click();
      await expect(page).toHaveURL(origin + '/post/');
      await expect(page.locator('.post-index-list h2 a')).toHaveCount(Math.min(10, index.length));
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  const native = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await native.newPage();
    await page.goto(origin + '/');
    await page.locator('.reader-dock [data-reader-nav="posts"]').click();
    await expect(page).toHaveURL(origin + '/post/');
    await page.locator('.post-index-list h2 a').first().click();
    await expect(page.locator('.article-body')).toBeVisible();
    assert.equal(await page.locator('a[href^="/admin"]').count(), 0);
  } finally {
    await native.close();
  }
}
