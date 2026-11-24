import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionHeaders, writeTree } from './helpers';
import { runMenuAction, runMoreAction, runProjectsAction } from './more-menu';

// Home is the list of projects (open ones, then the saved and closed ones), without the explorer;
// the × of a row and of Abrir projeto forgets the project after the app's confirmation dialog, which
// offers to erase its notes too; the view of a project has only –, which hides it.

const files: Record<string, string> = {
  'loja/AGENTS.md': '# Loja\n[Guia](docs/guia.md)\n[Falta](docs/falta.md)\n',
  'loja/docs/guia.md': '# Guia\n',
  'loja/pagamentos/CLAUDE.md': '# Pagamentos\n[Regras](regras.md)\n',
  'loja/pagamentos/regras.md': '# Regras\n',
  'outro/CLAUDE.md': '# Outro\n[Contrato](contrato.md)\n',
  'outro/contrato.md': '# Contrato\n',
  'sem-instrucoes/notas.md': '# Notas soltas\n',
  'fechado/AGENTS.md': '# Fechado\n',
  'sumido/AGENTS.md': '# Sumido\n',
};
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-home-'));
  writeTree(base, files);
  const at = (name: string) => join(base, name);
  return {
    base,
    loja: at('loja'),
    pagamentos: at('loja/pagamentos'),
    outro: at('outro'),
    sem: at('sem-instrucoes'),
    fechado: at('fechado'),
    sumido: at('sumido'),
  };
}
/** Every entry of a tree with its mode, size, modification time and bytes: what forgetting must not touch. */
function disk(root: string) {
  const entries: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      const info = lstatSync(path, { bigint: true });
      entries[path] =
        `${info.mode}:${info.size}:${info.mtimeNs}:${info.ino}` +
        (info.isFile() ? `:${readFileSync(path, 'base64')}` : '');
      if (info.isDirectory()) walk(path);
    }
  };
  walk(root);
  return entries;
}

async function api(page: Page, base = '') {
  const { token } = await (await page.request.get(`${base}/api/session`)).json();
  const headers = { 'X-AAE-Token': token };
  return async (operation: string, data?: object) => {
    const response = data
      ? await page.request.post(`${base}/api/${operation}`, { headers, data })
      : await page.request.get(`${base}/api/${operation}`, { headers });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
}
/** Only these projects open, in this order; `closed` saved but closed. Other tests leave theirs saved. */
async function only(page: Page, open: string[], closed: string[] = []) {
  const call = await api(page);
  const workspace = await call('workspace');
  for (const root of workspace.roots) await call('close', { path: root.path });
  // What earlier tests left saved goes, so that the list holds only this test's projects.
  for (const item of workspace.savedCases)
    if (![...open, ...closed].includes(item.path)) await call('forget', { path: item.path });
  for (const path of closed) {
    await call('open', { path });
    await call('close', { path });
  }
  for (const path of open) await call('open', { path });
  return call;
}
/** What forgetting may change in the app state: the projects, the saved list and the notes. */
async function state(call: (operation: string) => Promise<any>) {
  const workspace = await call('workspace');
  return {
    roots: workspace.roots.map((root: { path: string }) => root.path),
    saved: workspace.savedCases.map((item: { path: string }) => item.path),
    notes: workspace.notes,
  };
}
const homeList = (page: Page) => page.getByRole('region', { name: 'Projetos' });
const row = (page: Page, path: string) => page.locator(`.home-row[data-project="${path}"]`);
const forgetButton = (scope: Page | Locator, name: string) =>
  scope.getByRole('button', { name: `Excluir o projeto ${name} do aplicativo…`, exact: true });
const confirmation = (page: Page, name: string) =>
  page.getByRole('dialog', { name: `Excluir ${name} do aplicativo?`, exact: true });
const box = async (locator: Locator) => (await locator.boundingBox())!;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: false, bottom: false }));
  });
});

