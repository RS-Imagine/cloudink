import { chromium, expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
  page.on('console', (message) => {
    if (message.type() === 'error' && /WebGLProgram|Shader Error/.test(message.text())) errors.push(message.text());
  });
  await page.goto(url);
  await expect(page.locator('#scene[data-ready="true"]')).toBeAttached({ timeout: 30000 });
  await expect(page.locator('#journal .entry')).toHaveCount(8);
  await expect.poll(() => page.evaluate(() => window.__inkTree?.stats().intro)).toBe(true);
  await page.evaluate(() => { window.__inkTree.pause(); window.__inkTree.setGrow(0); });
  await page.waitForTimeout(300);
  const bare = createHash('sha256').update(await page.locator('#scene canvas').screenshot()).digest('hex');
  await page.evaluate(() => window.__inkTree.setGrow(1));
  await page.waitForTimeout(300);
  const full = createHash('sha256').update(await page.locator('#scene canvas').screenshot()).digest('hex');
  if (bare === full) throw new Error('Growth shader did not change the rendered tree');
  const stats = await page.evaluate(() => window.__inkTree.stats());
  if (stats.drawCalls > 12 || stats.triangles > 90000) throw new Error(`Scene budget exceeded: ${JSON.stringify(stats)}`);
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

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(url);
  await expect(mobilePage.locator('#scene[data-ready="true"]')).toBeAttached({ timeout: 30000 });
  await mobilePage.touchscreen.tap(150, 280);
  await expect.poll(() => mobilePage.evaluate(() => window.__inkTree?.stats().grow)).toBe(1);
  await mobile.close();

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
