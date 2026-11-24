import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleRelations,
  contextualGraph,
  positionFiles,
  TILE_HEIGHT,
  TILE_WIDTH,
} from '../../src/graphLayout';
import type { FileNode, Model, Relation, Trace } from '../../src/types';
import { moreButton, runProjectsAction } from './more-menu';
import { sessionHeaders, showMap } from './helpers';

const file = (id: string): FileNode => ({
  id,
  path: id,
  name: id.split('/').at(-1)!,
  relative: id,
  kind: 'file',
  status: 'resolved',
  root: '/fixture',
  roots: ['/fixture'],
});
const edge = (id: string, source: string, target: string, kind = 'markdown'): Relation => ({
  id,
  source,
  target,
  kind,
  line: Number(id.replace(/\D/g, '')) || 1,
  origin: source,
  raw: target,
  evidence: target,
  confidence: 'deterministic',
  resolvedBy: 'file',
});
const model = (nodes: FileNode[], edges: Relation[]): Model => ({
  nodes,
  edges,
  roots: [{ path: '/fixture', name: 'fixture', parent: null, level: 0, entries: [nodes[0].id] }],
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
    files: nodes.length,
    parsed: nodes.length,
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
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('canvas layout: dense directional context has no overlapping file rectangles', () => {
  const nodes = Array.from({ length: 24 }, (_, i) => file(`/fixture/${i}.md`));
  const edges = nodes
    .slice(1)
    .map((node, i) =>
      i < 10 ? edge(`e${i}`, node.id, nodes[0].id) : edge(`e${i}`, nodes[0].id, node.id),
    );
  const placed = positionFiles(nodes, nodes[0].id, edges, null);
  const focus = placed.positions.get(nodes[0].id)!;
  for (const relation of edges) {
    const source = placed.positions.get(relation.source)!;
    const target = placed.positions.get(relation.target)!;
    expect(source.x).toBeLessThan(target.x);
  }
  expect(focus.x).toBeGreaterThan(40);
  const values = [...placed.positions.values()];
  for (let a = 0; a < values.length; a++)
    for (let b = a + 1; b < values.length; b++) {
      expect(
        Math.abs(values[a].x - values[b].x) >= TILE_WIDTH ||
          Math.abs(values[a].y - values[b].y) >= TILE_HEIGHT,
      ).toBe(true);
    }
});

test('canvas layout: preserves every long trace step, inverse direction and duplicate evidence', () => {
  const nodes = Array.from({ length: 90 }, (_, i) => file(`/fixture/${i}.md`));
  const edges = nodes
    .slice(1)
    .map((node, i) => edge(`e${i}`, node.id, nodes[i].id, i === 1 ? 'scope' : 'markdown'));
  edges.push(edge('duplicate', nodes[1].id, nodes[0].id, 'import'));
  const trace: Trace = {
    found: true,
    nodes: nodes.map((node) => node.id),
    steps: edges.slice(0, -1).map((edge) => ({ edge: edge.id, reverse: true })),
  };
  const graph = contextualGraph(model(nodes, edges), nodes[0].id, trace, false, '');
  expect(graph.files).toHaveLength(90);
  expect(graph.bundles).toHaveLength(89);
  expect(graph.bundles.flatMap((bundle) => bundle.relations)).toHaveLength(90);
  expect(graph.bundles.flatMap((bundle) => bundle.steps)).toEqual(
    trace.steps.map((_, i) => ({ index: i + 1, reverse: true })),
  );
  expect(graph.bundles[0].relations).toHaveLength(2);
  const positions = positionFiles(graph.files, nodes[0].id, graph.allowed, trace).positions;
  expect(
    [...positions.values()].every((position, i, all) => i === 0 || position.x > all[i - 1].x),
  ).toBe(true);
  expect(
    bundleRelations([edges[0], edge('opposite', edges[0].target, edges[0].source)], null),
  ).toHaveLength(2);
});

test('canvas layout: counts omitted neighbors without losing evidence for shown pairs', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => file(`/fixture/${i}.md`));
  const edges = nodes.slice(1).map((node, i) => edge(`e${i}`, nodes[0].id, node.id));
  edges.push(edge('duplicate', nodes[0].id, nodes[1].id));
  const graph = contextualGraph(model(nodes, edges), nodes[0].id, null, false, '');
  expect(graph.files).toHaveLength(24);
  expect(graph.hidden).toBe(16);
  expect(graph.bundles[0].relations).toHaveLength(2);
});

