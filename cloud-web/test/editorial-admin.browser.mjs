// Full before/after review of the shipped admin, using only ephemeral audit data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { owner, password } from './fixture.mjs';
import { openPostSwitcher } from './studio.browser.mjs';

const baseline = '1b176737e055666836715d0b98255ce9de7418af';
const original = (path) => execFileSync('git', ['show', baseline + ':' + path], { encoding: 'utf8' });
const stylePaths = [
  'assets/design-tokens.css',
  'cloud-admin/ui/style.css',
  'assets/design-foundation.css',
  'assets/motion.css',
  'cloud-admin/ui/studio.css',
  'cloud-admin/ui/workflows.css',
  'assets/mobile.css',
  'assets/expressive.css',
];

export async function verifyEditorialAdmin(browser, origin, output, engine) {
  const before = stylePaths.map(original).join('\n');
  const oldMarkup = original('cloud-admin/ui/index.html');
  const samples = [];
  const errors = [];
  const widths = engine === 'chromium' ? [1440, 768, 390, 360] : [1440, 390, 360];
  for (const version of engine === 'chromium' ? ['before', 'after'] : ['after']) {
    for (const width of widths) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: width >= 760 ? 1000 : 844 },
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
        await context.addInitScript((mode) => {
          localStorage.setItem('theme', mode);
          localStorage.setItem('cloudink-admin-palette', 'brown');
        }, theme);
        await context.route('https://cdn.jsdelivr.net/**', (route) =>
          route.fulfill({ contentType: 'text/css', body: '' }),
        );
        if (version === 'before') {
          await context.route(origin + '/admin', (route) =>
            route.fulfill({ contentType: 'text/html; charset=utf-8', body: oldMarkup }),
          );
          await context.route(origin + '/style.css', (route) =>
            route.fulfill({ contentType: 'text/css; charset=utf-8', body: before }),
          );
        }
        const page = await context.newPage();
        async function capture(screen) {
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => CloudInkTheme.setPalette('brown'));
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            [engine, version, screen, width, theme].join('/') + ' reflows',
          );
          const file = ['editorial-admin', version, screen, width, theme, engine].join('-') + '.png';
          await page.screenshot({ path: resolve(output, file), fullPage: true, animations: 'disabled' });
          samples.push({ version, screen, width, theme, engine, file });
          if (
            engine === 'chromium' &&
            version === 'after' &&
            [1440, 390].includes(width) &&
            theme === 'light' &&
            ['login', 'dashboard', 'editor', 'images', 'settings', 'confirmation'].includes(screen)
          ) {
            console.log('ADMIN_REVIEW_PREVIEW ' + JSON.stringify({
              screen, width, theme,
              image: (await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64'),
            }));
          }
        }
        await page.goto(origin + '/admin');
        await expect(page.locator('#login-view')).toBeVisible();
        if (version === 'after') {
          await expect(page.locator('html')).toHaveAttribute('data-admin-design', 'editorial');
          await expect(page.locator('#login-view .auth-cover')).toBeVisible();
          await expect(page.locator('#login-submit')).toBeVisible();
        }
        await capture('login');
        await page.locator('#login-form input[name=email]').fill(owner);
        await page.locator('#login-form input[name=password]').fill(password);
        await page.locator('#login-submit').click();
        await expect(page.locator('#home-view')).toBeVisible();
        await capture('dashboard');
        await page.locator('#articles-nav').click();
        await expect(page.locator('#posts-title')).toBeVisible();
        await capture('articles');
        await page.locator('#search').fill('no-such-editorial-article');
        await expect(page.locator('.studio-empty')).toBeVisible();
        await capture('empty-search');
        await page.locator('#search').fill('');
        await openPostSwitcher(page);
        await page.locator('.post-item').filter({ hasText: '把日子，写成一封长信' }).click();
        await expect(page.locator('#editor-view')).toBeVisible();
        await expect(page.locator('#body')).toBeVisible();
        await capture('editor');
        const body = await page.locator('#body').inputValue();
        await page.locator('#show-preview').click();
        await page.frameLocator('#preview-frame').locator('article h1').waitFor();
        await capture('preview');
        await page.locator('#show-writing').click();
        await expect(page.locator('#body')).toHaveValue(body);
        await page.locator('#delete-post').click();
        await expect(page.locator('#confirmation-dialog')).toBeVisible();
        await expect(page.locator('#confirmation-cancel')).toBeFocused();
        await capture('confirmation');
        await page.keyboard.press('Escape');
        await expect(page.locator('#delete-post')).toBeFocused();
        await page.locator('#images').click();
        await expect(page.locator('#images-view')).toBeVisible();
        await expect(page.locator('#image-library-grid')).toHaveAttribute('aria-busy', 'false');
        await capture('images');
        await page.locator('#image-maintenance summary').click();
        await expect(page.locator('#image-library-optimize')).toBeVisible();
        await capture('image-maintenance');
        await page.locator('#settings').click();
        await expect(page.locator('#settings-view')).toBeVisible();
        await capture('settings');
        for (const [screen, id] of [
          ['appearance', 'site-form'],
          ['account', 'account-form'],
          ['backup', 'backup-card'],
          ['service', 'service-card'],
        ]) {
          await page.locator('#' + id).scrollIntoViewIfNeeded();
          await capture(screen);
        }
        // Inspect an actual native modal menu at each layout size.
        await page.locator('#studio-tools summary').click();
        await expect(page.locator('#import-posts')).toBeVisible();
        await capture('menu');
        await page.locator('#import-posts').click();
        await page.locator('#import-files').setInputFiles({
          name: 'invalid-encoding.md', mimeType: 'text/markdown', buffer: Buffer.from([0xff]),
        });
        await expect(page.locator('#markdown-import-dialog')).toBeVisible();
        await expect(page.locator('#markdown-import-results [data-state=error]')).toHaveCount(1);
        await capture('import');
        await page.locator('#markdown-import-close').click();
        await context.close();
      }
    }
  }
  await writeFile(
    resolve(output, 'editorial-admin-coverage-' + engine + '.json'),
    JSON.stringify({ baseline, samples, note: 'Ephemeral fixture; same data, browser and viewport; no production data.' }, null, 2),
  );
  const cards = samples.map((item) => {
    const label = [item.version, item.screen, item.width, item.theme].join(' · ');
    return '<figure><figcaption>' + label + '</figcaption><a href="' + item.file + '"><img loading="lazy" src="' + item.file + '" alt="' + label + '"></a></figure>';
  }).join('');
  await writeFile(
    resolve(output, 'editorial-admin-review-' + engine + '.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudInk 后台书刊设计</title><style>body{margin:0;padding:24px;background:#f7f3ee;color:#30251e;font:15px/1.8 system-ui}main{max-width:1440px;margin:auto}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:24px}figure{margin:0}img{width:100%;height:440px;object-fit:contain;object-position:top;border:1px solid #968375;background:#fffcf8}a{color:inherit}figcaption{padding:12px 0}</style><main><h1>CloudInk · 后台书刊设计</h1><p>before：升级前真实模板与样式；after：本次正式界面。同数据、同视口、同 Brown 配色。点击查看完整图片；其他主题与功能检查见主报告。</p><div class="gallery">' + cards + '</div></main></html>',
  );
  assert.deepEqual(errors, [], engine + ' editorial review must not throw');
}
