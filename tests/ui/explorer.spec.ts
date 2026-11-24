import { expect, test } from '@playwright/test';
import { showAudit } from './audit-list';
import {
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  statSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, join, relative, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { menuButton, runMoreAction, runProjectsAction } from './more-menu';
import { enterProject, sessionHeaders, showMap } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('open, inspect, trace, annotate, audit, nested roots and create real files', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { token: sessionToken, home } = await (await page.request.get('/api/session')).json();
  const sessionHeaders = { 'X-AAE-Token': sessionToken };
  const previous = await (
    await page.request.get('/api/workspace', { headers: sessionHeaders })
  ).json();
  for (const root of previous.roots)
    await page.request.post('/api/close', { headers: sessionHeaders, data: { path: root.path } });
  const folder = mkdtempSync(join(tmpdir(), 'aae-browser-'));
  const project = join(folder, 'research-agent');
  mkdirSync(join(project, 'memory'), { recursive: true });
  mkdirSync(join(project, 'tools'));
  writeFileSync(
    join(project, 'AGENTS.md'),
    '# Research assistant\n\n[Context](memory/context.md)\n[Tools](tools/search.md)\n[Missing](missing.md)\n',
  );
  writeFileSync(join(project, 'memory/context.md'), '# Context\n\n[Search](../tools/search.md)\n');
  writeFileSync(join(project, 'tools/search.md'), '# Search\n\nRead-only search.\n');
  writeFileSync(
    join(project, 'memory/CLAUDE.md'),
    '# Memory instructions\n[Context](context.md)\n',
  );
  const before = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  // A slow initial folder listing must not overwrite a path typed by the user.
  await page.route(
    (url) => url.pathname === '/api/directories' && url.searchParams.get('path') === home,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    },
  );
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByRole('textbox', { name: 'Caminho do diretório' }).fill(project);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  // Opening selects no file; clicking AGENTS.md in the structure selects it and opens the inspector (the
  // list stays); the switch shows its map.
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await expect(page.locator('.relation-heading').first()).toContainText('Para onde aponta');
  await expect(page.locator('.relation-list').first()).toContainText('context.md');
  await showMap(page);
  await expect(page.locator('.react-flow__node-file')).not.toHaveCount(0);
  await page.locator('.react-flow__node-file').filter({ hasText: 'context.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('context.md');
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await expect(page.locator('.relation-list').last()).toContainText('AGENTS.md');
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await page.screenshot({ path: test.info().outputPath('workspace.png') });
  // "Definir como A/B" is visible without opening "Detalhes".
  await expect(page.locator('.file-details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Definir como A' }).click();
  await page.getByLabel('Arquivo de destino B').fill(join(project, 'tools/search.md'));
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('.trace-summary')).toContainText('1 passo');
  await page.getByLabel('Arquivo de origem A').fill(join(project, 'tools/search.md'));
  await page.getByLabel('Arquivo de destino B').fill(join(project, 'AGENTS.md'));
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('.bottom-content')).toHaveText('Nenhum caminho seguindo as setas.');
  await page.getByLabel('Direção do caminho').selectOption('undirected');
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('.trace-result')).toContainText('sentido inverso');
  await page.getByRole('button', { name: 'Anotações', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Anotação do arquivo' })
    .fill('Revisar as fontes deste agente.');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect
    .poll(async () => {
      const token = (await (await page.request.get('/api/session')).json()).token;
      const model = await (
        await page.request.get('/api/workspace', { headers: { 'X-AAE-Token': token } })
      ).json();
      return model.notes[join(project, 'AGENTS.md')];
    })
    .toBe('Revisar as fontes deste agente.');
  await page.reload();
  // The reload opens on Home, the list of projects: the tree is in the project.
  await enterProject(page);
  await page.locator('.explorer').getByTitle(join(project, 'AGENTS.md'), { exact: true }).click();
  await page.getByRole('button', { name: 'Anotações', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Anotação do arquivo' })).toHaveValue(
    'Revisar as fontes deste agente.',
  );
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(page.locator('.audit-content')).toContainText('missing.md');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByRole('textbox', { name: 'Caminho do diretório' }).fill(join(project, 'memory'));
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  await expect(page.locator('.root-meta').last()).toContainText('+1 nível');
  await expect(page.locator('.scope-parent', { hasText: 'research-agent' })).toBeVisible();
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(project);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  // Reopening an open root selects its folder, not a file.
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('research-agent');
  await page.locator('.tree-item', { hasText: 'context.md' }).last().click();
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await expect(page.locator('.relation-list').last()).toContainText('AGENTS.md');
  await page.getByRole('button', { name: 'Arquivo', exact: true }).click();
  await expect(page.locator('.source-code')).toContainText('# Context');
  expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe(before);

  await runProjectsAction(page, 'Nova arquitetura');
  await page.getByLabel('Diretório pai').fill(folder);
  await page.getByLabel('Nome do novo diretório').fill('created-architecture');
  await page.getByRole('button', { name: 'Adicionar nó' }).click();
  await page.getByRole('textbox', { name: 'Nome do nó 4' }).fill('pesquisa');
  await page.getByLabel('Tipo do nó 4').selectOption('tool');
  await page.getByRole('button', { name: 'Conectar nós' }).click();
  await page.getByLabel('Destino da relação 3').selectOption('pesquisa');
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  await expect(page.locator('.blueprint')).toContainText('tool/pesquisa.md');
  expect(readdirSync(folder)).not.toContain('created-architecture');
  await page.screenshot({ path: test.info().outputPath('create-preview.png') });
  await page.getByRole('button', { name: 'Criar e abrir' }).click();
  await expect(page.locator('.tree-root', { hasText: 'created-architecture' })).toBeVisible();
  expect(statSync(join(folder, 'created-architecture/AGENTS.md')).isFile()).toBeTruthy();
  expect(readFileSync(join(folder, 'created-architecture/agent/assistente.md'), 'utf8')).toContain(
    '../tool/pesquisa.md',
  );
  // The created project is only Markdown: the new file is in the tree, and there is no manifest.
  const created = page.getByRole('listitem', { name: 'Projeto created-architecture' });
  await created.getByRole('button', { name: 'Expandir pasta tool' }).click();
  await expect(created.getByRole('button', { name: 'pesquisa.md' })).toBeVisible();
  expect(readdirSync(join(folder, 'created-architecture'))).not.toContain(
    'agent-architecture.json',
  );
  await page.setViewportSize({ width: 749, height: 396 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= window.innerWidth &&
          document.documentElement.scrollHeight <= window.innerHeight,
      ),
    )
    .toBe(true);
  // The compact top bar keeps the menus within reach.
  await expect(menuButton(page, 'Projetos')).toBeInViewport({ ratio: 1 });
  await expect(menuButton(page, 'Mais')).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath('compact-window.png') });
  expect(errors).toEqual([]);
});

