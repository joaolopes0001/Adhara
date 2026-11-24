// A view on the screen never goes below its least height (paneMinHeight in src/layout.tsx: its header,
// the header line of the Structure, three rows and the line under them), and nothing is drawn over
// another thing: with the bottom panel open, the panel gives way first; when two views one above the
// other still do not fit, they go side by side; when that does not fit either, the view that does not
// fit waits in the Views strip, listed as minimized, and comes back with the room.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, writeTree } from './helpers';

const LEAST = 36 + 31 + 3 * 30 + 31;
const LEAST_LOW = 30 + 25 + 3 * 24 + 24;

/** Two projects with a few files each; `um` has a folder whose twelve files reference nothing. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-views-room-'));
  const files: Record<string, string> = {};
  for (const name of ['um', 'dois']) {
    files[`${name}/AGENTS.md`] =
      `# ${name}\n` + ['a', 'b', 'c', 'd', 'e'].map((f) => `[${f}](${f}.md)\n`).join('');
    for (const f of ['a', 'b', 'c', 'd', 'e']) files[`${name}/${f}.md`] = `# ${f}\n`;
  }
  for (let i = 0; i < 12; i++) files[`um/soltos/s-${String(i).padStart(2, '0')}.md`] = '# s\n';
  writeTree(base, files);
  return { um: join(base, 'um'), dois: join(base, 'dois') };
}

/** Each view on the screen, the grid, the bottom panel and the strip, as drawn. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const grid = document.querySelector<HTMLElement>('.map-workspace')!;
    const views = [...document.querySelectorAll<HTMLElement>('.workspace-pane')]
      .filter((view) => view.dataset.minimized === 'false')
      .map((view) => {
        const header = view.querySelector('.scope-header')!.getBoundingClientRect();
        // What is drawn at the middle of the header is the view's own (nothing over it).
        const hit = document.elementFromPoint(header.left + 40, header.top + header.height / 2);
        return {
          id: view.dataset.paneId!.split('/').at(-1)!,
          ...box(view)!,
          headerOnTop: !!hit && view.contains(hit),
        };
      });
    return {
      grid: { ...box(grid)!, scroll: grid.scrollHeight - grid.clientHeight },
      columns: grid.dataset.columns,
      panel: box(document.querySelector('.tool-panel')),
      main: box(document.querySelector('.main-pane'))!,
      views,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: false, bottom: false }));
  });
});

test('two views one above the other keep their least height: the bottom panel gives way, else they go side by side', async ({
  page,
}) => {
  const paths = fixture();
  await page.setViewportSize({ width: 1512, height: 671 });
  const close = await openOnly(page, [paths.um, paths.dois]);
  await page.goto('/');
  await enterProject(page, 'um');
  await page.getByRole('button', { name: 'Restaurar vista dois', exact: true }).click();
  await page.getByRole('button', { name: 'Organizar vistas em linhas', exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '1');
  // Negative: without the panel, the two rows share the whole centre.
  let drawn = await measure(page);
  expect(drawn.views).toHaveLength(2);
  for (const view of drawn.views) expect(view.height).toBeGreaterThan(LEAST + 50);

  // The Audit below: the panel takes what the two rows at their least height leave it.
  await page.locator('.dock-tools').getByRole('button', { name: 'Auditoria', exact: true }).click();
  await expect(page.locator('.tool-panel')).toBeVisible();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '1');
  drawn = await measure(page);
  expect(drawn.views.map((view) => view.id)).toEqual(['um', 'dois']);
  for (const view of drawn.views) {
    expect(view.height).toBeGreaterThanOrEqual(LEAST);
    expect(view.headerOnTop).toBe(true);
    expect(view.bottom).toBeLessThanOrEqual(drawn.grid.bottom);
  }
  expect(drawn.grid.scroll).toBeLessThanOrEqual(0);
  expect(drawn.panel!.top).toBeGreaterThanOrEqual(drawn.grid.bottom);
  expect(drawn.panel!.height).toBe(drawn.main.height - (2 * LEAST + 1));
  // The Views strip says the truth: neither view is minimized.
  for (const name of ['um', 'dois'])
    await expect(
      page.getByRole('button', { name: `Ativar vista ${name}`, exact: true }),
    ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('rows-audit.png') });

  // A lower window: two rows and the panel at its least height do not fit; the views go side by side,
  // and the other arrangement is not offered while it does not fit.
  await page.setViewportSize({ width: 1512, height: 560 });
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '2');
  drawn = await measure(page);
  for (const view of drawn.views) {
    expect(view.height).toBeGreaterThanOrEqual(LEAST);
    expect(view.headerOnTop).toBe(true);
  }
  expect(drawn.grid.scroll).toBeLessThanOrEqual(0);
  await expect(
    page.getByRole('button', { name: 'Organizar vistas em linhas', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('low-window-audit.png') });
  // Without the panel there is room again, and the arrangement chosen comes back.
  await page.getByRole('button', { name: 'Recolher painel inferior', exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '1');
  await close();
});

test('749×396 with the inspector: the view that does not fit waits in the Views strip, minimized, and comes back with the room', async ({
  page,
}) => {
  const paths = fixture();
  await page.setViewportSize({ width: 749, height: 396 });
  const close = await openOnly(page, [paths.um, paths.dois]);
  await page.goto('/');
  await enterProject(page, 'um');
  await page.getByRole('button', { name: 'Restaurar vista dois', exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-visible-panes', '2');
  // A file of um in the inspector: two columns no longer fit beside it, nor two rows of 151 px.
  const um = page.locator(`.workspace-pane[data-pane-id="scope:${paths.um}"]`);
  await um.locator('.structure-row', { hasText: 'a.md' }).click();
  await um.locator('.structure-row', { hasText: 'a.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('a.md');
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-visible-panes', '1');
  let drawn = await measure(page);
  expect(drawn.views.map((view) => view.id)).toEqual(['um']);
  expect(drawn.views[0].height).toBeGreaterThanOrEqual(LEAST_LOW);
  expect(drawn.grid.scroll).toBeLessThanOrEqual(0);
  const dois = page.getByRole('button', { name: 'Restaurar vista dois', exact: true });
  await expect(dois).toContainText('Minimizada');
  await page.screenshot({ path: test.info().outputPath('compact-inspector.png') });
  // Brought back from the strip, it takes the place; the other one waits.
  await dois.click();
  await expect(page.getByRole('button', { name: 'Restaurar vista um', exact: true })).toBeVisible();
  drawn = await measure(page);
  expect(drawn.views.map((view) => view.id)).toEqual(['dois']);
  // The inspector closed: room for both again, side by side.
  await page.getByRole('button', { name: 'Fechar inspetor', exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-visible-panes', '2');
  drawn = await measure(page);
  for (const view of drawn.views) {
    expect(view.height).toBeGreaterThanOrEqual(LEAST_LOW);
    expect(view.headerOnTop).toBe(true);
  }
  await close();
});

test('a folder map without arrows at the least height of a view: its sentence and its first cards stay in the map area', async ({
  page,
}) => {
  const paths = fixture();
  await page.setViewportSize({ width: 1512, height: 671 });
  const close = await openOnly(page, [paths.um, paths.dois]);
  await page.goto('/');
  await enterProject(page, 'um');
  await page.getByRole('button', { name: 'Restaurar vista dois', exact: true }).click();
  await page.getByRole('button', { name: 'Organizar vistas em linhas', exact: true }).click();
  const um = page.locator(`.workspace-pane[data-pane-id="scope:${paths.um}"]`);
  await um.locator('.structure-open', { hasText: /^soltos$/ }).click();
  await page.getByRole('button', { name: 'Mapa de um', exact: true }).click();
  await page.locator('.dock-tools').getByRole('button', { name: 'Auditoria', exact: true }).click();
  // The twelve files are cards, under the sentence that says there is no arrow between them; no line
  // under the map repeats them.
  await expect(um.locator('.react-flow__node-file')).toHaveCount(12);
  await expect(um.locator('.folder-lane')).toHaveText(
    'Nenhuma referência entre os itens desta pasta.',
  );
  await expect(um.locator('.folder-strip')).toHaveCount(0);
  await expect
    .poll(() =>
      um.evaluate((view) => {
        const area = view.querySelector('.map-area')!.getBoundingClientRect();
        const sentence = view.querySelector('.folder-lane')!.getBoundingClientRect();
        const card = view.querySelector('.react-flow__node-file')!.getBoundingClientRect();
        return (
          sentence.top >= area.top &&
          sentence.bottom <= area.bottom + 0.5 &&
          card.top >= area.top &&
          card.top < area.bottom
        );
      }),
    )
    .toBe(true);
  expect(await um.evaluate((view) => view.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
    LEAST,
  );
  await close();
});
