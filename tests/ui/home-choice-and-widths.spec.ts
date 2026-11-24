import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionHeaders, writeTree } from './helpers';
import { runProjectsAction } from './more-menu';

// The project chosen on Home is the only view on the screen (the others wait minimized in the strip of
// views); the view of a project has no ×, only –; the inspector grows until the centre keeps 320 px;
// the class column of the Structure never runs over the numbers beside it.

/** Three small projects and a fourth with a folder of its own AGENTS.md and CLAUDE.md that points far. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-choice-'));
  const files: Record<string, string> = {};
  for (const name of ['alfa', 'beta', 'gama', 'delta']) {
    files[`${name}/AGENTS.md`] = `# ${name}\n[Guia](docs/guia.md)\n`;
    files[`${name}/docs/guia.md`] = '# Guia\n';
  }
  // 113 distinct files outside the folder, so that "points to" has three digits beside a long class.
  const note = (i: number) => `notas/n-${String(i).padStart(3, '0')}.md`;
  files['alfa/modulo/AGENTS.md'] =
    '# Módulo\n' + Array.from({ length: 113 }, (_, i) => `- [n](../${note(i)})\n`).join('');
  files['alfa/modulo/CLAUDE.md'] = '# Módulo\n[agents](AGENTS.md)\n';
  for (let i = 0; i < 113; i++) files[`alfa/${note(i)}`] = '# N\n';
  // A folder whose long name leaves its item count no room in a narrow view.
  files['alfa/uma-pasta-com-um-nome-bem-comprido-que-nao-cabe/a.md'] = '# A\n';
  files['alfa/uma-pasta-com-um-nome-bem-comprido-que-nao-cabe/b.md'] = '# B\n';
  files['alfa/docs/longo.md'] =
    '# Longo\n\n' + 'Uma frase comprida de instruções. '.repeat(80) + '\n';
  writeTree(base, files);
  const at = (name: string) => join(base, name);
  return { base, alfa: at('alfa'), beta: at('beta'), gama: at('gama'), delta: at('delta') };
}

/** Only these projects open, in this order; `closed` saved but closed. */
async function only(page: Page, open: string[], closed: string[] = []) {
  const headers = await sessionHeaders(page);
  const call = async (operation: string, data: object) =>
    expect((await page.request.post(`/api/${operation}`, { headers, data })).ok()).toBe(true);
  const workspace = await (await page.request.get('/api/workspace', { headers })).json();
  for (const root of workspace.roots) await call('close', { path: root.path });
  // What earlier tests left saved goes, so that names repeat nowhere.
  for (const item of workspace.savedCases)
    if (![...open, ...closed].includes(item.path)) await call('forget', { path: item.path });
  for (const path of closed) {
    await call('open', { path });
    await call('close', { path });
  }
  for (const path of open) await call('open', { path });
}

const row = (page: Page, path: string) =>
  page.locator(`.home-row[data-project="${path}"] .structure-open`);
const pane = (page: Page, path: string) =>
  page.locator(`.workspace-pane[data-pane-id="scope:${path}"]`);
const home = (page: Page) => page.getByRole('button', { name: 'Início', exact: true });
/**
 * The views of these projects on the screen beside the current one: restored from their tabs when they
 * are minimized (the choice on Home), as they already are where Home showed every view.
 */
async function showBeside(page: Page, names: string[]) {
  for (const name of names) {
    const restore = page.getByRole('button', { name: `Restaurar vista ${name}`, exact: true });
    if (await restore.count()) await restore.click();
    await expect(
      page.locator(`.workspace-pane[data-pane-id$="/${name}"][data-minimized="false"]`),
    ).toHaveCount(1);
  }
}
/** The id of each project view and whether it is minimized, in the order of the grid. */
const shown = (page: Page) =>
  page
    .locator('.workspace-pane[data-pane-id^="scope:"]')
    .evaluateAll((items) =>
      Object.fromEntries(
        items.map((item) => [
          (item as HTMLElement).dataset.paneId!.split('/').at(-1),
          (item as HTMLElement).dataset.minimized === 'true' ? 'minimized' : 'shown',
        ]),
      ),
    );

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('layout-seeded')) {
      sessionStorage.setItem('layout-seeded', '1');
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ explorer: true, inspector: false, bottom: false }),
      );
    }
  });
});

