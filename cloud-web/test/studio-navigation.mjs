// Primary destinations remain visible in one navigation bar; editing has an explicit back action.
export async function navigateStudio(page, id) {
  const destination = page.locator('#' + id);
  if (!(await destination.isVisible()) && (await page.locator('#editor-back').isVisible()))
    await page.locator('#editor-back').click();
  await destination.click();
}
export async function openArticleInfo(page) {
  if (!(await page.locator('.post-details').isVisible())) {
    await page.locator('#editor-info-toggle').click();
    await page.locator('#editor-info-dialog').waitFor({ state: 'visible' });
  }
}
