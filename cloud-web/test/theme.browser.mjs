// Imported by the isolated three-engine UI audit; never contacts a deployed Worker.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function verifyThemes(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  const root = page.locator('html');
  const mode = page.locator('select[data-theme-mode]');
  await page.goto(origin + '/');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(root).toHaveAttribute('data-theme-mode', 'auto');
  await expect(mode).toHaveValue('auto');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(20, 27, 23)');
  await mode.selectOption('light');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await mode.selectOption('auto');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.locator('.post-card h2 a').first().click();
  await expect(page.locator('article h1')).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(mode).toHaveValue('auto');
  await page.keyboard.press('Tab');
  await mode.focus();
  await expect(mode).toBeFocused();
  await expect(mode).toHaveCSS('outline-style', 'solid');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: resolve(output, 'theme-' + engine + '-mobile-dark.png'),
    fullPage: true,
  });
  // Reader mode and the admin cache must not override the published author palette.
  await page.evaluate(() => localStorage.setItem('cloudink-admin-palette', 'neutral'));
  await page.reload();
  await expect(root).toHaveAttribute('data-palette', 'ink');
  await page.goto(origin + '/admin');
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(root).toHaveAttribute('data-palette', 'neutral');
  await page.locator('[data-theme-toggle]').first().click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await context.close();

  // Denied storage must preserve system following, navigation and manual theme changes.
  const blocked = await browser.newContext({ colorScheme: 'dark' });
  blocked.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  await blocked.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  await blocked.addInitScript(() => {
    for (const key of ['getItem', 'setItem'])
      Object.defineProperty(Storage.prototype, key, {
        configurable: true,
        value() {
          throw new DOMException('Unavailable', 'SecurityError');
        },
      });
  });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(origin + '/');
  await expect(blockedPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await blockedPage.locator('select[data-theme-mode]').selectOption('light');
  await expect(blockedPage.locator('html')).toHaveAttribute('data-theme', 'light');
  await blocked.close();

  const noScript = await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark' });
  await noScript.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const staticPage = await noScript.newPage();
  await staticPage.goto(origin + '/');
  await expect(staticPage.locator('body')).toHaveCSS('background-color', 'rgb(20, 27, 23)');
  await staticPage.locator('.post-card h2 a').first().click();
  await expect(staticPage.locator('article h1')).toBeVisible();
  await noScript.close();
  await verifyPalettePicker(browser, origin, output, engine);
  assert.deepEqual(errors, [], 'Theme smoke must have no browser errors: ' + engine);
}

async function verifyPalettePicker(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(origin + '/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#home-view')).toBeVisible();
  await page.locator('#settings').click();
  const root = page.locator('html');
  const radios = page.locator('input[name=themePalette]');
  const palettes = ['ink', 'neutral', 'brown', 'blue', 'violet', 'rose'];
  await expect(radios).toHaveCount(palettes.length);
  assert.deepEqual(await radios.evaluateAll((nodes) => nodes.map((node) => node.value)), palettes);
  const ink = page.getByRole('radio', { name: '墨绿', exact: true });
  await ink.focus();
  await ink.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '灰蓝', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(ink).toBeChecked();
  await expect(page.locator('input[value=ink] + .palette-swatch')).toHaveCSS(
    'outline-style',
    'solid',
  );
  const accents = new Set();
  for (const palette of palettes) {
    const radio = page.locator('input[name=themePalette][value=' + palette + ']');
    await radio.check();
    await page.locator('#save-site').click();
    await expect(root).toHaveAttribute('data-palette', palette);
    await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'success');
    for (const mode of ['light', 'dark']) {
      await page.locator('select[data-theme-mode]').selectOption(mode);
      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const read = (name) => style.getPropertyValue('--ci-' + name).trim();
        const luminance = (hex) => {
          const parts = hex.replace('#', '').match(/../g);
          const rgb = parts.map((part) => {
            const value = parseInt(part, 16) / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        return {
          primary: read('primary'),
          ratios: [
            ['text', 'bg'],
            ['muted', 'surface'],
            ['on-primary', 'primary'],
            ['on-primary-container', 'primary-container'],
          ].map(([foreground, background]) => {
            const a = luminance(read(foreground)),
              b = luminance(read(background));
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.ok(colors.ratios.every((ratio) => ratio >= 4.5), palette + ' ' + mode + ' contrast');
      assert.equal(colors.overflow, false);
      if (mode === 'light') accents.add(colors.primary);
      await page.screenshot({
        path: resolve(output, 'palette-settings-' + palette + '-' + mode + '-' + engine + '.png'),
        fullPage: true,
      });
    }
    if (palette === 'brown') {
      await page.reload();
      await expect(page.locator('#home-view')).toBeVisible();
      await expect(root).toHaveAttribute('data-palette', 'brown');
      await page.locator('.article-card').first().click();
      await page.locator('#show-preview').click();
      await expect(page.frameLocator('#preview-frame').locator('html')).toHaveAttribute(
        'data-palette',
        'brown',
      );
      await page.screenshot({
        path: resolve(output, 'palette-preview-brown-' + engine + '.png'),
        fullPage: true,
      });
      await page.locator('#settings').click();
      await expect(page.getByRole('radio', { name: '棕褐 Brown', exact: true })).toBeChecked();
    }
  }
  assert.equal(accents.size, palettes.length, 'Every swatch selects a distinct palette');
  if (engine === 'chromium') {
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(page.locator('.palette-name').first()).toBeVisible();
    await page.getByRole('radio', { name: '棕褐 Brown', exact: true }).check();
    await expect(page.getByRole('radio', { name: '棕褐 Brown', exact: true })).toBeChecked();
    await page.emulateMedia({ forcedColors: 'none' });
  }
  await ink.check();
  await page.locator('#save-site').click();
  await expect(root).toHaveAttribute('data-palette', 'ink');
  await context.close();
  assert.deepEqual(errors, [], engine + ' palette picker must not throw');
}