test('Home is the list of projects: open ones with their numbers, then the saved and closed, in the rows and columns of the Structure, without a canvas', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = fixture();
  // A project in a long path: its folder is cut at the start in the row.
  const deep = join(
    paths.base,
    'uma-pasta-com-um-nome-bem-comprido',
    'e-mais-outra-pasta-longa',
    'longo',
  );
  writeTree(deep, { 'AGENTS.md': '# Longo\n' });
  await only(page, [paths.loja, paths.outro, paths.sem, deep], [paths.fechado, paths.sumido]);
  rmSync(paths.sumido, { recursive: true });
  await page.goto('/');
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  await expect(homeList(page)).toBeVisible();
  await expect(page.locator('.main-pane .react-flow')).toHaveCount(0);
  await expect(page.locator('.home-row.is-folder .structure-open > span')).toHaveText([
    'loja',
    'outro',
    'sem-instrucoes',
    'longo',
  ]);
  await expect(homeList(page).locator('.structure-grid')).toHaveText(
    /4 projetos abertos\s*pasta\s*arquivos\s*instruções\s*observações/,
  );
  // Files, instruction files and observations of each project (the folder of a missing target is no file).
  const numbers = async (path: string) =>
    (await row(page, path).locator('.structure-count > [aria-hidden]').allTextContents()).map(
      Number,
    );
  expect(await numbers(paths.loja)).toEqual([4, 2]);
  expect(await numbers(paths.outro)).toEqual([2, 1]);
  expect(await numbers(paths.sem)).toEqual([1, 0]);
  await expect(row(page, paths.loja).locator('.structure-count').nth(1)).toHaveAttribute(
    'title',
    'AGENTS.md\npagamentos/CLAUDE.md',
  );
  await expect(row(page, paths.loja).locator('.observation-marker')).toHaveText('1');
  await expect(row(page, paths.loja).locator('.observation-marker')).toHaveAccessibleName(
    /Abrir na Auditoria$/,
  );
  await expect(row(page, paths.outro).locator('.observation-marker')).toHaveCount(0);
  // Below, the saved and closed ones, with only name and folder; an unavailable folder says so.
  await expect(homeList(page).locator('.home-group')).toHaveText('Salvos e fechados · 2');
  await expect(page.locator('.home-row.is-closed .structure-open > span')).toHaveText([
    'fechado',
    'sumido',
  ]);
  await expect(row(page, paths.fechado).locator('.structure-count')).toHaveCount(0);
  await expect(row(page, paths.sumido).locator('.structure-listing')).toHaveText('indisponível');
  await expect(row(page, paths.fechado).locator('.structure-listing')).toHaveCount(0);
  await expect(
    row(page, paths.sumido).getByRole('button', { name: 'Abrir projeto sumido' }),
  ).toBeDisabled();
  // Every row, open or closed, has its × at the end, always in view, named for its project.
  for (const [path, name] of [
    [paths.loja, 'loja'],
    [paths.outro, 'outro'],
    [paths.sem, 'sem-instrucoes'],
    [deep, 'longo'],
    [paths.fechado, 'fechado'],
    [paths.sumido, 'sumido'],
  ]) {
    const button = forgetButton(row(page, path), name);
    await expect(button).toBeVisible();
    const [r, b] = [await box(row(page, path)), await box(button)];
    expect(b.x + b.width, `× of ${name} at the end of its row`).toBeLessThanOrEqual(r.x + r.width);
    expect(b.x + b.width, `× of ${name} is the last thing of the row`).toBeGreaterThan(
      r.x + r.width - 20,
    );
    expect(b.width).toBeGreaterThanOrEqual(24);
    expect(b.height).toBeGreaterThanOrEqual(24);
  }
  // A long folder is cut at the start (its end stays visible), whole in the tooltip.
  const path = row(page, deep).locator('.home-path');
  await expect(path).toHaveAttribute('title', deep);
  const cut = await path.evaluate((cell) => {
    const text = cell.querySelector('bdi')!.getBoundingClientRect();
    const own = cell.getBoundingClientRect();
    return {
      overflow: cell.scrollWidth > cell.clientWidth,
      start: text.left - own.left,
      end: own.right - text.right,
    };
  });
  expect(cut.overflow).toBe(true);
  expect(cut.start, 'the start of the path is cut').toBeLessThan(0);
  expect(Math.abs(cut.end), 'the end of the path is in view').toBeLessThanOrEqual(1);
  // Rows of a list, not cards: no outline, radius, shadow or coloured edge; one surface.
  const shapes = await page.locator('.home-row').evaluateAll((rows) =>
    rows.map((element) => {
      const style = getComputedStyle(element);
      return [style.borderRadius, style.boxShadow, style.borderLeftColor, style.borderTopWidth];
    }),
  );
  for (const shape of shapes) expect(shape).toEqual(['0px', 'none', 'rgba(0, 0, 0, 0)', '0px']);
  const backgrounds = await page.evaluate(() =>
    ['.home', '.home-list'].map(
      (selector) => getComputedStyle(document.querySelector(selector)!).backgroundColor,
    ),
  );
  expect(backgrounds[0]).toBe(backgrounds[1]);
  // The same height, letter and number columns as the Structure.
  const listed = await page
    .locator('.home-row')
    .evaluateAll((rows) => rows.map((element) => element.getBoundingClientRect().height));
  expect(new Set(listed)).toEqual(new Set([30]));
  const look = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const name = element.querySelector('.structure-open')!;
        const tracks = getComputedStyle(element).gridTemplateColumns.split(' ');
        return {
          height: element.getBoundingClientRect().height,
          font: getComputedStyle(name).fontSize,
          family: getComputedStyle(name).fontFamily,
          numbers: tracks.slice(2, 5),
        };
      });
  const home = await look('.home-row');
  await page.screenshot({ path: test.info().outputPath('home-list-dark.png') });
  // Anywhere on an open row goes to the Structure of its root.
  await row(page, paths.outro).locator('.structure-count').first().click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('outro');
  await expect(page.getByRole('region', { name: 'Estrutura de outro' })).toBeVisible();
  await expect(homeList(page)).toHaveCount(0);
  const structure = await look('.structure-row');
  expect(home).toEqual(structure);
  // A closed row opens its project, in the Structure of its root.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await row(page, paths.fechado).locator('.home-path').click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('fechado');
  expect(
    (await (await api(page))('workspace')).roots.map((root: { path: string }) => root.path),
  ).toContain(paths.fechado);
  expect(errors).toEqual([]);
});