/** Bounded read-only inventory of a real copy: type, size, mtime and (within budget) sha256. */
function copyInventory(root: string) {
  const MAX_ENTRIES = 5000;
  const MAX_HASHED_FILE = 1 << 20;
  const MAX_HASHED_TOTAL = 64 << 20;
  const rows: Record<string, string> = {};
  const unhashed = new Set<string>();
  let hashedBytes = 0;
  let truncated = false;
  const pending = [''];
  while (pending.length) {
    if (Object.keys(rows).length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const path = pending.pop()!;
    const full = path ? join(root, path) : root;
    const info = lstatSync(full);
    if (info.isDirectory()) {
      rows[path || '.'] = `d:${info.mtimeMs}`;
      // Heavy folders keep their own mtime but are not descended.
      if (path && ['.git', 'node_modules'].includes(basename(path))) continue;
      for (const name of readdirSync(full).sort().reverse())
        pending.push(path ? join(path, name) : name);
    } else if (info.isFile()) {
      let digest = '';
      if (info.size <= MAX_HASHED_FILE && hashedBytes + info.size <= MAX_HASHED_TOTAL) {
        digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        hashedBytes += info.size;
      } else unhashed.add(path);
      rows[path] = `f:${info.size}:${info.mtimeMs}:${digest}`;
    } else if (info.isSymbolicLink()) rows[path] = `l:${readlinkSync(full)}:${info.mtimeMs}`;
    else rows[path] = `o:${info.mode}`;
  }
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return {
    rows,
    digest,
    entries: Object.keys(rows).length,
    hashedBytes,
    unhashed: unhashed.size,
    truncated,
  };
}

function inside(path: string, parent: string) {
  const rest = relative(parent, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

test('Optional run on a real directory copy (AAE_REAL_COPY)', async ({ page }) => {
  test.setTimeout(180000);
  const configuredRoot = process.env.AAE_REAL_COPY;
  test.skip(!configuredRoot, 'No copy given; set AAE_REAL_COPY to run this scenario.');
  const candidate = configuredRoot!;
  expect(existsSync(candidate), 'AAE_REAL_COPY must point to an existing directory').toBe(true);
  expect(statSync(candidate).isDirectory(), 'AAE_REAL_COPY must be a directory').toBe(true);
  const root = realpathSync(candidate);
  // A copy never lives inside a path the maintainer protected.
  for (const raw of (process.env.AAE_PROTECTED_PATHS ?? '').split(delimiter)) {
    if (!raw.trim()) continue;
    const entry = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
    const real = existsSync(entry) ? realpathSync(entry) : entry;
    expect(inside(root, real), 'The copy must not be inside AAE_PROTECTED_PATHS').toBe(false);
  }
  const before = copyInventory(root);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const headers = await sessionHeaders(page);
  const workspace = async () => (await page.request.get('/api/workspace', { headers })).json();
  for (const opened of (await workspace()).roots)
    await page.request.post('/api/close', { data: { path: opened.path }, headers });
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByRole('textbox', { name: 'Caminho do diretório' }).fill(root);
  const start = Date.now();
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  await expect
    .poll(async () => (await workspace()).roots.some((r: { path: string }) => r.path === root), {
      timeout: 30000,
    })
    .toBe(true);
  type Node = { id: string; name: string; relative: string; status: string; kind: string };
  type Edge = { source: string; target: string };
  const model = await workspace();
  const opened = model.roots.find((r: { path: string }) => r.path === root);
  // The entry is discovered, never named: the first AGENTS.md/CLAUDE.md of the reading.
  const entry: string | undefined = opened.entries[0];
  expect(entry, 'A cópia precisa de um AGENTS.md ou CLAUDE.md').toBeTruthy();
  expect(['AGENTS.md', 'CLAUDE.md']).toContain(basename(entry!));
  const nodes = new Map<string, Node>(model.nodes.map((node: Node) => [node.id, node]));
  const reference = (model.edges as Edge[])
    .filter((edge) => edge.source === entry && edge.target !== entry)
    .map((edge) => nodes.get(edge.target))
    .find((node) => node && node.status === 'resolved' && inside(node.id, root));
  expect(reference, 'A entrada precisa de ao menos uma referência resolvida na cópia').toBeTruthy();
  // Opening selects no file (structure first): the entry is chosen here, by the search.
  await expect(page.getByRole('region', { name: `Estrutura de ${basename(root)}` })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('textbox', { name: 'Buscar arquivos' }).fill(relative(root, entry!));
  await page.locator(`.search-results button[title="${entry}"]`).click();
  await page.getByRole('textbox', { name: 'Buscar arquivos' }).fill('');
  await expect(page.locator('.inspector h2')).toHaveText(basename(entry!), { timeout: 30000 });
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await expect(page.locator('.relation-list').first()).toContainText(reference!.name);
  await page.getByRole('button', { name: 'Arquivo', exact: true }).click();
  const firstLine = readFileSync(entry!, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine) await expect(page.locator('.source-code')).toContainText(firstLine.slice(0, 60));
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(page.locator('.audit-counting > summary')).toHaveText(
    'Como estes números são contados',
  );
  if ((model.issues as { code: string }[]).some((issue) => issue.code === 'limit')) {
    await showAudit(page, 'Avisos', 'limit');
    await expect(page.locator('.audit-content')).toContainText('limite');
  }
  // Hierarchy: a direct child folder opened as a second root is shown one level below.
  const nested = (opened.entries as string[]).find((path) => dirname(path) !== root);
  const child = nested
    ? join(root, relative(root, nested).split('/')[0])
    : readdirSync(root, { withFileTypes: true })
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => join(root, item.name))
        .sort()[0];
  if (child) {
    await runProjectsAction(page, 'Adicionar diretório');
    await page.getByRole('textbox', { name: 'Caminho do diretório' }).fill(child);
    await page.getByRole('button', { name: 'Abrir este diretório' }).click();
    await expect(page.locator('.root-meta').last()).toContainText(`${basename(root)} · +1 nível`, {
      timeout: 30000,
    });
  } else
    test.info().annotations.push({
      type: 'sem-hierarquia',
      description: 'A cópia não tem subdiretório visível; a hierarquia não foi exercitada.',
    });
  await page.getByRole('button', { name: 'Recolher painel inferior' }).click();
  await page.getByRole('textbox', { name: 'Buscar arquivos' }).fill(reference!.relative);
  await page.locator(`.search-results button[title="${reference!.id}"]`).click();
  await expect(page.locator('.inspector h2')).toHaveText(reference!.name);
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await expect(page.locator('.relation-list').last()).toContainText(basename(entry!));
  await page.screenshot({ path: test.info().outputPath('copia-real-espaco.png') });
  await page.getByLabel('Buscar arquivos').fill(basename(entry!));
  await page.locator(`.search-results button[title="${entry}"]`).click();
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByLabel('Nome do filtro', { exact: true }).fill('Entrada da cópia');
  await page.getByLabel('Direção do filtro').selectOption('outgoing');
  await page.getByRole('button', { name: 'Salvar e destacar', exact: true }).click();
  await runMoreAction(page, 'Recolher painéis');
  const filterPane = page.getByRole('region', {
    name: 'Vista do filtro Entrada da cópia',
    exact: true,
  });
  await expect(filterPane.locator('.react-flow__edge.filter-matched')).not.toHaveCount(0);
  await expect(filterPane.locator('.filter-summary')).toContainText('relações');
  await expect
    .poll(() =>
      filterPane
        .locator('.file-tile.focused')
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThanOrEqual(180);
  await expect(filterPane.locator('.file-tile.focused')).toBeInViewport({ ratio: 0.9 });
  await page.screenshot({ path: test.info().outputPath('copia-real-filtro.png') });
  const after = copyInventory(root);
  expect(after.rows).toEqual(before.rows);
  expect(errors).toEqual([]);
  writeFileSync(
    test.info().outputPath('copia-real-somente-leitura.json'),
    JSON.stringify(
      {
        root,
        testedAt: new Date().toISOString(),
        elapsedSeconds: (Date.now() - start) / 1000,
        inventory: {
          entries: before.entries,
          hashedBytes: before.hashedBytes,
          unhashedFiles: before.unhashed,
          truncated: before.truncated,
          digestBefore: before.digest,
          digestAfter: after.digest,
        },
        hierarchyExercised: Boolean(child),
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
});
