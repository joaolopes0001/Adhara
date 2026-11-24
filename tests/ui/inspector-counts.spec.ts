import { expect, test } from '@playwright/test';
import { auditRow, auditTab, openAuditDetail, showAudit } from './audit-list';
import type { Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnlyWithWorkspace, readable, writeTree } from './helpers';
import { runMoreAction } from './more-menu';

// What the inspector counts (distinct files, relations, self-references apart), the audit
// total next to the CLI's, and wikilinks resolved by the name a file declares in its frontmatter.
const files: Record<string, string> = {
  'AGENTS.md':
    '# Pacote\n[P](shared/politica.md)\n[Guia](guide.md)\nVer [[folha-c-slug]] e [[dup-slug]].\nOutra vez: [P](shared/politica.md)\n[Execução](run/saida.md)\n',
  'guide.md': '# Guia\n[P](shared/politica.md)\nVeja `unico.md`.\n',
  'shared/politica.md': '# Política\nVeja [esta política](politica.md).\n[Volta](../AGENTS.md)\n',
  'scripts/check.py': 'print("shared/politica.md")\n',
  'docs/unico.md': '---\nname: unico\n---\n# Único\n',
  'folha_c.md': '---\nname: folha-c-slug\n---\n# Folha C\n',
  'dup_a.md': '---\nname: dup-slug\n---\n# A\n',
  'dup_b.md': '---\nname: dup-slug\n---\n# B\n',
  'agent-architecture.json': JSON.stringify(
    { version: 1, scope: { version: 1, runtimeWorkspace: ['run/'] } },
    null,
    2,
  ),
};

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-inspector-counts-')), 'pacote');
  writeTree(root, files);
  // Listed, never followed, and never counted as a file (as `find -type f`).
  symlinkSync('guide.md', join(root, 'atalho.md'));
  return root;
}

