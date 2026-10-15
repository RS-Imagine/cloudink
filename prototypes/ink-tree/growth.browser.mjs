import { chromium, expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/?debug`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#scene[data-ready="true"]')).toBeAttached({ timeout: 30000 });
  await expect(page.locator('#journal .entry')).toHaveCount(8);
  await expect.poll(() => page.evaluate(() => window.__inkTree?.stats().intro)).toBe(true);
  await page.locator('#open-search').click();
  await expect(page.locator('#reading-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__inkTree.stats().grow)).toBe(1);
  await page.goto(url);
  await expect(page.locator('#scene[data-ready="true"]')).toBeAttached({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => window.__inkTree?.stats().intro)).toBe(false);
  await context.close();

  const deep = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const deepPage = await deep.newPage();
  await deepPage.goto(url + '#/post/a-tree-of-words');
  await expect(deepPage.locator('#scene[data-ready="true"]')).toBeAttached({ timeout: 30000 });
  await expect.poll(() => deepPage.evaluate(() => window.__inkTree?.stats().intro)).toBe(false);
  await expect(deepPage.locator('#reading-panel')).toBeVisible();
  await deep.close();

  const reduced = await browser.newContext({ reducedMotion: 'reduce' });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(url);
  await expect(reducedPage.locator('#scene[data-ready="true"]')).toBeAttached({ timeout: 30000 });
  await expect.poll(() => reducedPage.evaluate(() => window.__inkTree?.stats().intro)).toBe(false);
  await reduced.close();

  if (errors.length) throw new Error(`Prototype browser errors: ${errors.join('; ')}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
