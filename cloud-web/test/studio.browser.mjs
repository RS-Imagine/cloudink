// App-shell checks use only the UI audit's local temporary fixture.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password, setupToken } from './fixture.mjs';

export async function openPostSwitcher(page) {
  if (!(await page.locator('#post-switcher').evaluate((node) => node.open)))
    await page.locator('#post-switcher summary').click();
}

export async function verifyStudio(browser, origin, output, engine) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  const page = await context.newPage();
  await page.goto(origin + '/admin');
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('.studio-skip')).toBeHidden();
  await page.locator('#login-form input[name=email]').fill(owner);
  await page.locator('#login-form input[name=password]').fill('Incorrect-password-123');
  await page.locator('#login-submit').click();
  await expect(page.locator('#login-error')).not.toHaveText('');
  await expect(page.locator('#login-submit')).toBeEnabled();
  await page.locator('#login-form input[name=password]').fill(password);
  await page.locator('#login-submit').click();
  await expect(page.locator('#home-view')).toBeVisible();
  await expect(page.locator('#app-view')).toHaveAttribute('data-view', 'home');
  const sessionCookie = (await context.cookies()).find(
    (cookie) => cookie.name === '__Host-cloudink_session',
  );
  assert.ok(sessionCookie?.secure && sessionCookie.httpOnly, engine + ' keeps a secure session');
  await expect(page.locator('.studio-nav [aria-current]')).toHaveAttribute('id', 'dashboard-nav');
  const initialCount = await page.locator('.article-card').count();
  assert.equal(initialCount, 4);
  await page.locator('[data-post-filter=draft]').click();
  await expect(page.locator('.article-card')).toHaveCount(1);
  await page.locator('[data-post-filter=published]').click();
  await expect(page.locator('.article-card')).toHaveCount(3);
  await page.locator('[data-post-filter=all]').click();
  await page.locator('#search').fill('missing-title-no-match');
  await expect(page.locator('.article-card')).toHaveCount(0);
  await expect(page.locator('.studio-empty')).toContainText('匹配');
  await page.locator('.studio-empty button').click();
  await expect(page.locator('.article-card')).toHaveCount(initialCount);
  await expect(page.locator('#search')).toBeFocused();
  await page.locator('#articles-nav').click();
  await expect(page.locator('#app-view')).toHaveAttribute('data-view', 'posts');
  await expect(page.locator('#posts-title')).toBeVisible();
  await expect(page.locator('.home-intro')).toBeHidden();
  await expect(page.locator('#articles-nav')).toHaveAttribute('aria-current', 'page');
  await page.locator('#dashboard-nav').click();
  for (const width of [1440, 900, 390, 360, 320]) {
    await page.setViewportSize({ width, height: width >= 1100 ? 1000 : 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const id of ['dashboard-nav', 'articles-nav', 'images', 'settings', 'new-post']) {
      await expect(page.locator('#' + id)).toBeVisible();
      const rect = await page.locator('#' + id).boundingBox();
      assert.ok(rect.width >= 44 && rect.height >= 44, id + ' must keep a touch target');
    }
    if (width < 760) await expect(page.locator('.studio-nav')).toHaveCSS('position', 'fixed');
    else
      assert.ok((await page.locator('.sidebar').boundingBox()).width >= (width >= 1100 ? 220 : 80));
  }
  await page.locator('#studio-tools summary').click();
  await expect(page.locator('#logout')).toBeVisible();
  await expect(page.locator('#account-email')).toHaveText(owner);
  await page.keyboard.press('Escape');
  await expect(page.locator('#studio-tools')).not.toHaveAttribute('open', '');
  await expect(page.locator('#studio-tools summary')).toBeFocused();
  await openPostSwitcher(page);
  await expect(page.locator('.post-item')).toHaveCount(initialCount);
  await page.keyboard.press('Escape');
  await expect(page.locator('#post-switcher summary')).toBeFocused();
  await openPostSwitcher(page);
  await page.locator('#images').click();
  await expect(page.locator('#images-view')).toBeVisible();
  await expect(page.locator('#post-switcher')).not.toHaveAttribute('open', '');
  await expect(page.locator('#images')).toHaveAttribute('aria-current', 'page');
  await page.locator('#settings').click();
  await expect(page.locator('#site-form')).toBeVisible();
  await expect(page.locator('#settings')).toHaveAttribute('aria-current', 'page');
  await page.locator('#dashboard-nav').click();
  for (const [width, dark] of [
    [1440, false],
    [390, false],
    [360, true],
  ]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate((dark) => CloudInkTheme.setMode(dark ? 'dark' : 'light'), dark);
    await page.screenshot({
      path: resolve(
        output,
        'studio-shell-' + engine + '-' + width + '-' + (dark ? 'dark' : 'light') + '.png',
      ),
      fullPage: true,
    });
  }
  await page.locator('.workspace-header [data-theme-toggle]').click();
  await expect(page.locator('.workspace-header [data-theme-toggle] svg')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('#app-view')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('.studio-skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#workspace')).toBeFocused();
  // Primary navigation must still flush a draft before leaving the editor.
  await page.locator('#new-post').click();
  await page.locator('#title').fill('Studio draft ' + engine);
  await page.locator('#body').fill('Keep this text while navigating.');
  await page.locator('#dashboard-nav').click();
  await expect(page.locator('#home-view')).toBeVisible();
  await openPostSwitcher(page);
  await page
    .locator('.post-item')
    .filter({ hasText: 'Studio draft ' + engine })
    .click();
  await expect(page.locator('#body')).toHaveValue('Keep this text while navigating.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#delete-post').click();
  await expect(page.locator('#home-view')).toBeVisible();
  await expect(page.locator('#post-count')).toHaveText(String(initialCount));
  await page.locator('#studio-tools summary').click();
  await page.locator('#logout').click();
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  await expect(page.locator('.studio-skip')).toBeHidden();
  await context.close();

  const wizard = await browser.newContext({
    viewport: { width: 360, height: 844 },
    colorScheme: 'dark',
  });
  wizard.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await wizard.route('**/api/config', async (route) => {
    const response = await route.fetch(),
      config = await response.json();
    await route.fulfill({ response, json: { ...config, initialized: false } });
  });
  const setup = await wizard.newPage();
  await setup.goto(origin + '/admin');
  await expect(setup.locator('#setup-view')).toBeVisible();
  await setup.locator('#setup-next').click();
  await expect(setup.locator('#setup-account-step')).toBeVisible();
  await expect(setup.locator('#setup-form input[name=token]')).toBeFocused();
  for (const [name, value] of Object.entries({
    token: setupToken,
    email: owner,
    password,
    confirm: password,
  }))
    await setup.locator('#setup-form input[name=' + name + ']').fill(value);
  await setup.locator('#setup-next').click();
  await expect(setup.locator('#setup-site-step')).toBeVisible();
  await expect(setup.locator('#setup-form input[name=title]')).toBeFocused();
  await expect(setup.locator('#setup-progress-site')).toHaveAttribute('aria-current', 'step');
  assert.equal(
    await setup.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await setup.screenshot({
    path: resolve(output, 'studio-setup-' + engine + '.png'),
    fullPage: true,
  });
  await setup.locator('#setup-back').click();
  await expect(setup.locator('#setup-form input[name=token]')).toHaveValue(setupToken);
  await expect(setup.locator('#setup-progress-account')).toHaveAttribute('aria-current', 'step');
  await wizard.close();
  assert.deepEqual(errors, [], engine + ' app shell must not produce browser errors');
}
