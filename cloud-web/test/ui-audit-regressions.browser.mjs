import { navigateStudio } from './studio-navigation.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';

export async function verifyUiAuditRegressions(browser, origin, output, engine) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  let releaseRead, releaseSave, releaseCrossRead, releaseCrossSave;
  try {
    await page.goto(origin + '/admin');
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    const { csrf } = await (await page.request.get(origin + '/api/posts')).json();
    const before = await (await page.request.get(origin + '/api/shorts?limit=1')).json();
    const body = '完整短记原稿。'.repeat(100);
    const slug = 'audit-' + engine;
    for (let index = 0; index < 3; index++) {
      const response = await page.request.put(origin + '/api/shorts/' + slug + '-' + index, {
        headers: { Origin: origin, 'X-CSRF-Token': csrf },
        data: {
          front_matter: { slug: slug + '-' + index, date: '2030-01-01 12:0' + index, draft: true },
          body_markdown: body,
          etag: null,
        },
      });
      assert.equal(response.status(), 200);
    }
    await page.reload();
    await expect(page.locator('#sidebar-shorts-count')).toHaveText(String(before.total + 3));
    await page.locator('#flclash-goto-shorts-link').click();
    await expect(page.locator('#shorts-view')).toBeVisible();
    await expect(page.locator('#home-view')).toBeHidden();
    await expect(page.locator('.short-admin-card')).toHaveCount(before.total + 3);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#short-new').click();
    const unsaved = '尚未保存的短记需要保留';
    await page.locator('#short-body').fill(unsaved);
    await page.locator('#short-new').click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await expect(page.locator('#confirmation-cancel')).toBeFocused();
    await page.locator('#confirmation-cancel').click();
    await expect(page.locator('#confirmation-dialog')).toBeHidden();
    await expect(page.locator('#short-body')).toHaveValue(unsaved);
    await page.locator('#short-cancel').click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation-dialog')).toBeHidden();
    await expect(page.locator('#short-body')).toHaveValue(unsaved);
    await navigateStudio(page, 'dashboard-nav');
    await navigateStudio(page, 'shorts');
    await expect(page.locator('#short-body')).toHaveValue(unsaved);
    await page
      .locator('.short-admin-card')
      .filter({ has: page.locator('#short-publish-' + slug + '-2') })
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation-dialog')).toBeHidden();
    await expect(page.locator('#short-body')).toHaveValue(unsaved);
    if (engine === 'chromium') {
      const warning = page.waitForEvent('dialog');
      const reload = page.reload().catch((error) => error);
      const dialog = await warning;
      assert.equal(dialog.type(), 'beforeunload');
      await dialog.dismiss();
      await reload;
      await expect(page.locator('#short-body')).toHaveValue(unsaved);
    }
    await page.locator('#short-new').click();
    await acceptConfirmation(page);
    await expect(page.locator('#short-body')).toHaveValue('');
    await page.locator('#short-cancel').click();
    await expect(page.locator('#short-editor')).toBeHidden();
    await page.locator('#short-new').click();
    await page.locator('#short-date').fill('2030-01-01 12:34');
    await page.locator('#short-cancel').click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation-dialog')).toBeHidden();
    await expect(page.locator('#short-date')).toHaveValue('2030-01-01 12:34');
    await page.locator('#short-cancel').click();
    await acceptConfirmation(page);
    await expect(page.locator('#short-editor')).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 1000 });

    const readGate = new Promise((resolve) => (releaseRead = resolve));
    await context.route(
      (url) => url.pathname === '/api/shorts/' + slug + '-2',
      async (route) => {
        if (route.request().method() === 'GET') await readGate;
        await route.continue();
      },
    );
    await page
      .locator('.short-admin-card')
      .filter({ has: page.locator('#short-publish-' + slug + '-2') })
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await expect(page.locator('#short-body')).toHaveAttribute('readonly', '');
    await expect(page.locator('#short-save')).toBeDisabled();
    await page.locator('#short-cancel').click();
    await page.locator('#short-new').click();
    await page.locator('#short-body').fill('新输入不能被旧请求覆盖');
    releaseRead();
    await page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/shorts/' + slug + '-2',
    );
    await expect(page.locator('#short-body')).toHaveValue('新输入不能被旧请求覆盖');
    await page.locator('#short-cancel').click();
    await acceptConfirmation(page);
    await page
      .locator('.short-admin-card')
      .filter({ has: page.locator('#short-publish-' + slug + '-2') })
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await expect(page.locator('#short-body')).toHaveValue(body);
    await page.locator('#short-body').fill(body + '完整保留');
    await page.locator('#short-save').click();
    await expect(page.locator('#short-status')).toHaveText('草稿已保存。');
    const saved = await (await page.request.get(origin + '/api/shorts/' + slug + '-2')).json();
    assert.equal(saved.draft.body_markdown, body + '完整保留');
    await page.locator('#short-cancel').click();

    const saveGate = new Promise((resolve) => (releaseSave = resolve));
    let holdSave = true;
    await context.route(
      (url) => url.pathname === '/api/shorts/' + slug + '-2',
      async (route) => {
        if (holdSave && route.request().method() === 'PUT') await saveGate;
        await route.fallback();
      },
    );
    await page
      .locator('.short-admin-card')
      .filter({ has: page.locator('#short-publish-' + slug + '-2') })
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await expect(page.locator('#short-body')).toHaveValue(body + '完整保留');
    await page.locator('#short-body').fill('旧编辑器中的保存内容');
    await page.locator('#short-save').click();
    await expect(page.locator('#short-save')).toHaveAttribute('aria-busy', 'true');
    await page.locator('#short-cancel').click();
    await acceptConfirmation(page);
    await page.locator('#short-new').click();
    await page.locator('#short-body').fill('新编辑器中的独立草稿');
    holdSave = false;
    releaseSave();
    await expect(page.locator('#short-save')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#short-body')).toHaveValue('新编辑器中的独立草稿');
    const newSave = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.startsWith('/api/shorts/'),
    );
    await page.locator('#short-save').click();
    const newResponse = await newSave;
    assert.equal(newResponse.status(), 200);
    const newSlug = decodeURIComponent(new URL(newResponse.url()).pathname.split('/').at(-1));
    assert.notEqual(
      newSlug,
      slug + '-2',
      'A delayed save cannot attach its identity to a new draft',
    );
    assert.equal(
      (await (await page.request.get(origin + '/api/shorts/' + slug + '-2')).json()).draft
        .body_markdown,
      '旧编辑器中的保存内容',
    );
    await expect(page.locator('#short-save')).not.toHaveAttribute('aria-busy', 'true');
    const newSource = await (await page.request.get(origin + '/api/shorts/' + newSlug)).json();
    assert.equal(newSource.draft.body_markdown, '新编辑器中的独立草稿');
    const removed = await page.request.delete(origin + '/api/shorts/' + newSlug, {
      headers: { Origin: origin, 'X-CSRF-Token': csrf },
      data: { etag: newSource.etag },
    });
    assert.equal(removed.status(), 200);
    await page.locator('#short-cancel').click();
    await navigateStudio(page, 'dashboard-nav');
    await page.locator('#flclash-quick-short-btn').click();
    await expect(page.locator('#short-editor')).toBeVisible();
    await expect(page.locator('#short-body')).toHaveValue('');
    await page.locator('#short-cancel').click();

    const crossSave = new Promise((resolve) => (releaseCrossSave = resolve));
    const crossRead = new Promise((resolve) => (releaseCrossRead = resolve));
    await context.route(
      (url) => url.pathname === '/api/shorts/' + slug + '-0',
      async (route) => {
        if (route.request().method() === 'PUT') await crossSave;
        await route.fallback();
      },
    );
    await context.route(
      (url) => url.pathname === '/api/shorts/' + slug + '-1',
      async (route) => {
        if (route.request().method() === 'GET') await crossRead;
        await route.fallback();
      },
    );
    await page
      .locator('.short-admin-card')
      .filter({ has: page.locator('#short-publish-' + slug + '-0') })
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await expect(page.locator('#short-body')).toHaveValue(body);
    await page.locator('#short-body').fill('另一条短记的在途保存');
    await page.locator('#short-save').click();
    await expect(page.locator('#short-save')).toHaveAttribute('aria-busy', 'true');
    await page.locator('#short-cancel').click();
    await acceptConfirmation(page);
    await page
      .locator('.short-admin-card')
      .filter({ has: page.locator('#short-publish-' + slug + '-1') })
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await expect(page.locator('#short-body')).toHaveAttribute('readonly', '');
    releaseCrossSave();
    await expect(page.locator('#short-save')).not.toHaveAttribute('aria-busy', 'true');
    if (await page.locator('#short-save').isEnabled()) {
      const unexpectedSave = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === '/api/shorts/' + slug + '-1',
      );
      await page.locator('#short-save').click();
      await unexpectedSave;
    }
    assert.equal(
      (await (await page.request.get(origin + '/api/shorts/' + slug + '-1')).json()).draft
        .body_markdown,
      body,
      'An old action must not allow saving an editor whose original is still loading',
    );
    await expect(page.locator('#short-save')).toBeDisabled();
    await expect(page.locator('#short-publish')).toBeDisabled();
    releaseCrossRead();
    await expect(page.locator('#short-body')).toHaveValue(body);
    await expect(page.locator('#short-save')).toBeEnabled();
    await page.locator('#short-cancel').click();

    await page.locator('#short-new').click();
    await page.locator('#short-body').fill('保存失败时也不能丢弃');
    await context.route(
      (url) => url.pathname.startsWith('/api/shorts/'),
      (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({ status: 503, json: { error: 'Short save unavailable' } })
          : route.fallback(),
    );
    await page.locator('#short-save').click();
    await expect(page.locator('#notice')).toContainText('Short save unavailable');
    await page.locator('#short-cancel').click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation-dialog')).toBeHidden();
    await expect(page.locator('#short-body')).toHaveValue('保存失败时也不能丢弃');
    await page.locator('#studio-tools summary').click();
    await page.locator('#logout').click();
    await expect(page.locator('#confirmation-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmation-dialog')).toBeHidden();
    await expect(page.locator('#short-body')).toHaveValue('保存失败时也不能丢弃');
    await page.locator('#studio-tools summary').click();
    await page.locator('#logout').click();
    await acceptConfirmation(page);
    await expect(page.locator('#login-view')).toBeVisible();
    await page.locator('#login-form input[name=email]').fill(owner);
    await page.locator('#login-form input[name=password]').fill(password);
    await page.locator('#login-submit').click();
    await expect(page.locator('#home-view')).toBeVisible();
    await navigateStudio(page, 'shorts');
    await expect(page.locator('#short-editor')).toBeHidden();
  } catch (error) {
    await page.screenshot({
      path: resolve(output, 'audit-failure-' + engine + '.png'),
      fullPage: true,
    });
    throw error;
  } finally {
    releaseRead?.();
    releaseSave?.();
    releaseCrossRead?.();
    releaseCrossSave?.();
    await context.close();
  }
}