test('Home: a click on a project shows only its view; the others stay open, minimized in the strip, and come back from their tabs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1512, height: 694 });
  const paths = fixture();
  // Two projects: a click on beta shows beta, never alfa beside it.
  await only(page, [paths.alfa, paths.beta]);
  await page.goto('/');
  await row(page, paths.beta).click();
  await expect(pane(page, paths.beta)).toBeVisible();
  await expect(pane(page, paths.alfa)).toBeHidden();
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'shown' });
  // Both still read: the footer counts two folders, and alfa is a tab of the strip.
  await expect(page.locator('.status-roots')).toHaveText('2 diretórios');
  const strip = page.locator('.workspace-view-strip');
  await expect(strip.locator('.workspace-view-tab.is-minimized')).toHaveText(/alfa\s*Minimizada/);
  await page.screenshot({ path: test.info().outputPath('home-choice-two.png') });
  // Three projects: each click shows only the one clicked, also after going back to Home.
  await only(page, [paths.alfa, paths.beta, paths.gama]);
  await page.reload();
  await row(page, paths.gama).click();
  await expect(pane(page, paths.gama)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'minimized', gama: 'shown' });
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-visible-panes', '1');
  await home(page).click();
  await row(page, paths.alfa).click();
  await expect(pane(page, paths.alfa)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'shown', beta: 'minimized', gama: 'minimized' });
  // The same project again: still alone.
  await home(page).click();
  await row(page, paths.alfa).click();
  await expect(pane(page, paths.alfa)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'shown', beta: 'minimized', gama: 'minimized' });
  // Side by side is one click on a tab away, and the choice is not applied again while in the project.
  await page.getByRole('button', { name: 'Restaurar vista gama', exact: true }).click();
  expect(await shown(page)).toEqual({ alfa: 'shown', beta: 'minimized', gama: 'shown' });
  await page
    .getByRole('region', { name: 'Estrutura de alfa' })
    .locator('.structure-open', { hasText: 'docs' })
    .click();
  expect(await shown(page)).toEqual({ alfa: 'shown', beta: 'minimized', gama: 'shown' });
  // A saved and closed project opened from Home follows the same rule, once its reading arrives.
  await only(page, [paths.alfa, paths.beta], [paths.delta]);
  await page.reload();
  await row(page, paths.delta).click();
  await expect(pane(page, paths.delta)).toBeVisible();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('delta');
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'minimized', delta: 'shown' });
  await page.screenshot({ path: test.info().outputPath('home-choice-closed.png') });
  expect(errors).toEqual([]);
});

