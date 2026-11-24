import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, sessionHeaders, writeTree } from './helpers';
import { runProjectsAction } from './more-menu';

// Every open project has exactly one view the user can reach (in the grid, or minimized with its tab);
// a view goes only when the user closes it or removes its project, and removing a project never brings
// another view back. Home (the list of projects, selection empty) reaches every project by its row.

// A control that never becomes usable fails the step instead of waiting for the test timeout.
test.use({ actionTimeout: 10000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: false, bottom: false }));
  });
});

/**
 * alfa holds beta (its own CLAUDE.md, so it is also a scope of alfa) and delta-pkg below node_modules,
 * a folder the reader leaves out; gama stands apart. No other folder has an entry of its own, so the
 * only directory views are the views of the opened projects.
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-views-'));
  const alfa = join(base, 'alfa');
  const beta = join(alfa, 'equipes', 'beta');
  const delta = join(alfa, 'node_modules', 'delta-pkg');
  const gama = join(base, 'gama');
  writeTree(alfa, {
    'AGENTS.md': '# Alfa\n[Guia](docs/guia.md)\n[Beta](equipes/beta/notas.md)\n',
    'docs/guia.md': '# Guia\n',
  });
  writeTree(beta, { 'CLAUDE.md': '# Beta\n[Notas](notas.md)\n', 'notas.md': '# Notas\n' });
  writeTree(delta, { 'AGENTS.md': '# Pacote\n[Leia](leia.md)\n', 'leia.md': '# Leia\n' });
  writeTree(gama, { 'AGENTS.md': '# Gama\n[Plano](plano.md)\n', 'plano.md': '# Plano\n' });
  return { alfa, beta, delta, gama };
}
const nameOf = (path: string) => path.split('/').at(-1)!;

async function openedRoots(page: Page) {
  const headers = await sessionHeaders(page);
  const model = await (await page.request.get('/api/workspace', { headers })).json();
  return (model.roots as { path: string }[]).map((root) => root.path).sort();
}
/** Panes the user can reach: in the grid, or out of it with a tab that restores them. */
async function reachable(page: Page) {
  return await page.evaluate(() => {
    const tabs = new Set(
      [...document.querySelectorAll<HTMLElement>('[data-view-id]')].map(
        (tab) => tab.dataset.viewId,
      ),
    );
    return [...document.querySelectorAll<HTMLElement>('.workspace-pane')]
      .filter((pane) => pane.dataset.minimized !== 'true' || tabs.has(pane.dataset.paneId))
      .map((pane) => pane.dataset.paneId!)
      .sort();
  });
}
/** The views the screen offers for the open projects: one per project, or, on Home, the row of each one. */
async function views(page: Page) {
  if (await page.locator('.home-list').count())
    return (
      await page
        .locator('.home-row.is-folder')
        .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.project!))
    ).sort();
  const panes = await reachable(page);
  return panes
    .filter((id) => id.startsWith('scope:'))
    .map((id) => id.slice('scope:'.length))
    .sort();
}
async function settled(page: Page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.status-state')).toHaveText('Pronto');
}
async function expectOneViewPerProject(page: Page, context: string) {
  await settled(page);
  const roots = await openedRoots(page);
  await expect
    .poll(async () => await views(page), { message: context, timeout: 5000 })
    .toEqual(roots);
  return roots;
}
async function addDirectory(page: Page, path: string) {
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(path);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: `Painel do diretório ${path}`, exact: true }),
  ).toBeVisible();
}
async function removeFromTree(page: Page, path: string) {
  // Home has no tree: the tree is in a project.
  await expect(page.locator('.home-list, .map-workspace').first()).toBeVisible();
  if (await page.locator('.home-list').count()) await enterProject(page);
  await page.getByRole('button', { name: `Remover ${nameOf(path)} da tela`, exact: true }).click();
  await expect(page.getByText(`${nameOf(path)} saiu da tela`)).toBeVisible();
}
/**
 * The × of a project in Abrir projeto forgets it, after the dialog, with the views on the screen behind
 * (the view of a project has no ×).
 */
