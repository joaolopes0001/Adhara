import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateFilter, readFilters, FILTER_NODE_LIMIT } from '../../src/mapFilters';
import type { MapFilter } from '../../src/mapFilters';
import { contextualGraph, pathLayers } from '../../src/graphLayout';
import { folderSums } from '../../src/folderMap';
import type { Model, Relation } from '../../src/types';
import { runMoreAction, runProjectsAction } from './more-menu';
import { sessionHeaders } from './helpers';

const edge = (
  source: string,
  target: string,
  kind = 'markdown',
  id = source + '>' + target,
): Relation => ({
  id,
  source,
  target,
  kind,
  line: 2,
  origin: source,
  evidence: target,
  raw: target,
  confidence: 'deterministic',
  resolvedBy: 'file',
});
function model(names: string[], edges: Relation[]): Model {
  return {
    nodes: names.map((path) => ({
      id: path,
      path,
      name: path.split('/').at(-1)!,
      relative: path.slice(3),
      root: '/r',
      roots: ['/r'],
      kind: 'file',
      status: 'resolved',
    })),
    edges,
    roots: [{ path: '/r', name: 'r', parent: null, level: 0, entries: [names[0]] }],
    savedCases: [],
    objects: [],
    issues: [],
    signals: [],
    scope: { source: null, patterns: [] },
    notes: {},
    delta: null,
    expected: {},
    editing: {},
    restoreErrors: [],
    stats: {
      files: names.length,
      parsed: names.length,
      edges: edges.length,
      entries: 1,
      resolution: {
        file: edges.length,
        skill: 0,
        root: 0,
        'root-dot': 0,
        basename: 0,
        suffix: 0,
        'skill-basename': 0,
        'skill-suffix': 0,
        'frontmatter-name': 0,
        unresolved: 0,
      },
      structure: {
        cycles: 0,
        selfReferences: 0,
        repeatedReferences: 0,
        highFanout: 0,
        fanoutThreshold: 12,
        maxFanout: null,
      },
      reachability: null,
    } as unknown as Model['stats'],
    policy: {
      excluded: [],
      maxNodes: 20000,
      maxFileBytes: 1048576,
      maxTextBytes: 33554432,
      ai: false,
    },
  };
}
const filter = (
  files: string[],
  kind: MapFilter['kind'] = 'connections',
  direction: MapFilter['direction'] = 'both',
): MapFilter => ({ id: 'test', name: 'Test', files, kind, direction, conventions: false });

test('manual filters: exact paths, incoming/outgoing, conventions and source model unchanged', () => {
  const a = '/r/CLAUDE.md',
    b = '/r/child/CLAUDE.md',
    c = '/r/c.md',
    d = '/r/d.md';
  const original = model(
    [a, b, c, d],
    [edge(a, c), edge(c, a), edge(b, d), edge(a, d, 'scope'), edge(a, c, 'import', 'duplicate')],
  );
  const before = JSON.stringify(original);
  const outgoing = evaluateFilter(original, filter([a], 'connections', 'outgoing'));
  expect([...outgoing.edges]).toEqual([a + '>' + c, 'duplicate']);
  expect(outgoing.nodes.has(b)).toBe(false);
  expect([...evaluateFilter(original, filter([a], 'connections', 'incoming')).edges]).toEqual([
    c + '>' + a,
  ]);
  expect(evaluateFilter(original, { ...filter([a]), conventions: true }).edges.size).toBe(4);
  expect(JSON.stringify(original)).toBe(before);
});

test('manual filters: shortest paths across n files, reverse traversal, cycles and disconnected endpoints', () => {
  const [a, b, c, d, x] = ['a', 'b', 'c', 'd', 'x'].map((n) => `/r/${n}.md`);
  const graph = model(
    [a, b, c, d, x],
    [edge(a, b), edge(b, c), edge(c, d), edge(b, a), edge(a, b, 'import', 'duplicate')],
  );
  const directed = evaluateFilter(graph, filter([a, c, d, x], 'paths', 'outgoing'));
  expect(directed.nodes.has(b)).toBe(true);
  expect(directed.edges).toEqual(new Set([a + '>' + b, b + '>' + c, c + '>' + d, 'duplicate']));
  expect(directed.disconnected).toContainEqual([d, a]);
  expect(directed.disconnected).toContainEqual([a, x]);
  const reverse = evaluateFilter(graph, filter([d, a], 'paths', 'both'));
  expect(reverse.reversed.has(c + '>' + d)).toBe(true);
  expect(reverse.disconnected).toEqual([]);
  const isolated = contextualGraph(graph, a, null, false, '', reverse, true);
  expect(
    isolated.bundles
      .flatMap((bundle) => bundle.relations)
      .map((edge) => edge.id)
      .sort(),
  ).toEqual([...reverse.edges].sort());
  expect(isolated.files.some((file) => file.id === x)).toBe(false);
  const layers = pathLayers(graph.nodes, graph.edges, a);
  expect(layers.get(a)).toBeLessThan(layers.get(b)!);
  expect(layers.get(b)).toBeLessThan(layers.get(c)!);
  expect(layers.get(c)).toBeLessThan(layers.get(d)!);
  expect(evaluateFilter(graph, filter([a, a], 'paths')).edges.size).toBe(0);
});

