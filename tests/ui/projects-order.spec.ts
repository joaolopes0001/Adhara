import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, readable, sessionHeaders, showMap, writeTree } from './helpers';
import { runMoreAction, runProjectsAction } from './more-menu';

// "Remover da tela" closes a project and keeps it saved, with its annotations and its Alterações
// reference; the order of the opened projects is chosen by dragging a handle or by the keyboard,
// persists and is followed by the tree, the root views and the Auditoria; "Esquecer" asks first
// and erases the reference, also from the welcome screen; a small map says when part of it lies
// outside the view.

const files: Record<string, string> = {
  'alfa/AGENTS.md': '# Alfa\n[Notas](notas.md)\n[Falta](falta-alfa.md)\n',
  'alfa/notas.md': '# Notas\n',
  'beta/AGENTS.md': '# Beta\n[Serviço](servico/CLAUDE.md)\n[Falta](falta-beta.md)\n',
  'beta/servico/CLAUDE.md': '# Serviço\n[Runbook](runbook.md)\n',
  'beta/servico/runbook.md': '# Runbook\n',
  'gama/AGENTS.md': '# Gama\n[Falta](falta-gama.md)\n',
};
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-projects-'));
  writeTree(base, files);
  return { base, alfa: join(base, 'alfa'), beta: join(base, 'beta'), gama: join(base, 'gama') };
}
function unchanged(base: string) {
  for (const [name, text] of Object.entries(files))
    expect(readFileSync(join(base, name), 'utf8')).toBe(text);
}

async function api(page: Page) {
  const headers = await sessionHeaders(page);
  return async (operation: string, data?: object) => {
    const response = data
      ? await page.request.post(`/api/${operation}`, { headers, data })
      : await page.request.get(`/api/${operation}`, { headers });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
}
/** Only these projects open, in this order (other tests leave theirs saved). */
// Unlike openOnly of helpers.ts: through `api`, without checking the status, and returns `call`.
async function openOnly(page: Page, paths: string[]) {
  const call = await api(page);
  for (const root of (await call('workspace')).roots) await call('close', { path: root.path });
  for (const path of paths) await call('open', { path });
  return call;
}
const treeOrder = (page: Page) => page.locator('.root-overview strong');
const tabOrder = (page: Page) => page.locator('.workspace-view-tab > span');
/** Visible grid panes in their visual order (CSS order). */
const gridOrder = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.workspace-pane[data-minimized="false"]')]
      .sort((a, b) => Number(a.style.order) - Number(b.style.order))
      .map((element) => element.dataset.paneId!.split('/').at(-1)),
  );
