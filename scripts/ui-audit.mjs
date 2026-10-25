import { verifyImageQuality } from '../cloud-web/test/image-quality.browser.mjs';
import { verifyImageOptimizer } from '../cloud-web/test/image-optimizer.browser.mjs';
// Isolated production theme and approved prototype review. Never uses Wrangler remote mode.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import assert from 'node:assert/strict';
import {
  chromium,
  firefox,
  webkit,
  expect,
} from '../cloud-admin/node_modules/@playwright/test/index.mjs';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../cloud-admin/node_modules/miniflare/dist/src/index.js';
import { workerOptions, owner, password, setupToken, draft } from '../cloud-web/test/fixture.mjs';

import { transform } from '../cloud-admin/node_modules/esbuild/lib/main.js';
import { verifySurfaces } from '../cloud-web/test/surfaces.browser.mjs';
import { verifyMobile } from '../cloud-web/test/mobile.browser.mjs';
import { verifyRelease } from '../cloud-web/test/release.browser.mjs';
import { verifyCompletion } from '../cloud-web/test/completion.browser.mjs';
import { verifyWorkflows } from '../cloud-web/test/workflows.browser.mjs';
import { verifyStudio, openPostSwitcher } from '../cloud-web/test/studio.browser.mjs';
import { verifyReader } from '../cloud-web/test/reader.browser.mjs';
import { verifyHome } from '../cloud-web/test/home.browser.mjs';
import { verifyMotion } from '../cloud-web/test/motion.browser.mjs';
import { verifyMarkdownImport } from '../cloud-web/test/import.browser.mjs';
import { verifyThemes } from '../cloud-web/test/theme.browser.mjs';