test('manual filters: complete long paths, explicit limits, missing files and exhausted search never mean no path', () => {
  const names = Array.from({ length: 95 }, (_, i) => `/r/${i}.md`);
  const graph = model(
    names,
    names.slice(1).map((target, i) => edge(names[i], target)),
  );
  const result = evaluateFilter(graph, filter([names[0], names.at(-1)!], 'paths', 'outgoing'));
  expect(result.nodes.size).toBe(95);
  expect(result.edges.size).toBe(94);
  expect(contextualGraph(graph, names[0], null, false, '', result, true).files).toHaveLength(95);
  const limited = evaluateFilter(graph, filter([names[0], names.at(-1)!], 'paths'), 3);
  expect(limited.limited).toBe(true);
  expect(limited.disconnected).toEqual([]);
  const denseNames = Array.from({ length: 300 }, (_, i) => `/r/${i}.md`);
  const dense = model(
    denseNames,
    denseNames.slice(1).map((target) => edge(denseNames[0], target)),
  );
  const capped = evaluateFilter(dense, filter([denseNames[0]]));
  expect(capped.nodes.size).toBe(FILTER_NODE_LIMIT);
  expect(capped.limited).toBe(true);
  expect(capped.omitted).toBe(300 - FILTER_NODE_LIMIT);
  const long = model(
    denseNames,
    denseNames.slice(1).map((target, i) => edge(denseNames[i], target)),
  );
  const rejected = evaluateFilter(long, filter([denseNames[0], denseNames.at(-1)!], 'paths'));
  expect(rejected.edges.size).toBe(0);
  expect(rejected.omitted).toBe(1);
  expect(rejected.limited).toBe(true);
  expect(evaluateFilter(graph, filter(['/r/deleted.md'])).missing).toEqual(['/r/deleted.md']);
  // Browser storage can be unavailable (including when evaluated outside a browser).
  expect(readFilters()).toEqual([]);
});

test('directory map: immediate children, current directory excluded, nested scopes and limits explicit', () => {
  const graph = model(['/r', '/r/CLAUDE.md', '/r/child', '/r/child/CLAUDE.md'], []);
  graph.nodes[0].kind = graph.nodes[2].kind = 'directory';
  // The map of a folder is its items (src/folderMap.ts): the direct children, never the folder itself.
  const content = folderSums(graph, '/r', false);
  expect(content.items.map((item) => item.id)).toEqual(['/r/child', '/r/CLAUDE.md']);
  expect(content.items.some((item) => item.id === '/r')).toBe(false);
});

