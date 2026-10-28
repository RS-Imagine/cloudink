import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from '../cloud-admin/node_modules/@playwright/test/index.mjs';

const root = resolve('.');
const output = resolve('build-work/editorial-review');
await mkdir(output, { recursive: true });
const files = new Set([
  '/prototypes/editorial/index.html',
  '/prototypes/editorial/style.css',
  '/prototypes/editorial/app.js',
  '/prototypes/editorial/botanical.svg',
  '/assets/design-tokens.css',
]);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (!files.has(path)) return res.writeHead(404).end();
  try {
    const body = await readFile(resolve(root, '.' + path));
    res.writeHead(200, {
      'Content-Type': {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.svg': 'image/svg+xml',
      }[extname(path)],
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(8798, '127.0.0.1', done));
const origin = 'http://127.0.0.1:8798/prototypes/editorial/index.html';
const report = [];
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch();
    try {
      for (const width of [1440, 768, 390, 360]) {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height: 960 },
            reducedMotion: 'reduce',
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('response', (response) => {
            if (response.status() >= 400) errors.push(response.url());
          });
          await page.goto(origin);
          await page.evaluate(() => document.fonts.ready);
          if (theme === 'dark') await page.locator('#theme').click();
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
          const prefix = name + '-' + width + '-' + theme;
          for (const art of ['on', 'off']) {
            await page.locator('#illustration').selectOption(art);
            assert.equal(await page.locator('.hero-art').isVisible(), art === 'on');
            assert(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
              prefix + ': home overflow',
            );
            await page.screenshot({
              path: output + '/' + prefix + '-home-' + art + '.png',
              fullPage: true,
            });
          }
          if (name === 'chromium' && width === 1440 && theme === 'light') {
            await page.locator('#illustration').selectOption('on');
            console.log(
              'EDITORIAL_PREVIEW ' +
                JSON.stringify({
                  name: prefix + '-home',
                  image: (await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64'),
                }),
            );
          }
          await page.locator('#search-open').click();
          await page.locator('#query').fill('空白');
          assert.equal(await page.locator('#results li').count(), 1);
          await page.screenshot({ path: output + '/' + prefix + '-search.png' });
          await page.locator('#query').fill('no-match-xyz');
          assert.equal(await page.locator('#results li').count(), 0);
          await page.keyboard.press('Escape');
          await page.waitForFunction(
            () => document.querySelector('#search-open') === document.activeElement,
          );
          if (width < 761) {
            await page.locator('#menu').click();
            assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'true');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'false');
          }
          await page.locator('.post-link').first().click();
          await page.waitForFunction(() => !document.querySelector('#article').hidden);
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            prefix + ': article overflow',
          );
          await page.screenshot({ path: output + '/' + prefix + '-article.png', fullPage: true });
          if (name === 'chromium' && [1440, 390].includes(width) && theme === 'light') {
            console.log(
              'EDITORIAL_PREVIEW ' +
                JSON.stringify({
                  name: prefix + '-article',
                  image: (await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64'),
                }),
            );
          }
          await page.goBack();
          await page.waitForFunction(() => !document.querySelector('#home').hidden);
          await page.goto(origin + '#about');
          assert(await page.locator('#about').isVisible());
          assert.equal(errors.length, 0, errors.join('\n'));
          report.push({ browser: name, width, theme, errors, status: 'passed' });
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  await writeFile(output + '/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ cases: report.length, status: 'passed' }));
} finally {
  await new Promise((done) => server.close(done));
}