test('canvas layout: short and zero-step traces retain space for contextual neighbors', () => {
  const nodes = [file('/fixture/a.md'), file('/fixture/b.md'), file('/fixture/c.md')];
  const edges = [edge('e1', nodes[0].id, nodes[1].id), edge('e2', nodes[0].id, nodes[2].id)];
  for (const trace of [
    { found: true, nodes: [nodes[0].id], steps: [] },
    { found: true, nodes: [nodes[0].id, nodes[1].id], steps: [{ edge: 'e1', reverse: false }] },
  ]) {
    const graph = contextualGraph(model(nodes, edges), nodes[0].id, trace, false, '');
    expect(positionFiles(graph.files, nodes[0].id, edges, trace).positions.size).toBe(3);
  }
});

test('canvas browser: repeated references expose each original evidence and inverse trace', async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'aae-canvas-'));
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# Instructions\n[First](target.md)\n[Second](target.md)\n[Third](target.md)\n',
  );
  writeFileSync(join(root, 'target.md'), '# Target\n');
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const opened of previous.roots)
    await page.request.post('/api/close', { data: { path: opened.path }, headers });
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  // Opening selects no file; clicking AGENTS.md in the structure selects it (the list stays and the
  // inspector opens), and the switch shows its map.
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await showMap(page);
  await expect
    .poll(() =>
      page
        .locator('.file-tile.focused')
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThanOrEqual(180);
  const badge = page.getByRole('button', {
    name: '3 relações de AGENTS.md para target.md. Ver evidências',
    exact: true,
  });
  await expect(badge).toBeVisible();
  await badge.click();
  const picker = page.getByRole('region', { name: 'Evidências da conexão' });
  await expect(picker.locator('div > button')).toHaveCount(3);
  await picker.getByRole('button', { name: /linha 3/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.inspector')).toContainText('[Second](target.md)');
  const boxes = await page.locator('.react-flow__node-file').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  );
  expect(boxes).toHaveLength(2);
  expect(
    boxes[0].right <= boxes[1].left ||
      boxes[1].right <= boxes[0].left ||
      boxes[0].bottom <= boxes[1].top ||
      boxes[1].bottom <= boxes[0].top,
  ).toBe(true);
  await page.setViewportSize({ width: 749, height: 540 });
  await moreButton(page).click();
  await expect(page.getByRole('menuitem', { name: 'Mostrar explorador' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+b');
  await expect(page.locator('.contextual-canvas')).toHaveClass(/compact-context/);
  await expect
    .poll(() =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
    )
    .toBeGreaterThanOrEqual(0.74);
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await page.getByLabel('Arquivo de origem A').fill(join(root, 'target.md'));
  await page.getByLabel('Arquivo de destino B').fill(join(root, 'AGENTS.md'));
  await page.getByLabel('Direção do caminho').selectOption('undirected');
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('.trace-bundle')).toContainText('inverso');
  await expect(page.locator('.trace-bundle')).toContainText('3 relações');
  await page.request.post('/api/close', { headers, data: { path: root } });
});

test('canvas browser: self reference bends outside its own file tile', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'aae-canvas-loop-'));
  writeFileSync(join(root, 'AGENTS.md'), '# Entry\n[Self](AGENTS.md)\n');
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const opened of previous.roots)
    await page.request.post('/api/close', { data: { path: opened.path }, headers });
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  // Opening selects no file; clicking AGENTS.md in the structure selects it, and the switch shows its map.
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await showMap(page);
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(1);
  const geometry = await page.locator('.react-flow__edge-path').evaluate((element) => {
    const path = element as SVGPathElement;
    const tile = document.querySelector('.file-tile')!.getBoundingClientRect();
    const points = Array.from({ length: 9 }, (_, i) => {
      const point = path.getPointAtLength((path.getTotalLength() * (i + 1)) / 10);
      return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    });
    return {
      length: path.getTotalLength(),
      crosses: points.some(
        (point) =>
          point.x > tile.left + 2 &&
          point.x < tile.right - 2 &&
          point.y > tile.top + 2 &&
          point.y < tile.bottom - 2,
      ),
    };
  });
  expect(geometry.length).toBeGreaterThan(100);
  expect(geometry.crosses).toBe(false);
  await page.request.post('/api/close', { headers, data: { path: root } });
});
