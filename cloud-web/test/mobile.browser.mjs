// Mobile regressions use only the UI audit's local temporary content.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';
import { openPostSwitcher } from './studio.browser.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';

async function settled(page) {
  await expect.poll(() => page.evaluate(() => !CloudInkMotion.stats().framePending && !CloudInkMobile.stats().viewportPending)).toBe(true);
}
async function drag(page, handle, distance) {
  const bounds = await handle.boundingBox();
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + distance, { steps: 8 });
  await page.mouse.up();
  await settled(page);
}
export async function verifyMobile(browser, origin, output, engine) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, colorScheme: 'light',
    reducedMotion: 'no-preference',
    ...(engine !== 'firefox' ? { hasTouch: true, isMobile: true } : {}),
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  await page.goto(origin + '/posts/slow-days/');
  await page.locator('.mobile-toc-btn').click();
  const toc = page.locator('.toc-container'), grip = toc.locator('.ci-sheet-grip');
  await settled(page);
  await expect(toc).toHaveAttribute('data-sheet-snap', 'peek');
  await expect(grip).toHaveCSS('touch-action', 'none');
  await page.screenshot({ path: resolve(output, 'mobile-toc-peek-' + engine + '.png'), fullPage: false });
  await drag(page, grip, -140);
  await expect(toc).toHaveAttribute('data-sheet-snap', 'expanded');
  await grip.press('End');
  await settled(page);
  await expect(toc).toHaveAttribute('data-sheet-snap', 'peek');
  await grip.press('Home');
  await settled(page);
  await expect(toc).toHaveAttribute('data-sheet-snap', 'expanded');
  // Content scroll must not start a sheet gesture or move the underlying document.
  await toc.evaluate(node => {
    const overflow = document.createElement('div');
    for (let i = 0; i < 30; i++) {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Scrollable contents ' + i;
      overflow.append(paragraph);
    }
    node.append(overflow);
  });
  const position = await toc.evaluate(node => node.style.translate);
  const articleY = await page.evaluate(() => scrollY);
  await toc.evaluate(node => { node.scrollTop = 120; });
  assert.equal(await toc.evaluate(node => node.style.translate), position);
  assert.equal(await page.evaluate(() => scrollY), articleY);
  await toc.evaluate(node => { node.scrollTop = 0; });
  if (engine === 'chromium') {
    const session = await context.newCDPSession(page);
    const bounds = await grip.boundingBox();
    const x = bounds.x + bounds.width / 2, y = bounds.y + 22;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++)
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 18 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await session.detach();
    await settled(page);
    await expect(toc).toHaveAttribute('data-sheet-snap', 'expanded');
  }
  await grip.dispatchEvent('pointerdown', { pointerId: 17, pointerType: 'touch', button: 0, isPrimary: true, clientY: 150 });
  await grip.dispatchEvent('pointermove', { pointerId: 17, pointerType: 'touch', button: 0, isPrimary: true, clientY: 240 });
  await grip.dispatchEvent('pointercancel', { pointerId: 17, pointerType: 'touch', button: 0, isPrimary: true });
  await settled(page);
  await expect(toc).toHaveAttribute('data-sheet-snap', 'expanded');
  await page.screenshot({ path: resolve(output, 'mobile-toc-expanded-' + engine + '.png'), fullPage: false });
  await drag(page, grip, 550);
  await expect(page.locator('.mobile-toc-btn')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.mobile-toc-btn')).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await page.locator('#site-search-btn').click();
  await settled(page);
  await expect(page.locator('#search-modal')).toHaveAttribute('data-sheet-snap', 'expanded');
  // Reverse an in-flight close without running its old completion.
  await page.evaluate(() => CloudInkMotion.closeDialog(document.getElementById('search-modal')));
  await page.waitForTimeout(40);
  await page.evaluate(() => CloudInkMotion.openDialog(document.getElementById('search-modal')));
  await settled(page);
  await expect(page.locator('#search-modal')).toBeVisible();
  await page.locator('#search-input').fill('生活');
  await expect(page.locator('#search-results a')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-modal')).toBeHidden();
  await expect(page.locator('#site-search-btn')).toBeFocused();
  await page.locator('.article-body img').first().click();
  await settled(page);
  await expect(page.locator('.reader-dialog')).toHaveAttribute('data-ci-sheet-active', '');
  await page.locator('.reader-dialog > .ci-sheet-grip').click();
  await expect(page.locator('.reader-dialog')).toHaveCount(0);
  await settled(page);
  assert.equal(await page.evaluate(() => CloudInkMobile.stats().active), 0);
  await page.goto(origin + '/admin');
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#app-view')).toHaveAttribute('data-view', 'home');
  await page.locator('#new-post').click();
  await page.locator('#title').fill('Mobile draft ' + engine);
  await page.locator('#body').fill('Keep this draft through mobile menus and rotation.');
  await page.locator('#save-post').click();
  await expect(page.locator('#save-state')).toHaveAttribute('data-tone', 'success');
  await openPostSwitcher(page);
  await expect(page.locator('#studio-sheet')).toBeVisible();
  await settled(page);
  await expect(page.locator('#studio-sheet #search')).toHaveCount(1);
  await expect(page.locator('#article-browser #search')).toHaveCount(0);
  await page.locator('#search').fill('Mobile draft ' + engine);
  await expect(page.locator('#post-list .post-item')).toHaveCount(1);
  await page.screenshot({ path: resolve(output, 'mobile-post-picker-' + engine + '.png'), fullPage: false });
  await page.locator('#post-list .post-item').click();
  await expect(page.locator('#studio-sheet')).toBeHidden();
  await expect(page.locator('#article-browser #search')).toHaveCount(1);
  await expect(page.locator('#body')).toHaveValue('Keep this draft through mobile menus and rotation.');
  await openPostSwitcher(page);
  await expect(page.locator('#studio-sheet')).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#studio-sheet')).toBeHidden();
  await expect(page.locator('#article-browser #search')).toHaveCount(1);
  await expect(page.locator('#body')).toHaveValue('Keep this draft through mobile menus and rotation.');
  await page.setViewportSize({ width: 360, height: 844 });
  await page.evaluate(() => CloudInkTheme.setMode('dark'));
  await page.locator('#studio-tools summary').click();
  await expect(page.locator('#studio-sheet')).toBeVisible();
  await settled(page);
  await page.screenshot({ path: resolve(output, 'mobile-more-dark-' + engine + '.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(page.locator('#studio-tools summary')).toBeFocused();
  let deletions = 0;
  page.on('request', request => {
    if (request.method() === 'DELETE' && request.url().includes('/api/posts/')) deletions++;
  });
  await page.locator('#delete-post').click();
  await expect(page.locator('#confirmation-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirmation-dialog')).toBeHidden();
  await expect(page.locator('#body')).toHaveValue('Keep this draft through mobile menus and rotation.');
  await page.locator('#delete-post').click();
  await settled(page);
  await page.evaluate(() => {
    document.getElementById('confirmation-accept').click();
    CloudInkMotion.openDialog(document.getElementById('confirmation-dialog'));
  });
  await settled(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirmation-dialog')).toBeHidden();
  assert.equal(deletions, 0, 'Reopening an outgoing confirmation cancels its old result');
  await expect(page.locator('#body')).toHaveValue('Keep this draft through mobile menus and rotation.');
  await page.locator('#delete-post').click();
  await acceptConfirmation(page);
  await expect(page.locator('#post-count')).toHaveText('4');
  assert.equal(deletions, 1);
  await settled(page);
  assert.deepEqual(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  }), []);
  await context.close();

  // Simulates visualViewport geometry, not a real mobile input method.
  const keyboard = await browser.newContext({
    viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', colorScheme: 'light',
  });
  keyboard.on('page', p => p.on('pageerror', error => errors.push(error.message)));
  await keyboard.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await keyboard.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.__resizeTestViewport = height => { viewport.height = height; viewport.dispatchEvent(new Event('resize')); };
  });
  const keypad = await keyboard.newPage();
  await keypad.goto(origin + '/posts/slow-days/');
  await keypad.locator('#site-search-btn').click();
  await expect(keypad.locator('#search-input')).toBeFocused();
  await keypad.evaluate(() => __resizeTestViewport(430));
  await expect(keypad.locator('html')).toHaveAttribute('data-ci-keyboard', '');
  await settled(keypad);
  const bounds = await keypad.locator('#search-modal').boundingBox();
  assert.ok(bounds.y >= -1 && bounds.y + bounds.height <= 431, 'Search stays above the simulated keyboard');
  await expect(keypad.locator('#search-input')).toBeFocused();
  await keypad.screenshot({ path: resolve(output, 'mobile-keyboard-search-' + engine + '.png'), fullPage: false });
  await keypad.keyboard.press('Escape');
  await keypad.evaluate(() => __resizeTestViewport(844));
  await keypad.goto(origin + '/admin');
  await keypad.locator('#login-form input[name=email]').fill(owner);
  await keypad.locator('#login-form input[name=password]').fill(password);
  await keypad.locator('#login-submit').click();
  await expect(keypad.locator('#app-view')).toHaveAttribute('data-view', 'home');
  await keypad.locator('#new-post').click();
  await keypad.locator('#body').focus();
  await keypad.evaluate(() => __resizeTestViewport(430));
  await expect(keypad.locator('.studio-nav')).toHaveCSS('visibility', 'hidden');
  await expect(keypad.locator('#body')).toBeFocused();
  await keypad.locator('#body').evaluate(node => node.blur());
  await keypad.evaluate(() => __resizeTestViewport(844));
  await expect(keypad.locator('.studio-nav')).toHaveCSS('visibility', 'visible');
  await keyboard.close();
  assert.deepEqual(errors, [], engine + ' mobile flows must not throw browser errors');
}
