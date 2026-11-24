import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionHeaders, showMap } from './helpers';
import { runMoreAction, runProjectsAction } from './more-menu';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('parallel directory scopes preserve parent context, paths, history and compact navigation', async ({
  page,
}) => {
  const base = mkdtempSync(join(tmpdir(), 'aae-scopes-'));
  const root = join(base, 'parent');
  const child = join(root, 'research');
  mkdirSync(join(child, 'notes'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# Parent\n[Child context](research/context.md)\n');
  writeFileSync(join(child, 'CLAUDE.md'), '# Child\n[Context](context.md)\n');
  writeFileSync(join(child, 'context.md'), '# Context\n[Deep file](notes/details.md)\n');
  writeFileSync(join(child, 'notes/details.md'), '# Details\n');
  const before = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const opened of previous.roots)
    await page.request.post('/api/close', { data: { path: opened.path }, headers });
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  const parentPane = page.getByRole('region', { name: `Painel do diretório ${root}`, exact: true });
  const childPane = page.getByRole('region', { name: `Painel do diretório ${child}`, exact: true });
  await expect(parentPane).toBeVisible();
  // Opening selects no file; AGENTS.md is chosen in the structure (which stays) and its map is one switch
  // away. A single view has no header: the location of the top bar says what it shows.
  const location = page.locator('.breadcrumbs [aria-current="location"]');
  await expect(parentPane.locator('.scope-header')).toHaveCount(0);
  await expect(location).toHaveText('parent');
  await parentPane.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await expect(location).toHaveText('AGENTS.md');
  await showMap(page);
  // A reference into another scope also opens its parallel pane.
  await parentPane.locator('.react-flow__node-file').filter({ hasText: 'context.md' }).click();
  await expect(childPane.locator('.scope-location')).toContainText('context.md');
  await expect(parentPane.locator('.scope-location')).toContainText('AGENTS.md');
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  // Expanding the tree does not navigate; clicking its folder name does.
  await page.getByRole('button', { name: 'Recolher pasta research', exact: true }).click();
  await page.getByRole('button', { name: 'Expandir pasta research', exact: true }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await page
    .locator('.tree-item')
    .filter({ hasText: /^researchinstruções$/ })
    .click();
  await expect(childPane).toBeVisible();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  // A view opened by the scope rule says why and, visible too, its containment.
  await expect(childPane.locator('.scope-reason')).toContainText('research tem CLAUDE.md próprio');
  // Said by its words alone: no "i" before them.
  await expect(childPane.locator('.scope-reason svg')).toHaveCount(0);
  expect(await childPane.locator('.scope-reason').getAttribute('title')).toContain(
    `Contenção de diretório · ${root} (Filho de parent · +1 nível)`,
  );
  await expect(childPane.locator('.scope-parent')).toBeVisible();
  await expect(childPane.locator('.scope-parent')).toHaveText('Filho de parent · +1 nível');
  await expect(childPane.locator('.scope-parent')).toHaveAttribute(
    'title',
    `Contenção de diretório · ${root}`,
  );
  await expect(parentPane.locator('.scope-location')).toContainText('AGENTS.md');
  await childPane.getByLabel('Detalhes do diretório research').click();
  await expect(childPane.locator('.scope-header code')).toHaveText(child);
  await childPane.getByLabel('Detalhes do diretório research').click();
  const parentBox = await parentPane.boundingBox();
  const childBox = await childPane.boundingBox();
  expect(childBox!.x).toBeGreaterThan(parentBox!.x);
  expect(Math.abs(childBox!.y - parentBox!.y)).toBeLessThan(2);
  await page.screenshot({ path: test.info().outputPath('parallel-directory-scopes.png') });
  // File navigation stays within this pane and exposes clickable real ancestors.
  await page
    .locator('.tree-item')
    .filter({ hasText: /^context.md$/ })
    .click();
  await expect(page.locator('.inspector h2')).toHaveText('context.md');
  await expect(childPane.locator('.scope-location')).toContainText('context.md');
  await expect(
    page
      .getByRole('navigation', { name: 'Localização' })
      .getByRole('button', { name: 'research', exact: true }),
  ).toHaveAttribute('title', child);
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('research');
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  await page.getByRole('button', { name: 'Avançar seleção' }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await runMoreAction(page, 'Ativar tema escuro');
  await page.setViewportSize({ width: 749, height: 396 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    )
    .toBe(true);
  await expect(parentPane.locator('.file-tile.focused')).toBeInViewport({ ratio: 0.6 });
  // The child view has a folder selected, in the mode it opened with (the map, the mode of the view the
  // folder was chosen from): its structure, one switch away, shows the entry first among files.
  await expect(
    childPane.getByRole('button', { name: 'Mapa de research', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await childPane.getByRole('button', { name: 'Estrutura de research', exact: true }).click();
  await expect(childPane.locator('.structure-row.kind-entry').first()).toBeInViewport({
    ratio: 0.6,
  });
  // Switched to its folder map in this compact window, the entry tile is framed in view.
  await childPane.getByRole('button', { name: 'Mapa de research', exact: true }).click();
  await expect(childPane.locator('.file-tile.entry').first()).toBeInViewport({ ratio: 0.6 });
  await page.screenshot({ path: test.info().outputPath('parallel-directory-scopes-compact.png') });
  // A child folder view closes by "Fechar vista".
  await childPane.getByRole('button', { name: 'Fechar vista research', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  await expect(location).toHaveText('AGENTS.md');
  // Re-reading reflects entry files added or removed outside the application.
  await page.setViewportSize({ width: 1536, height: 960 });
  await page
    .locator('.tree-item')
    .filter({ hasText: /^context.md$/ })
    .click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  unlinkSync(join(child, 'CLAUDE.md'));
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  await expect(page.locator('.inspector h2')).toHaveText('context.md');
  writeFileSync(join(child, 'CLAUDE.md'), '# Restored child entry\n[Context](context.md)\n');
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  await expect(childPane.locator('.scope-location')).toContainText('context.md');
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(before);
  expect(errors).toEqual([]);
});