const output = resolve('build-work/ui-audit');
const origin = 'https://127.0.0.1:8795';
const studyOrigin = 'http://127.0.0.1:8796';
const widths = [1440, 390, 360];
const themes = ['light', 'dark'];
const screens = ['home', 'article', 'dashboard', 'editor'];
const report = {
  baseline: '7a155d59c3dceda9253caba61a6f02044d973c5b',
  upstream: 'db7bf42ad5a67753c4c387d2d01dc71e5141a5b8',
  revision: process.env.GITHUB_SHA || 'local',
  method:
    'Local HTTPS Miniflare (test certificate), ephemeral R2; local static prototype; system fonts; external CDN CSS stubbed; single cold-ish lab sample per screen, not field CWV.',
  browsers: {},
  assets: {},
  samples: [],
  surfaces: [],
  existingLayoutIssues: [],
};
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const allowed = new Set(
  ['tokens.css', 'style.css', 'app.js', 'index.html', 'motion.html', 'motion.js', 'surfaces.html']
    .map((p) => '/prototypes/ui-2.0/' + p)
    .concat(
      '/assets/cloudink.svg',
      '/assets/design-tokens.css',
      '/assets/design-foundation.css',
      '/assets/motion.css',
      '/assets/motion.js',
      '/assets/theme.js',
      '/assets/expressive.css',
    ),
);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, studyOrigin).pathname;
  if (!allowed.has(path)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(resolve('.' + path));
    response.writeHead(200, {
      'Content-Type': {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.svg': 'image/svg+xml',
      }[extname(path)],
      'Cache-Control': 'no-store',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(8796, '127.0.0.1', done));
const mf = new Miniflare(
  convertV4MiniflareOptions({ ...workerOptions(), host: '127.0.0.1', port: 8795, https: true }),
);
let browser;
const errors = [];
const demoPosts = [
  {
    slug: 'slow-days',
    title: '把日子，写成一封长信',
    description: '在平凡的缝隙里，收集那些值得被记住的瞬间。',
    body: '清晨的光落在窗台上，咖啡还冒着热气。忽然觉得，这样的时刻也值得被认真写下。\n\n## 一些值得被记住的小事\n\n写作不一定要从一个完整的想法开始。有时候，只需要留意一个细节。\n\n> 写作，是与生活保持联系的一种方式。\n\n## 慢下来，才看得见\n\n我们总是在赶路，偶尔也需要停下来。留一点空间，让语言有呼吸的余地。\n\n| 片刻 | 记录 |\n| --- | --- |\n| 清晨 | 一杯咖啡 |\n\n$x^2 + y^2$\n\n\`\`\`rust\nfn main() { println!("Hello, CloudInk"); }\n\`\`\`\n\n## 先开始就好\n\n一个想法，一页笔记，一次小小的开始。',
  },
  {
    slug: 'white-space',
    title: '给生活留一点空白',
    description: '空白，也是表达的一部分。',
    body: '## 留白\n\n不必填满每一页。',
  },
  {
    slug: 'digital-garden',
    title: '一个人的数字花园',
    description: '种下想法，让它们慢慢生长。',
    body: '## 生长\n\n写下一个想法。',
  },
  {
    slug: 'mountain-letter',
    title: '在山间，找回自己的节奏',
    description: '一次与自己重新相遇的时间。',
    body: '## 山间\n\n这是一篇尚未发布的草稿。',
  },
];
const ready = {
  home: '.hero h1',
  article: 'article h1',
  dashboard: '#home-view',
  editor: '#preview-frame',
};
async function watch(context) {
  await context.addInitScript(() => {
    window.__uiAudit = { lcp: null, cls: 0, longTasks: null };
    const supported = PerformanceObserver.supportedEntryTypes || [];
    if (supported.includes('largest-contentful-paint'))
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__uiAudit.lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    if (supported.includes('layout-shift'))
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (!entry.hadRecentInput) window.__uiAudit.cls += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
    if (supported.includes('longtask')) {
      window.__uiAudit.longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__uiAudit.longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    }
  });
  // Keep baseline independent of external CDN availability. Not representative of internet loading.
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'text/css', body: '' }),
  );
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
}
async function capture(page, name, screen, theme, width, engine = 'chromium') {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  const data = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    return {
      ...window.__uiAudit,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      resourceCount: performance.getEntriesByType('resource').length,
      resourceBytes: performance
        .getEntriesByType('resource')
        .reduce((total, entry) => total + entry.transferSize, 0),
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      htmlBytes: new TextEncoder().encode(document.documentElement.outerHTML).length,
    };
  });
  report.samples.push({ version: name, screen, theme, width, engine, ...data });
  console.log(JSON.stringify({ capture: name, screen, theme, width, engine }));
  const overflow = data.scrollWidth > width + 1;
  if (name === 'production' && overflow)
    report.existingLayoutIssues.push({ screen, width, theme, scrollWidth: data.scrollWidth });
  assert.equal(overflow, false, name + '/' + screen + '/' + width + ' must fit viewport');
  await page.screenshot({
    path: resolve(output, name + '-' + screen + '-' + width + '-' + theme + '-' + engine + '.png'),
    fullPage: true,
    animations: 'disabled',
  });
}
async function tokenContrast(page) {
  const results = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const rgb = (hex) => {
      const value = hex.trim().slice(1);
      return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
    };
    const luminance = (color) =>
      rgb(color)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
    return [
      ['text', 'bg'],
      ['text', 'surface'],
      ['text', 'elevated'],
      ['muted', 'bg'],
      ['muted', 'surface'],
      ['on-primary', 'primary'],
      ['on-primary-container', 'primary-container'],
      ['error', 'surface'],
      ['success', 'surface'],
    ].map(([fg, bg]) => {
      const a = luminance(style.getPropertyValue('--ci-' + fg));
      const b = luminance(style.getPropertyValue('--ci-' + bg));
      return { fg, bg, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  });
  for (const pair of results) assert.ok(pair.ratio >= 4.5, JSON.stringify(pair));
  return results;
}
try {
  await mf.ready;
  const setup = await mf.dispatchFetch(origin + '/api/setup', {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: 'Bearer ' + setupToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: owner,
      password,
      site: {
        title: 'CloudInk 演示博客',
        bigTitle: '记录所见，也记录心之所向。',
        author: '林间',
        subtitle: '关于生活、思考与创造。',
        description: '一个安静的文字角落。',
        about: '## 关于这个角落\n\n保持好奇，慢慢生长。',
      },
    }),
  });
  assert.equal(setup.status, 200, await setup.clone().text());
  const cookie = setup.headers.get('Set-Cookie').split(';')[0];
  const csrf = (await setup.json()).csrf;
  for (const [index, post] of demoPosts.entries()) {
    const value = draft(post.slug, post.body);
    Object.assign(value.front_matter, {
      title: post.title,
      description: post.description,
      date: '2026-10-' + String(12 - index * 2).padStart(2, '0'),
    });
    const response = await mf.dispatchFetch(origin + '/api/posts/' + post.slug, {
      method: 'PUT',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ draft: value, etag: null }),
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  report.browsers.chromium = browser.version();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
  await watch(context);
  const admin = await context.newPage();
  await admin.goto(origin + '/admin');
  await expect(admin.locator('#login-view')).toBeVisible();
  await admin.locator('#login-form input[name=email]').fill(owner);
  await admin.locator('#login-form input[name=password]').fill(password);
  await admin.locator('#login-submit').click();
  await expect(admin.locator('#home-view')).toBeVisible();
  // Generate a generic local image; no external or production media is used.
  const imageData = await admin.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 640;
    const context = canvas.getContext('2d');
    context.fillStyle = '#d9e5d9';
    context.fillRect(0, 0, 1080, 640);
    context.fillStyle = '#f6f6e9';
    context.beginPath();
    context.arc(800, 140, 60, 0, Math.PI * 2);
    context.fill();
    for (const [color, y, offset] of [
      ['#8ea58c', 340, 0],
      ['#60816c', 440, 150],
      ['#31594d', 570, -100],
    ]) {
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(0, 640);
      context.lineTo(0, y);
      context.bezierCurveTo(280 + offset, y - 250, 650 + offset, y + 100, 1080, y - 120);
      context.lineTo(1080, 640);
      context.closePath();
      context.fill();
    }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  // Generate real Rust/WASM pages through the local publication UI.
  for (const post of demoPosts.slice(0, 3)) {
    await openPostSwitcher(admin);
    await admin.locator('.post-item').filter({ hasText: post.title }).click();
    await expect(admin.locator('#title')).toHaveValue(post.title);
    if (post.slug === 'slow-days') {
      await admin.locator('#image-files').setInputFiles({
        name: '山间来信.png',
        mimeType: 'image/png',
        buffer: Buffer.from(imageData, 'base64'),
      });
      await expect(admin.locator('#notice')).toContainText('图片已上传');
    }
    await admin.locator('#publish-post').click();
    await expect(admin.locator('#publish-post')).not.toHaveAttribute('aria-busy', 'true');
    await expect(admin.locator('#publish-banner')).toContainText('已上线');
  }
  for (const width of widths)
    for (const theme of themes) {
      await context.setDefaultTimeout(15000);
      const page = await context.newPage();
      await page.setViewportSize({ width, height: width > 759 ? 1000 : 844 });
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      await page.emulateMedia({ colorScheme: theme });
      for (const screen of screens) {
        await page.goto(
          screen === 'home'
            ? origin + '/'
            : screen === 'article'
              ? origin + '/posts/slow-days/'
              : origin + '/admin',
        );
        if (screen === 'editor') {
          await expect(page.locator('#home-view')).toBeVisible();
          await openPostSwitcher(page);
          await page.locator('.post-item').filter({ hasText: demoPosts[0].title }).click();
          if (width >= 1100)
            await page
              .frameLocator('#preview-frame')
              .locator('article h1')
              .waitFor({ state: 'attached' });
          else await expect(page.locator('#body')).toBeVisible();
        } else await expect(page.locator(ready[screen])).toBeVisible();
        await capture(page, 'production', screen, theme, width);
        if (screen === 'editor' && width < 1100) {
          await page.locator('#show-preview').click();
          await page.frameLocator('#preview-frame').locator('article h1').waitFor();
          await capture(page, 'production', 'editor-preview', theme, width);
        }
        if (screen === 'article' && width !== 360) {
          await page.locator('#site-search-btn').click();
          await page.locator('#search-input').fill('生活');
          await expect(page.locator('#search-results a')).toHaveCount(2);
          await capture(page, 'production', 'search', theme, width);
          await page.keyboard.press('Escape');
          await page.locator('#share-btn').click();
          await expect(page.locator('.reader-dialog')).toBeVisible();
          await capture(page, 'production', 'share', theme, width);
          await page.keyboard.press('Escape');
          await page.locator('.article-body img').first().click();
          await expect(page.locator('.reader-dialog')).toBeVisible();
          await capture(page, 'production', 'image-preview', theme, width);
          await page.keyboard.press('Escape');
          if (width < 760) {
            await page.locator('.mobile-toc-btn').click();
            await expect(page.locator('.mobile-toc-btn')).toHaveAttribute('aria-expanded', 'true');
            await capture(page, 'production', 'toc', theme, width);
            await page.keyboard.press('Escape');
          }
        }
      }
      // Inventory supplemental workflow surfaces using the real authenticated UI.
      if (width !== 360)
        for (const [screen, button, selector] of [
          ['images', '#images', '#images-view'],
          ['settings', '#settings', '#settings-view'],
        ]) {
          await page.locator(button).click();
          await expect(page.locator(selector)).toBeVisible();
          await capture(page, 'production', screen, theme, width);
        }
      if (width !== 360)
        for (const [screen, path] of [
          ['about', '/about/'],
          ['not-found', '/posts/missing-design-page/'],
        ]) {
          await page.goto(origin + path);
          await expect(page.locator('h1').last()).toBeVisible();
          await capture(page, 'production', screen, theme, width);
        }
      await page.close();
    }
  await context.close();
  // Fresh contexts preserve both authentication screens in the inventory.
  for (const width of [1440, 390])
    for (const theme of themes) {
      const loginContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: width === 1440 ? 1000 : 844 },
        colorScheme: theme,
      });
      await watch(loginContext);
      const page = await loginContext.newPage();
      await page.goto(origin + '/admin');
      await expect(page.locator('#login-view')).toBeVisible();
      await capture(page, 'production', 'login', theme, width);
      await page.close();
      // Setup is captured from the same shipped DOM, with only initialization status mocked.
      await loginContext.route('**/api/config', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.initialized = false;
        await route.fulfill({ response, json: data });
      });
      const setupPage = await loginContext.newPage();
      await setupPage.goto(origin + '/admin');
      await expect(setupPage.locator('#setup-view')).toBeVisible();
      await capture(setupPage, 'production', 'setup', theme, width);
      for (const [name, value] of Object.entries({
        token: setupToken,
        email: owner,
        password,
        confirm: password,
      }))
        await setupPage.locator('#setup-form input[name=' + name + ']').fill(value);
      await setupPage.locator('#setup-next').click();
      await expect(setupPage.locator('#setup-site-step')).toBeVisible();
      await capture(setupPage, 'production', 'setup-site', theme, width);
      await loginContext.close();
    }
  await browser.close();
  browser = undefined;
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    browser = await launcher.launch({
      headless: true,
      ...(engine === 'chromium' ? { args: ['--no-sandbox'] } : {}),
    });
    report.browsers[engine] = browser.version();
    // Accept only the local fixture certificate; keep Secure/HttpOnly cookies intact.
    const currentBrowser = browser;
    const localBrowser = {
      newContext: (options) => currentBrowser.newContext({ ...options, ignoreHTTPSErrors: true }),
    };
    await verifyStudio(localBrowser, origin, output, engine);
    await verifyWorkflows(localBrowser, origin, output, engine);
    await verifyHome(localBrowser, origin, output, engine);
    await verifyReader(localBrowser, origin, output, engine);
    await verifyMobile(localBrowser, origin, output, engine);
    await verifyRelease(localBrowser, origin, output, engine);
    await verifyCompletion(localBrowser, origin, output, engine);
    await verifyThemes(localBrowser, origin, output, engine);
    await verifyMarkdownImport(localBrowser, origin, output, engine);
    await verifyImageOptimizer(localBrowser, origin);
    await verifyImageQuality(localBrowser, origin, output, engine);
    report.surfaces.push(await verifySurfaces(localBrowser, origin, output, engine));
    await verifyMotion(localBrowser, origin, output, engine);
    for (const width of engine === 'chromium' ? widths : [390])
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport: { width, height: width > 759 ? 1000 : 844 },
          colorScheme: theme,
          reducedMotion: 'reduce',
          ...(engine !== 'firefox' ? { hasTouch: width < 760, isMobile: width < 760 } : {}),
        });
        await watch(context);
        const page = await context.newPage();
        const outside = [];
        page.on('request', (request) => {
          if (!request.url().startsWith(studyOrigin + '/')) outside.push(request.url());
        });
        for (const screen of screens) {
          await page.goto(
            studyOrigin + '/prototypes/ui-2.0/index.html?capture&theme=' + theme + '#' + screen,
          );
          await page.reload();
          await expect(page.locator('#content')).toBeVisible();
          await capture(page, 'prototype', screen, theme, width, engine);
          assert.equal(
            await page.locator('.screen').evaluate((node) => getComputedStyle(node).animationName),
            'none',
          );
        }
        report.samples.at(-1).contrast = await tokenContrast(page);
        // Palette alternative must maintain readable text in both themes.
        await page.evaluate(() => {
          document.documentElement.dataset.palette = 'neutral';
        });
        await tokenContrast(page);
        await page.evaluate(() => {
          document.documentElement.dataset.palette = 'ink';
        });
        const textarea = page.locator('#demo-body');
        await textarea.fill('## 新的演示内容\n\n不会发送到远端。');
        await page.getByRole('button', { name: '预览', exact: true }).click();
        await expect(page.locator('#demo-preview')).toContainText('不会发送到远端');
        await page.getByRole('button', { name: '写作', exact: true }).click();
        await expect(textarea).toHaveValue(/新的演示内容/);
        await page.locator('#demo-save').click();
        await expect(page.locator('#demo-save')).not.toHaveAttribute('aria-busy', 'true');
        await expect(page.locator('#save-indicator')).toContainText('演示草稿已保存');
        await page.locator('[data-theme-toggle]').click();
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          theme === 'light' ? 'dark' : 'light',
        );
        await page.goto(
          studyOrigin + '/prototypes/ui-2.0/index.html?capture&theme=' + theme + '#home',
        );
        const search = page.getByRole('button', { name: '搜索文章', exact: true });
        await search.click();
        await expect(page.locator('#search-input')).toBeFocused();
        await page.locator('#search-input').fill('不存在的词');
        await expect(page.locator('#search-results')).toContainText('还没有找到');
        await page.keyboard.press('Escape');
        await expect(search).toBeFocused();
        await page.goto(
          studyOrigin + '/prototypes/ui-2.0/index.html?capture&theme=' + theme + '#dashboard',
        );
        await page.getByRole('button', { name: '草稿', exact: true }).click();
        await expect(page.locator('.writing-row')).toHaveCount(2);
        const library = page.locator('[data-library]:visible').first();
        await library.click();
        await expect(page.locator('#library-dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(library).toBeFocused();
        assert.deepEqual(outside, [], 'The prototype must be completely local, with no API calls');
        await context.close();
      }
    const surfaceDemoContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'no-preference',
    });
    const surfaceDemo = await surfaceDemoContext.newPage();
    const demoOutside = [];
    surfaceDemo.on('request', (request) => {
      if (!request.url().startsWith(studyOrigin + '/')) demoOutside.push(request.url());
    });
    await surfaceDemo.goto(studyOrigin + '/prototypes/ui-2.0/surfaces.html');
    await expect(surfaceDemo.locator('select[data-effects-mode]')).toBeVisible();
    await surfaceDemo.locator('select[data-effects-mode]').selectOption('off');
    await expect(surfaceDemo.locator('html')).toHaveAttribute('data-effects', 'solid');
    await surfaceDemo.locator('select[data-theme-mode]').selectOption('dark');
    await expect(surfaceDemo.locator('html')).toHaveAttribute('data-theme', 'dark');
    await surfaceDemo.keyboard.press('Escape');
    await expect(surfaceDemo.locator('.reader-menu')).not.toHaveAttribute('open', '');
    assert.deepEqual(demoOutside, [], 'Surface comparison stays local');
    await surfaceDemoContext.close();
    // Ordinary motion can be interrupted by quick navigation; editor state stays in memory.
    const motionContext = await browser.newContext({
      reducedMotion: 'no-preference',
      viewport: { width: 1440, height: 1000 },
    });
    const page = await motionContext.newPage();
    await page.goto(studyOrigin + '/prototypes/ui-2.0/index.html#editor');
    await page.locator('#demo-body').fill('Retain this demo text');
    await page.locator('#demo-save').click();
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#demo-save')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#demo-body')).toHaveValue('Retain this demo text');
    await page.evaluate(async () => {
      for (const name of ['dashboard', 'home', 'article', 'editor']) {
        location.hash = name;
        await new Promise((done) => setTimeout(done, 30));
      }
    });
    await expect(page.locator('#demo-body')).toHaveValue('Retain this demo text');
    await motionContext.close();
    await browser.close();
    browser = undefined;
  }
  for (const path of [
    'build-work/web-public/client.js',
    'build-work/web-public/styles.css',
    'cloud-admin/ui/app.generated.js',
    'cloud-admin/ui/style.css',
    'cloud-admin/ui/studio.css',
    'cloud-admin/ui/workflows.css',
    'cloud-admin/ui/preview.worker.generated.js',
    'cloud-admin/ui/image.worker.generated.js',
    'cloud-admin/ui/image-maintenance.generated.js',
    'cloud-admin/ui/wasm/blog_wasm_bg.wasm',
    'assets/design-tokens.css',
    'assets/design-foundation.css',
    'assets/theme.js',
    'crates/blog-core/src/assets/home.css',
    'crates/blog-core/src/assets/reader.css',
    'assets/motion.js',
    'assets/motion.css',
    'assets/mobile.js',
    'assets/mobile.css',
    'assets/expressive.css',
    'prototypes/ui-2.0/index.html',
    'prototypes/ui-2.0/tokens.css',
    'prototypes/ui-2.0/style.css',
    'prototypes/ui-2.0/app.js',
  ]) {
    const bytes = await readFile(path);
    report.assets[path] = {
      bytes: bytes.length,
      gzip: gzipSync(bytes).length,
      brotli: brotliCompressSync(bytes).length,
    };
  }
  const tokens = await readFile('assets/design-tokens.css', 'utf8');
  const foundations = await readFile('assets/design-foundation.css', 'utf8');
  const readerCSS = await readFile('build-work/web-public/styles.css', 'utf8');
  const adminCSS = await (await mf.dispatchFetch(origin + '/style.css')).text();
  report.assets['served/admin/style.css'] = {
    bytes: Buffer.byteLength(adminCSS),
    gzip: gzipSync(adminCSS).length,
    brotli: brotliCompressSync(adminCSS).length,
  };
  assert.ok(
    readerCSS.includes(tokens) && adminCSS.includes(tokens),
    'Both surfaces must embed the same tokens',
  );
  assert.ok(
    readerCSS.includes(foundations) && adminCSS.includes(foundations),
    'Both surfaces must embed the same foundations',
  );
  assert.ok(
    gzipSync(tokens).length + gzipSync(foundations).length <= 5120,
    'Six-palette shared CSS gzip budget',
  );
  const motionJS = (await transform(await readFile('assets/motion.js', 'utf8'), { minify: true }))
    .code;
  const motionCSS = (
    await transform(await readFile('assets/motion.css', 'utf8'), { minify: true, loader: 'css' })
  ).code;
  report.assets['shared/motion.min.js+css'] = {
    gzip: gzipSync(motionJS).length + gzipSync(motionCSS).length,
  };
  assert.ok(report.assets['shared/motion.min.js+css'].gzip <= 4096, 'Motion runtime gzip budget');
  const homeCSS = (
    await transform(await readFile('crates/blog-core/src/assets/home.css', 'utf8'), {
      minify: true,
      loader: 'css',
    })
  ).code;
  report.assets['reader/home.min.css'] = { gzip: gzipSync(homeCSS).length };
  assert.ok(report.assets['reader/home.min.css'].gzip <= 3072, 'Home CSS gzip budget');
  const readerCSSMin = (
    await transform(await readFile('crates/blog-core/src/assets/reader.css', 'utf8'), {
      minify: true,
      loader: 'css',
    })
  ).code;
  report.assets['reader/reading.min.css'] = { gzip: gzipSync(readerCSSMin).length };
  assert.ok(report.assets['reader/reading.min.css'].gzip <= 4096, 'Reading CSS gzip budget');
  const studioCSS = (
    await transform(await readFile('cloud-admin/ui/studio.css', 'utf8'), {
      minify: true,
      loader: 'css',
    })
  ).code;
  report.assets['admin/studio.min.css'] = { gzip: gzipSync(studioCSS).length };
  assert.ok(report.assets['admin/studio.min.css'].gzip <= 4096, 'Studio shell CSS gzip budget');
  const workflowCSS = (
    await transform(await readFile('cloud-admin/ui/workflows.css', 'utf8'), {
      minify: true,
      loader: 'css',
    })
  ).code;
  report.assets['admin/workflows.min.css'] = { gzip: gzipSync(workflowCSS).length };
  assert.ok(report.assets['admin/workflows.min.css'].gzip <= 4096, 'Workflow CSS gzip budget');
  const mobileJS = (await transform(await readFile('assets/mobile.js', 'utf8'), { minify: true }))
    .code;
  const mobileCSS = (
    await transform(await readFile('assets/mobile.css', 'utf8'), { minify: true, loader: 'css' })
  ).code;
  report.assets['shared/mobile.min.js+css'] = {
    gzip: gzipSync(mobileJS).length + gzipSync(mobileCSS).length,
  };
  assert.ok(
    report.assets['shared/mobile.min.js+css'].gzip <= 5120,
    'Mobile interactions gzip budget',
  );
  const expressiveCSS = (
    await transform(await readFile('assets/expressive.css', 'utf8'), {
      minify: true,
      loader: 'css',
    })
  ).code;
  report.assets['shared/expressive.min.css'] = { gzip: gzipSync(expressiveCSS).length };
  assert.ok(
    report.assets['shared/expressive.min.css'].gzip <= 2048,
    'Expressive surfaces CSS gzip budget',
  );
  assert.ok(
    report.assets['assets/theme.js'].gzip <= 2048,
    'Theme and effects bootstrap gzip budget',
  );
  // Aggregate guards complement the per-module budgets: no hidden growth between releases.
  const releaseBudgets = {
    'build-work/web-public/client.js': 74 * 1024,
    'build-work/web-public/styles.css': 13 * 1024,
    'cloud-admin/ui/app.generated.js': 29 * 1024,
    'served/admin/style.css': 15 * 1024,
    'cloud-admin/ui/preview.worker.generated.js': 55 * 1024,
    'cloud-admin/ui/image.worker.generated.js': 4 * 1024,
    'cloud-admin/ui/image-maintenance.generated.js': 4 * 1024,
    'cloud-admin/ui/wasm/blog_wasm_bg.wasm': 750 * 1024,
  };
  report.releaseBudgets = releaseBudgets;
  for (const [path, budget] of Object.entries(releaseBudgets))
    assert.ok(report.assets[path].gzip <= budget, path + ' exceeds the release gzip budget');
  assert.deepEqual(errors, [], JSON.stringify(errors));
  report.checks = [
    '24 primary production + 24 reference screenshots in Chromium; supplemental workflow and theme captures',
    'supplemental login/setup/settings/images inventory',
    'Chromium, Firefox and WebKit production theme + prototype smoke',
    'touch emulation (Chromium/WebKit)',
    '360px overflow guard on production and prototype',
    'six native color swatches: keyboard, saved choice, Brown preview, 12 palette/mode contrast combinations and responsive screenshots',
    'light/dark palette contrast pairs',
    'three-engine SVG/ICO upload, decoded image preview, saved icon reload, default reset, mobile/desktop screenshots; full publication and backup round-trip in Chromium',
    'three-engine bounded glass/opaque comparisons, worst-backdrop text contrast, effect opt-out/sync, storage/CSS denial, system preferences and low-resource fallback; Chromium CPU4x scroll samples',
    'reduced motion',
    'three-engine mobile detents, drag/cancel, keyboard alternatives, modal menu identity, rotation and viewport simulation; Chromium touch cancellation',
    'three-engine editor pane/selection retention, save retry, library failure/retry and protection, confirmation focus/Escape, settings and backup feedback',
    'three-engine studio shell, filters, native disclosures, guarded draft navigation, login and setup steps',
    'three-engine reader layout, TOC focus/anchors, search keyboard/loading/retry, history and no-script article',
    'three-engine reader home, native mobile menu, aria-current, skip link, long text and no-script navigation',
    'three-engine spring press, cancellation, dialog reversal, keyboard, reduced motion and WAAPI fallback',
    'search and library Escape/focus return',
    'editor view/state retention',
    'demo loading feedback',
    'rapid navigation',
    'no external prototype network',
  ];
  report.checks.push(
    'three-engine startup/config/session/data failure-retry, no auth flash, manual login/logout focus, card keyboard navigation and responsive preview focus',
    'three-engine 360px text-spacing reflow: reader/search/login/dashboard/settings/images and primary navigation',
    'keyboard viewport overrides released during simulated pinch zoom; editor text retained',
    'aggregate public/admin/preview/WASM gzip release budgets',
  );
  // Artifact includes a self-contained folder hierarchy: open index.html after extracting.
  await mkdir(resolve(output, 'preview/prototypes/ui-2.0'), { recursive: true });
  await mkdir(resolve(output, 'preview/assets'), { recursive: true });
  for (const name of [
    'index.html',
    'tokens.css',
    'style.css',
    'app.js',
    'README.md',
    'motion.html',
    'motion.js',
    'surfaces.html',
  ])
    await copyFile(
      resolve('prototypes/ui-2.0', name),
      resolve(output, 'preview/prototypes/ui-2.0', name),
    );
  await copyFile(resolve('assets/cloudink.svg'), resolve(output, 'preview/assets/cloudink.svg'));
  await copyFile(
    resolve('assets/design-tokens.css'),
    resolve(output, 'preview/assets/design-tokens.css'),
  );
  for (const name of [
    'design-foundation.css',
    'motion.css',
    'motion.js',
    'mobile.css',
    'mobile.js',
    'theme.js',
    'expressive.css',
  ])
    await copyFile(resolve('assets', name), resolve(output, 'preview/assets', name));
  await writeFile(
    resolve(output, 'preview/mobile-frame.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudInk 移动面板演示</title><link rel="stylesheet" href="assets/design-tokens.css"><link rel="stylesheet" href="assets/design-foundation.css"><link rel="stylesheet" href="assets/motion.css"><link rel="stylesheet" href="assets/mobile.css"><style>*{box-sizing:border-box}body{margin:0;padding:24px;font:15px/1.8 var(--ci-font-ui);color:var(--ci-text);background:var(--ci-bg)}body:has(dialog[open]){overflow:hidden}header{display:flex;align-items:center;gap:10px;font-weight:600}h1{font-size:30px;line-height:1.4;margin-top:40px}p{color:var(--ci-muted)}button{min-height:44px;border:1px solid var(--ci-divider);border-radius:14px;padding:10px 16px;background:var(--ci-surface);color:var(--ci-text);font:inherit}main>button{display:block;width:100%;margin:16px 0}.demo-items button{display:block;width:100%;margin:8px 0;text-align:left}.demo-close{float:right}.demo-actions{display:flex;gap:8px;justify-content:flex-end}dialog{border:1px solid var(--ci-divider);background:var(--ci-elevated);color:var(--ci-text)}</style><header><img src="assets/cloudink.svg" width="28" height="28" alt="">CloudInk · 云砚</header><main><h1>随手展开，轻轻收起。</h1><p>拖动把手，或使用点击与方向键，体验正式共用的移动面板。</p><button id="open-list">选择文章</button><button id="open-confirm">操作确认</button><button id="theme">切换明暗</button><p id="result" role="status">本地交互演示。</p></main><dialog id="list" data-sheet="list" aria-labelledby="list-title"><button class="demo-close" data-close="list">关闭</button><h2 id="list-title">选择文章</h2><div class="demo-items"></div></dialog><dialog id="confirm" data-sheet="compact" aria-labelledby="confirm-title"><h2 id="confirm-title">继续这次操作？</h2><p>把手关闭和 Esc 均为取消；按钮确认只更新本地演示状态。</p><div class="demo-actions"><button data-close="confirm">取消</button><button id="accept">确认</button></div></dialog><script src="assets/motion.js"></script><script src="assets/mobile.js"></script><script>CloudInkMotion.mount();const $=id=>document.getElementById(id);for(let i=1;i<=12;i++){const button=document.createElement(\'button\');button.textContent=\'一篇值得留下的文字 · \'+i;button.addEventListener(\'click\',()=>{$(\'result\').textContent=\'已选择演示文章 \'+i;CloudInkMotion.closeDialog($(\'list\'))});document.querySelector(\'.demo-items\').append(button)}$(\'open-list\').onclick=()=>CloudInkMotion.openDialog($(\'list\'));$(\'open-confirm\').onclick=()=>CloudInkMotion.openDialog($(\'confirm\'));document.querySelectorAll(\'[data-close]\').forEach(button=>button.onclick=()=>CloudInkMotion.closeDialog($(button.dataset.close)));$(\'accept\').onclick=()=>{$(\'result\').textContent=\'本地确认已完成\';CloudInkMotion.closeDialog($(\'confirm\'))};$(\'theme\').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme===\'dark\'?\'light\':\'dark\'};</script></html>',
  );
  await writeFile(
    resolve(output, 'preview/mobile.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudInk 移动交互预览</title><link rel="stylesheet" href="assets/design-tokens.css"><style>body{margin:0;padding:24px;font:15px/1.8 var(--ci-font-ui);background:var(--ci-bg);color:var(--ci-text);text-align:center}h1{font-size:26px}iframe{display:block;width:390px;max-width:100%;height:760px;border:1px solid var(--ci-divider);border-radius:28px;margin:24px auto;background:var(--ci-surface)}</style><h1>CloudInk · 移动面板</h1><p>使用鼠标或触摸拖动把手，也可以点击把手、使用方向键或 Esc。</p><iframe src="mobile-frame.html" title="CloudInk 手机交互演示"></iframe></html>',
  );
  const pairs = new Map();
  for (const sample of report.samples) {
    const key = [sample.screen, sample.width, sample.theme, sample.engine].join('-');
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(sample);
  }
  const cards = [...pairs.entries()]
    .map(
      ([key, samples]) =>
        '<section data-width="' +
        samples[0].width +
        '" data-theme="' +
        samples[0].theme +
        '"><h2>' +
        key +
        '</h2><div class="pair">' +
        samples
          .map((sample) => {
            const file =
              [sample.version, sample.screen, sample.width, sample.theme, sample.engine].join('-') +
              '.png';
            return (
              '<figure><figcaption>' +
              (sample.version === 'production' ? '正式界面（当前提交）' : '已确认的设计参考') +
              '</figcaption><a href="' +
              file +
              '"><img loading="lazy" src="' +
              file +
              '" alt="' +
              file +
              '"></a></figure>'
            );
          })
          .join('') +
        '</div></section>',
    )
    .join('');
  const primaryFiles = new Set(
    report.samples.map(
      (sample) =>
        [sample.version, sample.screen, sample.width, sample.theme, sample.engine].join('-') +
        '.png',
    ),
  );
  report.supplementalScreenshots = (await readdir(output))
    .filter((file) => file.endsWith('.png') && !primaryFiles.has(file))
    .sort();
  const supplemental = report.supplementalScreenshots
    .map((file) => {
      const url = encodeURIComponent(file);
      const label = file.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
      return (
        '<figure><figcaption>' +
        label +
        '</figcaption><a href="' +
        url +
        '"><img loading="lazy" decoding="async" src="' +
        url +
        '" alt="' +
        label +
        '"></a></figure>'
      );
    })
    .join('');
  await writeFile(
    resolve(output, 'index.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudInk 2.0 设计审阅</title><style>body{font:15px/1.6 system-ui;background:#f3f5f1;color:#202a25;margin:0;padding:24px}main{max-width:1400px;margin:auto}a{color:#24594f}header{padding:20px 0}h1{margin:0}h2{font-size:18px}section{border-top:1px solid #c7d1c5;padding:24px 0}.pair{display:flex;gap:24px;align-items:flex-start}figure{margin:0;flex:1;min-width:0}figcaption{margin-bottom:12px}img{width:100%;height:auto;border-radius:12px;border:1px solid #c7d1c5}select{padding:10px;margin:12px 10px 12px 0}button{padding:10px}.supplemental{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px}.supplemental figcaption{overflow-wrap:anywhere;font-size:13px}.supplemental img{aspect-ratio:3/2;object-fit:contain;background:#e9ede6}summary{cursor:pointer;padding:20px 0;font-weight:600}@media(max-width:700px){.pair{display:block}figure{margin-bottom:20px}}</style><main><header><h1>CloudInk 2.0 · 最终设计审阅</h1><p><a href="preview/prototypes/ui-2.0/surfaces.html">打开玻璃与不透明比较</a> · <a href="preview/mobile.html">打开移动面板交互演示</a> · <a href="preview/prototypes/ui-2.0/index.html">打开已确认的设计参考</a> · <a href="preview/prototypes/ui-2.0/motion.html">打开交互动画演示</a> · <a href="report.json">实验性能与资源报告</a></p><p>正式界面只使用本地临时演示数据；参考原型不访问接口。<a href="https://github.com/RS-Imagine/cloudink/actions/runs/39118109086/artifacts/12133585772">下载 PR-00 升级前基线</a>。<a href="https://github.com/RS-Imagine/cloudink/actions/runs/39147267055/artifacts/12143813480">下载 PR-05 阶段基线</a>。<a href="https://github.com/RS-Imagine/cloudink/actions/runs/39238605433/artifacts/12180362373">下载 PR-08 上游基线</a>。左侧为当前正式界面，右侧为已确认原型，不能将原型当作升级前截图；升级前请使用 PR-00 基线包。补充文字间距截图以 release-text-spacing 开头。点击截图查看原尺寸。实验指标不代表真机或真实用户性能。</p><label>宽度 <select id="width"><option value="">全部</option><option>1440</option><option>390</option><option>360</option></select></label><label>主题 <select id="theme"><option value="">全部</option><option>light</option><option>dark</option></select></label><p>当前界面溢出记录：' +
      report.existingLayoutIssues.length +
      '；详见 report.json。</p></header>' +
      cards +
      '<details open><summary>全部补充交互截图 · ' +
      report.supplementalScreenshots.length +
      ' 张</summary><div class="supplemental">' +
      supplemental +
      '</div></details>' +
      '</main><script>document.querySelectorAll("select").forEach(select=>select.addEventListener("change",()=>{document.querySelectorAll("section[data-width]").forEach(section=>{const w=document.getElementById("width").value,t=document.getElementById("theme").value;section.hidden=!!((w&&section.dataset.width!==w)||(t&&section.dataset.theme!==t))})}));</script></html>',
  );
  console.log(
    JSON.stringify({
      browsers: report.browsers,
      screenshots: report.samples.length,
      supplementalScreenshots: report.supplementalScreenshots,
      samples: report.samples,
      assets: report.assets,
      surfaces: report.surfaces,
      releaseBudgets: report.releaseBudgets,
      existingLayoutIssues: report.existingLayoutIssues,
      checks: report.checks,
    }),
  );
} finally {
  await browser?.close();
  await mf.dispose();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