async function dragTo(page: Page, handle: Locator, target: Locator, dy: number, drop = true) {
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y + dy, { steps: 12 });
  if (drop) await page.mouse.up();
}
/** Text color against the first opaque background up the tree. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: false, bottom: false }));
  });
});

test('projects: "Remover da tela" closes the project from the tree or its menu and keeps it saved with annotations and the Alterações reference', async ({
  page,
}) => {
  const { base, alfa, beta, gama } = fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = await openOnly(page, [alfa, beta, gama]);
  await call('note', { node: join(alfa, 'AGENTS.md'), body: 'Nota que fica' });
  // A reference chosen by the user (origin "user"): removing from the screen must not touch it.
  const adopted = (await call('reference', {})).delta.roots.find(
    (root: { path: string }) => root.path === alfa,
  );
  expect(adopted.referenceOrigin).toBe('user');
  await page.goto('/');
  // Home lists the projects, without the tree: the tree is in a project.
  await enterProject(page, 'alfa');
  await expect(treeOrder(page)).toHaveText(['alfa', 'beta', 'gama']);
  await expect(page.locator('.status-bar')).toContainText('3 diretórios');

  // With two views, the view of an opened root ends in Minimizar, with no ×: never "Fechar vista" nor
  // Excluir (on Home and in Abrir projeto), and "Remover da tela" lives in the tree. Going to beta from
  // the tree brings its view beside alfa's, which Home showed alone.
  await page.getByRole('button', { name: 'Voltar ao diretório beta', exact: true }).click();
  const betaPane = page.locator(`[data-pane-id="scope:${beta}"]`);
  await expect(betaPane.getByRole('button', { name: 'Minimizar vista beta' })).toBeVisible();
  await expect(betaPane.getByRole('button', { name: /^Fechar/ })).toHaveCount(0);
  await expect(betaPane.getByRole('button', { name: /da tela$/ })).toHaveCount(0);
  await expect(
    betaPane.getByRole('button', { name: 'Excluir o projeto beta do aplicativo…', exact: true }),
  ).toHaveCount(0);
  const removeView = page.getByRole('button', { name: 'Remover beta da tela', exact: true });
  await expect(removeView).toHaveAttribute('title', /fecha o projeto.*continua salvo/);
  await expect(removeView).toHaveAttribute(
    'title',
    /continua salvo, com anotações e a referência de Alterações/,
  );
  await page.screenshot({ path: test.info().outputPath('projects-root-view-dark.png') });
  await removeView.click();
  // Out of the tree, the views, the Auditoria and the counter; a notice says it stays saved.
  await expect(treeOrder(page)).toHaveText(['alfa', 'gama']);
  await expect(page.locator('.status-bar')).toContainText('2 diretórios');
  await expect(page.locator(`[data-pane-id="scope:${beta}"]`)).toHaveCount(0);
  await expect(page.locator('.removed-notice')).toContainText('beta saiu da tela');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await expect(page.locator('.audit-project strong')).toHaveText(['alfa', 'gama']);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await runProjectsAction(page, 'Abrir projeto');
  await expect(page.locator('.saved-case', { hasText: beta })).toContainText('Salvo · fechado');
  await page.getByRole('button', { name: 'Fechar diálogo', exact: true }).click();

  // The visible action of each project in the tree, with the same explanation.
  const removeAlfa = page.getByRole('button', { name: 'Remover alfa da tela', exact: true });
  await expect(removeAlfa).toBeVisible();
  await expect(removeAlfa).toHaveAttribute('title', /continua salvo, com anotações e a referência/);
  await removeAlfa.click();
  await expect(treeOrder(page)).toHaveText(['gama']);
  // ... and in the project menu, in words.
  await page.getByLabel('Ações do projeto gama', { exact: true }).click();
  await page
    .locator('.root-menu')
    .getByRole('button', { name: 'Remover da tela', exact: true })
    .click();

  // With nothing open, Home lists the saved projects to reopen or forget.
  const welcome = page.getByRole('region', { name: 'Projetos' });
  await expect(welcome).toBeVisible();
  // Found by path: other tests may leave projects with the same names saved.
  const row = (path: string) => welcome.locator(`.home-row[data-project="${path}"]`);
  for (const [name, path] of [
    ['alfa', alfa],
    ['beta', beta],
    ['gama', gama],
  ]) {
    await expect(row(path).getByRole('button', { name: `Abrir projeto ${name}` })).toBeVisible();
    await expect(
      row(path).getByRole('button', { name: `Excluir o projeto ${name} do aplicativo…` }),
    ).toBeVisible();
  }
  await page.screenshot({ path: test.info().outputPath('projects-welcome-dark.png') });
  await row(alfa).getByRole('button', { name: 'Abrir projeto alfa', exact: true }).click();
  await expect(treeOrder(page)).toHaveText(['alfa']);
  // Reopened as it was: the annotation and the reference chosen before are still there.
  const reopened = await call('workspace');
  expect(reopened.notes[join(alfa, 'AGENTS.md')]).toBe('Nota que fica');
  const reference = reopened.delta.roots.find((root: { path: string }) => root.path === alfa);
  expect(reference.referenceOrigin).toBe('user');
  expect(reference.referenceAt).toBe(adopted.referenceAt);
  expect(reopened.savedCases.map((item: { path: string }) => item.path)).toEqual(
    expect.arrayContaining([alfa, beta, gama]),
  );
  unchanged(base);
  expect(errors).toEqual([]);
});

test('projects: removing one project from the screen keeps the views of the other open, as they were', async ({
  page,
}) => {
  const { alfa, beta } = fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openOnly(page, [alfa, beta]);
  await page.goto('/');
  // From Home into beta, where the tree is: a view of each project, both in the Structure.
  await enterProject(page, 'beta');
  const tree = page.locator('.explorer');
  // A view of each project: beta with its AGENTS.md on the map, zoomed in by hand; then alfa, current.
  await tree.getByTitle(join(beta, 'AGENTS.md'), { exact: true }).click();
  const betaPane = page.locator(`[data-pane-id="scope:${beta}"]`);
  await betaPane.getByRole('button', { name: 'Mapa de beta', exact: true }).click();
  const transform = () =>
    betaPane.locator('.react-flow__viewport').evaluate((element) => element.style.transform);
  await betaPane.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
  let zoomed = '';
  await expect
    .poll(
      async () => {
        const now = await transform();
        const settled = now === zoomed;
        zoomed = now;
        return settled;
      },
      { intervals: [300] },
    )
    .toBe(true);
  await tree.getByTitle(join(alfa, 'AGENTS.md'), { exact: true }).click();
  const alfaPane = page.locator(`[data-pane-id="scope:${alfa}"]`);
  await expect(alfaPane).toBeVisible();
  await expect(betaPane).toBeVisible();

  // "Remover da tela" lives in the tree; forgetting is on Home and in Abrir projeto (no × on the view).
  await page.getByRole('button', { name: 'Remover alfa da tela', exact: true }).click();
  await expect(treeOrder(page)).toHaveText(['beta']);
  await expect(alfaPane).toHaveCount(0);
  // The view of beta stays in the grid, not replaced by the overview, with the zoom chosen by hand.
  await expect(betaPane).toBeVisible();
  await expect(page.locator('[data-pane-id="overview"]')).toHaveCount(0);
  await expect(betaPane.locator('.react-flow__node-file', { hasText: 'AGENTS.md' })).toBeVisible();
  expect(await transform()).toBe(zoomed);
  // No repeated history entry: the first "Voltar seleção" goes back to what came before beta's file,
  // the root of beta, as it came from Home.
  await page.getByRole('button', { name: 'Voltar seleção', exact: true }).click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('beta');
  await expect(betaPane.getByRole('region', { name: 'Estrutura de beta' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('projects: after removing two projects, every "Voltar" and "Avançar" changes the selection', async ({
  page,
}) => {
  const base = mkdtempSync(join(tmpdir(), 'aae-projects-history-'));
  const roots = Object.fromEntries(
    ['alfa', 'beta', 'gama'].map((name) => {
      const root = join(base, name);
      mkdirSync(root);
      writeFileSync(join(root, 'AGENTS.md'), `# ${name}\n[Y](y.md)\n`);
      writeFileSync(join(root, 'y.md'), '# Y\n');
      return [name, root];
    }),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openOnly(page, [roots.alfa, roots.beta, roots.gama]);
  await page.goto('/');
  await enterProject(page);
  const explorer = page.locator('.explorer');
  for (const [name, file] of [
    ['gama', 'y.md'],
    ['beta', 'AGENTS.md'],
    ['beta', 'y.md'],
    ['alfa', 'AGENTS.md'],
    ['alfa', 'y.md'],
  ])
    await explorer.getByTitle(join(roots[name], file), { exact: true }).click();
  for (const name of ['alfa', 'beta']) {
    await explorer.getByRole('button', { name: `Remover ${name} da tela`, exact: true }).click();
    await expect(explorer.locator('.root-section', { hasText: name })).toHaveCount(0);
  }
  // What is selected (in the tree) or "-" for Home, after each step.
  const selection = () =>
    explorer
      .locator('[aria-current="true"]')
      .evaluateAll((items) => items[0]?.getAttribute('title') ?? '-');
  const walk = async (label: 'Voltar seleção' | 'Avançar seleção') => {
    const button = page.getByRole('button', { name: label, exact: true });
    const seen = [await selection()];
    while (await button.isEnabled()) {
      await button.click();
      await expect.poll(selection).not.toBe(seen.at(-1));
      seen.push(await selection());
    }
    return seen;
  };
  const back = await walk('Voltar seleção');
  expect(back.length).toBeGreaterThan(1);
  const forward = await walk('Avançar seleção');
  expect(forward).toEqual([...back].reverse());
  expect(errors).toEqual([]);
});

test('projects: a selected file deleted on disk gives way to its folder after "Reler", never to a file of another project', async ({
  page,
}) => {
  const base = mkdtempSync(join(tmpdir(), 'aae-projects-deleted-'));
  const alfa = join(base, 'alfa'),
    beta = join(base, 'beta');
  const tree: Record<string, string> = {
    'alfa/AGENTS.md': '# Alfa\n[X](docs/x.md)\n',
    'alfa/docs/x.md': '# X\n',
    'alfa/docs/outro.md': '# Outro\n',
    'beta/AGENTS.md': '# Beta\n[Y](y.md)\n',
    'beta/y.md': '# Y\n',
  };
  writeTree(base, tree);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openOnly(page, [alfa, beta]);
  await page.goto('/');
  await enterProject(page);
  const explorer = page.locator('.explorer');
  await explorer.getByTitle(join(beta, 'y.md'), { exact: true }).click();
  await explorer.getByRole('button', { name: 'Expandir pasta docs' }).click();
  await explorer.getByTitle(join(alfa, 'docs/x.md'), { exact: true }).click();
  const alfaPane = page.locator(`[data-pane-id="scope:${alfa}"]`),
    betaPane = page.locator(`[data-pane-id="scope:${beta}"]`);
  await expect(alfaPane).toBeVisible();
  await expect(betaPane).toBeVisible();

  // Deleted, and no longer cited (a cited file would stay as a missing destination).
  rmSync(join(alfa, 'docs/x.md'));
  writeFileSync(join(alfa, 'AGENTS.md'), '# Alfa\n');
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  // The view of alfa shows the folder of the deleted file; beta keeps its view and is not selected.
  await expect(alfaPane.getByRole('region', { name: 'Estrutura de docs' })).toBeVisible();
  await expect(betaPane).toBeVisible();
  await expect(page.locator('.inspector h2')).not.toHaveText('y.md');
  await expect(explorer.locator('[aria-current="true"]')).toHaveAttribute(
    'title',
    join(alfa, 'docs'),
  );
  expect(errors).toEqual([]);
});

test('projects: dragging the handle or the keyboard reorders the projects; tree, root views and Auditoria follow and the order persists', async ({
  page,
}) => {
  const { base, alfa, beta, gama } = fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = await openOnly(page, [alfa, beta, gama]);
  await page.goto('/');
  // Home lists the projects, without the tree: into the first one.
  await enterProject(page);
  for (const name of ['alfa', 'beta', 'gama'])
    await page.getByRole('button', { name: `Voltar ao diretório ${name}`, exact: true }).click();
  // A child folder view (beta/servico, with its own CLAUDE.md) stays next to its project.
  await page.getByRole('button', { name: 'Expandir pasta servico', exact: true }).click();
  await page.locator('.tree-item', { hasText: /^runbook\.md$/ }).click();
  await expect(tabOrder(page)).toHaveText(['alfa', 'beta', 'servico', 'gama']);
  await expect.poll(() => gridOrder(page)).toEqual(['alfa', 'beta', 'servico', 'gama']);

  // Drag gama by its handle above alfa; while dragging, a line and a hint show where it lands.
  const handle = (name: string) =>
    page.getByRole('button', { name: new RegExp(`^Reordenar ${name} `) });
  const header = (path: string) => page.locator(`[data-root-header="${path}"]`);
  await expect(handle('gama')).toHaveAttribute('title', 'Arraste para mudar a ordem (ou ↑ e ↓)');
  await dragTo(page, handle('gama'), header(alfa), 3, false);
  await expect(page.locator('.project-drop-line')).toHaveCount(1);
  await expect(page.locator('.project-drag-hint')).toHaveText(
    'Solte para colocar gama na posição 1 de 3 · Esc cancela',
  );
  await expect(page.locator('.root-section.is-dragged')).toContainText('gama');
  await page.screenshot({ path: test.info().outputPath('projects-dragging-dark.png') });
  await page.mouse.up();
  await expect(treeOrder(page)).toHaveText(['gama', 'alfa', 'beta']);
  await expect(page.locator('.project-drop-line')).toHaveCount(0);
  // The root views follow the order of the projects; the child view stays with beta.
  await expect(tabOrder(page)).toHaveText(['gama', 'alfa', 'beta', 'servico']);
  await expect.poll(() => gridOrder(page)).toEqual(['gama', 'alfa', 'beta', 'servico']);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await expect(page.locator('.audit-project strong')).toHaveText(['gama', 'alfa', 'beta']);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  expect((await call('workspace')).roots.map((root: { name: string }) => root.name)).toEqual([
    'gama',
    'alfa',
    'beta',
  ]);

  // Esc cancels a drag: nothing moves.
  await dragTo(page, handle('alfa'), header(gama), 3, false);
  await expect(page.locator('.project-drag-hint')).toContainText('Solte para colocar alfa');
  await page.keyboard.press('Escape');
  await expect(page.locator('.project-drag-hint')).toHaveCount(0);
  await page.mouse.up();
  await expect(treeOrder(page)).toHaveText(['gama', 'alfa', 'beta']);

  // Keyboard: ↑ on the focused handle; reordering reads the disk again, so a change made outside shows.
  writeFileSync(join(beta, 'novo.md'), '# Novo\n');
  // A mouse click on the handle (not only Tab) must focus it, so the arrows work right after it.
  await handle('beta').click();
  await expect(handle('beta')).toBeFocused();
  await expect(treeOrder(page)).toHaveText(['gama', 'alfa', 'beta']);
  await page.keyboard.press('ArrowUp');
  await expect(treeOrder(page)).toHaveText(['gama', 'beta', 'alfa']);
  await expect(handle('beta')).toBeFocused();
  await expect(page.locator('.project-list [role="status"]')).toHaveText(
    'beta agora é o 2º de 3 projetos.',
  );
  await expect(page.locator('.change-notice').first()).toContainText('1 arquivo adicionado');
  // The project menu offers the same moves, in words, disabled at the ends.
  await page.getByLabel('Ações do projeto gama', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Mover gama para cima', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Mover gama para baixo', exact: true }).click();
  await expect(treeOrder(page)).toHaveText(['beta', 'gama', 'alfa']);
  await expect(tabOrder(page)).toHaveText(['beta', 'servico', 'gama', 'alfa']);

  // The order persists: a new page (on Home, the list in that order; then the tree) and the server state
  // keep it.
  await page.reload();
  await expect(page.locator('.home-row.is-folder .structure-open > span')).toHaveText([
    'beta',
    'gama',
    'alfa',
  ]);
  await enterProject(page);
  await expect(treeOrder(page)).toHaveText(['beta', 'gama', 'alfa']);
  expect((await call('workspace')).roots.map((root: { name: string }) => root.name)).toEqual([
    'beta',
    'gama',
    'alfa',
  ]);
  for (const theme of ['claro', 'escuro']) {
    await runMoreAction(page, `Ativar tema ${theme}`);
    for (const selector of ['.root-overview strong', '.root-menu summary', '.root-remove'])
      expect(await readable(page.locator(selector).first()), selector).toBeGreaterThanOrEqual(3);
  }
  unchanged(base);
  expect(errors).toEqual([]);
});

test('projects: a new order refused by the server brings the previous order back, with the message next to the list', async ({
  page,
}) => {
  const { alfa, beta, gama } = fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openOnly(page, [alfa, beta, gama]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/reorder', async (route) => {
    await held;
    await route.fulfill({ status: 400, json: { error: 'Ordem recusada no teste.' } });
  });
  await page.goto('/');
  // Home lists the projects, without the tree: into the first one.
  await enterProject(page);
  await page.getByRole('button', { name: /^Reordenar alfa / }).focus();
  await page.keyboard.press('ArrowDown');
  // Shown right away while the server answers...
  await expect(treeOrder(page)).toHaveText(['beta', 'alfa', 'gama']);
  release();
  // ... and back to the previous order when it refuses, with the message by the list, not in the banner.
  await expect(treeOrder(page)).toHaveText(['alfa', 'beta', 'gama']);
  const message = page.locator('.explorer .project-order-error');
  await expect(message).toHaveAttribute('role', 'alert');
  await expect(message).toContainText('Ordem recusada no teste.');
  await expect(message).toContainText('A ordem anterior foi mantida.');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  for (const theme of ['claro', 'escuro']) {
    await runMoreAction(page, `Ativar tema ${theme}`);
    expect(await readable(message.locator('span'))).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`projects-order-error-${theme}.png`) });
  }
  await page.getByRole('button', { name: 'Dispensar erro da ordem dos projetos' }).click();
  await expect(message).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('projects: "Excluir" asks first, in the dialog of the app, from Home and from the projects dialog, and erases the Alterações reference', async ({
  page,
}) => {
  const { base, alfa, beta } = fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const call = await openOnly(page, [alfa, beta]);
  await call('note', { node: join(alfa, 'AGENTS.md'), body: 'Nota preservada' });
  await call('reference', {});
  await call('close', { path: alfa });
  await call('close', { path: beta });
  await page.goto('/');
  // The list of Home: alfa and beta are saved and closed.
  const home = page.getByRole('region', { name: 'Projetos' });
  const row = home.locator(`.home-row[data-project="${alfa}"]`);
  const forgetAlfa = row.getByRole('button', {
    name: 'Excluir o projeto alfa do aplicativo…',
    exact: true,
  });
  await forgetAlfa.click();
  const confirm = page.getByRole('dialog', { name: 'Excluir alfa do aplicativo?', exact: true });
  await expect(confirm).toContainText('A referência de Alterações');
  await expect(confirm).toContainText('são apagadas');
  await expect(confirm).toContainText('A pasta e os arquivos no disco não são tocados.');
  await expect(confirm).toContainText(
    'A 1 anotação fica guardada e volta se você adicionar alfa de novo.',
  );
  await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  for (const theme of ['claro', 'escuro']) {
    // The menu of the top bar is behind the dialog: the theme changes by its saved preference.
    await page.evaluate(
      (value) => localStorage.setItem('aae-theme', value),
      theme === 'claro' ? 'light' : 'dark',
    );
    await page.reload();
    await forgetAlfa.click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      theme === 'claro' ? 'light' : 'dark',
    );
    expect(await readable(confirm.locator('.confirm-body > p').first())).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      await readable(confirm.getByRole('button', { name: 'Excluir projeto', exact: true })),
    ).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`projects-forget-${theme}.png`) });
  }
  // Escape (or Cancelar) keeps the project, and the focus goes back to its ×.
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(forgetAlfa).toBeFocused();
  await forgetAlfa.click();
  await confirm.getByRole('button', { name: 'Excluir projeto', exact: true }).click();
  await expect(row).toHaveCount(0);
  let state = await call('workspace');
  expect(state.savedCases.map((item: { path: string }) => item.path)).not.toContain(alfa);
  expect(state.notes[join(alfa, 'AGENTS.md')]).toBe('Nota preservada');

  // The projects dialog asks in the same dialog, over it; Escape closes only the confirmation.
  await runProjectsAction(page, 'Abrir projeto');
  const dialog = page.getByRole('dialog', { name: 'Abrir projeto' });
  // Other tests leave projects named "beta" saved: this one is found by its path.
  const saved = dialog.locator('.saved-case', { hasText: beta });
  const confirmBeta = page.getByRole('dialog', {
    name: 'Excluir beta do aplicativo?',
    exact: true,
  });
  await saved
    .getByRole('button', { name: 'Excluir o projeto beta do aplicativo…', exact: true })
    .click();
  await expect(confirmBeta).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(confirmBeta).toHaveCount(0);
  await saved
    .getByRole('button', { name: 'Excluir o projeto beta do aplicativo…', exact: true })
    .click();
  await confirmBeta.getByRole('button', { name: 'Excluir projeto', exact: true }).click();
  await expect(saved).toHaveCount(0);
  await page.getByRole('button', { name: 'Fechar diálogo', exact: true }).click();

  // Reopened, the forgotten project starts a new reference (the one chosen before is gone).
  state = await call('open', { path: alfa });
  expect(
    state.delta.roots.find((root: { path: string }) => root.path === alfa).referenceOrigin,
  ).toBe('first-reading');
  await call('close', { path: alfa });
  unchanged(base);
  expect(errors).toEqual([]);
});

test('map: a small view says when part of the map lies outside it, and "Enquadrar" shows the whole map', async ({
  page,
}) => {
  const base = mkdtempSync(join(tmpdir(), 'aae-offscreen-'));
  const names = Array.from({ length: 10 }, (_, index) => `nota-${index + 1}.md`);
  writeFileSync(
    join(base, 'AGENTS.md'),
    `# Hub\n${names.map((name) => `[${name}](${name})`).join('\n')}\n`,
  );
  for (const name of names) writeFileSync(join(base, name), `# ${name}\n`);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openOnly(page, [base]);
  await page.goto('/');
  // From Home, the list of projects, by the row of the project.
  await enterProject(page);
  // AGENTS.md chosen in the structure (which stays), its map shown by the switch.
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await showMap(page);
  const pane = page.locator('.scope-pane');
  await expect(pane.locator('.react-flow__node-file')).toHaveCount(11);
  // A wide view frames every column; this map is taller than the view, so it says so.
  await page.setViewportSize({ width: 749, height: 396 });
  // Said in the header line of the map: "Enquadrar" as a link, described by the warning.
  const hint = pane.locator('.map-head .canvas-offscreen');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveAccessibleName('Enquadrar mapa');
  await expect(hint).toHaveAccessibleDescription('Parte do mapa fora da vista');
  await page.screenshot({ path: test.info().outputPath('map-offscreen-hint.png') });
  await hint.click();
  await expect(hint).toHaveCount(0);
  const allInside = () =>
    pane.evaluate((element) => {
      const canvas = element.querySelector('.react-flow')!.getBoundingClientRect();
      return [...element.querySelectorAll('.react-flow__node-file')].every((tile) => {
        const box = tile.getBoundingClientRect();
        return (
          box.top >= canvas.top - 1 &&
          box.bottom <= canvas.bottom + 1 &&
          box.left >= canvas.left - 1 &&
          box.right <= canvas.right + 1
        );
      });
    });
  await expect.poll(allInside).toBe(true);
  // A map that fits says nothing.
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.locator('.tree-item', { hasText: /^nota-1\.md$/ }).click();
  await expect(pane.locator('.file-tile.focused')).toContainText('nota-1.md');
  await expect.poll(allInside).toBe(true);
  await expect(pane.locator('.canvas-offscreen')).toHaveCount(0);
  expect(errors).toEqual([]);
});
