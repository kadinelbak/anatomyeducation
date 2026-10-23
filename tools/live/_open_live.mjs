// Opens Live from whichever entry point the page has. After the home screen lands, #home-live is the Live button;
// before it, #home-explore reveals the landing card, which has the #go-live chip.
export async function openLive(page) {
  const home = await page.$("#home-live");
  if (home && (await home.isVisible())) {
    await home.click();
    return;
  }
  const explore = await page.$("#home-explore");
  if (explore && (await explore.isVisible())) {
    await explore.click();
    await page.waitForSelector("#go-live", { state: "visible" });
  }
  await page.click("#go-live");
}
