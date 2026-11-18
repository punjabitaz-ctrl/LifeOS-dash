// Navigation helper for the browser smokes (v1.4.0): a name in the phone bottom bar (or the full desktop bar) is one tap; any other area
// is More, then the area in the sheet.
export async function navTo(page, name) {
  const bar = page.locator('.nav button:has-text("' + name + '")');
  if (await bar.count()) { await bar.first().click(); return; }
  await page.click('#nav-more');
  await page.click('#more-list button:has-text("' + name + '")');
}