test('Home: no saved project keeps the first-use screen; the explorer and the inspector stay out of Home and come back as they were', async ({
  page,
}) => {
  const paths = fixture();
  await only(page, []);
  await page.goto('/');
  // Without projects, the screen of today: a sentence, Adicionar diretório (primary), Nova arquitetura.
  await expect(page.locator('.welcome-content > p')).toHaveText(
    'Adicione a pasta de um agente (AGENTS.md, CLAUDE.md, skills, memória) para ver a estrutura, as referências e as observações.',
  );
  await expect(page.locator('.welcome-actions').getByRole('button')).toHaveText([
    'Adicionar diretório',
    'Nova arquitetura',
  ]);
  await expect(page.locator('.welcome-actions button.primary')).toHaveText('Adicionar diretório');
  await expect(homeList(page)).toHaveCount(0);
  // With the explorer and the inspector open in the saved layout.
  await only(page, [paths.loja, paths.outro]);
  await page.evaluate(() =>
    localStorage.setItem(
      'aae-layout',
      JSON.stringify({ explorer: true, inspector: true, bottom: false }),
    ),
  );
  await page.reload();
  await expect(homeList(page)).toBeVisible();
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(page.locator('.inspector')).toHaveCount(0);
  const shell = await box(page.locator('.main-layout'));
  const center = await box(page.locator('.home'));
  expect(center.x).toBe(shell.x);
  expect(center.width).toBe(shell.width);
  // Out by default, the explorer and the inspector come in on Home only when asked for: the button of
  // the explorer is not pressed, and Mais offers to show them.
  const toggle = page
    .locator('.app-header')
    .getByRole('button', { name: 'Explorador', exact: true });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.app-header').getByRole('button', { name: 'Mais', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Mostrar inspetor' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Mostrar explorador/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+b');
  await expect(page.locator('.explorer')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+b');
  await expect(page.locator('.explorer')).toBeHidden();
  await expect((await box(page.locator('.home'))).width).toBe(shell.width);
  // Leaving Home: both come back, as the saved layout has them.
  await row(page, paths.loja).click();
  await expect(page.locator('.explorer')).toBeVisible();
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Back on Home (the house button), they are out again, whatever was asked for there before.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(page.locator('.inspector')).toHaveCount(0);
  // And with the explorer collapsed by the user, it stays collapsed after Home.
  await row(page, paths.loja).click();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.explorer')).toBeHidden();
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(homeList(page)).toBeVisible();
  await row(page, paths.outro).click();
  await expect(page.getByRole('region', { name: 'Estrutura de outro' })).toBeVisible();
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // Ctrl+K on Home: the search lives in the explorer, which comes in over Home; a file found there
  // leaves Home on its map, as from no view.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('Buscar arquivos')).toBeFocused();
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  await expect(homeList(page)).toBeVisible();
  await page.getByLabel('Buscar arquivos').fill('guia.md');
  await page.locator('.search-results button', { hasText: 'guia.md' }).first().click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('guia.md');
  await expect(page.locator('.file-tile.focused')).toContainText('guia.md');
  await expect(homeList(page)).toHaveCount(0);
});

test('forget from Home: the dialog of the app says what goes and what stays, Cancel and Esc change nothing, the notes are the user’s choice, and the disk does not change', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = fixture();
  const call = await only(page, [paths.loja, paths.pagamentos, paths.outro]);
  // Two notes of loja, one in its nested project (inside both saved projects: neither counts it).
  const notes = {
    [join(paths.loja, 'AGENTS.md')]: 'nota da loja',
    [join(paths.loja, 'docs/guia.md')]: 'outra nota da loja',
    [join(paths.pagamentos, 'regras.md')]: 'nota de pagamentos',
  };
  for (const [node, body] of Object.entries(notes)) await call('note', { node, body });
  const before = disk(paths.base);
  await page.goto('/');
  const start = await state(call);
  // The × opens the dialog of the app, small, with Cancel in focus and short sentences.
  await forgetButton(row(page, paths.loja), 'loja').click();
  const dialog = confirmation(page, 'loja');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/modal small/);
  expect((await box(dialog)).width).toBe(420);
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await expect(dialog.locator('.confirm-body > p').first()).toHaveText(
    'O projeto sai do aplicativo. A referência de Alterações, as marcações de “esperada” e a permissão de edição deste projeto são apagadas. A pasta e os arquivos no disco não são tocados.',
  );
  // The option, unchecked, with the real number of notes; the sentence says what happens.
  const option = dialog.getByRole('checkbox', {
    name: 'Apagar também as 2 anotações deste projeto',
  });
  await expect(option).not.toBeChecked();
  const consequence = dialog.locator('.confirm-consequence > span:not([aria-hidden])');
  await expect(consequence).toHaveText(
    'As 2 anotações ficam guardadas e voltam se você adicionar loja de novo.',
  );
  await page.screenshot({ path: test.info().outputPath('forget-dialog-dark.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await state(call)).toEqual(start);
  // Cancel changes nothing; the box comes back unchecked each time.
  await forgetButton(row(page, paths.loja), 'loja').click();
  await option.check();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await state(call)).toEqual(start);
  await forgetButton(row(page, paths.loja), 'loja').click();
  await expect(option).not.toBeChecked();
  // Checking the box changes the sentence, never the height of the dialog nor the place of the buttons.
  const places = async () => [
    await box(dialog),
    await box(dialog.getByRole('button', { name: 'Cancelar' })),
    await box(dialog.getByRole('button', { name: 'Excluir projeto' })),
  ];
  const unchecked = await places();
  await option.check();
  await expect(consequence).toHaveText('As 2 anotações são apagadas agora. Não há como recuperar.');
  expect(await places()).toEqual(unchecked);
  await option.uncheck();
  // Confirming, unchecked, takes loja out of the open list and of the saved one; the notes stay.
  await dialog.getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, paths.loja)).toHaveCount(0);
  let now = await state(call);
  expect(now.roots).toEqual([paths.pagamentos, paths.outro]);
  expect(now.saved).not.toContain(paths.loja);
  expect(now.notes).toMatchObject(notes);
  // The same folder added again brings them back.
  await call('open', { path: paths.loja });
  await page.reload();
  await expect(row(page, paths.loja)).toBeVisible();
  // Checked, they are erased from the app state; the nested project's note stays (it is not loja's alone).
  await forgetButton(row(page, paths.loja), 'loja').click();
  await option.check();
  await dialog.getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(dialog).toHaveCount(0);
  now = await state(call);
  expect(now.saved).not.toContain(paths.loja);
  expect(Object.keys(now.notes).filter((key) => key.startsWith(paths.base + '/'))).toEqual([
    join(paths.pagamentos, 'regras.md'),
  ]);
  // A project without notes has no option and no sentence about them.
  await forgetButton(row(page, paths.outro), 'outro').click();
  await expect(confirmation(page, 'outro')).toBeVisible();
  await expect(confirmation(page, 'outro').getByRole('checkbox')).toHaveCount(0);
  await expect(confirmation(page, 'outro').locator('.confirm-consequence')).toHaveCount(0);
  await confirmation(page, 'outro').getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(row(page, paths.outro)).toHaveCount(0);
  expect(disk(paths.base)).toEqual(before);
  expect(errors).toEqual([]);
});

