import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMoreAction } from './more-menu';

/** WCAG contrast ratio between two computed `rgb()`/`rgba()` colors. */
export function contrast(a: string, b: string) {
  const luminance = (color: string) =>
    color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((value) => value / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The lucide icons that say a tone or a state by their drawing (problem, warning, error, refusal,
 * information, done, working), by the class lucide gives each, whatever name it was imported under
 * (`AlertCircle` draws `lucide-circle-alert`). Scope it to an alert surface: the "i" is also the icon of a
 * few controls (the details of a view, the Status menu button). tests/test_alert_icons.py checks the
 * imports of every module of `src/`.
 */
export const ALERT_ICONS = [
  'triangle-alert',
  'circle-alert',
  'octagon-alert',
  'shield-alert',
  'info',
  'badge-alert',
  'badge-info',
  'message-square-warning',
  'message-circle-warning',
  'file-exclamation-point',
  'circle-x',
  'ban',
  'octagon-x',
  'shield-x',
  'circle-check',
  'circle-check-big',
  'loader',
  'loader-circle',
  'loader-pinwheel',
]
  .map((name) => `svg.lucide-${name}`)
  .join(', ');

/** The colour of a tone (`problem`, `warning`, `info`) in the current theme, as the page resolves it. */
export async function toneColor(page: Page, tone: 'problem' | 'warning' | 'info') {
  return await page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(--tone-${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, tone);
}

/** The computed text colour of an element. */
export const colorOf = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).color);

/**
 * The colours of every line of the Audit list, strictly: what is written on a problem or warning line in that
 * tone; on an informative line the destination in the normal text colour, a fact without destination and
 * any note ("não conclusivo") in the muted colour: the tone of the line gives the colour, nothing else.
 * Returns how many lines it checked.
 */
export async function expectAuditLineColours(page: Page, label = '') {
  const tones = {
    problem: await toneColor(page, 'problem'),
    warning: await toneColor(page, 'warning'),
    info: await toneColor(page, 'info'),
  };
  const normal = await colorOf(page.locator('.audit-observations'));
  const lines = await page.locator('.audit-observations .audit-line:not(.signal)').all();
  for (const line of lines) {
    const tone = ((await line.getAttribute('class'))!.match(/tone-(problem|warning|info)/) ??
      [])[1] as keyof typeof tones | undefined;
    expect(tone, `${label} tone class`).toBeDefined();
    for (const target of await line.locator('.file-observation-target').all())
      expect(await colorOf(target), `${label} target (${tone})`).toBe(
        tone === 'info' ? normal : tones[tone!],
      );
    for (const text of await line.locator('.file-observation-text').all())
      expect(await colorOf(text), `${label} fact (${tone})`).toBe(tones[tone!]);
    for (const note of await line.locator('.file-observation-type').all())
      expect(await colorOf(note), `${label} type or note (${tone})`).toBe(tones.info);
  }
  return lines.length;
}

/** Contrast of an element's text against the first opaque background among it and its ancestors. */
export async function readable(locator: Locator) {
  const colors = await locator.evaluate((element) => {
    let node: Element | null = element,
      background = 'rgba(0, 0, 0, 0)';
    while (node && /rgba\(.*, 0\)$|transparent/.test(background)) {
      background = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return { color: getComputedStyle(element).color, background };
  });
  return contrast(colors.color, colors.background);
}

/**
 * Checks the contrast of the first element of each selector in the dark theme and then in the light one,
 * saving a capture of the tool panel in each; it leaves the light theme on.
 */
export async function inBothThemes(page: Page, selectors: string[], name: string) {
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of selectors)
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await page
      .locator('.tool-panel')
      .screenshot({ path: test.info().outputPath(`${name}-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
}

/** Headers of an API call: the session token of the server under test. */
export async function sessionHeaders(page: Page) {
  const { token } = await (await page.request.get('/api/session')).json();
  return { 'X-AAE-Token': token };
}

/** Closes every open project, so that a test sees only the ones it opens. */
export async function closeAllProjects(page: Page, headers: Record<string, string>) {
  for (const old of (await (await page.request.get('/api/workspace', { headers })).json()).roots)
    await page.request.post('/api/close', { headers, data: { path: old.path } });
}

/** Closes every open project and opens `roots`; returns the function that closes them again. */
export async function openOnly(page: Page, roots: string[]) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  for (const path of roots)
    expect((await page.request.post('/api/open', { headers, data: { path } })).status()).toBe(200);
  return async () => {
    for (const path of roots) await page.request.post('/api/close', { headers, data: { path } });
  };
}

/** Closes every open project and opens `root`; returns the function that reads the workspace model. */
export async function openOnlyWithWorkspace(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  const workspace = async () =>
    await (await page.request.get('/api/workspace', { headers })).json();
  for (const old of (await workspace()).roots)
    await page.request.post('/api/close', { headers, data: { path: old.path } });
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  return workspace;
}

/**
 * Selects a file by the search (Ctrl+K) and checks that the inspector shows it, then clears the search.
 * The first click selects it (in a map, it only moves the map); a second one on the selection opens the
 * inspector.
 */
export async function selectFile(page: Page, path: string) {
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill(path.split('/').slice(-2).join('/'));
  const result = page
    .locator('.search-results button', { hasText: path.split('/').at(-1)! })
    .first();
  await result.click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText(
    path.split('/').at(-1)!,
  );
  await result.click();
  await expect(page.locator('.inspector .copy-path code')).toHaveText(path);
  await page.getByLabel('Limpar busca').click();
}

/**
 * Leaves Home (the list of projects, where the explorer and the inspector do not appear) for the Structure
 * of the root of an open project, as a click on its row does: the first one listed, or the one named.
 */
export async function enterProject(page: Page, name?: string) {
  const rows = page.locator('.home-row.is-folder');
  const escaped = name?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = escaped
    ? rows.filter({
        has: page.locator('.structure-open > span', { hasText: new RegExp(`^${escaped}$`) }),
      })
    : rows.first();
  await row.locator('.structure-open').click();
  await expect(page.locator('.home-list')).toHaveCount(0);
}

/**
 * The map of the selection of the only view, by its Estrutura | Mapa switch in the top bar: a click on a
 * file in the Estrutura keeps the list (and opens the inspector), so its map is one switch away.
 */
export async function showMap(page: Page) {
  const button = page.locator('#top-view-mode').getByRole('button', { name: /^Mapa de / });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Writes each file (path relative to `root`, then text), creating the folders on the way. */
export function writeTree(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}