test('the view of a project has no ×: only –, also beside a folder view; derived views keep theirs; all minimized still shows a way back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 694 });
  const paths = fixture();
  const filter = {
    id: 'choice-filter',
    name: 'Guia de beta',
    files: [join(paths.beta, 'docs/guia.md')],
    kind: 'connections',
    direction: 'both',
    conventions: false,
  };
  await page.addInitScript((saved) => {
    if (!sessionStorage.getItem('filter-set')) {
      sessionStorage.setItem('filter-set', '1');
      localStorage.setItem('aae-map-filters', JSON.stringify([saved]));
    }
  }, filter);
  await only(page, [paths.alfa, paths.beta]);
  await page.goto('/');
  await row(page, paths.alfa).click();
  await showBeside(page, ['beta']);
  // A folder view of alfa (its own AGENTS.md) opens beside: it keeps Fechar vista.
  await page
    .getByRole('region', { name: 'Estrutura de alfa' })
    .locator('.structure-open', { hasText: 'modulo' })
    .click();
  const folder = page.locator('.workspace-pane[data-pane-id$="/alfa/modulo"]');
  await expect(folder).toBeVisible();
  await expect(
    folder
      .locator('.scope-header')
      .getByRole('button', { name: 'Fechar vista modulo', exact: true }),
  ).toBeVisible();
  for (const [path, name] of [
    [paths.alfa, 'alfa'],
    [paths.beta, 'beta'],
  ]) {
    const header = pane(page, path).locator('.scope-header');
    await expect(
      header.getByRole('button', { name: `Minimizar vista ${name}`, exact: true }),
    ).toBeVisible();
    // No ×, by any name: neither forget nor close.
    await expect(
      header.getByRole('button', { name: /Excluir|Fechar|Esquecer|Forget|Close/ }),
    ).toHaveCount(0);
    await expect(header.locator('.lucide-x')).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath('project-header-no-close.png') });
  // A filter box keeps its ×, which closes it and forgets nothing.
  await page.getByRole('button', { name: 'Filtros do mapa' }).click();
  await page
    .getByRole('dialog', { name: 'Filtros do mapa' })
    .getByRole('button', { name: 'Abrir vista', exact: true })
    .click();
  const box = page.locator('[data-pane-id="filter:choice-filter"]');
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: 'Fechar vista Guia de beta', exact: true }).click();
  await expect(box).toHaveCount(0);
  await expect(page.locator('.status-roots')).toHaveText('2 diretórios');
  // Every view minimized: the strip and Restaurar vistas stay on the screen.
  for (const name of ['alfa', 'beta', 'modulo'])
    await page.getByRole('button', { name: `Minimizar vista ${name}`, exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-visible-panes', '0');
  await expect(page.getByRole('button', { name: 'Restaurar vistas', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-view-tab')).toHaveCount(3);
  await page.getByRole('button', { name: 'Restaurar vista beta', exact: true }).click();
  await expect(pane(page, paths.beta)).toBeVisible();
  // Forgetting stays on Home and in Abrir projeto.
  await runProjectsAction(page, 'Abrir projeto');
  await expect(
    page
      .getByRole('dialog', { name: 'Abrir projeto' })
      .getByRole('button', { name: 'Excluir o projeto beta do aplicativo…', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await home(page).click();
  await expect(
    page
      .locator(`.home-row[data-project="${paths.beta}"]`)
      .getByRole('button', { name: 'Excluir o projeto beta do aplicativo…', exact: true }),
  ).toBeVisible();
});

/** Widths of the inspector, the centre and the explorer, and whether the page scrolls sideways. */
const widths = (page: Page) =>
  page.evaluate(() => {
    const width = (selector: string) =>
      Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
    return {
      inspector: width('.inspector'),
      center: width('.main-pane'),
      explorer: width('.explorer:not([hidden])'),
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('aae-layout') || '{}').inspectorWidth);
async function openLongFile(page: Page) {
  const structure = page.getByRole('region', { name: /^Estrutura de / });
  if (!(await structure.locator('.structure-open', { hasText: 'longo.md' }).count()))
    await structure.locator('.structure-open', { hasText: 'docs' }).first().click();
  await structure.locator('.structure-open', { hasText: 'longo.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('longo.md');
  // Measured once the inspector stopped sliding in.
  await expect
    .poll(() => page.locator('.inspector').evaluate((element) => element.getAnimations().length))
    .toBe(0);
}

test('inspector: the divider passes 640 px and stops where the centre keeps 320 px; keyboard and ARIA follow the window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 694 });
  const paths = fixture();
  await only(page, [paths.alfa]);
  await page.goto('/');
  await row(page, paths.alfa).click();
  await openLongFile(page);
  const separator = page.getByRole('separator', { name: 'Largura do inspetor' });
  const before = await widths(page);
  expect(before.inspector).toBe(380);
  // The room: the window less the explorer, the dividers and the centre's 320 px.
  const max = 1512 - before.explorer - 320 - 2;
  await expect(separator).toHaveAttribute('aria-valuemax', String(max));
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 120);
  await page.mouse.down();
  await page.mouse.move(5, handle.y + 120, { steps: 15 });
  await page.mouse.up();
  const dragged = await widths(page);
  expect(dragged.inspector, 'beyond the old 640 px').toBeGreaterThan(640);
  expect(dragged.inspector).toBe(max);
  expect(dragged.center, 'the centre keeps its minimum').toBeGreaterThanOrEqual(320);
  expect(dragged.center).toBeLessThan(330);
  expect(dragged.sideways).toBe(false);
  await expect(separator).toHaveAttribute('aria-valuenow', String(max));
  expect(await saved(page)).toBe(max);
  await page.screenshot({ path: test.info().outputPath('inspector-widest.png') });
  // Keyboard: Home goes to the minimum, an arrow 20 px, End back to the room of the window.
  await separator.focus();
  await page.keyboard.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', '260');
  await page.keyboard.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', '280');
  await page.keyboard.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow', String(max));
  // Without the explorer, the inspector may take its width too.
  await page.keyboard.press('Control+b');
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(separator).toHaveAttribute('aria-valuemax', String(1512 - 320 - 2));
  await separator.focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await widths(page)).inspector).toBe(1512 - 320 - 2);
  expect((await widths(page)).center).toBeGreaterThanOrEqual(320);
  // The editor and its bar fit a wide inspector: the bar of actions never leaves it.
  const actions = await page.locator('.inspector-identity .endpoint-actions').evaluate((bar) => ({
    right: bar.getBoundingClientRect().right,
    inspector: bar.closest('.inspector')!.getBoundingClientRect().right,
  }));
  expect(actions.right).toBeLessThanOrEqual(actions.inspector);
});

test('inspector: a saved width larger than the window is drawn within it, never written down, and comes back in a wider one', async ({
  page,
}) => {
  const paths = fixture();
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('wide-seeded')) {
      sessionStorage.setItem('wide-seeded', '1');
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ explorer: true, inspector: true, bottom: false, inspectorWidth: 3000 }),
      );
    }
  });
  await page.setViewportSize({ width: 1512, height: 694 });
  await only(page, [paths.alfa]);
  await page.goto('/');
  await row(page, paths.alfa).click();
  await openLongFile(page);
  const separator = page.getByRole('separator', { name: 'Largura do inspetor' });
  for (const [width, height] of [
    [1512, 694],
    [1100, 700],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    // The centre keeps its 320 px and the inspector takes the rest (once the resize arrived).
    await expect
      .poll(async () => Math.floor((await widths(page)).center / 10), `${width}: the centre`)
      .toBe(32);
    const now = await widths(page);
    expect(now.center).toBeGreaterThanOrEqual(320);
    expect(now.sideways, `${width}: no sideways scroll`).toBe(false);
    await expect(separator).toHaveAttribute('aria-valuenow', String(now.inspector));
    await expect(separator).toHaveAttribute('aria-valuemax', String(now.inspector));
    expect(await saved(page), `${width}: the preference stays`).toBe(3000);
  }
  // The compact window: one side panel at a time, the inspector opened again by a click on the file, and
  // at most 44% of the window, as before (its map keeps the room its header is laid out for).
  await page.setViewportSize({ width: 749, height: 396 });
  // Entering the compact window closes both side panels; a click on the selected file opens the inspector.
  await expect(page.locator('.inspector')).toHaveCount(0);
  await openLongFile(page);
  await expect(page.locator('.explorer')).toBeHidden();
  const compact = await widths(page);
  expect(compact.inspector).toBe(Math.round(749 * 0.44));
  expect(compact.center).toBeGreaterThanOrEqual(418);
  expect(Number(await separator.getAttribute('aria-valuemax'))).toBeCloseTo(749 * 0.44, 1);
  expect(compact.sideways).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  await expect(page.getByRole('button', { name: 'Início', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('inspector-compact.png') });
  expect(await saved(page)).toBe(3000);
  // After a reload the saved width is read again as it was.
  await page.reload();
  expect(await saved(page)).toBe(3000);
});

/** Pairs of neighbouring cells of a Structure row whose drawn content overlaps, in px (none: []). */
async function overlaps(line: Locator) {
  return line.evaluate((row) => {
    const cells = [...row.children].filter((cell) => getComputedStyle(cell).display !== 'none');
    // A cell is drawn where its own box and every descendant box are (an overflowing label included).
    const extent = (cell: Element) => {
      let left = cell.getBoundingClientRect().left,
        right = cell.getBoundingClientRect().right;
      for (const item of cell.querySelectorAll('*')) {
        const box = item.getBoundingClientRect();
        if (!box.width) continue;
        left = Math.min(left, box.left);
        right = Math.max(right, box.right);
      }
      return { left, right };
    };
    const found: string[] = [];
    for (let index = 1; index < cells.length; index++) {
      const a = extent(cells[index - 1]),
        b = extent(cells[index]);
      if (a.right > b.left + 0.5)
        found.push(
          `${cells[index - 1].className} × ${cells[index].className}: ${a.right - b.left}`,
        );
    }
    return found;
  });
}

test('Structure: a long class is cut inside its column, whole in its tooltip, and no cell runs over its neighbour at any width of the view', async ({
  page,
}) => {
  const paths = fixture();
  await only(page, [paths.alfa, paths.beta, paths.gama]);
  await page.setViewportSize({ width: 1512, height: 694 });
  await page.goto('/');
  await row(page, paths.alfa).click();
  await showBeside(page, ['beta']);
  const line = pane(page, paths.alfa).locator('.structure-row', { hasText: 'modulo' });
  await expect(line.locator('.structure-own-entry')).toHaveText('AGENTS.md e CLAUDE.md próprios');
  await expect(line.locator('.structure-count').first()).toHaveText(/113/);
  // Two views side by side in 1512 px: no cell is drawn over its neighbour (before, the class ran over
  // the number of "points to").
  expect(await overlaps(line)).toEqual([]);
  await line.screenshot({ path: test.info().outputPath('structure-class-two-views.png') });
  // The class is cut with an ellipsis; its tooltip has the whole text while it is cut, and the
  // explanation of the label always.
  const label = line.locator('.structure-own-entry');
  expect(
    await label.evaluate((element) => [
      element.scrollWidth > element.clientWidth,
      getComputedStyle(element).textOverflow,
    ]),
  ).toEqual([true, 'ellipsis']);
  await label.hover();
  await expect(label).toHaveAttribute('title', /^AGENTS\.md e CLAUDE\.md próprios\nPasta com/);
  // A class shown whole has no tooltip repeating it.
  const kind = pane(page, paths.alfa).locator('.structure-kind');
  await expect(kind).toHaveText('Instruções');
  await kind.hover();
  await expect(kind).not.toHaveAttribute('title');
  // Any width of the window, with two and three views, and the compact one. Along the way, the count of
  // items of the folder with a long name is cut: in part, its tooltip says it whole; with no room at all,
  // the tooltip of the folder's name says it.
  const folderRow = pane(page, paths.alfa).locator('.structure-row', { hasText: 'uma-pasta-com' });
  const items = folderRow.locator('.structure-items');
  await expect(folderRow.locator('.structure-open')).toHaveAttribute('title', / · 2 itens\n/);
  const cuts: string[] = [];
  for (const views of [2, 3]) {
    if (views === 3) await showBeside(page, ['gama']);
    for (const width of [1000, 1100, 1200, 1300, 1400, 1512, 1700, 1920]) {
      await page.setViewportSize({ width, height: 694 });
      await expect(page.locator('.map-workspace')).toHaveAttribute(
        'data-visible-panes',
        String(views),
      );
      expect(await overlaps(line), `${views} views, ${width} px`).toEqual([]);
      const room = await items.evaluate((element) => [element.clientWidth, element.scrollWidth]);
      if (room[0] > 0 && room[0] < room[1]) {
        await items.hover();
        await expect(items, `${views} views, ${width} px`).toHaveAttribute('title', '2 itens');
        cuts.push(`${views}×${width}`);
      } else if (room[0] >= room[1]) {
        await items.hover();
        await expect(items, `${views} views, ${width} px`).not.toHaveAttribute('title');
      }
    }
  }
  // The count gives way so fast (it shrinks before the name) that a width cutting it in part is rare;
  // the folder's tooltip has it in any case. Written down for the record of the run.
  test
    .info()
    .annotations.push({ type: 'count cut in part', description: cuts.join(', ') || 'none' });
  await page.setViewportSize({ width: 749, height: 396 });
  expect(await overlaps(line), 'compact window').toEqual([]);
  await pane(page, paths.alfa)
    .locator('.structure-view')
    .screenshot({ path: test.info().outputPath('structure-compact-three-views.png') });
  // The headers of the same columns do not run over each other either.
  await page.setViewportSize({ width: 1512, height: 694 });
  expect(
    await overlaps(pane(page, paths.alfa).locator('.structure-columns .structure-grid')),
  ).toEqual([]);
});

/** The grid scrolls sideways, and the controls of a view header drawn outside their view (none: []). */
async function gridOverflow(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.map-workspace')!;
    const found: string[] = [];
    if (grid.scrollWidth > grid.clientWidth + 0.5)
      found.push(`grid ${grid.clientWidth}/${grid.scrollWidth}`);
    for (const view of document.querySelectorAll('.workspace-pane[data-minimized="false"]')) {
      const box = view.getBoundingClientRect();
      for (const control of view.querySelectorAll('.scope-header :is(button, summary)')) {
        const own = control.getBoundingClientRect();
        if (!own.width) continue;
        if (own.left < box.left - 0.5 || own.right > box.right + 0.5)
          found.push(
            `${control.getAttribute('aria-label') || control.textContent} outside its view`,
          );
      }
    }
    return found;
  });
}
const separatorOf = (page: Page) => page.getByRole('separator', { name: 'Largura do inspetor' });
const aria = async (page: Page) => Number(await separatorOf(page).getAttribute('aria-valuenow'));

