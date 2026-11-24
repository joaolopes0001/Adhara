import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, enterProject, readable, sessionHeaders, writeTree } from './helpers';
import { runMoreAction, runProjectsAction } from './more-menu';

// Structure first: a folder shows the file system (a list, never a canvas of every node), a file shows
// its map; Estrutura | Mapa per view, kept in history without new entries; a view opened by the scope
// rule says why and closes; a traced path is a temporary extra view; switching frames the map by width.
function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-structure-')), 'loja');
  const tree: Record<string, string> = {
    'AGENTS.md': '# Loja\nSiga [CLAUDE.md](CLAUDE.md).\n',
    'CLAUDE.md':
      '# Loja\n' +
      '- [Arquitetura](docs/arquitetura.md)\n' +
      '- [Estilo](docs/estilo.md)\n' +
      '- [Memória](memory/MEMORY.md)\n' +
      '- [Skill](.claude/skills/revisar/SKILL.md)\n' +
      '- [Pagamentos](servicos/pagamentos/CLAUDE.md)\n' +
      '- [Deploy](docs/deploy.md)\n',
    'agent-architecture.json': '{"nodes": []}\n',
    'package.json': '{"name": "loja"}\n',
    'build.sh': '#!/bin/sh\necho build\n',
    'docs/arquitetura.md': '# Arquitetura\n[API](api.md)\n',
    'docs/api.md': '# API\n',
    'docs/estilo.md': '# Estilo\n[Checklist](checklist.md)\n',
    'docs/checklist.md': '# Checklist\n',
    'memory/MEMORY.md': '# Memória\n- [[decisoes]]\n',
    'memory/decisoes.md': '---\nname: decisoes\n---\n# Decisões\n',
    '.claude/skills/revisar/SKILL.md': '---\nname: revisar\n---\n# Revisar\n',
    'servicos/pagamentos/CLAUDE.md': '# Pagamentos\nLeia [o runbook](runbook.md).\n',
    'servicos/pagamentos/runbook.md': '# Runbook\n',
    'servicos/pagamentos/main.go': 'package main\n',
  };
  writeTree(root, tree);
  return root;
}

async function closeAll(page: Page) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  return headers;
}