test('forget, the same dialog everywhere: Abrir projeto and its confirmation, no side-bordered box; double click and Enter on Cancel', async ({
  page,
}) => {
  const paths = fixture();
  const call = await only(page, [paths.loja], [paths.fechado]);
  await page.goto('/');
  // A double click on the × opens one dialog; Enter with the focus on Cancel forgets nothing.
  await forgetButton(row(page, paths.loja), 'loja').dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(confirmation(page, 'loja').getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await state(call)).roots).toEqual([paths.loja]);
  // In Abrir projeto, the × of a project asks in the same dialog, over the list; Esc closes only it.
  await runProjectsAction(page, 'Abrir projeto');
  const cases = page.getByRole('dialog', { name: 'Abrir projeto' });
  await expect(cases.locator('.saved-case')).toHaveCount(2);
  await forgetButton(cases, 'fechado').click();
  await expect(page.getByRole('dialog')).toHaveCount(2);
  const dialog = confirmation(page, 'fechado');
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(cases).toBeVisible();
  await forgetButton(cases, 'fechado').click();
  await dialog.getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cases.locator('.saved-case')).toHaveCount(1);
  expect((await state(call)).saved).toEqual([paths.loja]);
  // No confirmation in a box with a coloured edge remains.
  await forgetButton(cases, 'loja').click();
  const edges = await page.evaluate(
    () =>
      [...document.querySelectorAll('.modal *')].filter((element) => {
        const style = getComputedStyle(element);
        return (
          parseFloat(style.borderLeftWidth) >= 2 && style.borderLeftColor !== 'rgba(0, 0, 0, 0)'
        );
      }).length,
  );
  expect(edges).toBe(0);
  await expect(page.locator('.forget-confirm')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('views as windows: only – at the end of the header of a root view; – hides and the project stays read; a folder view keeps Fechar vista; Remover da tela stays in the tree', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = fixture();
  const call = await only(page, [paths.loja, paths.outro]);
  await page.goto('/');
  await row(page, paths.loja).click();
  const pane = (name: string) => page.locator(`.workspace-pane[data-pane-id$="/${name}"]`);
  await expect(pane('loja')).toBeVisible();
  // The project chosen on Home is alone in the grid; the other waits in the strip of views.
  await expect(pane('outro')).toHaveAttribute('data-minimized', 'true');
  await page.getByRole('button', { name: 'Restaurar vista outro', exact: true }).click();
  await expect(pane('outro')).toBeVisible();
  // One window control ends the header, –, in the shape of its icon buttons; no × on a project.
  const header = pane('loja').locator('.scope-header');
  const controls = header.locator('button, summary');
  const names = await controls.evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.trim()),
  );
  expect(names.at(-1)).toBe('Minimizar vista loja');
  expect(names.filter((name) => /^Excluir|^Fechar/.test(name ?? ''))).toEqual([]);
  await expect(forgetButton(header, 'loja')).toHaveCount(0);
  await expect(header.locator('.lucide-x')).toHaveCount(0);
  const minimize = header.getByRole('button', { name: 'Minimizar vista loja', exact: true });
  // The explorer slides in as the project opens: measured once it stopped, all in the same frame.
  await expect
    .poll(() => page.locator('.explorer').evaluate((element) => element.getAnimations().length))
    .toBe(0);
  const geometry = await header.evaluate((element) => {
    const rect = (item: Element) => item.getBoundingClientRect().toJSON() as DOMRect;
    const controls = [...element.querySelectorAll('button, summary')].filter(
      (item) => item.getBoundingClientRect().width > 0,
    );
    return {
      header: rect(element),
      arrange: rect(element.querySelector('.pane-arrange summary')!),
      minimize: rect(controls.at(-1)!),
      rights: controls.map((item) => item.getBoundingClientRect().right),
    };
  });
  const { minimize: m, header: h, arrange } = geometry;
  // Nothing of the header comes after the –, which ends it.
  expect(Math.max(...geometry.rights)).toBe(m.x + m.width);
  expect(h.x + h.width - (m.x + m.width), '– at the end of the header').toBeLessThanOrEqual(16);
  expect(Math.abs(m.width - arrange.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.height - arrange.height)).toBeLessThanOrEqual(1);
  await expect(header.locator('.pane-remove')).toHaveCount(0);
  await expect(minimize).toHaveAttribute('title', /o projeto continua aberto e lido/);
  // The – takes the view out of the grid into the strip; the project stays open and read.
  const footer = async () => ({
    roots: await page.locator('.status-roots').textContent(),
    files: await page.locator('.status-files').textContent(),
    relations: await page.locator('.status-relations').textContent(),
  });
  const read = await footer();
  const model = await call('workspace');
  await pane('outro').getByRole('button', { name: 'Minimizar vista outro', exact: true }).click();
  await expect(pane('outro')).toHaveAttribute('data-minimized', 'true');
  await expect(page.locator('.workspace-view-tab.is-minimized')).toHaveText(/outro\s*Minimizada/);
  expect(await footer()).toEqual(read);
  const after = await call('workspace');
  expect(after.roots).toEqual(model.roots);
  expect(after.edges.length).toBe(model.edges.length);
  expect(after.issues.map((issue: { id: string }) => issue.id)).toEqual(
    model.issues.map((issue: { id: string }) => issue.id),
  );
  await page.getByRole('button', { name: 'Restaurar vista outro', exact: true }).click();
  await expect(pane('outro')).toHaveAttribute('data-minimized', 'false');
  // No click on a view asks to forget its project; the projects are as they were.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await state(call)).roots).toEqual([paths.loja, paths.outro]);
  // The view of a folder that is not a root (own CLAUDE.md) keeps Fechar vista, without forgetting.
  await page
    .getByRole('region', { name: 'Estrutura de loja' })
    .locator('.structure-open', { hasText: 'pagamentos' })
    .click();
  const child = pane('pagamentos');
  await expect(child).toBeVisible();
  await expect(
    child.getByRole('button', { name: 'Fechar vista pagamentos', exact: true }),
  ).toBeVisible();
  await expect(child.getByRole('button', { name: /^Excluir o projeto/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('window-controls-dark.png') });
  // Remover da tela, in the project menu of the tree, closes the project and keeps it saved.
  await page.getByLabel('Ações do projeto outro', { exact: true }).click();
  await page.locator('.root-menu[open]').getByRole('button', { name: 'Remover da tela' }).click();
  await expect(pane('outro')).toHaveCount(0);
  const closed = await state(call);
  expect(closed.roots).toEqual([paths.loja]);
  expect(closed.saved).toContain(paths.outro);
  expect(errors).toEqual([]);
});