test.describe('1512×671 at 125%', () => {
  test.use({ viewport: { width: 1512, height: 671 }, deviceScaleFactor: 1.25 });

  test('inspector at its widest with two or three views on the screen: the grid never scrolls sideways and every control stays in its view; the preference does not change', async ({
    page,
  }) => {
    const paths = fixture();
    await only(page, [paths.alfa, paths.beta, paths.gama]);
    await page.goto('/');
    await row(page, paths.alfa).click();
    await openLongFile(page);
    const explorer = (await widths(page)).explorer;
    // One view: the inspector goes until the centre keeps 320 px.
    await separatorOf(page).focus();
    await page.keyboard.press('End');
    const single = 1512 - explorer - 320 - 2;
    await expect(separatorOf(page)).toHaveAttribute('aria-valuenow', String(single));
    expect(await saved(page)).toBe(single);
    // A second view restored beside: the inspector is drawn narrower, so that each view keeps 320 px
    // (names, not their first letter); the saved width stays.
    const double = 1512 - explorer - 641 - 2;
    await showBeside(page, ['beta']);
    await expect(separatorOf(page)).toHaveAttribute('aria-valuemax', String(double));
    expect(await aria(page)).toBe(double);
    expect((await widths(page)).inspector).toBe(double);
    expect(await saved(page)).toBe(single);
    expect(await gridOverflow(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('widest-two-views.png') });
    // Three views: two columns, the same room.
    await showBeside(page, ['gama']);
    expect(await aria(page)).toBe(double);
    expect(await gridOverflow(page)).toEqual([]);
    // With a tool open below, too.
    await page
      .locator('.dock-tools')
      .getByRole('button', { name: 'Auditoria', exact: true })
      .click();
    await expect(page.locator('.bottom-panel')).toBeVisible();
    expect(await gridOverflow(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('widest-three-views-audit.png') });
    await page
      .locator('.dock-tools')
      .getByRole('button', { name: 'Auditoria', exact: true })
      .click();
    // Back to one view: the inspector is drawn at the saved width again.
    for (const name of ['beta', 'gama'])
      await page.getByRole('button', { name: `Minimizar vista ${name}`, exact: true }).click();
    await expect(separatorOf(page)).toHaveAttribute('aria-valuenow', String(single));
    // A window that cannot hold two views beside the explorer and the inspector at its least width:
    // the views go one above the other, and the grid still does not scroll sideways.
    await showBeside(page, ['beta']);
    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '1');
    expect(await gridOverflow(page)).toEqual([]);
    // The compact window: without the inspector, the two views side by side; with it, kept at 44% of
    // the window (its buttons do not crowd), the views go one above the other.
    await page.setViewportSize({ width: 749, height: 396 });
    await expect(page.locator('.inspector')).toHaveCount(0);
    await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '2');
    expect(await gridOverflow(page)).toEqual([]);
    await pane(page, paths.alfa).locator('.structure-open', { hasText: 'longo.md' }).click();
    await expect(page.locator('.inspector h2')).toHaveText('longo.md');
    await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '1');
    expect(Number(await separatorOf(page).getAttribute('aria-valuemax'))).toBeCloseTo(
      749 * 0.44,
      1,
    );
    expect(await gridOverflow(page)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('compact-two-views.png') });
    expect(await saved(page)).toBe(single);
  });
});

