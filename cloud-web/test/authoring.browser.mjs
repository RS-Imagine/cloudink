import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { fixture, draft, owner, password } from './fixture.mjs';
import { navigateStudio } from './studio-navigation.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';

// All publication and failure cases below use a separate, temporary R2 fixture.
export async function verifyAuthoring(browser) {
  let dispose;
  const f = await fixture(
    {
      after: (callback) => {
        dispose = callback;
      },
    },
    {},
    8795,
  );
  const origin = 'http://localhost:8795';
  const contexts = [],
    pages = [],
    errors = [];
  let release;
  try {
    await f.mf.ready;
    await f.setup();
    const articles = [];
    for (let index = 0; index < 7; index++) {
      const doc = draft('count-' + index, 'Count fixture ' + index);
      const saved = await (
        await f.request('/api/posts/count-' + index, 'PUT', {
          draft: doc,
          etag: null,
        })
      ).json();
      articles.push({ slug: doc.front_matter.slug, etag: saved.etag });
    }
    async function publishArticle(item) {
      const state = await f.prepare(item);
      await f.stage(state);
      assert.equal((await f.commit(state)).status, 200);
    }
    for (const item of articles.slice(0, 5)) await publishArticle(item);
    for (const width of [1920, 443]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width < 768,
        hasTouch: width < 768,
        deviceScaleFactor: width < 768 ? 2.75 : 1,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      contexts.push(context);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      pages.push(page);
      await page.goto(origin + '/admin');
      await page.locator('#login-form input[name=email]').fill(owner);
      await page.locator('#login-form input[name=password]').fill(password);
      await page.locator('#login-submit').click();
      await expect(page.locator('#home-view')).toBeVisible();
      if (width < 768) {
        const list = await page.locator('#article-grid').boundingBox();
        for (const selector of ['#search', '#post-filters']) {
          const control = await page.locator(selector).boundingBox();
          assert.ok(
            Math.abs(control.x - list.x) <= 1 && Math.abs(control.width - list.width) <= 1,
            selector + ' aligns with both edges of the list',
          );
        }
      }
      await page.setViewportSize({ width: 980, height: 900 });
      await page.locator('#studio-tools summary').click();
      await expect(page.locator('.studio-tools-panel #site-link span')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: 900 });
    }
    async function counts(published, privateCount) {
      const api = await (await f.request('/api/posts')).json();
      assert.deepEqual(api.counts, { total: 7, published, draft: privateCount });
      for (const page of pages) {
        await page.reload();
        await expect(page.locator('#summary')).toHaveText(
          `${published} 篇已发布 · ${privateCount} 篇草稿`,
        );
        for (const [filter, count] of [
          ['draft', privateCount],
          ['published', published],
          ['all', 7],
        ]) {
          await page.locator(`#post-filters [data-post-filter="${filter}"]`).click();
          await expect(page.locator('.article-card')).toHaveCount(count);
        }
        await page.locator('#search').fill('count-6');
        await expect(page.locator('.article-card')).toHaveCount(1);
        await page.locator('#search').fill('');
        await expect(page.locator('.article-card')).toHaveCount(7);
      }
    }
    await counts(5, 2);
    for (const item of articles.slice(5)) await publishArticle(item);
    await counts(7, 0);

    const mobile = pages[1];
    await f.request('/api/posts/private-other', 'PUT', {
      draft: draft('private-other'),
      etag: null,
    });
    for (const slug of ['target-short', 'private-short']) {
      const response = await f.request('/api/shorts/' + slug, 'PUT', {
        front_matter: { slug, date: '2030-01-01 12:00', draft: true },
        body_markdown: slug + ' original',
        etag: null,
      });
      assert.equal(response.status, 200);
    }
    await navigateStudio(mobile, 'shorts');
    const target = mobile.locator('#short-publish-target-short');
    await mobile
      .locator('.short-admin-card')
      .filter({ has: target })
      .locator('.short-card-content')
      .press('Space');
    await expect(mobile.locator('#short-body')).toHaveValue('target-short original');
    await mobile.locator('#short-cancel').click();
    const writes = [];
    mobile.on('request', (request) => {
      const url = new URL(request.url());
      if (
        (request.method() === 'POST' && url.pathname === '/api/publish') ||
        (request.method() === 'PUT' && url.pathname.startsWith('/api/shorts/'))
      )
        writes.push(request.url());
    });
    await target.click();
    await expect(mobile.locator('#confirmation-dialog')).toBeVisible();
    await mobile.locator('#confirmation-cancel').click();
    await expect(mobile.locator('#confirmation-dialog')).toBeHidden();
    assert.equal(writes.length, 0, 'canceling list publication sends no writes');
    let fail = true;
    const publishRoute = (url) => url.pathname === '/api/publish';
    await mobile.route(publishRoute, async (route) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      if (fail) return route.fulfill({ status: 503, json: { error: 'Temporary publish failure' } });
      await route.continue().catch(() => {});
    });
    const originalLabel = await target.textContent();
    const size = (button) => [button.offsetWidth, button.offsetHeight];
    const before = await target.evaluate(size);
    await target.click();
    await acceptConfirmation(mobile);
    await expect.poll(() => typeof release).toBe('function');
    await expect(target).toHaveAttribute('aria-busy', 'true');
    assert.equal(await target.textContent(), originalLabel);
    assert.deepEqual(await target.evaluate(size), before);
    await expect(mobile.locator('#short-operation-status')).toHaveAttribute('data-tone', 'pending');
    release();
    release = null;
    await expect(mobile.locator('#short-operation-status')).toContainText(
      'Temporary publish failure',
    );
    await expect(target).toBeEnabled();
    fail = false;
    await target.click();
    await acceptConfirmation(mobile);
    await expect.poll(() => typeof release).toBe('function');
    release();
    release = null;
    await expect(mobile.locator('#short-operation-status')).toContainText('短记已上线', {
      timeout: 60000,
    });
    await expect(target).toHaveText('重新发布');
    await expect(
      mobile.locator('.short-admin-card').filter({ has: target }).locator('.badge'),
    ).toHaveText('已发布 · 原稿保留');
    await mobile.unroute(publishRoute);
    const list = await (await f.request('/api/shorts')).json();
    assert.equal(list.shorts.find((item) => item.slug === 'private-short').published, false);
    assert.equal((await (await f.request('/api/posts')).json()).counts.draft, 1);
    assert.equal(
      list.shorts.find((item) => item.slug === 'target-short').has_draft,
      true,
      'publishing retains the editable original',
    );

    await mobile.locator('#short-new').click();
    await mobile.locator('#short-body').fill('Confirmed short source.');
    const beforeCancel = writes.length;
    await mobile.locator('#short-publish').click();
    await mobile.locator('#confirmation-cancel').click();
    await expect(mobile.locator('#confirmation-dialog')).toBeHidden();
    assert.equal(writes.length, beforeCancel, 'editor confirmation precedes saving and publishing');
    await mobile.locator('#short-date').fill('invalid');
    await mobile.locator('#short-publish').click();
    await acceptConfirmation(mobile);
    await expect(mobile.locator('#short-operation-status')).toContainText('发布时间格式不正确');
    await expect(mobile.locator('#short-operation-status')).toHaveAttribute('data-tone', 'error');
    assert.equal(writes.length, beforeCancel, 'invalid source is rejected before any write');
    await mobile.locator('#short-date').fill('2030-01-01 12:01');
    const putRoute = (url) => url.pathname.startsWith('/api/shorts/');
    await mobile.route(putRoute, async (route) => {
      if (route.request().method() === 'PUT')
        await new Promise((resolve) => {
          release = resolve;
        });
      await route.continue().catch(() => {});
    });
    await mobile.locator('#short-publish').click();
    await acceptConfirmation(mobile);
    await expect.poll(() => typeof release).toBe('function');
    await mobile.locator('#short-body').fill('Changed while the confirmed source is saving.');
    release();
    release = null;
    await expect(mobile.locator('#short-operation-status')).toContainText('短记已上线', {
      timeout: 60000,
    });
    await expect(mobile.locator('#short-status')).toContainText('当前修改尚未保存');
    await expect(mobile.locator('#short-body')).toHaveValue(
      'Changed while the confirmed source is saving.',
    );
    await mobile.unroute(putRoute);
    await mobile.screenshot({
      path: resolve('cloud-web/dist/short-publish-mobile.png'),
      fullPage: true,
    });
    await mobile.locator('#short-cancel').click();
    await acceptConfirmation(mobile);

    const title = 'ExampleOS 13 安装配置 + 窗口管理 + desktop-shell 主题与快捷键完整指南';
    const body =
      '## 预览边界\n\n> 版本说明：本文演示 ExampleOS 13、window-manager 与 desktop-shell 5.x。实际安装时请去 GitHub Releases 页面核对最新版本。\n\n' +
      '![宽图](https://fixture.invalid/preview.svg)\n\n- 列表文字和图片都应该在预览容器中完整显示。\n\n' +
      '| 快捷键 | 功能 |\n| --- | --- |\n| Mod+Return | alacritty-' +
      'x'.repeat(120) +
      ' |\n\n```bash\ncurl https://fixture.invalid/' +
      'x'.repeat(150) +
      '\n```';
    for (const [index, page] of pages.entries()) {
      await page.route('https://fixture.invalid/preview.svg', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#b69b7b"/></svg>',
        }),
      );
      await navigateStudio(page, 'articles-nav');
      await page.locator('#new-post').click();
      await page.locator('#title').fill(title);
      await expect(page.locator('#title')).toHaveJSProperty('tagName', 'TEXTAREA');
      assert.ok(
        await page.locator('#title').evaluate((field) => field.clientHeight >= field.scrollHeight),
      );
      if (index) {
        await page.locator('#title').press('Enter');
        await expect(page.locator('#title')).toHaveValue(title);
        await page.locator('#title').fill('第一行\n第二行');
        await expect(page.locator('#title')).toHaveValue('第一行 第二行');
        assert.equal(
          await page.locator('#title').evaluate((field) =>
            field.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                isComposing: true,
                cancelable: true,
                bubbles: true,
              }),
            ),
          ),
          true,
          'IME confirmation is not prevented',
        );
        await page.locator('#title').fill(title);
      }
      await page.locator('#title').evaluate((field) => {
        field.blur();
        window.scrollTo(0, 0);
      });
      const titleBounds = await page.locator('#title').evaluate((field) => {
        const box = field.getBoundingClientRect();
        return {
          height: field.clientHeight,
          scroll: field.scrollHeight,
          top: field.scrollTop,
          visible: document.elementFromPoint(box.left + 10, box.bottom - 4) === field,
        };
      });
      assert.equal(titleBounds.top, 0, JSON.stringify(titleBounds));
      assert.equal(titleBounds.visible, true, JSON.stringify(titleBounds));
      assert.ok(
        await page
          .locator('#description')
          .evaluate(
            (field) => field.clientHeight >= 2 * parseFloat(getComputedStyle(field).lineHeight) - 1,
          ),
        'The summary field must show two complete lines at the current text size',
      );
      await page.screenshot({
        path: resolve('cloud-web/dist/authoring-title-' + (index ? 443 : 1920) + '.png'),
      });
      await page.locator('#body').fill(body);
      await page.locator(index ? '#show-preview' : '#show-split').click();
      const frame = page.frameLocator('#preview-frame');
      await expect(frame.locator('.article-body')).toContainText('GitHub Releases');
      await frame.locator('html').evaluate(() => document.fonts.ready);
      await expect
        .poll(() => frame.locator('.article-body img').evaluate((img) => img.naturalWidth))
        .toBe(1600);
      const metrics = await frame.locator('.article-shell').evaluate((shell) => {
        const targets = shell.querySelectorAll('.article-headline h1,blockquote p,li,img');
        const edges = [];
        for (const node of targets) {
          const rect = node.getBoundingClientRect();
          edges.push([rect.left, rect.right]);
          if (node.tagName !== 'IMG') {
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const line of range.getClientRects()) edges.push([line.left, line.right]);
          }
        }
        const table = shell.querySelector('table'),
          pre = shell.querySelector('pre');
        return {
          width: innerWidth,
          edges,
          root: document.documentElement.scrollWidth,
          table: [table.clientWidth, table.scrollWidth],
          code: [pre.clientWidth, pre.scrollWidth],
        };
      });
      assert.ok(
        metrics.edges.every(([left, right]) => left >= -1 && right <= metrics.width + 1),
        JSON.stringify(metrics),
      );
      assert.ok(metrics.root <= metrics.width + 1);
      assert.ok(
        metrics.table[1] > metrics.table[0] && metrics.code[1] > metrics.code[0],
        'wide content retains local scrolling',
      );
      assert.equal(
        await page.locator('#preview-frame').evaluate((el) => el.sandbox.contains('allow-scripts')),
        false,
      );
      await page.locator('#preview-frame').screenshot({
        path: resolve('cloud-web/dist/authoring-preview-' + (index ? 443 : 1920) + '.png'),
      });
    }
    assert.deepEqual(errors, [], 'authoring must not produce browser errors');
    console.log(
      JSON.stringify({
        authoring: true,
        counts: ['5+2', '7+0'],
        shortPublication: true,
        confirmationBeforeWrites: true,
        retainedEdits: true,
        previewBounds: true,
        wrappingTitle: true,
      }),
    );
  } finally {
    release?.();
    for (const context of contexts) await context.close();
    await dispose();
  }
}