test('forget the last project, a parent or a nested one, with a traced path, a saved filter and Alterações that cite it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = fixture();
  const filter = {
    id: 'home-list-filter',
    name: 'Cita a loja',
    files: [join(paths.loja, 'AGENTS.md'), join(paths.outro, 'CLAUDE.md')],
    kind: 'connections',
    direction: 'both',
    conventions: false,
  };
  await page.addInitScript((saved) => {
    if (!sessionStorage.getItem('filter-set')) {
      localStorage.setItem('aae-map-filters', JSON.stringify([saved]));
      sessionStorage.setItem('filter-set', '1');
    }
  }, filter);
  const call = await only(page, [paths.loja, paths.pagamentos, paths.outro]);
  await page.goto('/');
  // The parent goes; its nested project stays open, with its row.
  await forgetButton(row(page, paths.loja), 'loja').click();
  await confirmation(page, 'loja').getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(row(page, paths.loja)).toHaveCount(0);
  await expect(row(page, paths.pagamentos)).toBeVisible();
  expect((await state(call)).roots).toEqual([paths.pagamentos, paths.outro]);
  // And the other way round: the nested one goes, the parent stays.
  await call('open', { path: paths.loja });
  await page.reload();
  await forgetButton(row(page, paths.pagamentos), 'pagamentos').click();
  await confirmation(page, 'pagamentos').getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(row(page, paths.pagamentos)).toHaveCount(0);
  await expect(row(page, paths.loja)).toBeVisible();
  await call('open', { path: paths.sem });
  await page.reload();
  expect((await state(call)).roots).toEqual([paths.outro, paths.loja, paths.sem]);
  // The saved filter that cites loja open in its box, and a path traced through loja.
  await row(page, paths.loja).click();
  await page.getByRole('button', { name: 'Filtros do mapa' }).click();
  await page
    .getByRole('dialog', { name: 'Filtros do mapa' })
    .getByRole('button', { name: 'Abrir vista', exact: true })
    .click();
  const filterPane = page.locator('[data-pane-id="filter:home-list-filter"]');
  await expect(filterPane).toBeVisible();
  await page.locator('.dock-tools').getByRole('button', { name: 'Caminho', exact: true }).click();
  await page.getByLabel('Arquivo de origem A').fill(join(paths.loja, 'AGENTS.md'));
  await page.getByLabel('Arquivo de destino B').fill(join(paths.loja, 'docs/guia.md'));
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('[data-pane-id="trace"]')).toBeVisible();
  // The path takes the grid; the view of loja comes back beside it from its tab. The project is
  // forgotten from Abrir projeto, which keeps the path and the filter box on the screen.
  await page.getByRole('button', { name: 'Restaurar vista loja', exact: true }).click();
  const cases = page.getByRole('dialog', { name: 'Abrir projeto' });
  await runProjectsAction(page, 'Abrir projeto');
  await forgetButton(cases, 'loja').click();
  await confirmation(page, 'loja').getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(confirmation(page, 'loja')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(cases).toHaveCount(0);
  // Nothing breaks: the path through loja is gone with its fields, and the filter box says its file of
  // loja is outside the open folders.
  await expect(page.locator('[data-pane-id="trace"]')).toHaveCount(0);
  await expect(page.getByLabel('Arquivo de origem A')).toHaveValue('');
  await expect(page.getByLabel('Arquivo de destino B')).toHaveValue('');
  await expect(filterPane).toContainText('Arquivo fora dos diretórios abertos:');
  await expect(filterPane).toContainText(join(paths.loja, 'AGENTS.md'));
  await expect(page.locator('[data-pane-id$="/loja"]')).toHaveCount(0);
  // With Alterações open, another project goes: the tool stays, with the projects that are left.
  await page.getByRole('button', { name: 'Fechar vista Cita a loja', exact: true }).click();
  await page
    .locator('.dock-tools')
    .getByRole('button', { name: 'Alterações', exact: true })
    .click();
  const changes = page.locator('.tool-panel.tool-changes');
  await expect(changes).toBeVisible();
  await runProjectsAction(page, 'Abrir projeto');
  await forgetButton(cases, 'sem-instrucoes').click();
  await confirmation(page, 'sem-instrucoes')
    .getByRole('button', { name: 'Excluir projeto' })
    .click();
  await expect(confirmation(page, 'sem-instrucoes')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(cases).toHaveCount(0);
  await expect(page.locator('[data-pane-id$="/sem-instrucoes"]')).toHaveCount(0);
  await expect(changes).toBeVisible();
  await expect(changes).not.toContainText('sem-instrucoes');
  await expect(changes).not.toContainText(paths.loja);
  // Forgetting the last project leads to an empty Home: the first-use screen, without errors.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await forgetButton(row(page, paths.outro), 'outro').click();
  await confirmation(page, 'outro').getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(page.locator('.welcome-actions button.primary')).toHaveText('Adicionar diretório');
  await expect(homeList(page)).toHaveCount(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('hide every view and bring them back, hide and read again, hide and forget from Home', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = fixture();
  const call = await only(page, [paths.loja, paths.outro]);
  await page.goto('/');
  await row(page, paths.loja).click();
  const pane = (name: string) => page.locator(`.workspace-pane[data-pane-id$="/${name}"]`);
  // loja chosen on Home is alone; outro comes back beside it from its tab.
  await page.getByRole('button', { name: 'Restaurar vista outro', exact: true }).click();
  // Every view hidden, then back.
  await pane('loja').getByRole('button', { name: 'Minimizar vista loja', exact: true }).click();
  await pane('outro').getByRole('button', { name: 'Minimizar vista outro', exact: true }).click();
  await expect(page.locator('.workspace-minimized-empty')).toBeVisible();
  await expect(page.locator('.status-roots')).toHaveText('2 diretórios');
  await page.getByRole('button', { name: 'Restaurar vistas', exact: true }).click();
  await expect(pane('loja')).toHaveAttribute('data-minimized', 'false');
  await expect(pane('outro')).toHaveAttribute('data-minimized', 'false');
  // Hidden and read again: it stays hidden, and its project is still read.
  await pane('outro').getByRole('button', { name: 'Minimizar vista outro', exact: true }).click();
  await page.getByRole('button', { name: 'Reler diretórios' }).click();
  await expect(page.getByRole('button', { name: 'Reler diretórios' })).toBeEnabled();
  await expect(pane('outro')).toHaveAttribute('data-minimized', 'true');
  expect((await state(call)).roots).toEqual([paths.loja, paths.outro]);
  await expect(page.locator('.status-roots')).toHaveText('2 diretórios');
  // Hidden, then forgotten from Home: its tab goes with it.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await forgetButton(row(page, paths.outro), 'outro').click();
  await confirmation(page, 'outro').getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(row(page, paths.outro)).toHaveCount(0);
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(pane('loja')).toBeVisible();
  await expect(page.locator('.workspace-view-tab', { hasText: 'outro' })).toHaveCount(0);
  await expect(pane('outro')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a note draft not saved: the dialog says it is discarded, and it is', async ({ page }) => {
  const paths = fixture();
  const call = await only(page, [paths.loja, paths.outro]);
  await call('note', { node: join(paths.loja, 'docs/guia.md'), body: 'nota salva' });
  await page.goto('/');
  await row(page, paths.loja).click();
  await page
    .getByRole('region', { name: 'Estrutura de loja' })
    .locator('.structure-open', { hasText: 'AGENTS.md' })
    .click();
  await page.getByRole('button', { name: 'Anotações' }).click();
  await page.getByLabel('Anotação do arquivo').fill('rascunho que não foi salvo');
  await expect(page.locator('.save-status')).toHaveText('Alterações não salvas');
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await forgetButton(row(page, paths.loja), 'loja').click();
  const dialog = confirmation(page, 'loja');
  await expect(dialog.locator('.confirm-body > p').last()).toHaveText(
    '1 rascunho de anotação deste projeto não foi salvo e é descartado.',
  );
  await expect(
    dialog.getByRole('checkbox', { name: 'Apagar também a 1 anotação deste projeto' }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Excluir projeto' }).click();
  await expect(row(page, paths.loja)).toHaveCount(0);
  // Added again: the saved note is back, the draft is not.
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByRole('textbox', { name: 'Caminho do diretório' }).fill(paths.loja);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  await page
    .getByRole('region', { name: 'Estrutura de loja' })
    .locator('.structure-open', { hasText: 'AGENTS.md' })
    .click();
  await page.getByRole('button', { name: 'Anotações' }).click();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('');
  await expect(page.locator('.save-status')).toHaveText('');
  expect((await call('workspace')).notes[join(paths.loja, 'docs/guia.md')]).toBe('nota salva');
});

/** A server of this test only: `--port 0`, the URL printed at start, request logs discarded. */
async function startServer(state: string) {
  const child = spawn('python3', ['server/main.py', '--port', '0', '--state-dir', state], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`O servidor não iniciou: ${output}`)), 20000);
    child.stdout!.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`O servidor terminou (${code}): ${output}`));
    });
  });
  return { child, url };
}
async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

