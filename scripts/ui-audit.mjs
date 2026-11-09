import { verifyUiStability } from '../cloud-web/test/ui-stability.browser.mjs';
import { navigateStudio } from '../cloud-web/test/studio-navigation.mjs';
import { verifyUiAuditRegressions } from '../cloud-web/test/ui-audit-regressions.browser.mjs';
import { verifyReaderMetadata } from '../cloud-web/test/reader-metadata.browser.mjs';
import { verifyTemplateUpdates } from '../cloud-web/test/template-update.browser.mjs';
import { verifyArchive } from '../cloud-web/test/archive.browser.mjs';
import { verifyPostAddresses } from '../cloud-web/test/post-address.browser.mjs';
import { verifyHomeIllustrations } from '../cloud-web/test/home-illustration.browser.mjs';
import { verifyLongReading } from '../cloud-web/test/long-reading.browser.mjs';
import { verifyReaderLoading } from '../cloud-web/test/reader-loading.browser.mjs';
import { verifyImageQuality } from '../cloud-web/test/image-quality.browser.mjs';
import { verifyImageOptimizer } from '../cloud-web/test/image-optimizer.browser.mjs';
// Review the shipped UI with ephemeral data. Never uses Wrangler remote mode.
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { verifyStudio, openArticleList } from '../cloud-web/test/studio.browser.mjs';
import { verifyReader } from '../cloud-web/test/reader.browser.mjs';
import { verifyHome } from '../cloud-web/test/home.browser.mjs';
import { verifyMotion } from '../cloud-web/test/motion.browser.mjs';
import { verifyMarkdownImport } from '../cloud-web/test/import.browser.mjs';
import { verifyThemes } from '../cloud-web/test/theme.browser.mjs';

