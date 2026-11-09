import { navigateStudio, openArticleInfo } from './studio-navigation.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function openArticleList(page) {
  if (await page.locator('#editor-back').isVisible()) await page.locator('#editor-back').click();
  await expect(page.locator('#home-view')).toBeVisible();
}

export async function verifyStudio(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(origin + '/admin');
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    await expect(page.locator('#articles-nav')).toHaveAttribute('aria-current', 'page');
    const initial = await page.locator('.article-card').count();
    await page.locator('#search').fill('no-such-article-v4');
    await expect(page.locator('.article-card')).toHaveCount(0);
    await expect(page.locator('#selected-post-edit')).toBeDisabled();
    await page.locator('.studio-empty button').click();
    await expect(page.locator('.article-card')).toHaveCount(initial);
    await expect(page.locator('#search')).toBeFocused();
    await page.screenshot({ path: resolve(output, 'v4-studio-' + engine + '-1440.png') });
    for (const width of [1440, 900, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      for (const id of ['articles-nav', 'shorts', 'images', 'settings'])
        await expect(page.locator('#' + id)).toBeVisible();
      await expect(page.locator('#publish-welcome')).toBeVisible();
      await expect(page.locator('.manage-intro #publish-welcome')).toHaveCount(1);
      for (const id of ['images', 'shorts']) {
        await navigateStudio(page, id);
        await expect(page.locator('#' + id + '-view')).toBeVisible();
        await expect(page.locator('#publishing-summary')).toBeHidden();
        await expect(page.locator('#publish-welcome')).toBeHidden();
      }
      await navigateStudio(page, 'articles-nav');
      await expect(page.locator('#publish-welcome')).toBeVisible();
    }
    await page.locator('#new-post').click();
    await expect(page.locator('#publishing-summary')).toBeHidden();
    await expect(page.locator('#publish-welcome')).toBeHidden();
    await expect(page.locator('#show-writing')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.studio-nav')).toBeHidden();
    await page.locator('#title').fill('V4 private draft ' + engine);
    await page
      .locator('#body')
      .fill('The latest input survives saving, metadata sheets, preview and navigation.');
    await page.locator('#save-post').click();
    await expect(page.locator('#save-state')).toHaveAttribute('data-tone', 'success');
    await expect(page.locator('#save-state')).toBeVisible();
    await openArticleInfo(page);
    await expect(page.locator('#date')).toBeVisible();
    await expect(page.locator('#slug')).toBeVisible();
    const slug = await page.locator('#slug').inputValue();
    await page.locator('#editor-info-close').click();
    await page.locator('#show-preview').click();
    await page.frameLocator('#preview-frame').locator('article h1').waitFor();
    await expect(page.frameLocator('#preview-frame').locator('#primary-nav')).toBeHidden();
    await page.locator('#show-writing').click();
    const before = await page.locator('#body').inputValue();
    await page.locator('#publish-post').click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.locator('#confirmation-cancel').click();
    await expect(page.locator('#body')).toHaveValue(before);
    const live = await page.request.get(origin + '/posts/' + slug + '/');
    assert.equal(live.status(), 404, 'Canceling publication must leave the draft private');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(output, 'v4-editor-' + engine + '-390.png') });
    await page.locator('#editor-back').click();
    await expect(page.locator('.studio-nav')).toBeVisible();
    await expect(page.locator('#publish-welcome')).toBeVisible();
    await page.screenshot({ path: resolve(output, 'v4-studio-' + engine + '-390.png') });
    await page
      .locator('.article-title-button')
      .filter({ hasText: 'V4 private draft ' + engine })
      .click();
    await expect(page.locator('#body')).toHaveValue(before);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#publish-welcome')).toBeHidden();
    await page.screenshot({ path: resolve(output, 'v4-editor-' + engine + '-1440.png') });
    await page.locator('#delete-post').click();
    await acceptConfirmation(page);
    await expect(page.locator('#home-view')).toBeVisible();
    await navigateStudio(page, 'settings');
    await expect(page.locator('#publish-welcome')).toBeVisible();
    await expect(page.locator('.settings-intro #publish-welcome')).toHaveCount(1);
    const font = page.locator('#reading-font');
    const originalFont = await font.inputValue();
    await font.selectOption('sans');
    await page.locator('#save-site').click();
    await expect(page.locator('#site-feedback')).toHaveAttribute('data-tone', 'success');
    const beforeFontPublication = await (await page.request.get(origin + '/')).text();
    assert(beforeFontPublication.includes('data-reading-font="' + originalFont + '"'));
    await page.locator('#publish-settings').click();
    await expect(page.locator('#publish-settings')).toBeEnabled({ timeout: 60000 });
    await expect
      .poll(
        async () =>
          (await (await page.request.get(origin + '/')).text()).includes(
            'data-reading-font="sans"',
          ),
        { timeout: 60000 },
      )
      .toBe(true);
    await page.reload();
    await expect(page.locator('#home-view')).toBeVisible();
    await navigateStudio(page, 'settings');
    await expect(font).toHaveValue('sans');
    await page.locator('#new-post').click();
    await page.locator('#title').fill('Typography preview');
    await page.locator('#show-preview').click();
    await expect(page.frameLocator('#preview-frame').locator('html')).toHaveAttribute(
      'data-reading-font',
      'sans',
    );
    await page.locator('#editor-back').click();
    await page.locator('.article-title-button').filter({ hasText: 'Typography preview' }).click();
    await page.locator('#delete-post').click();
    await acceptConfirmation(page);
    await expect(page.locator('#home-view')).toBeVisible();
    await navigateStudio(page, 'settings');
    await font.selectOption(originalFont);
    await page.locator('#publish-settings').click();
    await expect(page.locator('#publish-settings')).toBeEnabled({ timeout: 60000 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