test('after forgetting, a restart of the server does not bring the project back; the notes stay or go as chosen', async ({
  page,
}) => {
  const paths = fixture();
  const stateDir = join(paths.base, 'state');
  mkdirSync(stateDir);
  // TRANSITIONAL, as the storageState of playwright.config.ts, which only reaches the suite's server.
  await page.addInitScript(() => localStorage.setItem('aae-lang', 'pt'));
  let server = await startServer(stateDir);
  try {
    let call = await api(page, server.url);
    for (const path of [paths.loja, paths.outro]) await call('open', { path });
    await call('note', { node: join(paths.loja, 'AGENTS.md'), body: 'fica' });
    await call('note', { node: join(paths.outro, 'CLAUDE.md'), body: 'vai' });
    await page.goto(server.url);
    // loja without its notes, outro with them.
    await forgetButton(row(page, paths.loja), 'loja').click();
    await confirmation(page, 'loja').getByRole('button', { name: 'Excluir projeto' }).click();
    await expect(row(page, paths.loja)).toHaveCount(0);
    await forgetButton(row(page, paths.outro), 'outro').click();
    await confirmation(page, 'outro').getByRole('checkbox').check();
    await confirmation(page, 'outro').getByRole('button', { name: 'Excluir projeto' }).click();
    await expect(page.locator('.welcome-actions button.primary')).toBeVisible();
    await stopServer(server.child);
    server = await startServer(stateDir);
    call = await api(page, server.url);
    const restarted = await call('workspace');
    expect(restarted.roots).toEqual([]);
    expect(restarted.savedCases).toEqual([]);
    expect(restarted.notes).toEqual({ [join(paths.loja, 'AGENTS.md')]: 'fica' });
    await page.goto(server.url);
    await expect(page.locator('.welcome-actions button.primary')).toHaveText('Adicionar diretório');
    await expect(homeList(page)).toHaveCount(0);
  } finally {
    await stopServer(server.child);
  }
});