const output = resolve('build-work/ui-audit');
const origin = 'https://127.0.0.1:8795';
const widths = [1440, 390, 360];
const themes = ['light', 'dark'];
const screens = ['home', 'article', 'dashboard', 'editor'];
const report = {
  revision: process.env.GITHUB_SHA || 'local',
  method:
    'Local HTTPS Miniflare (test certificate), ephemeral R2; self-hosted editorial font slices; external CDN CSS stubbed; service workers blocked for route-mocked checks (real offline cache covered by Chromium deployment flow); single cold-ish lab sample per screen, not field CWV.',
  browsers: {},
  assets: {},
  samples: [],
  surfaces: [],
  existingLayoutIssues: [],
  functionalChecksPassed: false,
  resourceBudgetFailures: [],
};
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
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
  home: '.reader-site-heading',
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
  if (name === 'production') {
    const loaded = await page.evaluate(() =>
      [...document.fonts].some(
        (font) => font.family.includes('Noto Serif SC') && font.status === 'loaded',
      ),
    );
    assert.ok(loaded, 'The shipped editorial font must load before visual review');
  }
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
  if (
    name === 'production' &&
    engine === 'chromium' &&
    [
      'home',
      'home-sparse',
      'article',
      'dashboard',
      'editor',
      'images',
      'settings',
      'login',
      'setup',
    ].includes(screen) &&
    [1440, 390].includes(width)
  ) {
    console.log(
      'READER_PREVIEW ' +
        JSON.stringify({
          width,
          screen,
          theme,
          image: (await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64'),
        }),
    );
  }
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
        bigTitle: '在日常里，写下回响。',
        themePalette: 'brown',
        homeIllustration: 'default',
        author: '林间',
        subtitle: 'Notes on a considered life.',
        description: '记录生活的细微，也保存技术的思考。\n在喧嚣的世界里，留下一些慢下来的文字。',
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
  // CC0 landscape, uploaded through the real optimizer into ephemeral fixture R2.
  const imageData = await readFile('build-work/editorial-photo/lake.jpg');
  await copyFile('build-work/editorial-photo/source.json', resolve(output, 'photo-source.json'));
  // Generate real Rust/WASM pages through the local publication UI.
  for (const post of demoPosts.slice(0, 3)) {
    await openArticleList(admin);
    await admin.locator('.article-title-button').filter({ hasText: post.title }).click();
    await expect(admin.locator('#title')).toHaveValue(post.title);
    if (post.slug === 'slow-days') {
      await admin.locator('#image-files').setInputFiles({
        name: '湖畔来信.jpg',
        mimeType: 'image/jpeg',
        buffer: imageData,
      });
      await expect(admin.locator('#upload-image')).not.toHaveAttribute('aria-busy', 'true', {
        timeout: 45000,
      });
      await expect(admin.locator('#notice')).toContainText('图片已上传');
      await expect(admin.locator('#upload-image svg')).toHaveCount(1);
    }
    await admin.locator('#publish-post').click();
    await expect(admin.locator('#publish-post')).not.toHaveAttribute('aria-busy', 'true');
    await expect(admin.locator('#publish-banner')).toContainText('已上线');
  }
  // Exercise actual Rust templates with sparse content, without production data or art.
  const sparseFiles = await admin.evaluate(async () => {
    const worker = new Worker('/preview.worker.js', { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sparse fixture render timed out')), 30000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          data.error ? reject(new Error(data.error)) : resolve(data.result);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage({
          id: 1,
          type: 'site',
          release: {
            schema_version: 1,
            id: 'visual-review-only',
            created_at: '2026-10-01T00:00:00Z',
            site: {
              title: 'CloudInk',
              bigTitle: '让平凡的日子，有迹可循。',
              subtitle: '认真生活，慢慢记录。',
              author: '林间',
              description: '记录生活的细微，也保存技术的思考。',
              themePalette: 'brown',
              homeIllustration: null,
              about: '',
            },
            markdown_posts: {
              'first-note':
                '+++\ntitle = "从一篇文章开始"\nslug = "first-note"\ndate = "2026-10-01"\ndescription = "不必等到万事俱备，写下此刻正在发生的生活。"\n+++\n\n## 开始记录\n\n每一段值得记住的日子，都可以成为一篇文章。',
            },
            about_markdown: null,
          },
        });
      });
    } finally {
      worker.terminate();
    }
  });
  const sparseContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    reducedMotion: 'reduce',
  });
  await watch(sparseContext);
  await sparseContext.route(origin + '/', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: sparseFiles['index.html'] }),
  );
  for (const width of widths)
    for (const theme of themes) {
      const page = await sparseContext.newPage();
      await page.setViewportSize({ width, height: width > 759 ? 1000 : 844 });
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(origin + '/');
      await expect(page.locator('.home-illustration')).toHaveCount(0);
      await expect(page.locator('.post-card')).toHaveCount(1);
      await capture(page, 'production', 'home-sparse', theme, width);
      await page.close();
    }
  await sparseContext.close();
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
          await openArticleList(page);
          await page
            .locator('.article-title-button')
            .filter({ hasText: demoPosts[0].title })
            .click();
          await expect(page.locator('#body')).toBeVisible();
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
          await navigateStudio(page, button.slice(1));
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
      newContext: (options) =>
        currentBrowser.newContext({ ...options, ignoreHTTPSErrors: true, serviceWorkers: 'block' }),
    };
    await verifyReaderMetadata(localBrowser, origin);
    await verifyTemplateUpdates(localBrowser, origin, output, engine);
    await verifyUiStability(localBrowser, origin, output, engine);
    await verifyUiAuditRegressions(localBrowser, origin, output, engine);
    await verifyLongReading(localBrowser, origin, output, engine);
    await verifyReaderLoading(localBrowser, origin, output, engine);
    await verifyStudio(localBrowser, origin, output, engine);
    await verifyWorkflows(localBrowser, origin, output, engine);
    await verifyHome(localBrowser, origin, output, engine);
    await verifyReader(localBrowser, origin, output, engine);
    await verifyMobile(localBrowser, origin, output, engine);
    await verifyRelease(localBrowser, origin, output, engine);
    await verifyCompletion(localBrowser, origin, output, engine);
    await verifyThemes(localBrowser, origin, output, engine);
    await verifyHomeIllustrations(localBrowser, origin, output, engine);
    await verifyMarkdownImport(localBrowser, origin, output, engine);
    await verifyPostAddresses(localBrowser, origin, output, engine);
    await verifyArchive(localBrowser, origin, output, engine);
    await verifyImageOptimizer(localBrowser, origin);
    await verifyImageQuality(localBrowser, origin, output, engine);
    report.surfaces.push(await verifySurfaces(localBrowser, origin, output, engine));
    await verifyMotion(localBrowser, origin, output, engine);
    await browser.close();
    browser = undefined;
  }
  report.functionalChecksPassed = true;
  for (const path of [
    'build-work/web-public/client.js',
    'build-work/web-public/reader-assets/highlight.js',
    'build-work/web-public/reader-assets/code.css',
    'build-work/web-public/reader-assets/katex.css',
    'build-work/web-public/styles.css',
    'cloud-admin/ui/app.generated.js',
    'cloud-admin/ui/images.css',
    'cloud-admin/ui/publication.generated.js',
    'cloud-admin/ui/backup.generated.js',
    'cloud-admin/ui/home-illustration.generated.js',
    'cloud-admin/ui/style.css',
    'cloud-admin/ui/studio.css',
    'cloud-admin/ui/workflows.css',
    'cloud-admin/ui/preview.worker.generated.js',
    'cloud-admin/ui/image.worker.generated.js',
    'cloud-admin/ui/image-maintenance.generated.js',
    'cloud-admin/ui/post-address.generated.js',
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
  if (report.assets['reader/home.min.css'].gzip > 4096)
    report.resourceBudgetFailures.push({
      path: 'reader/home.min.css',
      bytes: report.assets['reader/home.min.css'].gzip,
      budget: 4096,
    });
  const readerCSSMin = (
    await transform(await readFile('crates/blog-core/src/assets/reader.css', 'utf8'), {
      minify: true,
      loader: 'css',
    })
  ).code;
  report.assets['reader/reading.min.css'] = { gzip: gzipSync(readerCSSMin).length };
  if (report.assets['reader/reading.min.css'].gzip > 4096)
    report.resourceBudgetFailures.push({
      path: 'reader/reading.min.css',
      bytes: report.assets['reader/reading.min.css'].gzip,
      budget: 4096,
    });
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
  const galleryCSS = (
    await transform(await readFile(resolve('cloud-admin/ui/images.css'), 'utf8'), {
      loader: 'css',
      minify: true,
      target: 'es2022',
    })
  ).code;
  report.assets['admin/images.min.css'] = { gzip: gzipSync(galleryCSS).length };
  assert.ok(report.assets['admin/images.min.css'].gzip <= 3072, 'Gallery CSS gzip budget');
  // Aggregate guards complement the per-module budgets: no hidden growth between releases.
  const releaseBudgets = {
    'build-work/web-public/client.js': 40 * 1024,
    'build-work/web-public/reader-assets/highlight.js': 56 * 1024,
    'build-work/web-public/reader-assets/code.css': 4 * 1024,
    'build-work/web-public/reader-assets/katex.css': 8 * 1024,
    'build-work/web-public/styles.css': 13 * 1024,
    'cloud-admin/ui/app.generated.js': 29 * 1024,
    'cloud-admin/ui/publication.generated.js': 4 * 1024,
    'cloud-admin/ui/backup.generated.js': 16 * 1024,
    'cloud-admin/ui/home-illustration.generated.js': 3 * 1024,
    'served/admin/style.css': 15 * 1024,
    'cloud-admin/ui/preview.worker.generated.js': 55 * 1024,
    'cloud-admin/ui/image.worker.generated.js': 4 * 1024,
    'cloud-admin/ui/image-maintenance.generated.js': 4 * 1024,
    'cloud-admin/ui/post-address.generated.js': 4 * 1024,
    'cloud-admin/ui/wasm/blog_wasm_bg.wasm': 750 * 1024,
  };
  report.releaseBudgets = releaseBudgets;
  report.resourceBudgetFailures.push(
    ...Object.entries(releaseBudgets)
      .filter(([path, budget]) => report.assets[path].gzip > budget)
      .map(([path, budget]) => ({ path, bytes: report.assets[path].gzip, budget })),
  );
  assert.deepEqual(errors, [], JSON.stringify(errors));
  report.checks = [
    'three-engine delayed gallery/refresh/upload/editor controls retain button geometry, existing cards, thumbnail boxes and draft contents at 1440/390/360/320px',
    'three-engine long share-status text and unbroken URLs reflow without page overflow',

    'production screenshots with supplemental workflow and theme captures',
    'supplemental login/setup/settings/images inventory',
    'Chromium, Firefox and WebKit production UI checks',
    'touch emulation (Chromium/WebKit)',
    '360px overflow guard on production pages',
    'six native color swatches: keyboard, saved choice, Brown preview, 12 palette/mode contrast combinations and responsive screenshots',
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
    'rapid navigation',
  ];
  report.checks.push(
    'three-engine startup/config/session/data failure-retry, no auth flash, manual login/logout focus, card keyboard navigation and responsive preview focus',
    'three-engine 360px text-spacing reflow: reader/search/login/dashboard/settings/images and primary navigation',
    'keyboard viewport overrides released during simulated pinch zoom; editor text retained',
    'aggregate public/admin/preview/WASM gzip release budgets',
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
              '正式界面（当前提交）</figcaption><a href="' +
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
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudInk 界面回归检查</title><style>body{font:15px/1.6 system-ui;background:#f3f5f1;color:#202a25;margin:0;padding:24px}main{max-width:1400px;margin:auto}a{color:#24594f}header{padding:20px 0}h1{margin:0}h2{font-size:18px}section{border-top:1px solid #c7d1c5;padding:24px 0}.pair{display:flex;gap:24px;align-items:flex-start}figure{margin:0;flex:1;min-width:0}figcaption{margin-bottom:12px}img{width:100%;height:auto;border-radius:12px;border:1px solid #c7d1c5}select{padding:10px;margin:12px 10px 12px 0}button{padding:10px}.supplemental{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px}.supplemental figcaption{overflow-wrap:anywhere;font-size:13px}.supplemental img{aspect-ratio:3/2;object-fit:contain;background:#e9ede6}summary{cursor:pointer;padding:20px 0;font-weight:600}@media(max-width:700px){.pair{display:block}figure{margin-bottom:20px}}</style><main><header><h1>CloudInk · 正式界面回归检查</h1><p><a href="report.json">性能与资源报告</a></p><p>页面使用隔离的临时数据。截图对应当前提交；实验指标不代表真机或真实用户性能。</p><label>宽度 <select id="width"><option value="">全部</option><option>1440</option><option>390</option><option>360</option></select></label><label>主题 <select id="theme"><option value="">全部</option><option>light</option><option>dark</option></select></label><p>当前界面溢出记录：' +
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
  assert.deepEqual(
    report.resourceBudgetFailures,
    [],
    'Release gzip budgets exceeded; see report.json',
  );
} finally {
  await browser?.close();
  await mf.dispose();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
