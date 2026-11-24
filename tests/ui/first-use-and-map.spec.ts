import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, readable, sessionHeaders, writeTree } from './helpers';
import { menuButton, runMoreAction, runProjectsAction } from './more-menu';

// First use (no saved project) starts by choosing a folder; the map legend stays available with several
// views and in narrow maps; no button promises a "complete map" the contextual canvas does not draw;
// "Definir como A/B" is visible in the inspector without opening "Detalhes".
function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-first-use-')), 'pacote');
  const tree: Record<string, string> = {
    'AGENTS.md': '# Pacote\n[Contexto](context.md)\n[Pagamentos](servicos/pagamentos/CLAUDE.md)\n',
    'context.md': '# Contexto\n',
    'servicos/pagamentos/CLAUDE.md': '# Pagamentos\nLeia [o runbook](runbook.md).\n',
    'servicos/pagamentos/runbook.md': '# Runbook\n',
  };
  writeTree(root, tree);
  return root;
}

/** Text color against the first opaque background up the tree. */
// openOnly of helpers.ts for one root; the closing function returns the response of the API.
async function openOnly(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  return async () => page.request.post('/api/close', { headers, data: { path: root } });
}

test('first use: without saved projects the welcome starts with "Adicionar diretório"; with them, the list', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The test server keeps projects saved by other tests: the workspace answer decides what is saved.
  let saved: { path: string; name: string; available: boolean }[] = [];
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    const model = await response.json();
    model.roots = [];
    model.savedCases = saved;
    await route.fulfill({ response, json: model });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const welcome = page.locator('.welcome-actions');
  await expect(welcome.locator('button.primary')).toHaveText('Adicionar diretório');
  // First use: one sentence says what to add, no headline.
  await expect(page.locator('.welcome-content > p')).toHaveText(
    'Adicione a pasta de um agente (AGENTS.md, CLAUDE.md, skills, memória) para ver a estrutura, as referências e as observações.',
  );
  await expect(welcome.getByRole('button', { name: /Abrir projeto/ })).toHaveCount(0);
  await expect(welcome.getByRole('button', { name: 'Nova arquitetura' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('welcome-first-use-dark.png') });
  await welcome.locator('button.primary').click();
  await expect(page.getByRole('dialog', { name: 'Adicionar diretório' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('A pasta fica salva como projeto');
  await page.keyboard.press('Escape');
  // With nothing saved, "Abrir projeto" in the Projetos menu is disabled (an empty list would open)
  // and says why; choosing it does nothing; Ctrl+O still opens the list, which points to "Adicionar
  // diretório".
  await menuButton(page, 'Projetos').click();
  const projectsMenu = page.getByRole('menu', { name: 'Projetos' });
  const openItem = projectsMenu.getByRole('menuitem', { name: /Abrir projeto/ });
  await expect(openItem).toHaveAttribute('aria-disabled', 'true');
  await expect(openItem).toHaveAttribute('title', /Nenhum projeto salvo ainda/);
  await expect(openItem).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(projectsMenu).toHaveCount(0);
  await page.keyboard.press('Control+o');
  const projects = page.getByRole('dialog', { name: 'Abrir projeto' });
  await expect(projects.locator('.empty-small')).toHaveText('Nenhum projeto salvo.');
  await expect(projects.getByRole('button', { name: 'Trocar', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  saved = [{ path: '/tmp/aae-projeto-salvo', name: 'projeto-salvo', available: true }];
  await runMoreAction(page, 'Ativar tema claro');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // With saved projects the list is the content: each row opens its project, so the actions above it
  // only add a folder or create one, none of them filled, and "Abrir projeto" is not repeated.
  await expect(welcome.getByRole('button')).toHaveText(['Adicionar diretório', 'Nova arquitetura']);
  await expect(welcome.locator('button.primary')).toHaveCount(0);
  // The list of Home: the row of a saved project opens it by its name, and its × forgets it (after asking).
  const savedList = page.getByRole('region', { name: 'Projetos' });
  await expect(savedList.getByRole('button', { name: 'Abrir projeto projeto-salvo' })).toHaveText(
    'projeto-salvo',
  );
  // The × is an icon: what a screen reader hears says what it does, and to which project.
  const forget = savedList
    .locator('.home-row[data-project="/tmp/aae-projeto-salvo"]')
    .locator('.forget-button');
  await expect(forget).toBeVisible();
  await expect(forget).toHaveAccessibleName('Excluir o projeto projeto-salvo do aplicativo…');
  await expect(savedList).not.toContainText('Abrir lê o diretório');
  await page.screenshot({ path: test.info().outputPath('welcome-saved-light.png') });
  await runProjectsAction(page, 'Abrir projeto');
  await expect(page.getByRole('dialog', { name: 'Abrir projeto' })).toContainText('projeto-salvo');
  await page.keyboard.press('Escape');
  await runMoreAction(page, 'Ativar tema escuro');
  expect(errors).toEqual([]);
});

test('map: the legend opens in every view, also with several views and in a narrow map; no "Ver mapa completo"; A/B visible in the inspector', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 260 }),
      );
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const close = await openOnly(page, root);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // A file inside a folder with its own CLAUDE.md: two views side by side.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('runbook');
  await page.locator('.search-results button').first().click();
  const panes = page.locator('.scope-pane.parallel');
  await expect(panes).toHaveCount(2);
  // The ancestor view opens on its folder structure; its Mapa has the legend too.
  await expect(panes.first().locator('.structure-view')).toBeVisible();
  await panes.first().getByRole('button', { name: 'Mapa de pacote', exact: true }).click();
  for (const pane of await panes.all()) {
    const summary = pane.locator('.canvas-legend summary');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAccessibleName('Legenda do mapa');
    // Only the icon until opened: the closed legend does not cover the map.
    await expect(pane.locator('.canvas-legend-label')).toBeHidden();
    await expect(pane.getByRole('button', { name: 'Enquadrar mapa' })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Ver mapa completo' })).toHaveCount(0);
  const legend = panes.nth(1).locator('.canvas-legend');
  await legend.locator('summary').click();
  await expect(legend.locator(':scope > div')).toBeVisible();
  // Memory and skill have their own entries and colors.
  await expect(legend.locator(':scope > div > span')).toContainText([
    'Instruções',
    'Memória',
    'Skill',
    'Manifesto',
    'Direção da referência',
  ]);
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(
      await readable(legend.locator(':scope > div > span').first()),
      `legend (${theme})`,
    ).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`legend-two-views-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  await legend.locator('summary').click();
  await expect(legend.locator(':scope > div')).toBeHidden();

  // "Definir como A/B" without opening "Detalhes".
  await expect(page.locator('.inspector h2')).toHaveText('runbook.md');
  await expect(page.locator('.file-details')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Definir como A', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Definir como B', exact: true }).click();
  await expect(page.getByLabel('Arquivo de destino B')).toHaveValue(
    'pacote/servicos/pagamentos/runbook.md',
  );

  // One wide view: the legend shows its word; a narrow window keeps the icon.
  await page.getByRole('button', { name: 'Recolher painel inferior' }).click();
  // A child folder view closes by "Fechar vista".
  await page.getByRole('button', { name: 'Fechar vista pagamentos', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  await expect(page.locator('.canvas-legend-label')).toBeVisible();
  await page.setViewportSize({ width: 749, height: 396 });
  await expect(page.locator('.canvas-legend summary')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('legend-compact-dark.png') });
  expect(errors).toEqual([]);
  await close();
});