test('30 projects: the list scrolls under its header, rows keep their height and the × is never cut, in both windows and themes', async ({
  page,
}) => {
  test.setTimeout(120000);
  const base = mkdtempSync(join(tmpdir(), 'aae-home-many-'));
  const many = Array.from({ length: 30 }, (_, index) => {
    const path = join(base, `projeto-com-um-nome-longo-${String(index + 1).padStart(2, '0')}`);
    writeTree(path, { 'AGENTS.md': `# Projeto ${index + 1}\n` });
    return path;
  });
  // The first 12 open (the limit of open projects), the other 18 saved and closed.
  await only(page, many.slice(0, 12), many.slice(12));
  for (const [width, height] of [
    [1536, 960],
    [749, 396],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light']) {
      await page.goto('/');
      await page.evaluate((value) => localStorage.setItem('aae-theme', value), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const list = homeList(page);
      await expect(page.locator('.home-row')).toHaveCount(30);
      const geometry = await list.evaluate((element) => ({
        scrolls: element.scrollHeight > element.clientHeight,
        wide: element.scrollWidth - element.clientWidth,
        heights: [...element.querySelectorAll('.home-row')].map(
          (row) => row.getBoundingClientRect().height,
        ),
      }));
      expect(geometry.scrolls, `${width}×${height} ${theme}: the list scrolls`).toBe(true);
      expect(geometry.wide, 'no horizontal scroll').toBeLessThanOrEqual(0);
      expect(new Set(geometry.heights).size, 'one row height').toBe(1);
      expect(geometry.heights[0]).toBe(height <= 550 ? 24 : 30);
      for (const index of [0, 11, 12, 29]) {
        const target = page.locator('.home-row').nth(index);
        await target.scrollIntoViewIfNeeded();
        const [r, x, l] = [
          await box(target),
          await box(target.locator('.forget-button')),
          await box(list),
        ];
        expect(x.x + x.width, `× of row ${index + 1} inside its row`).toBeLessThanOrEqual(
          r.x + r.width,
        );
        expect(x.x + x.width, `× of row ${index + 1} inside the list`).toBeLessThanOrEqual(
          l.x + l.width,
        );
        expect(x.width).toBeGreaterThanOrEqual(24);
        // The header of the columns stays above the rows that scroll under it.
        const header = await box(list.locator('.structure-columns'));
        expect(header.y).toBeGreaterThanOrEqual(l.y - 1);
      }
      await page.screenshot({ path: test.info().outputPath(`home-30-${width}-${theme}.png`) });
    }
  }
});

test('the new text is English in the code, with the Portuguese of the pack', async ({ page }) => {
  const paths = fixture();
  const call = await only(page, [paths.loja], [paths.fechado]);
  await call('note', { node: join(paths.loja, 'AGENTS.md'), body: 'note' });
  await page.addInitScript(() => localStorage.setItem('aae-lang', 'en'));
  await page.goto('/');
  await expect(page.locator('.breadcrumbs')).toHaveText('Home');
  await expect(
    page.getByRole('region', { name: 'Projects' }).locator('.structure-grid'),
  ).toHaveText(/1 open project\s*folder\s*files\s*instructions\s*observations/);
  await expect(page.locator('.home-group')).toHaveText('Saved and closed · 1');
  await page.getByRole('button', { name: 'Forget project loja…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Forget loja?', exact: true });
  await expect(dialog).toContainText(
    'The project leaves the app. Its Changes baseline, its marks of “expected” and its editing permission are erased. The folder and the files on disk are not touched.',
  );
  await expect(
    dialog.getByRole('checkbox', { name: 'Also erase the 1 note of this project' }),
  ).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Forget project' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await runMenuAction(page, 'More', 'Português');
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  await expect(page.locator('.home-group')).toHaveText('Salvos e fechados · 1');
});