test('a choice on Home still being read gives way to what the user does meanwhile; without it, it applies', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 694 });
  const paths = fixture();
  await only(page, [paths.alfa, paths.beta], [paths.delta]);
  // The reading of a closed project takes a while (held here for 4 s).
  let held = 0;
  await page.route('**/api/open', async (route) => {
    if (held) await new Promise((resolve) => setTimeout(resolve, held));
    await route.continue();
  });
  await page.goto('/');
  held = 4000;
  await row(page, paths.delta).click();
  // Meanwhile the user opens a file of alfa found by Ctrl+K: alfa and beta on the screen.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('docs/longo.md');
  await page.locator('.search-results button', { hasText: 'longo.md' }).first().click();
  await expect(pane(page, paths.alfa)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'shown', beta: 'shown' });
  // The reading arrives: delta joins, and nothing the user had on the screen is minimized.
  await expect(pane(page, paths.delta)).toHaveCount(1, { timeout: 15000 });
  await expect(pane(page, paths.delta)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'shown', beta: 'shown', delta: 'shown' });
  // Without anything in between, the same slow reading ends with delta alone.
  await only(page, [paths.alfa, paths.beta], [paths.delta]);
  held = 0;
  await page.reload();
  held = 2000;
  await row(page, paths.delta).click();
  await expect(pane(page, paths.delta)).toBeVisible({ timeout: 15000 });
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'minimized', delta: 'shown' });
});

test('Voltar, Avançar and Alt+← from Home show the views as they were left: the project chosen alone, then the last arrangement', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 694 });
  const paths = fixture();
  await only(page, [paths.alfa, paths.beta]);
  await page.goto('/');
  await row(page, paths.beta).click();
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'shown' });
  const back = page.getByRole('button', { name: 'Voltar seleção', exact: true });
  const forward = page.getByRole('button', { name: 'Avançar seleção', exact: true });
  await home(page).click();
  await back.click();
  await expect(pane(page, paths.beta)).toBeVisible();
  // Never the two side by side again: beta alone, alfa in the strip.
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'shown' });
  await expect(page.locator('.workspace-view-tab.is-minimized')).toHaveText(/alfa\s*Minimizada/);
  await back.click();
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  await forward.click();
  await expect(pane(page, paths.beta)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'shown' });
  await home(page).click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(pane(page, paths.beta)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'minimized', beta: 'shown' });
  // The last arrangement, whatever entry: alfa restored beside, then Home and back.
  await showBeside(page, ['alfa']);
  await home(page).click();
  await back.click();
  await expect(pane(page, paths.beta)).toBeVisible();
  expect(await shown(page)).toEqual({ alfa: 'shown', beta: 'shown' });
});