/** Opens a project the way a person does: "Adicionar diretório" and "Abrir este diretório". */
async function addProject(page: Page, root: string) {
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório', exact: true }).click();
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = (structure: Locator, name: string) =>
  structure.locator('.structure-row').filter({
    has: structure.page().locator('.structure-open', { hasText: new RegExp(`^${escape(name)}$`) }),
  });

/** Text color against the first opaque background up the tree. */
/** What the single view shows: with one view, the top bar names it (the view has no header). */
const location = (page: Page) => page.locator('.breadcrumbs [aria-current="location"]');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('structure first: opening a project selects no file and lists the folder under a header of columns, with classes, unanalysed types and references as numbers', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  await closeAll(page);
  await page.goto('/');
  await addProject(page, root);
  const pane = page.locator(`.scope-pane[data-scope="${root}"]`);
  await expect(pane).toBeVisible();
  // No file is pre-selected; the view shows the structure of the root.
  await expect(location(page)).toHaveText('loja');
  await expect(page.locator('.inspector .inspector-identity')).toHaveCount(0);
  await expect(page.locator('.tree-item.selected')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Estrutura de loja', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Mapa de loja', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const structure = pane.getByRole('region', { name: 'Estrutura de loja' });
  // A list of the file system, not a canvas with every node.
  await expect(pane.locator('.react-flow')).toHaveCount(0);
  await expect(structure.locator(':scope > .structure-root > li > .structure-row')).toHaveCount(9);
  // Folders first, every inventoried item (analysed or not), in name order.
  await expect(
    structure.locator(':scope > .structure-root > li > .structure-row .structure-open'),
  ).toHaveText([
    '.claude',
    'docs',
    'memory',
    'servicos',
    'agent-architecture.json',
    'AGENTS.md',
    'build.sh',
    'CLAUDE.md',
    'package.json',
  ]);
  // One header of columns: the folder summary, then the words of the columns, said once for the list.
  const columns = structure.locator('.structure-columns');
  await expect(columns.locator('.structure-summary')).toHaveText('4 pastas · 5 arquivos · 4 lidos');
  await expect(columns.locator('.structure-heading')).toHaveText([
    'classe',
    'aponta para',
    'citado por',
    'observações',
  ]);
  await expect(columns.locator('.structure-heading', { hasText: 'aponta para' })).toHaveAttribute(
    'title',
    /arquivos distintos/,
  );
  // The words of the references are not repeated on each row: only the header shows them.
  const visibleWords = await structure.evaluate((element) => {
    const words = { 'aponta para': 0, 'citado por': 0 };
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (!parent || parent.closest('.visually-hidden')) continue;
      for (const word of Object.keys(words) as (keyof typeof words)[])
        if (text.nodeValue?.includes(word)) words[word]++;
    }
    return words;
  });
  expect(visibleWords).toEqual({ 'aponta para': 1, 'citado por': 1 });
  await expect(structure.locator('.structure-legend')).toHaveCount(0);

  // Class column: special files are named, a plain file is not ("Arquivo" is not written).
  await expect(row(structure, 'CLAUDE.md').locator('.structure-kind')).toHaveText('Instruções');
  await expect(row(structure, 'agent-architecture.json').locator('.structure-kind')).toHaveText(
    'Manifesto',
  );
  await expect(row(structure, 'package.json').locator('.structure-class')).toHaveText('');
  // A type the reader does not read is listed and marked, with the reason in the tooltip; it points
  // to nothing that could be counted ("–"), and nobody cites it ("0").
  const script = row(structure, 'build.sh');
  await expect(script.locator('.structure-state')).toHaveText('não lido');
  await expect(script.locator('.structure-state')).toHaveAttribute('title', /Tipo não lido/);
  const count = (item: Locator) => item.locator('.structure-count > [aria-hidden="true"]');
  const spoken = (item: Locator) => item.locator('.structure-count > .visually-hidden');
  await expect(count(script)).toHaveText(['–', '0']);
  await expect(spoken(script)).toHaveText(['aponta para: não lido', 'citado por 0 arquivos']);
  await expect(row(structure, 'CLAUDE.md').locator('.structure-state')).toHaveCount(0);
  // References as numbers in columns, each with its full name for assistive technology.
  const references = row(structure, 'CLAUDE.md').locator('.structure-count');
  await expect(count(row(structure, 'CLAUDE.md'))).toHaveText(['6', '1']);
  await expect(spoken(row(structure, 'CLAUDE.md'))).toHaveText([
    'aponta para 6 arquivos',
    'citado por 1 arquivo',
  ]);
  await expect(count(row(structure, 'AGENTS.md'))).toHaveText(['1', '0']);
  await expect(count(row(structure, 'package.json'))).toHaveText(['0', '0']);
  await expect(row(structure, 'package.json').locator('.structure-count.is-zero')).toHaveCount(2);
  // A folder: its count next to the name, discreet; in the reference columns, what crosses its edge in
  // distinct files (nothing outside is cited from servicos; CLAUDE.md, outside, cites into it).
  await expect(row(structure, 'servicos').locator('.structure-items')).toHaveText('1 item');
  await expect(count(row(structure, 'servicos'))).toHaveText(['0', '1']);
  await expect(spoken(row(structure, 'servicos'))).toHaveText([
    'aponta para 0 arquivos fora da pasta',
    'citado por 1 arquivo fora da pasta',
  ]);
  // Number columns line up: every "aponta para" cell ends where its header ends.
  const right = async (item: Locator) =>
    (await item.boundingBox())!.x + (await item.boundingBox())!.width;
  const heading = await right(columns.locator('.structure-heading', { hasText: 'aponta para' }));
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'package.json', 'build.sh'])
    expect(
      Math.abs((await right(row(structure, name).locator('.structure-count').first())) - heading),
      name,
    ).toBeLessThan(1);
  // Space reserved for the item marker, on every row.
  await expect(structure.locator('.structure-row')).toHaveCount(
    await structure.locator('[data-slot="marker"]').count(),
  );

  // Expanding shows the content in place without navigating; a nested own entry is named.
  await structure.getByRole('button', { name: 'Mostrar conteúdo de servicos' }).click();
  await expect(row(structure, 'pagamentos').locator('.structure-own-entry')).toHaveText(
    'CLAUDE.md próprio',
  );
  await structure.getByRole('button', { name: 'Mostrar conteúdo de .claude' }).click();
  await structure.getByRole('button', { name: 'Mostrar conteúdo de skills' }).click();
  await structure.getByRole('button', { name: 'Mostrar conteúdo de revisar' }).click();
  await expect(row(structure, 'SKILL.md').locator('.structure-kind')).toHaveText('Skill');
  await expect(location(page)).toHaveText('loja');
  await structure.getByRole('button', { name: 'Ocultar conteúdo de .claude' }).click();
  await expect(row(structure, 'SKILL.md')).toHaveCount(0);

  // Clicking a folder navigates to it; the class of memory files is shown there.
  await row(structure, 'memory').locator('.structure-open').click();
  await expect(location(page)).toHaveText('memory');
  const memory = pane.getByRole('region', { name: 'Estrutura de memory' });
  await expect(row(memory, 'MEMORY.md').locator('.structure-kind')).toHaveText('Memória');
  await expect(memory.getByRole('button', { name: 'Pasta acima: loja' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('structure-memory-dark.png') });
  await memory.getByRole('button', { name: 'Pasta acima: loja' }).click();
  await expect(location(page)).toHaveText('loja');

  // Clicking a file selects it: the list stays, with its line marked, and the inspector opens on it; the
  // map of its context is one switch away.
  await row(structure, 'CLAUDE.md').locator('.structure-open').click();
  await expect(page.locator('.inspector h2')).toHaveText('CLAUDE.md');
  await expect(row(structure, 'CLAUDE.md')).toHaveClass(/is-selected/);
  await expect(
    page.getByRole('button', { name: 'Estrutura de loja', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Mapa de loja', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mapa de loja', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(pane.locator('.file-tile.focused')).toContainText('CLAUDE.md');
  await expect(pane.locator('.structure-view')).toHaveCount(0);

  // Both themes cover the list and its marks with readable text.
  await page.getByRole('button', { name: 'Estrutura de loja' }).click();
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const [label, cell] of [
      ['name', row(structure, 'CLAUDE.md').locator('.structure-open > span')],
      ['class', row(structure, 'CLAUDE.md').locator('.structure-kind')],
      ['state', script.locator('.structure-state')],
      ['references', references.first()],
      ['summary', structure.locator('.structure-summary')],
      ['header', structure.locator('.structure-heading').first()],
    ] as const)
      expect(await readable(cell), `${label} (${theme})`).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`structure-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(agents);
  expect(errors).toEqual([]);
});

test('structure first: Estrutura | Mapa per view, the map of a folder with omission count, the folder of a file with it marked, and history without extra steps', async ({
  page,
}) => {
  const root = fixture();
  // Each note references the API, so all 34 items of docs take part in a reference (the map's limit).
  for (let i = 0; i < 30; i++)
    writeFileSync(join(root, `docs/nota-${i}.md`), `# Nota ${i}\n[API](api.md)\n`);
  await closeAll(page);
  await page.goto('/');
  await addProject(page, root);
  const pane = page.locator(`.scope-pane[data-scope="${root}"]`);
  const structure = pane.getByRole('region', { name: 'Estrutura de loja' });
  await row(structure, 'docs').locator('.structure-open').click();
  await expect(location(page)).toHaveText('docs');
  const docs = pane.getByRole('region', { name: 'Estrutura de docs' });
  // Every item of the folder is listed in the structure (34 files), paged at 200.
  await expect(docs.locator('.structure-row')).toHaveCount(34);

  // With a folder selected, Mapa shows its direct children, up to 24, with the omission count.
  await page.getByRole('button', { name: 'Mapa de loja', exact: true }).click();
  await expect(pane.locator('.canvas-caption')).toContainText(
    'Referências somadas entre os itens de docs',
  );
  await expect(pane.locator('.react-flow__node-file')).toHaveCount(24);
  await expect(pane.locator('.folder-strip')).toContainText('+10 itens');
  await expect(pane.locator('.canvas-caption > span:last-child')).toContainText('34 itens');
  await expect(pane.locator('.structure-view')).toHaveCount(0);

  // A new selection returns to the default of what it shows: a file opens its map.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('docs/estilo.md');
  await page.locator(`.search-results button[title="${join(root, 'docs/estilo.md')}"]`).click();
  await page.getByRole('button', { name: 'Limpar busca' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('estilo.md');
  await expect(page.getByRole('button', { name: 'Mapa de loja', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // With a file selected, Estrutura shows its folder with the file marked.
  await page.getByRole('button', { name: 'Estrutura de loja', exact: true }).click();
  const marked = docs.locator('.structure-row.is-selected');
  await expect(marked).toHaveCount(1);
  await expect(marked.locator('.structure-open')).toHaveText('estilo.md');
  await expect(marked.locator('.structure-open')).toHaveAttribute('aria-current', 'true');
  await expect(marked).toBeInViewport();
  await expect(page.locator('.inspector h2')).toHaveText('estilo.md');

  // The mode is not a history step: back returns to the folder as it was left (Mapa), forward to the
  // file as it was left (Estrutura).
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(location(page)).toHaveText('docs');
  await expect(page.getByRole('button', { name: 'Mapa de loja', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(location(page)).toHaveText('loja');
  await expect(
    page.getByRole('button', { name: 'Estrutura de loja', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Avançar seleção' }).click();
  await page.getByRole('button', { name: 'Avançar seleção' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('estilo.md');
  await expect(marked.locator('.structure-open')).toHaveText('estilo.md');
  await expect(page.getByRole('button', { name: 'Avançar seleção' })).toBeDisabled();
  // A re-reading keeps the mode chosen.
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await expect(page.locator('.status-bar')).toContainText('Pronto');
  await expect(
    page.getByRole('button', { name: 'Estrutura de loja', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(marked.locator('.structure-open')).toHaveText('estilo.md');
});

test('structure first: a view opened by a folder with its own entry says why and closes; ancestors show their folder; no other action opens views', async ({
  page,
}) => {
  const root = fixture();
  const nested = join(root, 'servicos/pagamentos');
  await closeAll(page);
  await page.goto('/');
  await addProject(page, root);
  const parent = page.locator(`.scope-pane[data-scope="${root}"]`);
  const child = page.locator(`.scope-pane[data-scope="${nested}"]`);
  await expect(parent).toBeVisible();
  // Selecting, switching modes and opening tools keep one view.
  await row(parent.getByRole('region', { name: 'Estrutura de loja' }), 'CLAUDE.md')
    .locator('.structure-open')
    .click();
  await page.getByRole('button', { name: 'Estrutura de loja', exact: true }).click();
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await page.getByRole('button', { name: 'Recolher painel inferior' }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  // One view: no tabs of views and no header of its own.
  await expect(page.locator('[data-view-id]')).toHaveCount(0);
  await expect(parent.locator('.scope-header')).toHaveCount(0);
  await expect(parent.locator('.scope-reason')).toHaveCount(0);

  // A file inside a folder with its own CLAUDE.md opens that folder's view, which explains itself.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('runbook');
  await page.locator('.search-results button').first().click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  const reason = child.locator('.scope-reason');
  await expect(reason).toHaveText(/Aberta automaticamente: pagamentos tem CLAUDE\.md próprio/);
  await expect(reason).toHaveAttribute(
    'title',
    new RegExp(`Contenção de diretório · ${escape(root)}`),
  );
  // Its containment stays available in the details.
  await child.getByLabel('Detalhes do diretório pagamentos').click();
  await expect(child.locator('.scope-details')).toContainText(`Contenção de diretório · ${root}`);
  await child.getByLabel('Detalhes do diretório pagamentos').click();
  await page.screenshot({ path: test.info().outputPath('auto-view-reason.png') });
  await reason.getByRole('button', { name: 'Fechar vista', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  await expect(page.locator('.tree-root')).toHaveCount(1);
  // As when closing any view, the selection moves to the view that remains.
  await expect(page.locator('.inspector h2')).toHaveText('CLAUDE.md');

  // From an empty workspace view, the ancestor view opens on its folder, not on a file chosen for the user.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('runbook');
  await page.locator('.search-results button').first().click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  await expect(parent.locator('.scope-location button')).toHaveText('.');
  await expect(parent.getByRole('region', { name: 'Estrutura de loja' })).toBeVisible();
  await expect(child.locator('.file-tile.focused')).toContainText('runbook.md');
  // A root opened by the person is not "opened automatically".
  await expect(parent.locator('.scope-reason')).toHaveCount(0);
});

test('vistas estáveis: a traced path is a temporary extra view; the other tabs stay and come back as they were', async ({
  page,
}) => {
  const root = fixture();
  await closeAll(page);
  await page.goto('/');
  await addProject(page, root);
  const structure = page.getByRole('region', { name: 'Estrutura de loja' });
  await row(structure, 'servicos').locator('.structure-open').click();
  await row(page.getByRole('region', { name: 'Estrutura de servicos' }), 'pagamentos')
    .locator('.structure-open')
    .click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  const tabs = page.locator('[data-view-id]');
  await expect(tabs).toHaveCount(2);
  // A view minimized by the person stays minimized after the path is cleared.
  await page.getByRole('button', { name: 'Minimizar vista pagamentos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restaurar vista pagamentos' })).toBeVisible();

  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await page.getByLabel('Arquivo de origem A').fill('loja/CLAUDE.md');
  await page.getByLabel('Arquivo de destino B').fill('memory/decisoes.md');
  await page.getByLabel('Arquivo de destino B').press('Enter');
  await expect(page.locator('.trace-summary')).toContainText('2 passos');
  // The tabs of the views stay; the path is one more, temporary view with the grid to itself.
  await expect(tabs).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: 'Restaurar vista loja', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restaurar vista pagamentos' })).toBeVisible();
  const traceTab = page.getByRole('button', { name: 'Ativar vista Caminho', exact: true });
  await expect(traceTab).toHaveAttribute('title', /vista temporária/);
  const tracePane = page.locator('.workspace-pane[data-pane-id="trace"]');
  await expect(tracePane).toHaveAttribute('data-minimized', 'false');
  await expect(tracePane.locator('.file-tile.traced')).toHaveCount(3);
  await expect(page.locator('.workspace-pane[data-minimized="false"]')).toHaveCount(1);
  // Selecting a step keeps the path in front.
  await tracePane.locator('.react-flow__node-file').filter({ hasText: 'MEMORY.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('MEMORY.md');
  await expect(page.locator('.workspace-pane[data-minimized="false"]')).toHaveCount(1);
  // Restoring a tab shows that view beside the path, without clearing it.
  await page.getByRole('button', { name: 'Restaurar vista loja', exact: true }).click();
  await expect(page.locator('.workspace-pane[data-minimized="false"]')).toHaveCount(2);
  await expect(tracePane).toHaveAttribute('data-minimized', 'false');
  await expect(page.locator('.trace-summary')).toContainText('2 passos');
  await page.screenshot({ path: test.info().outputPath('trace-temporary-view.png') });

  // Clearing the path restores the previous arrangement.
  await page.getByRole('button', { name: 'Limpar caminho', exact: true }).first().click();
  await expect(tabs).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Ativar vista loja', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restaurar vista pagamentos' })).toBeVisible();
  await expect(page.locator('.trace-summary')).toHaveCount(0);
  await expect(page.getByLabel('Arquivo de origem A')).toHaveValue('loja/CLAUDE.md');
  // Tracing again and closing the path view by its × does the same.
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(tabs).toHaveCount(3);
  await page
    .locator('.workspace-pane[data-pane-id="trace"]')
    .getByRole('button', { name: 'Limpar caminho' })
    .click();
  await expect(tabs).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Restaurar vista pagamentos' })).toBeVisible();
});

/** File tiles that start inside the pane but end beyond its right edge (cut on the right). */
async function cutOnTheRight(pane: Locator) {
  const box = (await pane.locator('.react-flow').boundingBox())!;
  const tiles = await pane
    .locator('.react-flow__node-file')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  return tiles.filter(
    (tile: DOMRect) =>
      tile.left < box.x + box.width &&
      tile.top < box.y + box.height &&
      tile.bottom > box.y &&
      tile.right > box.x + box.width + 1,
  ).length;
}

test('vistas estáveis: switching view, mode or selection frames the map by width, without cutting tiles on the right, unless adjusted by hand', async ({
  page,
}) => {
  const root = fixture();
  for (let i = 0; i < 6; i++) writeFileSync(join(root, `extra-${i}.md`), `# Extra ${i}\n`);
  await closeAll(page);
  await page.goto('/');
  await addProject(page, root);
  const pane = page.locator(`.scope-pane[data-scope="${root}"]`);
  const structure = pane.getByRole('region', { name: 'Estrutura de loja' });
  // With the inspector open, three columns do not fit at the previous minimum zoom.
  await row(structure, 'docs').locator('.structure-open').click();
  await row(pane.getByRole('region', { name: 'Estrutura de docs' }), 'estilo.md')
    .locator('.structure-open')
    .click();
  await expect(page.locator('.inspector h2')).toHaveText('estilo.md');
  // The list stays; the switch shows the map of the file. The inspector slides in: the view reaches its
  // width when it stops.
  await page.getByRole('button', { name: 'Mapa de loja', exact: true }).click();
  await expect.poll(() => pane.evaluate((element) => element.clientWidth)).toBeLessThan(1000);
  // Incoming (CLAUDE.md), selection and outgoing (checklist.md): every column whole.
  await expect(pane.locator('.file-tile.focused')).toContainText('estilo.md');
  await expect.poll(() => cutOnTheRight(pane)).toBe(0);
  for (const name of ['CLAUDE.md', 'estilo.md', 'checklist.md'])
    await expect(pane.locator('.react-flow__node-file').filter({ hasText: name })).toBeInViewport({
      ratio: 0.95,
    });
  // The map of a folder (several rows): columns whole, rows below reachable.
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(location(page)).toHaveText('loja');
  await page.getByRole('button', { name: 'Mapa de loja', exact: true }).click();
  await expect(pane.locator('.canvas-caption')).toContainText(
    'Referências somadas entre os itens de loja',
  );
  await expect.poll(() => cutOnTheRight(pane)).toBe(0);
  // Back to the structure and to the map again: framed again.
  await page.getByRole('button', { name: 'Estrutura de loja', exact: true }).click();
  await page.getByRole('button', { name: 'Mapa de loja', exact: true }).click();
  await expect.poll(() => cutOnTheRight(pane)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('framed-folder-map.png') });

  // A manual zoom is kept when the view only changes size.
  const zoom = () =>
    pane
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  await pane.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
  await page.waitForTimeout(400);
  const manual = await zoom();
  await page.waitForTimeout(400);
  expect(Math.abs((await zoom()) - manual)).toBeLessThan(0.02);
});

test('structure first: an empty folder says "vazia"; a folder cut by the inventory limit never does', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A reading cut by the inventory limit, served by a mocked API (as in the reader limits spec).
  const root = '/tmp/aae-structure-cut-fixture/cortes';
  const node = (relative: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id: `${root}${relative ? `/${relative}` : ''}`,
    path: `${root}${relative ? `/${relative}` : ''}`,
    name: relative.split('/').at(-1) || 'cortes',
    relative: relative || '.',
    kind,
    status: 'resolved',
    root,
    roots: [root],
    ...extra,
  });
  const model = {
    savedCases: [{ path: root, name: 'cortes', available: true }],
    roots: [{ path: root, name: 'cortes', parent: null, level: 0, entries: [`${root}/AGENTS.md`] }],
    nodes: [
      node('', 'directory', { listing: 'complete', omitted: 5 }),
      node('AGENTS.md', 'entry', { analysis: 'parsed', lines: 1 }),
      node('cortada', 'directory', { listing: 'unread', omitted: 3 }),
      node('parcial', 'directory', { listing: 'partial', omitted: 2 }),
      node('parcial/a.md', 'file', { analysis: 'parsed', lines: 1 }),
      node('vazia', 'directory', { listing: 'complete', omitted: 0 }),
    ],
    edges: [],
    objects: [],
    issues: [],
    signals: [],
    notes: {},
    expected: {},
    restoreErrors: [],
    delta: null,
    scope: { source: null, patterns: [] },
    stats: {
      files: 2,
      parsed: 2,
      edges: 0,
      entries: 1,
      inventory: {
        complete: false,
        lookupComplete: true,
        omitted: 5,
        omittedFiles: 5,
        byTopLevel: [],
      },
    },
    policy: { excluded: [], maxNodes: 5, maxFileBytes: 1048576, maxTextBytes: 33554432, ai: false },
  };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'session')
      return route.fulfill({
        json: { token: 'test-session', home: '/tmp', defaultParent: '/tmp' },
      });
    if (path === 'workspace' || path === 'refresh') return route.fulfill({ json: model });
    if (path === 'content') return route.fulfill({ json: { text: '# x', truncated: false } });
    return route.fulfill({ status: 404, json: { error: `Operação inesperada ${path}` } });
  });
  await page.goto('/');
  // From Home, the list of projects, by the row of the project.
  await enterProject(page, 'cortes');
  const structure = page.getByRole('region', { name: 'Estrutura de cortes' }).first();
  const name = (folder: string) => row(structure, folder).locator('.structure-name');

  // An empty folder is quiet: "vazia", no warning.
  await expect(row(structure, 'vazia').locator('.structure-items')).toHaveText('vazia');
  await expect(row(structure, 'vazia').locator('.structure-listing')).toHaveCount(0);
  await expect(row(structure, 'parcial').locator('.structure-items')).toHaveCount(0);
  // A cut folder is a level-2 line in place of the count: the number left out, in the warning tone.
  for (const [folder, text] of [
    ['cortada', 'não lida · 3 itens no disco'],
    ['parcial', 'lida em parte · 2 itens fora'],
  ]) {
    const listing = row(structure, folder).locator('.structure-listing');
    await expect(listing).toHaveText(text);
    await expect(listing.locator('svg')).toHaveCount(0);
    await expect(listing).toHaveAttribute('title', /limite de itens/);
    // Negative: never the words of an empty folder.
    await expect(name(folder)).not.toContainText('vazia');
    await expect(name(folder)).not.toContainText('0 itens');
  }
  await expect(structure.getByText('0 itens')).toHaveCount(0);
  // No icon: the text itself takes the warning tone, readable on the row.
  const listing = row(structure, 'cortada').locator('.structure-listing');
  const colors = await listing.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--tone-warning)';
    document.body.append(probe);
    const warning = getComputedStyle(probe).color;
    probe.remove();
    return { text: getComputedStyle(element).color, warning };
  });
  expect(colors.text).toBe(colors.warning);
  expect(await readable(listing)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: test.info().outputPath('structure-cut-folders.png') });

  // Compact window: the columns shrink, nothing scrolls sideways, the numbers keep their place.
  await page.setViewportSize({ width: 749, height: 396 });
  await expect
    .poll(() => structure.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0);
  await expect(row(structure, 'parcial').locator('.structure-listing')).toBeVisible();
  await expect(
    structure.locator('.structure-heading', { hasText: 'observações' }),
  ).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('structure-cut-folders-compact.png') });
  await page.setViewportSize({ width: 1280, height: 720 });

  // Inside a folder not read: the empty message says why, never "vazia".
  await row(structure, 'cortada').locator('.structure-open').click();
  const inside = page.getByRole('region', { name: 'Estrutura de cortada' }).first();
  await expect(inside.locator('.structure-empty')).toContainText(
    'Pasta não lida · 3 itens no disco',
  );
  await expect(inside.locator('.structure-summary .structure-listing')).toHaveText(
    'não lida · 3 itens no disco',
  );
  await expect(inside).not.toContainText('vazia');
  expect(errors).toEqual([]);
});
