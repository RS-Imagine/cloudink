import assert from 'node:assert/strict';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

// Compare the live head to the independently served destination HTML.
function snapshot(html) {
  const doc = html === null ? document : new DOMParser().parseFromString(html, 'text/html');
  const values = [
    ...doc.head.querySelectorAll(
      'meta[name="description"],meta[name="author"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"],script[type="application/ld+json"]',
    ),
  ].map((node) => {
    if (node.tagName === 'LINK') return ['canonical', node.getAttribute('href')];
    if (node.tagName === 'SCRIPT') return ['jsonld', JSON.parse(node.textContent)];
    return [
      node.getAttribute('property') || node.getAttribute('name'),
      node.getAttribute('content'),
    ];
  });
  return { title: doc.title, values: values.sort((a, b) => a[0].localeCompare(b[0])) };
}
export async function verifyReaderMetadata(browser, origin) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const targets = ['/', '/posts/slow-days/', '/archive/'];
    await page.goto(origin + '/');
    await page.evaluate(() => {
      window.__metadataDocument = 'same-document';
    });
    const expected = {};
    for (const target of targets) {
      const response = await context.request.get(origin + target);
      assert.equal(response.status(), 200);
      expected[target] = await page.evaluate(snapshot, await response.text());
    }
    async function check(target) {
      await expect(page).toHaveURL(origin + target);
      await expect.poll(() => page.evaluate(snapshot, null)).toEqual(expected[target]);
      assert.equal(await page.evaluate(() => window.__metadataDocument), 'same-document');
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    }
    async function follow(target) {
      await page.evaluate((href) => {
        document.getElementById('metadata-next')?.remove();
        const a = document.createElement('a');
        a.id = 'metadata-next';
        a.href = href;
        a.textContent = 'Next metadata fixture';
        document.querySelector('#swup').prepend(a);
      }, target);
      await page.locator('#metadata-next').click();
    }
    await follow(targets[1]);
    await check(targets[1]);
    assert.ok(await page.locator('meta[property="og:image"]').count(), 'article cover fixture');
    await follow(targets[2]);
    await check(targets[2]);
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
    await expect(page.locator('meta[name="twitter:image"]')).toHaveCount(0);
    await page.goBack();
    await check(targets[1]);
    await page.goForward();
    await check(targets[2]);
    // Cached destinations must use metadata from the same cached HTML.
    await follow(targets[1]);
    await check(targets[1]);

    await context.route('**/metadata-failure/', (route) =>
      route.fulfill({ status: 503, body: 'Unavailable' }),
    );
    await follow('/metadata-failure/');
    await expect(page.locator('#reader-navigation-status')).toContainText('打开失败');
    await check(targets[1]);

    let releaseSlow;
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    await context.route('**/metadata-delayed/', async (route) => {
      await slow;
      await route
        .fulfill({
          contentType: 'text/html',
          body: '<html><head><title>Late stale page</title><meta name="description" content="stale"></head><body><main id="swup">Late</main></body></html>',
        })
        .catch(() => {});
    });
    await follow('/metadata-delayed/');
    await expect(page.locator('#swup')).toHaveAttribute('aria-busy', 'true');
    await follow(targets[2]);
    await check(targets[2]);
    releaseSlow();
    await page.waitForTimeout(150);
    await check(targets[2]);

    // A destination lacking social/schema tags must remove, not inherit, them.
    await context.route(
      (url) => url.pathname === '/metadata-minimal/',
      (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><head><title>Minimal page</title><meta name="description" content="Minimal"></head><body><main id="swup">Minimal content</main></body></html>',
        }),
    );
    await follow('/metadata-minimal/?preview=1#content');
    await expect(page.locator('#swup')).toHaveText('Minimal content');
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
      'href',
      origin + '/metadata-minimal/',
    );
    await expect(
      page.locator(
        'meta[property^="og:"],meta[name^="twitter:"],script[type="application/ld+json"]',
      ),
    ).toHaveCount(0);
    await expect(page).toHaveTitle('Minimal page');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
