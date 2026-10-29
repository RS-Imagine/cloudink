import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { build } from '../../cloud-admin/node_modules/esbuild/lib/main.js';
import { readerFixtures } from './reader-loading.browser.mjs';

const baseline = '6b97a08cf93ef0a1a545f045d0660e17174cb258';
export async function verifyReaderPerformance(browser, origin, output) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  let fixtures, home;
  try {
    fixtures = await readerFixtures(context, origin);
    home = await (await context.request.get(origin + '/')).text();
  } finally {
    await context.close();
  }
  const root = process.cwd(),
    folder = resolve('build-work/web-public');
  const oldSource = [
    'assets/motion.js',
    'assets/mobile.js',
    'crates/blog-core/src/assets/client.js',
  ]
    .map((path) => execFileSync('git', ['show', baseline + ':' + path], { encoding: 'utf8' }))
    .join('\n');
  const previous = await build({
    stdin: {
      contents:
        "import Swup from 'swup'; import hljs from './cloud-admin/node_modules/highlight.js/lib/common'; window.Swup=Swup; window.hljs=hljs;\n" +
        oldSource,
      resolveDir: root,
    },
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    write: false,
  });
  const files = new Map();
  for (const name of ['client.js', 'theme.js', 'styles.css', 'favicon.svg'])
    files.set('/' + name, await readFile(resolve(folder, name)));
  files.set('/client-before.js', previous.outputFiles[0].contents);
  files.set('/analytics.js', Buffer.from('/* Analytics is disabled. */'));
  for (const name of await readdir(resolve(folder, 'reader-assets'))) {
    if (name === 'fonts') continue;
    files.set('/reader-assets/' + name, await readFile(resolve(folder, 'reader-assets', name)));
  }
  for (const name of await readdir(resolve(folder, 'reader-assets/fonts'))) {
    const bytes = await readFile(resolve(folder, 'reader-assets/fonts', name));
    files.set('/reader-assets/fonts/' + name, bytes);
    files.set('/baseline/fonts/' + name, bytes);
  }
  files.set(
    '/baseline/katex.css',
    await readFile('cloud-admin/node_modules/katex/dist/katex.min.css'),
  );
  for (const [name, file] of [
    ['code-light', 'github.min.css'],
    ['code-dark', 'github-dark.min.css'],
  ])
    files.set(
      '/baseline/' + name + '.css',
      await readFile('cloud-admin/node_modules/highlight.js/styles/' + file),
    );
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const match = url.pathname.match(/^\/case\/(before|after)\/(home|plain|code|math)$/);
    let data, type;
    if (match) {
      let html = match[2] === 'home' ? home : fixtures[match[2]];
      if (match[1] === 'before') {
        html = html.replace(/<link\b[^>]*data-reader-style[^>]*>/g, '');
        html = html.replace(
          '</head>',
          '<link rel="stylesheet" href="/baseline/katex.css">' +
            '<link rel="stylesheet" id="hljs-light" href="/baseline/code-light.css" media="all">' +
            '<link rel="stylesheet" id="hljs-dark" href="/baseline/code-dark.css" media="none"></head>',
        );
        html = html.replace(/src="\/client\.js[^"]*"/, 'src="/client-before.js"');
      }
      data = Buffer.from(html);
      type = 'text/html; charset=utf-8';
    } else {
      data = files.get(url.pathname);
      type = url.pathname.endsWith('.js')
        ? 'text/javascript'
        : url.pathname.endsWith('.css')
          ? 'text/css'
          : url.pathname.endsWith('.woff2')
            ? 'font/woff2'
            : 'image/svg+xml';
    }
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    const compress = /(?:javascript|css|html)/.test(type);
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      ...(compress ? { 'Content-Encoding': 'gzip' } : {}),
    });
    response.end(compress ? gzipSync(data) : data);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  const samples = [];
  try {
    for (const width of [390, 1440])
      for (const kind of ['home', 'plain', 'code', 'math'])
        for (let repeat = 0; repeat < 3; repeat++)
          for (const mode of ['before', 'after']) {
            const session = await browser.newContext({
              viewport: { width, height: 900 },
              deviceScaleFactor: 1,
              reducedMotion: 'reduce',
              colorScheme: 'light',
            });
            const page = await session.newPage();
            const cdp = await session.newCDPSession(page);
            try {
              await cdp.send('Network.enable');
              await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
              await cdp.send('Network.emulateNetworkConditions', {
                offline: false,
                latency: 80,
                downloadThroughput: 400000,
                uploadThroughput: 400000,
              });
              await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
              await page.addInitScript(() => {
                window.readerMetrics = { lcp: 0, cls: 0 };
                new PerformanceObserver((list) => {
                  for (const item of list.getEntries()) window.readerMetrics.lcp = item.startTime;
                }).observe({ type: 'largest-contentful-paint', buffered: true });
                new PerformanceObserver((list) => {
                  for (const item of list.getEntries())
                    if (!item.hadRecentInput) window.readerMetrics.cls += item.value;
                }).observe({ type: 'layout-shift', buffered: true });
              });
              await page.goto(address + '/case/' + mode + '/' + kind, {
                waitUntil: 'load',
                timeout: 30000,
              });
              await page.waitForFunction(() => !!window.swup);
              if (kind === 'code') await page.locator('.article-body code.hljs').waitFor();
              if (kind === 'math') await page.evaluate(() => document.fonts.ready);
              await page.waitForTimeout(150);
              const sample = await page.evaluate(() => ({
                ...window.readerMetrics,
                fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0,
                domContentLoaded:
                  performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
                resources: performance
                  .getEntriesByType('resource')
                  .map((r) => ({ path: new URL(r.name).pathname, bytes: r.encodedBodySize })),
              }));
              if (mode === 'after') {
                const paths = sample.resources.map((r) => r.path);
                if (kind === 'home' || kind === 'plain')
                  assert.ok(
                    !paths.some((p) =>
                      /^\/reader-assets\/(?:highlight\.js|code\.css|katex\.css|fonts\/KaTeX_)/.test(
                        p,
                      ),
                    ),
                  );
                if (kind === 'code')
                  assert.ok(!paths.some((p) => p.includes('katex') || p.includes('/fonts/KaTeX_')));
                if (kind === 'math') assert.ok(!paths.includes('/reader-assets/highlight.js'));
              }
              assert.ok(
                sample.cls < 0.03,
                JSON.stringify({ kind, mode, width, repeat, ...sample }),
              );
              samples.push({ width, kind, repeat, mode, ...sample });
              if (repeat === 0)
                await page.screenshot({
                  path: resolve(
                    output,
                    'reader-loading-' + mode + '-' + kind + '-' + width + '.png',
                  ),
                  fullPage: true,
                });
            } finally {
              await session.close();
            }
          }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const median = (numbers) => numbers.sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
  const comparison = [];
  for (const width of [390, 1440])
    for (const kind of ['home', 'plain', 'code', 'math']) {
      const entry = { width, kind };
      for (const mode of ['before', 'after']) {
        const group = samples.filter(
          (s) => s.width === width && s.kind === kind && s.mode === mode,
        );
        entry[mode] = {
          resourceBytes: median(group.map((s) => s.resources.reduce((n, r) => n + r.bytes, 0))),
          scriptBytes: median(
            group.map((s) =>
              s.resources.filter((r) => r.path.endsWith('.js')).reduce((n, r) => n + r.bytes, 0),
            ),
          ),
          fcp: median(group.map((s) => s.fcp)),
          lcp: median(group.map((s) => s.lcp)),
          domContentLoaded: median(group.map((s) => s.domContentLoaded)),
          cls: Math.max(...group.map((s) => s.cls)),
        };
      }
      if (kind === 'home' || kind === 'plain')
        assert.ok(entry.after.scriptBytes < entry.before.scriptBytes * 0.6);
      comparison.push(entry);
    }
  const report = {
    baseline,
    method:
      'Controlled same-origin gzip HTTP fixture: identical page content/base CSS; baseline rebuilds the previous JS and global vendor styles; current uses conditional assets. External CDN latency is excluded. Cold Chromium, DPR 1, 80ms latency, 400000 B/s, CPU 4x; 3 interleaved samples per page/viewport. Lab results, not field CWV; timing has no improvement assertion.',
    comparison,
    samples,
  };
  await writeFile(resolve(output, 'reader-performance.json'), JSON.stringify(report, null, 2));
  console.log('READER_PERFORMANCE ' + JSON.stringify({ baseline, comparison }));
}
