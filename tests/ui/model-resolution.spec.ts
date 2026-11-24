import { expect, test } from '@playwright/test';
import { observationCodes } from '../../src/observations';
import {
  auditFiles,
  auditRow,
  auditRows,
  auditTab,
  openAllAuditFiles,
  openAuditDetail,
  showAudit,
} from './audit-list';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALERT_ICONS,
  expectAuditLineColours,
  openOnlyWithWorkspace,
  readable,
  writeTree,
} from './helpers';
import { runMoreAction } from './more-menu';

// Synthetic package: root-relative and unique-name references, a declared runtime
// workspace, an unused declared pattern, orphans, islands, an ambiguity and cycles.
const files: Record<string, string> = {
  'AGENTS.md':
    '# Pacote\n[Equipe](team/AGENTS.md)\n[Guia](docs/guide.md)\n[Guia de novo](docs/guide.md)\n[Execução](workspace/run.md)\n[Ausente](missing.md)\nVeja `./notes/`.\nCritérios: `criterios.md`.\n',
  'team/AGENTS.md': '# Equipe\n[SLA](policies/sla.md)\n',
  'policies/sla.md': '# SLA\n',
  'policies/criterios.md': '# Critérios B\n',
  'docs/guide.md': '# Guia\n[Volta](../AGENTS.md)\nPrazo: `sla.md`\n',
  'docs/criterios.md': '# Critérios A\n',
  'notes/orphan.md': '# Esquecido\n',
  'workspace/README.md': '# Área de trabalho\n',
  'archive/a.md': '# A\n[B](b.md)\n',
  'archive/b.md': '# B\n[A](a.md)\n',
  'agent-architecture.json': JSON.stringify(
    {
      version: 1,
      scope: { version: 1, runtimeWorkspace: ['workspace/'], localFiles: ['config/*.local.json'] },
    },
    null,
    2,
  ),
};

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-model-resolution-')), 'pacote');
  writeTree(root, files);
  return root;
}

function unchanged(root: string, listing: string[]) {
  for (const [name, text] of Object.entries(files))
    expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(listing);
}

