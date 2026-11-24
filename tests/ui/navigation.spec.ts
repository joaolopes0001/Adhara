import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runMoreAction, runProjectsAction } from './more-menu';
import { enterProject, sessionHeaders, showMap } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('navigation, adjustable panels, drafts, themes and compact workspace', async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), 'aae-navigation-'));
  mkdirSync(join(folder, 'memory'));
  writeFileSync(join(folder, 'AGENTS.md'), '# Entry\n[Context](memory/context.md)\n');
  writeFileSync(join(folder, 'memory/context.md'), '# Context\n');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const root of previous.roots)
    await page.request.post('/api/close', { headers, data: { path: root.path } });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await runProjectsAction(page, 'Adicionar diretório');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Caminho do diretório').fill(folder);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  // Opening selects the folder, not a file; AGENTS.md is chosen in its structure,
  // which adds the folder as one more step of the history.
  await expect(page.locator('.inspector h2')).toHaveText(basename(folder));
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(page.locator('.inspector h2')).toHaveText(basename(folder));
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  await page.getByRole('button', { name: 'Avançar seleção' }).click();
  await page.getByRole('button', { name: 'Avançar seleção' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await page.getByRole('button', { name: 'Anotações', exact: true }).click();
  await page.getByLabel('Anotação do arquivo').fill('Rascunho preservado');
  await page.locator('.breadcrumb-root').click();
  await expect(page.locator('.directory-overview')).toContainText('memory');
  await page.locator('.directory-child').filter({ hasText: 'memory' }).click();
  await expect(page.locator('.directory-overview h2')).toHaveText('memory');
  await page.getByRole('button', { name: 'Diretório pai', exact: true }).click();
  await page.locator('.directory-child').filter({ hasText: 'AGENTS.md' }).click();
  await page.getByRole('button', { name: 'Anotações', exact: true }).click();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('Rascunho preservado');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');

  await page.getByRole('button', { name: 'Arquivo', exact: true }).click();
  await expect(page.locator('.source-code')).toContainText('# Entry');
  // Home is the list of projects: no file text, and neither the inspector nor the explorer.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(page.locator('.source-code')).toHaveCount(0);
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Projetos' })).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  // Back to the file, where the explorer and the inspector are; settled once the explorer has slid in
  // from the left edge (180 ms).
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await expect.poll(async () => (await page.locator('.explorer').boundingBox())?.x).toBe(0);

  const separator = page.getByRole('separator', { name: 'Largura do explorador' });
  const before = (await page.locator('.explorer').boundingBox())!.width;
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(handle.x - 45, handle.y + 80, { steps: 5 });
  await page.mouse.up();
  const smaller = (await page.locator('.explorer').boundingBox())!.width;
  expect(smaller).toBeLessThan(before - 30);
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  const resized = (await page.locator('.explorer').boundingBox())!.width;
  expect(resized).toBe(smaller + 20);
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  const bottom = page.getByRole('separator', { name: 'Altura do painel inferior' });
  // Without a saved size the tool panel opens at 420 px, up to 800.
  await expect(bottom).toHaveAttribute('aria-valuenow', '420');
  await expect(bottom).toHaveAttribute('aria-valuemax', '800');
  await bottom.focus();
  await page.keyboard.press('ArrowUp');
  await expect(bottom).toHaveAttribute('aria-valuenow', '440');
  const inspector = page.getByRole('separator', { name: 'Largura do inspetor' });
  await inspector.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(inspector).toHaveAttribute('aria-valuenow', '400');
  await runMoreAction(page, 'Recolher explorador');
  await expect(page.locator('.explorer')).toBeHidden();
  await runMoreAction(page, 'Recolher inspetor');
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('Buscar arquivos')).toBeFocused();
  expect((await page.locator('.explorer').boundingBox())!.width).toBe(resized);
  await page.getByLabel('Buscar arquivos').fill('does-not-exist');
  await expect(page.locator('.search-results')).toContainText('Nenhum arquivo corresponde');
  await page.getByRole('button', { name: 'Limpar busca' }).click();
  await expect(page.getByLabel('Buscar arquivos')).toHaveValue('');
  await page.getByLabel('Buscar arquivos').fill('context.md');
  await page.locator('.search-results button').click();
  await page.getByRole('button', { name: 'Limpar busca' }).click();
  await expect(page.locator('.tree-item.selected')).toContainText('context.md');
  await runMoreAction(page, 'Restaurar disposição');
  await runMoreAction(page, 'Mostrar inspetor');
  await expect(page.locator('.inspector h2')).toHaveText('context.md');
  await expect(separator).toHaveAttribute('aria-valuenow', '246');
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.react-flow')).toHaveClass(/light/);
  await runProjectsAction(page, 'Nova arquitetura');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await runMoreAction(page, 'Ativar tema escuro');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // The reload opens on Home: into the project, on the map of its folder.
  await enterProject(page);
  await showMap(page);
  await runProjectsAction(page, 'Nova arquitetura');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 749, height: 396 });
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await runMoreAction(page, 'Mostrar explorador');
  await expect(page.getByLabel('Buscar arquivos')).toBeVisible();
  await runMoreAction(page, 'Mostrar inspetor');
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Início', exact: true })).toBeInViewport();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    )
    .toBe(true);
  await expect(page.locator('.react-flow__node-file').first()).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('navigation-compact.png') });
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.locator('.tree-item', { hasText: 'AGENTS.md' }).click();
  await page.locator('.breadcrumb-root').click();
  // The folder opens in the mode of its view (the map, kept since the search): framed with the files in view.
  const folderMap = page.getByRole('button', { name: `Mapa de ${basename(folder)}`, exact: true });
  await expect(folderMap).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.react-flow__node-file').first()).toBeInViewport();
  // Its structure, one switch away.
  await page.getByRole('button', { name: `Estrutura de ${basename(folder)}`, exact: true }).click();
  await expect(page.locator('.structure-row').first()).toBeInViewport();
  // Its folder map, one switch away, is framed with the files in view.
  await folderMap.click();
  await expect(page.locator('.react-flow__node-file').first()).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('navigation-directory.png') });
  // The tree's project action is "Remover da tela".
  await page
    .getByRole('button', { name: `Remover ${basename(folder)} da tela`, exact: true })
    .click();
  await expect(page.locator('.breadcrumbs')).toHaveText('Início');
  await expect(page.getByRole('button', { name: 'Voltar seleção' })).toBeDisabled();
  expect(errors).toEqual([]);
});