async function forgetFromOpenProject(page: Page, path: string) {
  await runProjectsAction(page, 'Abrir projeto');
  const cases = page.getByRole('dialog', { name: 'Abrir projeto' });
  // Earlier tests leave projects of the same name saved: the row of this folder.
  await cases
    .locator('.saved-case', { hasText: path })
    .getByRole('button', { name: `Excluir o projeto ${nameOf(path)} do aplicativo…`, exact: true })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: `Excluir ${nameOf(path)} do aplicativo?`,
    exact: true,
  });
  await confirmation.getByRole('button', { name: 'Excluir projeto', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('opening a project after Home keeps a view for the project already open', async ({ page }) => {
  const { alfa, gama } = fixture();
  // Restored at start: the app opens on Home, the list of the open projects.
  const close = await openOnly(page, [alfa]);
  await page.goto('/');
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  expect(await expectOneViewPerProject(page, 'restored')).toEqual([alfa]);
  await addDirectory(page, gama);
  expect(await expectOneViewPerProject(page, 'gama after a restore')).toEqual([alfa, gama]);
  // The same from the home button: the overview, then another project.
  await removeFromTree(page, gama);
  await expectOneViewPerProject(page, 'gama removed');
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  await addDirectory(page, gama);
  expect(await expectOneViewPerProject(page, 'gama after Home')).toEqual([alfa, gama]);
  // Each view has its tab and its header button to minimize it; none forgets the project.
  await expect(page.locator('[data-view-id]')).toHaveCount(2);
  await expect(
    page.locator(`[data-pane-id="scope:${alfa}"]`).getByRole('button', {
      name: `Minimizar vista ${nameOf(alfa)}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(`[data-pane-id="scope:${alfa}"]`).getByRole('button', {
      name: `Excluir o projeto ${nameOf(alfa)} do aplicativo…`,
      exact: true,
    }),
  ).toHaveCount(0);
  await close();
});

test('removing a project that is a folder of another open project does not bring its view back', async ({
  page,
}) => {
  const { alfa, beta } = fixture();
  const close = await openOnly(page, []);
  await page.goto('/');
  await addDirectory(page, alfa);
  await addDirectory(page, beta);
  expect(await expectOneViewPerProject(page, 'alfa and beta')).toEqual([alfa, beta]);
  const betaPane = page.getByRole('region', { name: `Painel do diretório ${beta}`, exact: true });
  // A file of beta is selected when beta leaves the screen.
  await betaPane.locator('.structure-open', { hasText: 'notas.md' }).click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('notas.md');
  // Forgotten from Abrir projeto, its view still on the screen (the tree keeps "Remover da tela").
  await forgetFromOpenProject(page, beta);
  expect(await expectOneViewPerProject(page, 'beta removed')).toEqual([alfa]);
  await expect(betaPane).toHaveCount(0);
  // Neither a new reading, nor going back, nor a reload brings it back.
  await page.getByRole('button', { name: 'Reler diretórios' }).click();
  expect(await expectOneViewPerProject(page, 'reread')).toEqual([alfa]);
  for (let step = 0; step < 4; step++) {
    const back = page.getByRole('button', { name: 'Voltar seleção' });
    if (await back.isDisabled()) break;
    await back.click();
    expect(await expectOneViewPerProject(page, `back ${step + 1}`)).toEqual([alfa]);
  }
  await page.reload();
  await expectOneViewPerProject(page, 'reload');
  // Reopened, it has its view again; removed from the tree with the root selected, it goes again.
  await addDirectory(page, beta);
  expect(await expectOneViewPerProject(page, 'beta reopened')).toEqual([alfa, beta]);
  await removeFromTree(page, beta);
  expect(await expectOneViewPerProject(page, 'beta removed from the tree')).toEqual([alfa]);
  // The outer project leaves and the nested one stays with its view.
  await addDirectory(page, beta);
  await removeFromTree(page, alfa);
  expect(await expectOneViewPerProject(page, 'alfa removed')).toEqual([beta]);
  await close();
});

test('random sequences of open, remove, minimize, reread and reload keep one view per project', async ({
  page,
}) => {
  test.setTimeout(600000);
  const { alfa, beta, delta, gama } = fixture();
  const all = [alfa, beta, delta, gama];
  let seed = 20261114;
  const random = () => {
    // mulberry32: the same sequences on every run.
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const close = await openOnly(page, []);
  await page.goto('/');
  for (let sequence = 0; sequence < 30; sequence++) {
    await openOnly(page, []);
    await page.reload();
    const log: string[] = [];
    for (let step = 0; step < 6; step++) {
      const open = await openedRoots(page);
      const closed = all.filter((path) => !open.includes(path));
      const minimizable = page.locator('.workspace-pane[data-minimized="false"] .pane-actions');
      const actions = [
        ...(closed.length ? ['open', 'open'] : []),
        ...(open.length ? ['remove', 'remove'] : []),
        ...((await minimizable.count()) > 1 ? ['minimize'] : []),
        // "Reler" is disabled with no project open.
        ...(open.length ? ['reread'] : []),
        'reload',
      ];
      const action = pick(actions);
      const context = () => `sequence ${sequence}: ${[...log].join(' → ')}`;
      if (action === 'open') {
        const path = pick(closed);
        log.push(`open ${nameOf(path)}`);
        await addDirectory(page, path);
      } else if (action === 'remove') {
        const path = pick(open);
        // Abrir projeto forgets the project, with the views behind; the tree removes it from the screen.
        // (The same draws as when the view of a project had its own ×, visible only outside Home.)
        const usePane =
          random() < 0.5 && (await page.locator(`[data-pane-id="scope:${path}"]`).isVisible());
        log.push(`remove ${nameOf(path)}${usePane ? ' (Abrir projeto)' : ''}`);
        if (usePane) await forgetFromOpenProject(page, path);
        else await removeFromTree(page, path);
      } else if (action === 'minimize') {
        const button = pick(await page.getByRole('button', { name: /^Minimizar vista / }).all());
        log.push(`${await button.getAttribute('aria-label')}`);
        if (await button.isVisible()) await button.click();
      } else if (action === 'reread') {
        log.push('reread');
        await page.getByRole('button', { name: 'Reler diretórios' }).click();
      } else {
        log.push('reload');
        await page.reload();
      }
      const before = await openedRoots(page);
      const roots = await expectOneViewPerProject(page, context());
      expect(roots, context()).toEqual(before);
    }
  }
  await close();
});
