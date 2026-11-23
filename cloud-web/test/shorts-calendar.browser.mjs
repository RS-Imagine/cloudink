import assert from 'node:assert/strict';
import { expect } from '../../cloud-admin/node_modules/@playwright/test/index.mjs';
import { navigateStudio } from './studio-navigation.mjs';
import { acceptConfirmation } from './workflows.browser.mjs';

export async function verifyShortsCalendar(browser, studio, origin) {
  const day = '2026-11-06';
  const earliest = '日历当天最早的已发布短记。';
  // The backup fixture already restored a draft from 12:00 on this date.
  const notes = [
    [day + ' 14:30', earliest],
    [day + ' 19:40', '同一天较晚的短记。'],
    ['2026-11-07 10:00', '让最早一条落在第二页。'],
    ['2026-11-08 10:00', '短记日历应覆盖完整分页。'],
    ['2026-11-09 10:00', '适合验证滚动时的桌面日历。\n\n'.repeat(28)],
  ];
  await navigateStudio(studio, 'shorts');
  for (const [date, body] of notes) {
    await studio.locator('#short-new').click();
    await studio.locator('#short-date').fill(date);
    await studio.locator('#short-body').fill(body);
    await studio.locator('#short-publish').click();
    await acceptConfirmation(studio);
    await expect(studio.locator('#short-editor')).toBeHidden({ timeout: 45000 });
  }

  const url = origin + '/shorts/';
  const month = '[data-shorts-cal-month]';
  const dateCell = `[data-shorts-cal-date="${day}"]`;
  const browserOptions = { reducedMotion: 'reduce', serviceWorkers: 'block' };
  const desktop = await browser.newPage({
    ...browserOptions,
    viewport: { width: 1440, height: 900 },
  });
  const mobile = await browser.newPage({
    ...browserOptions,
    viewport: { width: 390, height: 844 },
  });
  try {
    for (const reader of [desktop, mobile]) {
      await reader.clock.setFixedTime(new Date('2026-11-23T04:00:00Z'));
    }
    const response = await desktop.goto(url);
    assert.equal(response.status(), 200);
    // Normal publishing sanitizes the renderer's output before the Worker serves it.
    assert.match(await response.text(), /data-shorts-cal="\{&quot;/);
    const panel = desktop.locator('#shorts-cal-panel');
    const data = await panel.locator('[data-shorts-cal-root]').evaluate((widget) => {
      return JSON.parse(widget.dataset.shortsCal);
    });
    assert.deepEqual(
      Object.fromEntries(Object.entries(data).map(([date, entry]) => [date, entry.count])),
      { [day]: 2, '2026-11-07': 1, '2026-11-08': 1, '2026-11-09': 1 },
    );
    await expect(panel.locator(month)).toHaveText('2026 年 11 月');
    await expect(panel.locator('[data-shorts-cal-prev]')).toBeDisabled();
    await expect(panel.locator('[data-shorts-cal-next]')).toBeDisabled();
    await expect(panel.locator(dateCell)).toHaveClass(/shorts-cal-l2/);
    await expect(desktop.locator('#shorts-list-next')).toHaveAttribute('href', '/shorts/page/2/');

    const panelTop = () => panel.evaluate((node) => node.getBoundingClientRect().top);
    const initialTop = await panelTop();
    assert.ok(initialTop > 24);
    await desktop.evaluate(() => window.scrollTo(0, 650));
    await expect.poll(panelTop).toBeCloseTo(24, 0);
    await expect
      .poll(() =>
        desktop
          .locator('#reader-context .author-card')
          .evaluate((node) => node.getBoundingClientRect().bottom),
      )
      .toBeLessThan(0);
    await desktop.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(panelTop).toBeCloseTo(initialTop, 0);

    const card = desktop.locator('.short-card').filter({ hasText: earliest });
    await panel.locator(dateCell).click();
    await expect(card).toHaveClass(/shorts-cal-highlight/);
    const target = await card.getAttribute('id');
    assert.deepEqual(data[day], { count: 2, firstId: target });
    assert.equal(new URL(desktop.url()).hash, '#' + target);

    await mobile.goto(url);
    const button = mobile.locator('.shorts-cal-fab');
    const drawer = mobile.getByRole('dialog', { name: '短记日历' });
    await button.click();
    await expect(drawer.locator(month)).toHaveText('2026 年 11 月');
    await drawer.getByRole('button', { name: '关闭短记日历' }).click();
    await expect(drawer).toBeHidden();
    await button.click();
    await drawer.locator(dateCell).click();
    await expect(drawer).toBeHidden();
    await expect(mobile.locator('.short-card').filter({ hasText: earliest })).toHaveClass(
      /shorts-cal-highlight/,
    );
    assert.equal(new URL(mobile.url()).hash, '#' + target);

    for (const [kind, attribute] of [
      ['missing', ''],
      ['invalid', ' data-shorts-cal="{"'],
    ]) {
      const fallback = url + '?calendar=' + kind;
      await mobile.route(fallback, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(/ data-shorts-cal="[^"]*"/, attribute);
        await route.fulfill({ response, body });
      });
      await mobile.goto(fallback);
      await button.click();
      await expect(drawer.locator(month)).toHaveText('2026 年 11 月');
      await expect(drawer.locator('.shorts-cal-empty')).toHaveCount(30);
      await expect(drawer.locator('.shorts-cal-has')).toHaveCount(0);
      await drawer.getByRole('button', { name: '关闭短记日历' }).click();
      await expect(drawer).toBeHidden();
    }
  } finally {
    await Promise.all([desktop.close(), mobile.close()]);
  }
}
