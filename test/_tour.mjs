// The first-run tour (src/ui/guide-ui.js) starts by itself on a new vault's first Overview. Browser smokes that test other screens
// call this once per page: whenever the tour card is up before an action, Playwright presses Skip tour first. test/smoke-tour.mjs
// tests the tour itself and does not use it.
export async function skipTour(page) {
  if (typeof page.addLocatorHandler !== 'function') return;
  await page.addLocatorHandler(page.locator('#tour'), async () => { await page.locator('#tour-skip').click(); });
}