test('map first: directory identity, manual highlight, independent views, themes and persisted filters', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-map-first-')), 'large-house');
  mkdirSync(join(root, 'child'), { recursive: true });
  const files: Record<string, string> = {
    'CLAUDE.md': '# Main\n[Current directory](.)\n[Bridge](bridge.md)\n[Again](bridge.md)\n',
    'AGENTS.md': '# Other\n[Unrelated](other.md)\n[Bridge](bridge.md)\n',
    'bridge.md': '# Bridge\n[End](end.md)\n',
    'end.md': '# End\n',
    'other.md': '# Other\n',
    'isolated.md': '# Alone\n',
    'child/CLAUDE.md': '# Nested\n[Child target](deep.md)\n',
    'child/deep.md': '# Deep\n',
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
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
  // Opening selects no file: the view lists the folder; the file is chosen next.
  await expect(page.getByRole('region', { name: 'Estrutura de large-house' })).toBeVisible();
  await expect(page.locator('.bottom-panel')).toHaveCount(0);
  // The file chosen in the tree keeps the Estrutura; its map is one switch away.
  await page.locator(`.tree-item[title="${root}/CLAUDE.md"]`).click();
  await page.getByRole('button', { name: 'Mapa de large-house', exact: true }).click();
  const canvas = page.locator('.workspace-pane:not([aria-hidden="true"]) .canvas-wrap');
  const initialBox = (await canvas.boundingBox())!;
  expect(initialBox.y).toBeLessThanOrEqual(125);
  // The persistent view/tool dock takes space from the canvas.
  expect(initialBox.height).toBeGreaterThanOrEqual(page.viewportSize()!.height * 0.75);
  await expect(page.locator('.file-tile.directory')).toContainText('Este diretório (.)');
  await expect(page.locator('.file-tile.directory')).toContainText('Referência ao diretório atual');
  await expect(page.locator('.file-tile.directory .tile-path')).toHaveText(root);
  await expect(
    page.locator('.workspace-pane:not([aria-hidden="true"]) .react-flow__node-root'),
  ).toHaveCount(0);
  await page.locator('.file-tile.directory').click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('large-house');
  // The folder tile of a map opens the map of its direct children (the view keeps its mode); its
  // structure is one click away, and back.
  await expect(
    page.getByRole('button', { name: 'Mapa de large-house', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.canvas-caption')).toContainText(
    'Referências somadas entre os itens de large-house',
  );
  await page.getByRole('button', { name: 'Estrutura de large-house', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Estrutura de large-house' })).toBeVisible();
  await page.getByRole('button', { name: 'Mapa de large-house', exact: true }).click();
  await expect(page.locator('.canvas-caption')).toContainText(
    'Referências somadas entre os itens de large-house',
  );
  const paths = await page
    .locator('.workspace-pane:not([aria-hidden="true"]) .file-tile .tile-name strong')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('title')));
  expect(paths).not.toContain(root);
  expect(paths).not.toContain(join(root, 'child/deep.md'));
  // `child` references only inside itself: it is an item of the folder, in the line under the map.
  expect(paths).not.toContain(join(root, 'child'));
  await expect(
    page.locator(
      `.workspace-pane:not([aria-hidden="true"]) .folder-strip-item[title="${join(root, 'child')}"]`,
    ),
  ).toContainText('1 interna');
  // The reference of CLAUDE.md to the folder itself keeps its identity, outside the items.
  await expect(
    page.locator('.workspace-pane:not([aria-hidden="true"]) .outside-group[data-kind="self"]'),
  ).toContainText('Este diretório (.)');
  await page.locator(`.tree-item[title="${root}/CLAUDE.md"]`).click();
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByLabel('Nome do filtro', { exact: true }).fill('CLAUDE principal');
  await page.getByLabel('Direção do filtro').selectOption('outgoing');
  await page.getByRole('button', { name: 'Salvar e destacar', exact: true }).click();
  const highlighted = page.locator('.workspace-pane[data-pane-id^="highlight:"] .filter-pane');
  await expect(highlighted.locator('.react-flow__edge.filter-matched')).toHaveCount(2);
  await expect(highlighted.locator('.react-flow__edge.filter-dimmed')).not.toHaveCount(0);
  const opacity = await highlighted
    .locator('.react-flow__edge.filter-dimmed path.react-flow__edge-path')
    .first()
    .evaluate((element) => getComputedStyle(element).opacity);
  expect(Number(opacity)).toBeLessThan(0.2);
  await page.screenshot({ path: test.info().outputPath('map-filter-highlight.png') });
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir vista', exact: true }).click();
  const pane = page.locator('.workspace-pane[data-pane-id^="filter:"] .filter-pane');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.react-flow__edge.filter-dimmed')).toHaveCount(0);
  await expect(pane.locator('.file-tile')).toHaveCount(3);
  await expect(pane.locator('.tile-name')).not.toContainText(['child/CLAUDE.md']);
  await pane
    .getByRole('button', {
      name: '2 relações de CLAUDE.md para bridge.md. Ver evidências',
      exact: true,
    })
    .click();
  await expect(
    pane.getByRole('region', { name: 'Evidências da conexão' }).locator('div > button'),
  ).toHaveCount(2);
  await pane.getByRole('button', { name: /linha 3/ }).click();
  await expect(page.locator('.inspector')).toContainText('[Bridge](bridge.md)');
  await runMoreAction(page, 'Recolher inspetor');
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByRole('button', { name: 'Novo filtro', exact: true }).click();
  // A new filter starts with the selected file. Replace it with explicit endpoints.
  for (const button of await page.locator('.filter-files button').all()) await button.click();
  await page.getByLabel('Nome do filtro', { exact: true }).fill('Caminhos escolhidos');
  await page.getByLabel('Tipo de filtro').selectOption('paths');
  for (const name of ['CLAUDE.md', 'end.md', 'isolated.md']) {
    await page.getByLabel('Buscar arquivo para filtro').fill(name);
    await page.locator(`.filter-candidates button[title="${root}/${name}"]`).click();
  }
  await expect(page.locator('.filter-files > div')).toHaveCount(3);
  await page.getByRole('button', { name: 'Salvar e abrir vista', exact: true }).click();
  const pathsPane = page.getByRole('region', {
    name: 'Vista do filtro Caminhos escolhidos',
    exact: true,
  });
  await expect(pathsPane.locator('.file-tile')).toHaveCount(4);
  await expect(pathsPane.locator('.react-flow__edge')).toHaveCount(2);
  await expect(pathsPane.locator('.filter-summary')).toContainText('2 avisos');
  await pathsPane.locator('.filter-summary > summary').click();
  await expect(pathsPane.locator('.filter-summary')).toContainText('Sem caminho:');
  await pathsPane.locator('.filter-summary > summary').click();
  await page.getByRole('button', { name: 'Fechar destaque CLAUDE principal' }).click();
  await expect(page.locator('.workspace-pane:not([aria-hidden="true"]) .scope-pane')).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Fechar vista CLAUDE principal' }).click();
  await expect(pathsPane).toHaveCount(1);
  await runMoreAction(page, 'Recolher painéis');
  await page.screenshot({ path: test.info().outputPath('map-filter-views.png') });
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(pathsPane.locator('.react-flow')).toHaveClass(/light/);
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
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
  const compactPane = (await pathsPane.boundingBox())!;
  expect((await pathsPane.locator('.canvas-wrap').boundingBox())!.height).toBeGreaterThanOrEqual(
    compactPane.height * 0.75,
  );
  await expect(pathsPane.locator('.file-tile').first()).toBeInViewport({ ratio: 0.5 });
  await page.screenshot({ path: test.info().outputPath('map-filter-compact-light.png') });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await expect(page.locator('.saved-filters > div')).toHaveCount(2);
  await page.getByRole('button', { name: 'Editar filtro Caminhos escolhidos' }).click();
  await expect(page.locator('.filter-files > div')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1536, height: 960 });
  await runMoreAction(page, 'Ativar tema escuro');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const [name, body] of Object.entries(files))
    expect(readFileSync(join(root, name), 'utf8')).toBe(body);
  // A file removed externally is reported after refresh; a saved path isn't silently replaced.
  unlinkSync(join(root, 'isolated.md'));
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page
    .locator('.saved-filters > div')
    .filter({ hasText: 'Caminhos escolhidos' })
    .getByRole('button', { name: 'Abrir vista' })
    .click();
  await pathsPane.locator('.filter-summary > summary').click();
  await expect(pathsPane).toContainText(`Arquivo fora dos diretórios abertos: ${root}/isolated.md`);
  expect(errors).toEqual([]);
});

