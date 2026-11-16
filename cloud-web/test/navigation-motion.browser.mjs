import assert from 'node:assert/strict';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';

const idle = (page) =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const { springs, effects, framePending } = CloudInkMotion.stats();
        return springs + effects + Number(framePending);
      }),
    )
    .toBe(0);

async function capture(page, { navigation, selected, content, horizontal, contentAxis = 0 }) {
  await page.evaluate(
    ({ navigation, selected, content, horizontal, contentAxis }) => {
      const nav = document.querySelector(navigation);
      const target = nav.querySelector(selected);
      window.navigationMotion = new Promise((resolve) => {
        const samples = [];
        const started = performance.now();
        const timeout = setTimeout(() => resolve(samples), 4000);
        function sample() {
          if (target.matches('[aria-current],[aria-pressed="true"]')) {
            const indicator = nav.querySelector('.ci-selection');
            const matrix = new DOMMatrix(getComputedStyle(indicator).transform);
            const position = horizontal ? matrix.m41 : matrix.m42;
            const destination = horizontal ? target.offsetLeft : target.offsetTop;
            const node = document.querySelector(content);
            const translate = getComputedStyle(node).translate.split(' ').map(parseFloat);
            samples.push({
              error: position - destination,
              translate: translate[contentAxis] || 0,
              overflow: document.documentElement.scrollWidth > innerWidth,
            });
            const stats = CloudInkMotion.stats();
            if (samples.length > 2 && !stats.springs && !stats.effects && !stats.framePending) {
              clearTimeout(timeout);
              return resolve(samples);
            }
          }
          if (performance.now() - started > 4000) return resolve(samples);
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
    },
    { navigation, selected, content, horizontal, contentAxis },
  );
}

async function assertRebound(page) {
  const samples = await page.evaluate(() => window.navigationMotion);
  assert.ok(
    samples.some((sample) => sample.error < -1),
    'Selection must travel to the new item',
  );
  assert.ok(
    samples.some((sample) => sample.error > 0.2),
    'Selection must visibly overshoot',
  );
  assert.ok(
    samples.some((sample) => Math.abs(sample.translate) > 2),
    'The incoming content must move, rather than only fade',
  );
  assert.ok(
    samples.some((sample) => sample.translate < -0.1),
    'The incoming content must rebound before settling',
  );
  assert.ok(
    samples.every((sample) => !sample.overflow),
    'Keep horizontal overflow clipped in motion',
  );
  await idle(page);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Animated content must not create horizontal scrolling',
  );
}

export async function verifyNavigationMotion(browser, origin) {
  const context = await browser.newContext({ reducedMotion: 'no-preference' });
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  await context.route('https://unpkg.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + '/');
      await idle(page);
      const navigation = width > 767 ? '.reader-side-nav' : '.reader-dock';
      for (const key of ['posts', 'shorts']) {
        const selected = `[data-reader-nav="${key}"]`;
        await capture(page, {
          navigation,
          selected,
          content: '#reader-center-content',
          horizontal: width < 768,
        });
        await page.locator(navigation + ' ' + selected).click();
        await expect(page.locator('#swup')).toHaveAttribute('data-page', key);
        await assertRebound(page);
      }
      // Retarget a running navigation, then finish immediately when motion is reduced.
      await page.locator(navigation + ' [data-reader-nav="posts"]').click();
      await expect(page.locator('#swup')).toHaveAttribute('data-page', 'posts');
      await page.locator(navigation + ' [data-reader-nav="shorts"]').click();
      await expect(page.locator('#swup')).toHaveAttribute('data-page', 'shorts');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await idle(page);
      await page.goBack();
      await expect(page.locator('#swup')).toHaveAttribute('data-page', 'posts');
      await idle(page);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

export async function verifyStudioMotion(page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#articles-nav').click();
    await idle(page);
    await capture(page, {
      navigation: '.studio-nav',
      selected: '[data-studio-nav="shorts"]',
      content: '#shorts-view',
      contentAxis: 1,
      horizontal: width < 768,
    });
    await page.locator('#shorts').click();
    await expect(page.locator('#shorts-view')).toBeVisible();
    await assertRebound(page);
    await page.locator('#images').click();
    await page.locator('#settings').click();
    await expect(page.locator('#settings-view')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await idle(page);
    await page.locator('#articles-nav').click();
    await idle(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
