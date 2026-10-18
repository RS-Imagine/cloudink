// Isolated UI baseline and PR-00 prototype review. Never uses Wrangler remote mode.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
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

const output = resolve('build-work/ui-audit');
const origin = 'http://127.0.0.1:8795';
const studyOrigin = 'http://127.0.0.1:8796';
const widths = [1440, 390, 360];
const themes = ['light', 'dark'];
const screens = ['home', 'article', 'dashboard', 'editor'];
const report = {
  base: '7a155d59c3dceda9253caba61a6f02044d973c5b',
  revision: process.env.GITHUB_SHA || 'local',
  method:
    'Local Miniflare, ephemeral R2; local static prototype; system fonts; external CDN CSS stubbed; single cold-ish lab sample per screen, not field CWV.',
  browsers: {},
  assets: {},
  samples: [],
  existingLayoutIssues: [],
};
await mkdir(output, { recursive: true });
const allowed = new Set(
  ['tokens.css', 'style.css', 'app.js', 'index.html']
    .map((p) => '/prototypes/ui-2.0/' + p)
    .concat('/assets/cloudink.svg'),
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
  convertV4MiniflareOptions({ ...workerOptions(), host: '127.0.0.1', port: 8795 }),
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
  const overflow = data.scrollWidth > width + 1;
  if (name === 'before' && overflow)
    report.existingLayoutIssues.push({ screen, width, theme, scrollWidth: data.scrollWidth });
  else assert.equal(overflow, false, name + '/' + screen + '/' + width + ' must fit viewport');
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
          await page.locator('.post-item').filter({ hasText: demoPosts[0].title }).click();
          if (width >= 1100)
            await page
              .frameLocator('#preview-frame')
              .locator('article h1')
              .waitFor({ state: 'attached' });
          else await expect(page.locator('#body')).toBeVisible();
        } else await expect(page.locator(ready[screen])).toBeVisible();
        await capture(page, 'before', screen, theme, width);
        if (screen === 'editor' && width < 1100) {
          await page.locator('#show-preview').click();
          await page.frameLocator('#preview-frame').locator('article h1').waitFor();
          await capture(page, 'before', 'editor-preview', theme, width);
        }
        if (screen === 'article' && width !== 360) {
          await page.locator('#site-search-btn').click();
          await page.locator('#search-input').fill('生活');
          await expect(page.locator('#search-results a')).toHaveCount(2);
          await capture(page, 'before', 'search', theme, width);
          await page.keyboard.press('Escape');
          await page.locator('#share-btn').click();
          await expect(page.locator('.reader-dialog')).toBeVisible();
          await capture(page, 'before', 'share', theme, width);
          await page.keyboard.press('Escape');
          await page.locator('.article-body img').first().click();
          await expect(page.locator('.reader-dialog')).toBeVisible();
          await capture(page, 'before', 'image-preview', theme, width);
          await page.keyboard.press('Escape');
          if (width < 760) {
            await page.locator('.mobile-toc-btn').click();
            await expect(page.locator('.mobile-toc-btn')).toHaveAttribute('aria-expanded', 'true');
            await capture(page, 'before', 'toc', theme, width);
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
          await capture(page, 'before', screen, theme, width);
        }
      if (width !== 360)
        for (const [screen, path] of [
          ['about', '/about/'],
          ['not-found', '/posts/missing-design-page/'],
        ]) {
          await page.goto(origin + path);
          await expect(page.locator('h1').last()).toBeVisible();
          await capture(page, 'before', screen, theme, width);
        }
      await page.close();
    }
  await context.close();
  // Fresh contexts preserve both authentication screens in the inventory.
  for (const width of [1440, 390])
    for (const theme of themes) {
      const loginContext = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1000 : 844 },
        colorScheme: theme,
      });
      await watch(loginContext);
      const page = await loginContext.newPage();
      await page.goto(origin + '/admin');
      await expect(page.locator('#login-view')).toBeVisible();
      await capture(page, 'before', 'login', theme, width);
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
      await capture(setupPage, 'before', 'setup', theme, width);
      for (const [name, value] of Object.entries({
        token: setupToken,
        email: owner,
        password,
        confirm: password,
      }))
        await setupPage.locator('#setup-form input[name=' + name + ']').fill(value);
      await setupPage.locator('#setup-next').click();
      await expect(setupPage.locator('#setup-site-step')).toBeVisible();
      await capture(setupPage, 'before', 'setup-site', theme, width);
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
    'cloud-admin/ui/preview.worker.generated.js',
    'cloud-admin/ui/wasm/blog_wasm_bg.wasm',
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
  assert.deepEqual(errors, [], JSON.stringify(errors));
  report.checks = [
    '24 before + 24 prototype main screenshots in Chromium',
    'supplemental login/setup/settings/images inventory',
    'Firefox and WebKit prototype smoke',
    'touch emulation (Chromium/WebKit)',
    '360px overflow guard on prototype',
    'light/dark palette contrast pairs',
    'reduced motion',
    'search and library Escape/focus return',
    'editor view/state retention',
    'demo loading feedback',
    'rapid navigation',
    'no external prototype network',
  ];
  // Artifact includes a self-contained folder hierarchy: open index.html after extracting.
  await mkdir(resolve(output, 'preview/prototypes/ui-2.0'), { recursive: true });
  await mkdir(resolve(output, 'preview/assets'), { recursive: true });
  for (const name of ['index.html', 'tokens.css', 'style.css', 'app.js', 'README.md'])
    await copyFile(
      resolve('prototypes/ui-2.0', name),
      resolve(output, 'preview/prototypes/ui-2.0', name),
    );
  await copyFile(resolve('assets/cloudink.svg'), resolve(output, 'preview/assets/cloudink.svg'));
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
              (sample.version === 'before' ? '现有界面' : '2.0 原型') +
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
  await writeFile(
    resolve(output, 'index.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudInk 2.0 设计审阅</title><style>body{font:15px/1.6 system-ui;background:#f3f5f1;color:#202a25;margin:0;padding:24px}main{max-width:1400px;margin:auto}a{color:#24594f}header{padding:20px 0}h1{margin:0}h2{font-size:18px}section{border-top:1px solid #c7d1c5;padding:24px 0}.pair{display:flex;gap:24px;align-items:flex-start}figure{margin:0;flex:1;min-width:0}figcaption{margin-bottom:12px}img{width:100%;height:auto;border-radius:12px;border:1px solid #c7d1c5}select{padding:10px;margin:12px 10px 12px 0}button{padding:10px}@media(max-width:700px){.pair{display:block}figure{margin-bottom:20px}}</style><main><header><h1>CloudInk 2.0 · 设计审阅</h1><p><a href="preview/prototypes/ui-2.0/index.html">打开四页交互原型</a> · <a href="report.json">实验性能与资源报告</a></p><p>原型不会访问账号、生产数据或发布内容。点击截图查看原尺寸。实验指标不代表真机或真实用户性能。</p><label>宽度 <select id="width"><option value="">全部</option><option>1440</option><option>390</option><option>360</option></select></label><label>主题 <select id="theme"><option value="">全部</option><option>light</option><option>dark</option></select></label><p>已有界面溢出记录：' +
      report.existingLayoutIssues.length +
      '；详见 report.json。</p></header>' +
      cards +
      '</main><script>document.querySelectorAll("select").forEach(select=>select.addEventListener("change",()=>{document.querySelectorAll("section").forEach(section=>{const w=document.getElementById("width").value,t=document.getElementById("theme").value;section.hidden=!!((w&&section.dataset.width!==w)||(t&&section.dataset.theme!==t))})}));</script></html>',
  );
  console.log(
    JSON.stringify({
      browsers: report.browsers,
      screenshots: report.samples.length,
      samples: report.samples,
      assets: report.assets,
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
