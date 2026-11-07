// Use the same primary destinations on desktop and in the compact mobile menu.
export async function navigateStudio(page, id) {
  const destination = page.locator('#' + id);
  if (!(await destination.isVisible())) await page.locator('#studio-menu-toggle').click();
  await destination.click();
}