async function search(page: Page, text: string, name: string) {
  // Ctrl+K: the search of the explorer, also on Home, where the explorer comes in only when asked for.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill(text);
  await page.locator('.search-results button', { hasText: name }).first().click();
  await expect(page.locator('.inspector h2')).toHaveText(name.split('/').at(-1)!);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('inspector counts distinct files and relations, keeps self-references apart and matches the map badge', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const listing = readdirSync(root, { recursive: true }).map(String).sort();
  const model = await (await openOnlyWithWorkspace(page, root))();
  await page.goto('/');
  // The footer counts real files like stats.files and `aae audit` metrics.files: the symlink is not one.
  expect(model.nodes.some((node: any) => node.kind === 'symlink')).toBe(true);
  expect([model.stats.files, model.stats.unresolvedTargets]).toEqual([
    Object.keys(files).length,
    1,
  ]);
  await expect(page.locator('.status-bar .status-files')).toHaveText(
    `${model.stats.parsed} de ${model.stats.files} arquivos lidos`,
  );
  await expect(page.locator('.status-bar .status-unresolved')).toHaveText(
    '1 citado não encontrado',
  );
  await search(page, 'shared/politica', 'shared/politica.md');
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const [outgoingHeading, incomingHeading] = [
    page.locator('.relation-heading').first(),
    page.locator('.relation-heading').nth(1),
  ];
  await expect(outgoingHeading.locator('h3')).toHaveText('Para onde aponta');
  await expect(outgoingHeading.locator('.count')).toHaveText('1 destino · 1 relação');
  await expect(outgoingHeading.locator('.self-count')).toHaveText('+ 1 autorreferência');
  // AGENTS.md cites it twice and guide.md once: 2 files, 3 relations; its own link is apart.
  await expect(incomingHeading.locator('h3')).toHaveText('Quem aponta para ele');
  await expect(incomingHeading.locator('.count')).toHaveText('2 arquivos · 3 relações');
  await expect(incomingHeading.locator('.self-count')).toHaveText('+ 1 autorreferência');
  // One line per citing file: AGENTS.md's two citations share a line, each line number with its evidence.
  const incoming = page.locator('.relation-list').nth(1).locator('.relation-row');
  await expect(incoming).toHaveCount(3);
  await expect(incoming.filter({ hasText: 'AGENTS.md' }).locator('.relation-evidence')).toHaveCount(
    2,
  );
  await expect(incoming.last().locator('.self-mark')).toHaveText('autorreferência');
  await expect(incoming.last().locator('.relation-target')).toContainText('politica.md');
  await expect(page.locator('.relation-list').nth(1).locator('.self-mark')).toHaveCount(1);
  await expect(page.locator('.relation-scope-note')).toContainText(
    '.md, .markdown, .txt, .json, .yaml, .yml, .toml',
  );
  await expect(page.locator('.relation-scope-note')).toContainText('scripts (.py, .sh…)');
  // The map badge counts relations, self-reference included in both directions; the counting rule
  // itself is said once, in the status bar, not on every card.
  const badge = page.locator('.file-tile.focused .tile-foot > span').last();
  await expect(badge).toHaveText(/↙ 4\s*↗ 2/);
  await expect(badge).toHaveAttribute('title', '↙ 4 de entrada · ↗ 2 de saída');
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of [
      '.relation-heading .count',
      '.relation-heading .self-count',
      '.relation-scope-note',
      '.self-mark',
    ])
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await page
      .locator('.inspector')
      .screenshot({ path: test.info().outputPath(`inspector-counts-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }

  // A script is inventoried but never read for references; citations inside it are not relations.
  await page.getByLabel('Limpar busca').click();
  await search(page, 'scripts/check', 'scripts/check.py');
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await expect(page.locator('.relation-heading').first().locator('.count')).toHaveText(
    '0 destinos · 0 relações',
  );
  await expect(page.locator('.relation-list').first()).toContainText('Tipo não lido (.py)');
  for (const [name, text] of Object.entries(files))
    expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(listing);
  expect(errors).toEqual([]);
});

test('audit header explains the CLI total with the resolution notes of the same reading', async ({
  page,
}) => {
  const root = fixture();
  const workspace = await openOnlyWithWorkspace(page, root);
  const model = await workspace();
  const cli = spawnSync('python3', ['-B', 'scripts/aae.py', 'audit', '--root', root, '--summary'], {
    encoding: 'utf8',
  });
  const total = JSON.parse(cli.stdout).summary.total;
  expect(JSON.parse(cli.stdout).summary.byCode).toMatchObject({
    'basename-resolved': 1,
    'declared-external': 1,
  });
  expect(total).toBe(model.issues.length + 2);
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(auditTab(page, 'Todas')).toHaveText(`Todas ${model.issues.length}`);
  // The note is in "Como estes números são contados", closed by default.
  const counting = page.locator('details.audit-counting');
  await expect(counting).not.toHaveAttribute('open', /.*/);
  const note = page.locator('.audit-cli-note');
  await expect(note).toBeHidden();
  await counting.locator('summary').click();
  await expect(note).toHaveText(
    `O aae audit conta ${total}: estas ${model.issues.length} observações, 1 resolução por nome ou sufixo único e 1 referência absorvida pelo escopo declarado.`,
  );
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await readable(note), theme).toBeGreaterThanOrEqual(4.5);
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  // The section is one for the whole audit: it stays with every level.
  await showAudit(page, 'Todas');
  await expect(note).toBeVisible();
});

test('wikilink resolved by the declared frontmatter name: label, note without guess warning, declared name and ambiguity candidates', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const workspace = await openOnlyWithWorkspace(page, root);
  const model = await workspace();
  const edge = model.edges.find((item: any) => item.raw === 'folha-c-slug');
  expect([edge.target, edge.resolvedBy]).toEqual([join(root, 'folha_c.md'), 'frontmatter-name']);
  await page.goto('/');
  // Home lists the projects, without the explorer: the tree is in the project.
  await enterProject(page);
  await page.locator('.explorer').getByTitle(join(root, 'AGENTS.md'), { exact: true }).click();
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const row = page
    .locator('.relation-list')
    .first()
    .locator('.relation-row', { hasText: 'folha_c.md' });
  await expect(row.locator('.resolution-mark')).toHaveText(
    '(resolvida pelo nome declarado no frontmatter)',
  );
  await row.locator('.relation-evidence').click();
  const evidenceNote = page.locator('.evidence-item .resolution-note');
  await expect(evidenceNote).toContainText('Resolvida pelo nome declarado no frontmatter.');
  await expect(evidenceNote).toContainText('identidade declarada pelo destino');
  await expect(evidenceNote).not.toContainText('Confira se é o destino pretendido');
  await page.locator('.evidence-item').getByRole('button', { name: 'folha_c.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('folha_c.md');
  await expect(page.locator('.declared-name')).toHaveText('Nome declarado: folha-c-slug');
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await readable(page.locator('.declared-name')), theme).toBeGreaterThanOrEqual(4.5);
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  // A declared name equal to the file name adds nothing.
  await search(page, 'docs/unico', 'docs/unico.md');
  await expect(page.locator('.declared-name')).toHaveCount(0);
  await page.getByLabel('Limpar busca').click();

  // Two files declaring the same name: ambiguous, every candidate listed, none chosen.
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await showAudit(page, 'Todas', 'ambiguous');
  const ambiguity = await openAuditDetail(auditRow(page, 'dup-slug'));
  await expect(ambiguity.locator('.diagnosis-searched')).toHaveText(
    '2 arquivos do projeto declaram name: dup-slug no frontmatter.',
  );
  await expect(ambiguity.locator('.diagnosis-candidates button')).toHaveText([
    'dup_a.md',
    'dup_b.md',
  ]);
  await ambiguity.getByRole('button', { name: 'dup_b.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('dup_b.md');
  await expect(page.locator('.declared-name')).toHaveText('Nome declarado: dup-slug');
  expect(errors).toEqual([]);
});
