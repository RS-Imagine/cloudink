// Shared expressive surfaces, tested only against the local UI audit fixture.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

async function filter(locator) {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return style.backdropFilter || style.webkitBackdropFilter || 'none';
  });
}
async function openReaderMenu(page) {
  const menu = page.locator('#reader-menu');
  if (!(await menu.evaluate((node) => node.open))) await menu.locator('summary').click();
  await expect(menu).toHaveAttribute('open', '');
}
async function closeReaderMenu(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('#reader-menu')).not.toHaveAttribute('open', '');
}
async function checkArea(page) {
  const area = await page.locator('body,body *').evaluateAll((nodes) => {
    let area = 0;
    for (const node of nodes) {
      const style = getComputedStyle(node);
      const filter = style.backdropFilter || style.webkitBackdropFilter || 'none';
      if (filter === 'none' || style.visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      const width = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
      const height = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
      area += width * height;
    }
    return area / (innerWidth * innerHeight);
  });
  assert.ok(area <= 0.18, 'Blurred surfaces must occupy at most 18% of the viewport: ' + area);
  return area;
}
async function contrast(page, selector) {
  return page.locator(selector).evaluate((node) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].map((v) => v / 255);
    };
    const luma = (rgb) =>
      rgb
        .slice(0, 3)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const style = getComputedStyle(node),
      root = getComputedStyle(document.documentElement);
    const bg = rgba(style.backgroundColor);
    return ['--ci-text', '--ci-muted'].flatMap((token) => {
      const fg = luma(rgba(root.getPropertyValue(token)));
      return [0, 1].map((backdrop) => {
        const lum = luma(bg.slice(0, 3).map((v) => v * bg[3] + backdrop * (1 - bg[3])));
        return { token, backdrop, ratio: (Math.max(fg, lum) + 0.05) / (Math.min(fg, lum) + 0.05) };
      });
    });
  });
}
async function frameSample(page) {
  return page.evaluate(async () => {
    const intervals = [];
    let previous;
    for (let i = 0; i < 100; i++) {
      const now = await new Promise(requestAnimationFrame);
      if (i > 9) intervals.push(now - previous);
      previous = now;
      window.scrollTo({ top: (i % 60) * 16, behavior: 'instant' });
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    return {
      frames: sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted.at(-1),
      over50: sorted.filter((n) => n > 50).length,
    };
  });
}
export async function verifySurfaces(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'no-preference',
    colorScheme: 'light',
  });
  const errors = [];
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  // Deterministic capability inputs; real-device performance is a separate acceptance step.
  await context.addInitScript(() => {
    window.__surfaceMemory = 8;
    Object.defineProperty(navigator, 'deviceMemory', {
      configurable: true,
      get: () => window.__surfaceMemory,
    });
    const connection = Object.assign(new EventTarget(), { saveData: false });
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
    window.__setSurfaceSaveData = (value) => {
      connection.saveData = value;
      connection.dispatchEvent(new Event('change'));
    };
    const nativeMatch = window.matchMedia.bind(window),
      signals = new Map();
    window.matchMedia = (query) => {
      if (!['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)'].includes(query))
        return nativeMatch(query);
      if (!signals.has(query))
        signals.set(query, Object.assign(new EventTarget(), { matches: false, media: query }));
      return signals.get(query);
    };
    window.__setSurfaceMedia = (query, value) => {
      const signal = window.matchMedia(query);
      signal.matches = value;
      signal.dispatchEvent(new Event('change'));
    };
  });
  const page = await context.newPage(),
    root = page.locator('html');
  await page.goto(origin + '/');
  const supported = await page.evaluate(
    () =>
      CSS.supports('color', 'color-mix(in srgb, black, transparent)') &&
      (CSS.supports('backdrop-filter', 'blur(1px)') ||
        CSS.supports('-webkit-backdrop-filter', 'blur(1px)')),
  );
  const enabled = supported ? 'glass' : 'solid';
  await expect(root).toHaveAttribute('data-effects', enabled);
  await expect(page.locator('[data-effects-control]')).toBeVisible();
  await page.locator('select[data-effects-mode]').selectOption('off');
  await page.reload();
  await expect(root).toHaveAttribute('data-effects-mode', 'off');
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.locator('.post-card h2 a').first().click();
  await expect(page.locator('article h1')).toBeVisible();
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.locator('select[data-effects-mode]').selectOption('auto');
  await expect(root).toHaveAttribute('data-effects', enabled);
  const contrasts = [],
    areas = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => CloudInkTheme.setMode(theme), theme);
    await page.evaluate(() => CloudInkTheme.setEffects('auto'));
    await expect(root).toHaveAttribute('data-effects', enabled);
    for (const palette of ['ink', 'neutral']) {
      await page.evaluate((palette) => CloudInkTheme.setPalette(palette), palette);
      await openReaderMenu(page);
      if (supported) {
        const details = await page.locator('.reader-menu-links').evaluate((node) => ({
          root: { ...document.documentElement.dataset },
          open: node.parentElement.open,
          blur: getComputedStyle(node).getPropertyValue('--ci-glass-blur'),
          background: getComputedStyle(node).backgroundColor,
          supports: CSS.supports(
            '((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) and (color: color-mix(in srgb, black, transparent))',
          ),
        }));
        assert.notEqual(
          await filter(page.locator('.reader-menu-links')),
          'none',
          JSON.stringify(details),
        );
        contrasts.push(...(await contrast(page, '.reader-menu-links')));
      }
      areas.push(await checkArea(page));
      await closeReaderMenu(page);
    }
    await page.evaluate(() => CloudInkTheme.setPalette('ink'));
    for (const mode of ['auto', 'off']) {
      await page.evaluate((mode) => CloudInkTheme.setEffects(mode), mode);
      await openReaderMenu(page);
      if (mode === 'off') assert.equal(await filter(page.locator('.reader-menu-links')), 'none');
      await page.screenshot({
        path: resolve(output, 'surface-reader-' + mode + '-' + theme + '-' + engine + '.png'),
        fullPage: false,
      });
      await closeReaderMenu(page);
    }
  }
  for (const pair of contrasts) assert.ok(pair.ratio >= 4.5, JSON.stringify(pair));
  await page.evaluate(() => CloudInkTheme.setEffects('auto'));
  for (const query of ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)']) {
    await page.evaluate((query) => __setSurfaceMedia(query, true), query);
    await expect(root).toHaveAttribute('data-effects', 'solid');
    await page.evaluate((query) => __setSurfaceMedia(query, false), query);
    await expect(root).toHaveAttribute('data-effects', enabled);
  }
  await page.evaluate(() => __setSurfaceSaveData(true));
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.evaluate(() => __setSurfaceSaveData(false));
  await expect(root).toHaveAttribute('data-effects', enabled);
  await page.evaluate(() => {
    window.__surfaceMemory = 4;
    CloudInkTheme.setEffects('auto');
  });
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.evaluate(() => {
    window.__surfaceMemory = 8;
    CloudInkTheme.setEffects('auto');
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(root).toHaveAttribute('data-effects', enabled);
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.emulateMedia({ forcedColors: 'none' });
  await expect(root).toHaveAttribute('data-effects', enabled);
  // Preference sync and deletion from a second same-origin tab.
  const second = await context.newPage();
  await second.goto(origin + '/');
  await second.evaluate(() => CloudInkTheme.setEffects('off'));
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await second.evaluate(() => localStorage.removeItem('cloudink-effects'));
  await expect(root).toHaveAttribute('data-effects', enabled);
  await second.close();
  await page.locator('#site-search-btn').click();
  assert.equal(await filter(page.locator('#search-modal')), 'none', 'Large dialogs remain opaque');
  await page.keyboard.press('Escape');
  await page.goto(origin + '/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#app-view')).toHaveAttribute('data-view', 'home');
  // A navigating iframe can briefly have a document without its root element.
  await page.frameLocator('#preview-frame').locator('html').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    const preview = document.getElementById('preview-frame').contentDocument;
    const html = preview.documentElement;
    html.remove();
    try {
      CloudInkTheme.setMode('dark');
    } finally {
      preview.append(html);
    }
    CloudInkTheme.setMode('light');
  });
  await expect(page.frameLocator('#preview-frame').locator('html')).toHaveAttribute(
    'data-theme',
    'light',
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => CloudInkTheme.setMode(theme), theme);
    for (const mode of ['auto', 'off']) {
      await page.evaluate((mode) => CloudInkTheme.setEffects(mode), mode);
      if (mode === 'off') assert.equal(await filter(page.locator('.studio-nav')), 'none');
      else if (supported) {
        assert.notEqual(await filter(page.locator('.studio-nav')), 'none');
        for (const pair of await contrast(page, '.studio-nav'))
          assert.ok(pair.ratio >= 4.5, JSON.stringify(pair));
      }
      areas.push(await checkArea(page));
      await page.screenshot({
        path: resolve(output, 'surface-admin-' + mode + '-' + theme + '-' + engine + '.png'),
        fullPage: false,
      });
    }
  }
  await page.locator('#settings').click();
  await page.locator('select[data-effects-mode]').selectOption('off');
  await page.reload();
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await expect(page.locator('#app-view')).toHaveAttribute('data-view', 'home');
  await page.locator('#settings').click();
  await expect(page.locator('#settings-view')).toBeVisible();
  const timing = {};
  if (engine === 'chromium') {
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    for (const mode of ['off', 'auto']) {
      await page.evaluate((mode) => CloudInkTheme.setEffects(mode), mode);
      timing[mode] = await frameSample(page);
    }
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await session.detach();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#studio-tools summary').click();
  await page.evaluate(() => CloudInkTheme.setEffects('auto'));
  if (supported)
    assert.notEqual(await filter(page.locator('#studio-tools > .studio-tools-panel')), 'none');
  areas.push(await checkArea(page));
  await page.keyboard.press('Escape');
  // The bootstrap must remain usable when CSS support or storage is denied.
  await context.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args) =>
      args.some((v) => String(v).includes('backdrop-filter')) ? false : supports(...args);
    for (const key of ['getItem', 'setItem'])
      Object.defineProperty(Storage.prototype, key, {
        configurable: true,
        value() {
          throw new DOMException('Unavailable', 'SecurityError');
        },
      });
  });
  await page.goto(origin + '/');
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.locator('select[data-effects-mode]').selectOption('off');
  await page.locator('select[data-effects-mode]').selectOption('auto');
  await expect(root).toHaveAttribute('data-effects', 'solid');
  await page.locator('.post-card h2 a').first().click();
  await expect(page.locator('article h1')).toBeVisible();
  await context.close();
  const staticContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  await staticContext.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const staticPage = await staticContext.newPage();
  await staticPage.goto(origin + '/');
  await expect(staticPage.locator('[data-effects-control]')).toBeHidden();
  await staticPage.locator('#reader-menu summary').click();
  assert.equal(await filter(staticPage.locator('.reader-menu-links')), 'none');
  await staticPage.locator('.post-card h2 a').first().click();
  await expect(staticPage.locator('article h1')).toBeVisible();
  await staticContext.close();
  assert.deepEqual(errors, [], engine + ' expressive surfaces must not throw browser errors');
  return {
    engine,
    supportsGlass: supported,
    maxBlurArea: Math.max(...areas),
    contrast: contrasts,
    cpu4xScroll: timing,
  };
}