// "Include scope conventions" was cut in half at the bottom of the dialog at 1512×671 with one file
// chosen: the list of files found gives way first, so every field stays whole; past its least height,
// the editor scrolls (an open "targets not found" list, or a lower window).
test('filter dialog: at 1512×671 the last field stays whole; the list of files found gives way first', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-filter-room-')), 'filtros');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# A\n[Missing](missing.md)\n[B](b.md)\n');
  for (const name of ['b', 'c', 'd', 'e', 'f'])
    writeFileSync(join(root, `${name}.md`), `# ${name}\n`);
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const opened of previous.roots)
    await page.request.post('/api/close', { data: { path: opened.path }, headers });
  await page.request.post('/api/open', { data: { path: root }, headers });
  await page.setViewportSize({ width: 1512, height: 671 });
  await page.goto('/');
  await page.locator('main').getByText('filtros', { exact: true }).first().click();
  await page.locator(`.tree-item[title="${root}/AGENTS.md"]`).click();
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Filtros do mapa' });
  await dialog.locator('.filter-candidates button').first().click();
  await expect(dialog.locator('.filter-files > div')).toHaveCount(2);
  const room = () =>
    dialog.evaluate((element) => {
      const editor = element.querySelector('.filter-editor')!;
      const last = element.querySelector('.filter-conventions')!.getBoundingClientRect();
      return {
        overflow: editor.scrollHeight - editor.clientHeight,
        lastInside: last.bottom <= editor.getBoundingClientRect().bottom + 0.5,
        list: element.querySelector('.filter-candidates')!.getBoundingClientRect().height,
      };
    });
  const closed = await room();
  expect(closed.overflow).toBeLessThanOrEqual(0);
  expect(closed.lastInside).toBe(true);
  expect(closed.list).toBeGreaterThanOrEqual(80);
  // Negative: the list never goes below its least height; the editor scrolls instead.
  await dialog.locator('.filter-unresolved summary').click();
  await page.setViewportSize({ width: 1512, height: 520 });
  const open = await room();
  expect(open.list).toBeGreaterThanOrEqual(79.5);
  expect(open.overflow).toBeGreaterThan(0);
});