/** Text color against the first opaque background up the tree. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 470 }),
      );
  });
});

test('model resolution: root-relative and unique-name references are shown on the relation; declared scope keeps placeholders out of the tree', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const listing = readdirSync(root, { recursive: true }).map(String).sort();
  const workspace = await openOnlyWithWorkspace(page, root);
  const model = await workspace();
  const edge = (source: string, target: string) =>
    model.edges.find(
      (item: any) => item.source === join(root, source) && item.target === join(root, target),
    );
  expect(edge('team/AGENTS.md', 'policies/sla.md').resolvedBy).toBe('root');
  expect(edge('docs/guide.md', 'policies/sla.md').resolvedBy).toBe('basename');
  expect(edge('AGENTS.md', 'workspace/run.md').declared).toEqual({
    kind: 'runtimeWorkspace',
    pattern: 'workspace/',
  });
  expect(model.nodes.find((node: any) => node.id === join(root, 'workspace/run.md')).status).toBe(
    'declared',
  );
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // (a) A root-relative reference written in a subfolder resolves, and the target lists the entry as a source.
  // The app opens on Home: Ctrl+K brings the explorer with its search.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('policies/sla');
  await page.locator('.search-results button', { hasText: 'policies/sla.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('sla.md');
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await expect(page.locator('.relation-heading').nth(1)).toContainText('Quem aponta para ele');
  await expect(page.locator('.relation-heading').nth(1).locator('.count')).toHaveText(
    '2 arquivos · 2 relações',
  );
  const incoming = page.locator('.relation-list').last();
  const fromEntry = incoming.locator('.relation-row', { hasText: 'team/AGENTS.md' });
  await expect(fromEntry).toContainText('AGENTS.md');
  await expect(fromEntry.locator('.resolution-mark')).toContainText('resolvida pela raiz aberta');
  await expect(
    incoming.locator('.relation-row', { hasText: 'docs/guide.md' }).locator('.resolution-mark'),
  ).toContainText('resolvida por nome único');
  await page
    .locator('.inspector')
    .screenshot({ path: test.info().outputPath('relations-resolution-dark.png') });
  await incoming
    .locator('.relation-row', { hasText: 'docs/guide.md' })
    .locator('.relation-evidence')
    .click();
  await expect(page.locator('.evidence-item')).toHaveCount(1);
  await expect(page.locator('.evidence-item .resolution-note')).toContainText(
    'Resolvida por nome único.',
  );
  await expect(page.locator('.evidence-item .resolution-note')).toContainText(
    'Confira se é o destino pretendido',
  );

  // (e) Embedded scope declaration: the absorbed target is "declared", not missing, with kind and pattern on the relation.
  await page.getByLabel('Limpar busca').click();
  await page.locator('.explorer').getByTitle(join(root, 'AGENTS.md'), { exact: true }).click();
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const outgoing = page.locator('.relation-list').first();
  await expect(
    outgoing.locator('.relation-row', { hasText: 'run.md' }).locator('.declared-mark'),
  ).toContainText('escopo declarado: workspace/');
  // A missing destination says "não existe"; a name without a file says so apart.
  await expect(outgoing.locator('.relation-row', { hasText: 'run.md' })).not.toContainText(
    'não existe',
  );
  await expect(outgoing.locator('.relation-row', { hasText: 'missing.md' })).toContainText(
    'não existe',
  );
  await outgoing
    .locator('.relation-row', { hasText: 'run.md' })
    .locator('.relation-evidence')
    .click();
  await expect(page.locator('.evidence-item .declared-note')).toContainText('Gerado na execução');
  await expect(page.locator('.evidence-item .declared-note')).toContainText('workspace/');
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await outgoing
    .locator('.relation-row', { hasText: 'run.md' })
    .locator('.relation-target')
    .click();
  await expect(page.locator('.inspector h2')).toHaveText('run.md');
  await expect(page.locator('.file-status')).toContainText('Declarado fora do pacote');
  const tile = page.locator('.file-tile.declared').first();
  await expect(tile).toContainText('Declarado fora do pacote');
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await tile.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe(
      'dashed',
    );
    await page.screenshot({ path: test.info().outputPath(`declared-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  // Selecting the placeholder expands its existing folder, yet it is never listed as its content.
  await expect(page.getByRole('button', { name: 'Recolher pasta workspace' })).toBeVisible();
  await expect(page.locator('.explorer .tree-item', { hasText: 'README.md' })).toHaveCount(1);
  await expect(page.locator('.explorer .tree-item', { hasText: 'run.md' })).toHaveCount(0);
  await page.locator('.explorer .tree-item', { hasText: 'workspace' }).click();
  await expect(page.locator('.directory-overview h2')).toHaveText('workspace');
  await expect(page.locator('.directory-child')).toHaveText(['README.md']);
  unchanged(root, listing);
  expect(errors).toEqual([]);
});

test('audit panel: filter totals, unreachable candidates, ambiguity candidates, counted scope and separate structural signals in both themes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const listing = readdirSync(root, { recursive: true }).map(String).sort();
  const workspace = await openOnlyWithWorkspace(page, root);
  const model = await workspace();
  expect(
    model.issues.filter((issue: any) =>
      ['cycle', 'repeated-reference', 'high-fanout'].includes(issue.code),
    ),
  ).toEqual([]);
  expect(model.issues).toHaveLength(8);
  expect(model.signals.map((signal: any) => signal.code).sort()).toEqual([
    'cycle',
    'cycle',
    'repeated-reference',
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  // (d) The tabs count by level and sum to the total: 1 problem, 1 warning, 6 informative, 8 in all.
  await expect(auditTab(page, 'Problemas')).toHaveText('Problemas 1');
  await expect(auditTab(page, 'Avisos')).toHaveText('Avisos 1');
  await expect(auditTab(page, 'Informativos')).toHaveText('Informativos 6');
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 8');
  await showAudit(page, 'Todas');
  await expect(auditRows(page)).toHaveCount(8);
  await showAudit(page, 'Informativos', 'unreachable');
  await expect(page.getByLabel('Tipo de observação').locator('option:checked')).toHaveText(
    'Sem caminho por referência explícita (5)',
  );
  await expect(auditRows(page)).toHaveCount(5);

  // (c) Unreachable candidates: orphan with its referenced ancestor folder, island, and review framing.
  // The meaning once above the list; the counts of the reachability in "Como estes números são contados".
  await expect(page.locator('.audit-type-meaning')).toHaveText(
    observationCodes.unreachable.meaning,
  );
  await page.locator('.audit-counting > summary').click();
  const reach = page.locator('.reachability-note');
  await expect(reach).toContainText('2 pontos de partida');
  await expect(reach).toContainText('1 isento pelo escopo declarado');
  await expect(reach).not.toContainText('análise');
  const orphan = auditRow(page, 'órfão').filter({
    has: page.locator('.file-observation-line[aria-label="Abrir notes/orphan.md"]'),
  });
  await expect(orphan.locator('.file-observation-text')).toHaveText(
    'órfão · nenhum arquivo o cita',
  );
  await expect(
    auditFiles(page).filter({ hasText: 'archive/a.md' }).locator('.file-observation-text'),
  ).toHaveText('ilha · 1 arquivo sem caminho o cita');
  await expect(page.locator('.audit-content')).not.toContainText('inacessível');
  await page.locator('.audit-scope > summary').click();
  await openAuditDetail(orphan);
  for (const theme of ['dark', 'light']) {
    for (const selector of [
      '.audit-level',
      '.audit-type-meaning',
      '.audit-counting > p',
      '.audit-scope > summary',
      '.audit-scope li .audit-tag',
      '.audit-scope li.unused > span:not(.audit-tag)',
      '.audit-observations .file-observation-text',
      '.diagnosis-ancestor',
      '.diagnosis-link',
    ]) {
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // Candidates are informative: no icon; what is written in the normal colour, the rest muted.
    await expect(page.locator('.audit-line.tone-info')).toHaveCount(5);
    await expect(page.locator('.audit-line').locator(ALERT_ICONS)).toHaveCount(0);
    expect(await expectAuditLineColours(page, theme)).toBe(5);
    await page.screenshot({ path: test.info().outputPath(`audit-unreachable-${theme}.png`) });
    await page
      .locator('.tool-panel')
      .screenshot({ path: test.info().outputPath(`audit-panel-unreachable-${theme}.png`) });
    if (theme === 'dark') await runMoreAction(page, 'Ativar tema claro');
  }
  await orphan.getByRole('button', { name: 'notes', exact: true }).click();
  await expect(page.locator('.directory-overview h2')).toHaveText('notes');

  // Ambiguity lists every candidate without choosing one; a candidate is navigable.
  await showAudit(page, 'Todas', 'ambiguous');
  await expect(auditRows(page)).toHaveCount(1);
  const ambiguity = await openAuditDetail(auditRow(page, 'criterios.md'));
  await expect(ambiguity.locator('.diagnosis-candidates button')).toHaveText([
    'docs/criterios.md',
    'policies/criterios.md',
  ]);
  await ambiguity.getByRole('button', { name: 'policies/criterios.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('criterios.md');
  await expect(page.locator('.copy-path code')).toHaveText(join(root, 'policies/criterios.md'));

  // The declaration is counted per pattern, including the one without effect.
  await showAudit(page, 'Avisos', 'scope-unused-pattern');
  await expect(auditRows(page)).toHaveCount(1);
  await expect(auditRows(page).locator('.file-observation-text')).toHaveText('config/*.local.json');
  const unusedPattern = await openAuditDetail(auditRows(page));
  await expect(unusedPattern.locator('.diagnosis-message')).toContainText('config/*.local.json');
  const scope = page.locator('.audit-scope');
  await expect(scope.locator('summary')).toContainText(
    'Escopo declarado em agent-architecture.json · 2 padrões · absorve 1 referência e 1 arquivo · 1 sem efeito',
  );
  await expect(scope.locator('li', { hasText: 'workspace/' })).toContainText(
    '1 referência absorvida · 1 arquivo',
  );
  await expect(scope.locator('li.unused')).toContainText('config/*.local.json');
  await expect(scope.locator('li.unused')).toContainText('Arquivo local');

  // (b) Structural signals live in their own tab and stay outside the observation total.
  await expect(auditTab(page, 'Sinais')).toHaveText('Sinais 3');
  await showAudit(page, 'Sinais');
  const signalType = page.getByLabel('Tipo de sinal');
  expect(
    await signalType
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  ).toEqual(['', 'cycle', 'repeated-reference']);
  await expect(page.locator('.audit-line.signal')).toHaveCount(3);
  await expect(page.locator('.audit-type-meaning')).toContainText(
    'Fora da contagem de observações',
  );
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 8');
  await signalType.selectOption('cycle');
  await openAllAuditFiles(page);
  await expect(page.locator('.audit-line.signal')).toHaveCount(2);
  await page
    .locator('.tool-panel')
    .screenshot({ path: test.info().outputPath('audit-panel-signals-light.png') });
  await runMoreAction(page, 'Ativar tema escuro');
  expect(
    await readable(page.locator('.audit-line.signal .file-observation-text').first()),
  ).toBeGreaterThanOrEqual(4.5);
  await page
    .locator('.tool-panel')
    .screenshot({ path: test.info().outputPath('audit-panel-signals-dark.png') });
  await showAudit(page, 'Todas');
  await expect(auditRows(page)).toHaveCount(8);
  await expect(page.locator('.audit-line.signal')).toHaveCount(0);
  // Two defects, in a tone's colour; the candidates are informative (the ambiguity written as a bare
  // name, `criterios.md`, too). No line has an icon.
  await expect(page.locator('.audit-line:not(.tone-info)')).toHaveCount(2);
  await expect(page.locator('.audit-line.tone-info')).toHaveCount(6);
  await expect(page.locator('.audit-line').locator(ALERT_ICONS)).toHaveCount(0);
  expect(await expectAuditLineColours(page)).toBe(8);
  unchanged(root, listing);
  expect(errors).toEqual([]);
});

test('audit panel: a model without signals, scope or the newer stats blocks still opens the audit', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = '/tmp/aae-legacy-model-fixture';
  const entry = `${root}/AGENTS.md`;
  // A partial model: no signals, no scope, stats without resolution/structure/reachability.
  const legacy = {
    savedCases: [{ path: root, name: 'legado', available: true }],
    roots: [{ path: root, name: 'legado', parent: null, level: 0, entries: [entry] }],
    nodes: [
      {
        id: root,
        path: root,
        name: 'legado',
        relative: '.',
        kind: 'directory',
        status: 'resolved',
        root,
        roots: [root],
      },
      {
        id: entry,
        path: entry,
        name: 'AGENTS.md',
        relative: 'AGENTS.md',
        kind: 'entry',
        status: 'resolved',
        root,
        roots: [root],
      },
    ],
    edges: [],
    objects: [],
    issues: [
      { id: 'i1', code: 'broken', message: 'Referência ausente: nada.md', node: entry, line: 2 },
      {
        id: 'i2',
        code: 'unreachable',
        message: 'Sem caminho por referência explícita.',
        node: `${root}/solto.md`,
        line: null,
      },
    ],
    notes: {},
    restoreErrors: [],
    stats: { files: 1, parsed: 1, edges: 0, entries: 1 },
    policy: {
      excluded: [],
      maxNodes: 20000,
      maxFileBytes: 1048576,
      maxTextBytes: 33554432,
      ai: false,
    },
  };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'session')
      return route.fulfill({
        json: { token: 'test-session', home: '/tmp', defaultParent: '/tmp' },
      });
    if (path === 'workspace' || path === 'refresh') return route.fulfill({ json: legacy });
    if (path === 'content') return route.fulfill({ json: { text: '# Legado', truncated: false } });
    return route.fulfill({ status: 404, json: { error: `Operação inesperada ${path}` } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 2');
  await showAudit(page, 'Todas');
  await expect(auditRows(page)).toHaveCount(2);
  await expect(page.locator('.audit-scope')).toHaveCount(0);
  await showAudit(page, 'Informativos', 'unreachable');
  await expect(page.locator('.reachability-note')).toContainText(
    'a alcançabilidade não foi calculada',
  );
  await expect(page.locator('.audit-line.tone-info')).toHaveCount(1);
  await expect(page.locator('.audit-line').locator(ALERT_ICONS)).toHaveCount(0);
  // No signals in this model: no tab for them.
  await expect(auditTab(page, 'Sinais')).toHaveCount(0);
  // A refresh goes through the same entry point.
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/refresh'));
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await refreshed;
  await showAudit(page, 'Todas');
  await expect(auditRows(page)).toHaveCount(2);
  expect(errors).toEqual([]);
});
