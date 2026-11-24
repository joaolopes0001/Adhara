// The line under the map of a folder starts folded to one line and opens on demand: the choice is a
// preference of the person, kept by the browser and shared by every view, and the map takes the height.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, writeTree } from './helpers';

/** Two projects whose root has two items that reference each other and many that reference nothing. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-strip-fold-'));
  const files: Record<string, string> = {};
  for (const name of ['um', 'dois']) {
    files[`${name}/AGENTS.md`] = '# raiz\n[a](a.md)\n';
    files[`${name}/a.md`] = '# a\n';
    for (let i = 0; i < 14; i++) files[`${name}/solto-com-nome-comprido-${i}.md`] = '# s\n';
  }
  writeTree(base, files);
  return { um: join(base, 'um'), dois: join(base, 'dois') };
}

const heights = (view: Locator) =>
  view.evaluate((element) => ({
    strip: element.querySelector('.folder-strip')!.getBoundingClientRect().height,
    area: element.querySelector('.folder-map-area')!.getBoundingClientRect().height,
  }));

async function framed(view: Locator) {
  await expect(view.locator('.react-flow__node-file').first()).toBeVisible();
  let last = '';
  await expect
    .poll(async () => {
      const now = await view
        .locator('.react-flow__viewport')
        .evaluate((element) => (element as HTMLElement).style.transform);
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
}

async function show(page: Page, paths: { um: string; dois: string }) {
  await enterProject(page, 'um');
  await page.getByRole('button', { name: 'Mapa de um', exact: true }).click();
  const restore = page.getByRole('button', { name: 'Restaurar vista dois', exact: true });
  if (await restore.count()) await restore.click();
  const um = page.locator(`.workspace-pane[data-pane-id="scope:${paths.um}"]`);
  const dois = page.locator(`.workspace-pane[data-pane-id="scope:${paths.dois}"]`);
  await dois.locator('.scope-header').first().click();
  await page.getByRole('button', { name: 'Mapa de dois', exact: true }).click();
  await framed(um);
  await framed(dois);
  return { um, dois };
}

async function open(page: Page) {
  const paths = fixture();
  await page.setViewportSize({ width: 1280, height: 694 });
  const close = await openOnly(page, [paths.um, paths.dois]);
  await page.goto('/');
  // The suite opens the line for the specs that read it; here the default is the subject.
  await page.evaluate(() => localStorage.removeItem('aae-folder-strip'));
  await page.reload();
  return { ...(await show(page, paths)), paths, close };
}

test('the line under the map folds to one line, gives its height to the map, is shared by the views and is kept', async ({
  page,
}) => {
  const { um, dois, paths, close } = await open(page);
  const fold = (view: Locator) => view.getByRole('button', { name: 'Recolher a linha' });
  const unfold = (view: Locator) => view.getByRole('button', { name: 'Mostrar a linha' });
  // Without a saved choice the line starts folded, in every view.
  await expect(unfold(um)).toHaveAttribute('aria-expanded', 'false');
  await expect(um.locator('.folder-strip-folded')).toBeVisible();
  await expect(dois.locator('.folder-strip-folded')).toBeVisible();
  await unfold(um).click();
  await expect(fold(um)).toHaveAttribute('aria-expanded', 'true');
  await framed(um);
  const open1 = await heights(um);
  const open2 = await heights(dois);
  expect(open1.strip).toBeGreaterThan(40);
  // The toggle never takes a row of its own: it sits within the first line, and its row is that line.
  const place = await um.evaluate((view) => {
    const box = (selector: string) => view.querySelector(selector)!.getBoundingClientRect();
    const toggle = box('.folder-strip-fold'),
      line = box('.folder-strip-line'),
      strip = box('.folder-strip');
    return {
      width: view.getBoundingClientRect().width,
      toggleMiddle: toggle.top + toggle.height / 2,
      lineTop: line.top,
      lineBottom: line.bottom,
      above: line.top - strip.top,
      scroll: view.querySelector('.folder-strip')!.scrollHeight,
    };
  });
  console.log(JSON.stringify({ place, expanded: open1.strip }));
  expect(place.toggleMiddle).toBeGreaterThan(place.lineTop);
  expect(place.toggleMiddle).toBeLessThan(place.lineBottom);
  expect(place.above).toBeLessThanOrEqual(6);

  await fold(um).focus();
  await page.keyboard.press('Enter');
  await expect(unfold(um)).toBeFocused();
  await expect(unfold(um)).toHaveAttribute('aria-expanded', 'false');
  // The other view follows, live.
  await expect(unfold(dois)).toBeVisible();
  const closed1 = await heights(um);
  const closed2 = await heights(dois);
  await expect(um.locator('.folder-strip-summary')).toContainText('Sem ligação · 14');
  await expect(um.locator('.folder-strip-summary')).toHaveAttribute('title', /Sem ligação · 14/);
  // One line: the height of a strip that holds one button line (4 + 24 + 4).
  expect(closed1.strip).toBeLessThanOrEqual(34);
  expect(closed1.area).toBeGreaterThan(open1.area);
  expect(closed1.area - open1.area).toBeCloseTo(open1.strip - closed1.strip, 0);
  expect(closed2.area).toBeGreaterThan(open2.area);
  await framed(um);
  await page.screenshot({ path: test.info().outputPath('folded.png') });
  console.log(JSON.stringify({ open1, closed1, open2, closed2 }));

  // Kept by the browser.
  await page.reload();
  const again = await show(page, paths);
  await expect(again.um.locator('.folder-strip-folded')).toBeVisible();
  await expect(again.dois.locator('.folder-strip-folded')).toBeVisible();

  // Space opens it again, the focus stays, and the other view follows.
  await unfold(um).focus();
  await page.keyboard.press('Space');
  await expect(fold(um)).toBeFocused();
  await expect(fold(dois)).toBeVisible();
  await expect.poll(async () => (await heights(um)).strip).toBeCloseTo(open1.strip, 0);
  expect((await heights(um)).area).toBeCloseTo(open1.area, 0);
  expect(await page.evaluate(() => localStorage.getItem('aae-folder-strip'))).toBe('open');
  await close();
});

test('the folded line in the light theme', async ({ page }) => {
  const { paths, close } = await open(page);
  await page.evaluate(() => localStorage.setItem('aae-theme', 'light'));
  await page.reload();
  const { um } = await show(page, paths);
  await expect(um.locator('.folder-strip-folded')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('folded-light.png') });
  await page.evaluate(() => {
    localStorage.removeItem('aae-folder-strip');
    localStorage.removeItem('aae-theme');
  });
  await close();
});
