import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeTitle, issueInfo, observationCodes } from '../../src/observations';
import {
  auditFiles,
  auditRow,
  auditRows,
  auditTab,
  openAllAuditFiles,
  openAuditDetail,
  showAudit,
} from './audit-list';
import {
  ALERT_ICONS,
  colorOf,
  enterProject,
  openOnly,
  readable,
  toneColor,
  writeTree,
} from './helpers';
import { runMoreAction } from './more-menu';

// Diagnosis explained and file classes: one dictionary of observation codes (title,
// one-sentence meaning, tone); the facts of a reference (what is written, how when that changes the
// reading, where the reader looked, candidates) in the audit and in the inspector, grouped by type there; markers with count and tone in the tree and in the Estrutura; the audit
// grouped by project with relative paths; a class selector that filters the tree and the Estrutura; class icons
// and distinct memory and skill colors in the legend and on the map.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-diagnosis-'));
  const tree: Record<string, string> = {
    'loja/AGENTS.md':
      '# Loja\nSkill: [gerar](.claude/skills/gerar-release/SKILL.md).\nMemória: [índice](memory/MEMORY.md).\nTermos: [glossário](glossario).\nAncorado: [velho](./docs/velho.md).\nSegredos ficam em `config/segredos.yaml`.\n',
    'loja/.claude/skills/gerar-release/SKILL.md':
      '---\nname: gerar-release\ndescription: Gera notas.\n---\n# Gerar release\n\nUse [o checklist](checklist.md) e escreva o resultado em [notas](notas.md).\n',
    'loja/.claude/skills/revisar-pr/checklist.md': '# Checklist da skill\n',
    'loja/docs/checklist.md': '# Checklist de revisão\n',
    'loja/docs/antigo.md': '# Antigo\n',
    'loja/memory/MEMORY.md': '# Memória\n- [[decisoes]]\n',
    'loja/memory/decisoes.md': '# Decisões\n',
    'loja/agent-architecture.json': '{"objects": []}\n',
    'loja/scripts/build.sh': '#!/bin/sh\necho ok\n',
    'infra/AGENTS.md': '# Infra\n[Política](politicas/ausente.md)\n',
  };
  writeTree(base, tree);
  return { loja: join(base, 'loja'), infra: join(base, 'infra') };
}

/** Text color against the first opaque background up the tree. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('D.1 dictionary: every observation code of the reader and of the compared audit has a Portuguese title, a one-sentence meaning and a tone', () => {
  // Codes the scanner emits as model issues, read from its source so a new code cannot be forgotten.
  const scanner = readFileSync(join(process.cwd(), 'server/scanner.py'), 'utf8');
  const emitted = new Set([...scanner.matchAll(/\bissue\('([a-z-]+)'/g)].map((match) => match[1]));
  expect(emitted.size).toBeGreaterThanOrEqual(10);
  // Findings `aae audit` adds and "Alterações" compares (see cliExtras in AuditPanel.tsx).
  for (const code of [
    ...emitted,
    'analysis-partial',
    'basename-resolved',
    'suffix-resolved',
    'declared-external',
  ]) {
    const entry = observationCodes[code];
    expect(entry, code).toBeDefined();
    for (const field of ['title', 'meaning'] as const)
      expect(entry[field].length, `${code}.${field}`).toBeGreaterThan(8);
    // What it is, in one sentence of about 20 words; why it matters and what to do live in the guide.
    expect(Object.keys(entry).sort(), code).toEqual(['meaning', 'title', 'tone']);
    expect(entry.meaning.split(/\s+/).length, `${code}.meaning`).toBeLessThanOrEqual(22);
    expect(entry.meaning.replace(/\.$/, ''), `${code}.meaning`).not.toMatch(/\.\s/);
    expect(['problem', 'warning', 'info']).toContain(entry.tone);
    // Interface in Portuguese: no internal code in the title.
    expect(entry.title).not.toMatch(/[a-z]+-[a-z]+|broken|unreachable|ambiguous/);
  }
  // Informative codes keep a neutral tone; references to fix are problems. An ambiguity and a destination
  // found only above the opened root are warnings; an ambiguity written as a bare name is informative.
  for (const code of ['unresolved-name', 'unreachable', 'symlink', 'unverified'])
    expect(observationCodes[code].tone).toBe('info');
  for (const code of ['broken', 'invalid-reference', 'manifest'])
    expect(observationCodes[code].tone).toBe('problem');
  for (const code of ['ambiguous', 'outside-root'])
    expect(observationCodes[code].tone).toBe('warning');
  expect(issueInfo({ code: 'ambiguous', form: 'path' }).tone).toBe('warning');
  expect(issueInfo({ code: 'ambiguous', form: 'name' })).toMatchObject({
    title: 'Nome com vários arquivos possíveis',
    tone: 'info',
  });
  // The changes tool names a code by the same dictionary (asserted on screen in changes-flow.spec.ts).
  expect(codeTitle('broken')).toBe('Referência ausente');
  expect(codeTitle('código-futuro')).toBeUndefined();
});

test('D.2–D.4 diagnosis: the audit is grouped by project with relative paths, and each observation shows what is written, how when it matters, where the reader looked and the candidates', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { loja, infra } = fixture();
  const close = await openOnly(page, [loja, infra]);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.status-bar .status-files')).toHaveText(/ de 10 arquivos lidos$/);
  await expect(page.locator('.status-bar .status-unresolved')).toHaveText(
    '5 citados não encontrados',
  );
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  // Tabs by level: 4 problems (3 in loja, 1 in infra) and 5 informative ones; it opens on the problems.
  await expect(auditTab(page, 'Problemas')).toHaveText('Problemas 4');
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Informativos')).toHaveText('Informativos 5');
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 9');
  await expect(auditTab(page, 'Avisos')).toHaveCount(0);

  // One header per project, in the order of the opened projects; one group per file, relative to it.
  await showAudit(page, 'Todas');
  await expect(page.locator('.audit-project strong')).toHaveText(['loja', 'infra']);
  const heads = auditFiles(page).locator('.observation-group-head');
  await expect(heads.locator('strong')).toHaveText([
    'AGENTS.md',
    '.claude/skills/gerar-release/SKILL.md',
    '.claude/skills/revisar-pr/checklist.md',
    'docs/antigo.md',
    'docs/checklist.md',
    'AGENTS.md',
  ]);
  await expect(heads.locator('.observation-group-count')).toHaveText([
    '· 3',
    '· 2',
    '· 1',
    '· 1',
    '· 1',
    '· 1',
  ]);
  // The absolute path stays available in the tooltip.
  await expect(heads.last()).toHaveAttribute('title', join(infra, 'AGENTS.md'));
  // One line per observation: the line, what is written and the type (the meaning is not repeated).
  await expect(auditRow(page, 'checklist.md').locator('.file-observation-line')).toHaveText('L7');
  await expect(auditRow(page, 'checklist.md').locator('.file-observation-type')).toHaveText(
    'Nome com vários arquivos possíveis',
  );
  await expect(auditRow(page, 'politicas/ausente.md').locator('.file-observation-type')).toHaveText(
    'Referência ausente',
  );
  // No icon on a line: what is written takes the colour of a problem, and stays quiet when informative;
  // the tone is said in words by the tab, never on the line.
  const named = auditRow(page, 'glossario');
  await expect(named.locator('.audit-line')).toHaveClass(/tone-info/);
  await expect(page.locator('.audit-observations .tone-chip')).toHaveCount(0);
  await expect(page.locator('.audit-observations .audit-line').locator(ALERT_ICONS)).toHaveCount(0);
  const broken = auditRow(page, 'notas.md');
  await expect(broken.locator('.audit-line')).toHaveClass(/tone-problem/);
  expect(await colorOf(broken.locator('.file-observation-target'))).toBe(
    await toneColor(page, 'problem'),
  );
  expect(await colorOf(named.locator('.file-observation-target'))).not.toBe(
    await toneColor(page, 'problem'),
  );
  // The reader message, which repeats the title, is not on the lines.
  await expect(page.locator('.audit-observations')).not.toContainText('Destino não encontrado');

  // "Só este projeto" from the header, or the project selector; the level and the type are kept.
  await page
    .locator('.audit-project', { hasText: 'infra' })
    .getByRole('button', { name: 'Só este projeto' })
    .click();
  await expect(page.getByLabel('Projeto da auditoria')).toHaveValue(infra);
  await openAllAuditFiles(page);
  await expect(auditRows(page)).toHaveCount(1);
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 1');
  await page.getByLabel('Projeto da auditoria').selectOption(loja);
  await showAudit(page, 'Problemas', 'broken');
  await expect(auditRows(page)).toHaveCount(3);
  await expect(auditTab(page, 'Problemas')).toHaveText('Problemas 3');
  await page.locator('.audit-project').getByRole('button', { name: 'Todos os projetos' }).click();
  await openAllAuditFiles(page);
  await expect(auditRows(page)).toHaveCount(4);
  await showAudit(page, 'Todas');

  // Ambiguous: not found where it is written; the candidates with the path to write.
  const ambiguous = auditRow(page, 'checklist.md');
  // Written as a bare name, the ambiguity is informative and named for what it may be.
  await ambiguous
    .getByRole('button', { name: /^Ver detalhe: Nome com vários arquivos possíveis/ })
    .click();
  const diagnosis = ambiguous.locator('.diagnosis');
  // The meaning of the type once, in the open line (several types are listed); then the facts, without labels.
  await expect(diagnosis.locator('.diagnosis-meaning')).toHaveText(
    issueInfo({ code: 'ambiguous', form: 'name' }).meaning,
  );
  await expect(diagnosis.locator('.diagnosis-written')).toContainText(
    'Use [o checklist](checklist.md) e escreva o resultado em [notas](notas.md).',
  );
  await expect(diagnosis.locator('.diagnosis-searched')).toContainText(
    'Não existe em .claude/skills/gerar-release/checklist.md (a partir da pasta deste arquivo)',
  );
  await expect(diagnosis.locator('.diagnosis-searched')).toContainText(
    '2 arquivos do projeto correspondem',
  );
  await expect(diagnosis.locator('.diagnosis-candidates li')).toHaveText([
    /\.claude\/skills\/revisar-pr\/checklist\.md\s*para citar este, escreva \.\.\/revisar-pr\/checklist\.md/,
    /docs\/checklist\.md\s*para citar este, escreva \.\.\/\.\.\/\.\.\/docs\/checklist\.md/,
  ]);
  // No generic advice: no "why it matters" nor "what to do", no labelled fields.
  await expect(diagnosis.locator('dt')).toHaveCount(0);
  await expect(diagnosis).not.toContainText('Por que importa');
  await expect(diagnosis).not.toContainText('O que fazer');
  // The actions live in the open line only.
  await expect(page.locator('.audit-observations .expected-button')).toHaveCount(1);
  await expect(ambiguous.getByRole('button', { name: /^Marcar como esperada/ })).toBeVisible();
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of [
      '.audit-project strong',
      '.audit-level',
      '.audit-level-count',
      '.audit-observations .observation-group-head strong',
      '.audit-observations .file-observation-line',
      '.audit-observations .file-observation-target',
      '.audit-observations .file-observation-type',
      '.diagnosis-meaning',
      '.diagnosis-written code',
      '.diagnosis-searched',
      '.diagnosis-candidates span',
      '.audit-observations .expected-button',
    ])
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await page
      .locator('.tool-panel')
      .screenshot({ path: test.info().outputPath(`audit-diagnosis-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }

  // Missing destination written as a path: a Markdown link (the plain reading, not named), the
  // placeholder path where it looked. One line open at a time.
  const missing = auditRow(page, 'notas.md');
  await openAuditDetail(missing);
  await expect(ambiguous.locator('.diagnosis')).toHaveCount(0);
  await expect(missing.locator('.diagnosis-citation')).toHaveCount(0);
  await expect(missing.locator('.diagnosis-searched')).toContainText(
    'Procurou em .claude/skills/gerar-release/notas.md a partir da pasta deste arquivo',
  );
  // Anchored path: only that place; a mention in backticks names how it was written.
  const anchored = auditRow(page, './docs/velho.md');
  await openAuditDetail(anchored);
  await expect(anchored.locator('.diagnosis-searched')).toHaveText(
    'Procurou só em docs/velho.md (caminho ancorado).',
  );
  const mention = auditRow(page, 'config/segredos.yaml');
  await openAuditDetail(mention);
  await expect(mention.locator('.diagnosis-citation')).toHaveText(
    ' · menção a caminho (em crase ou no texto)',
  );
  await expect(readable(mention.locator('.diagnosis-citation'))).resolves.toBeGreaterThanOrEqual(
    4.5,
  );
  // A bare name: where it looked, through the whole cascade.
  const name = auditRow(page, 'glossario');
  await openAuditDetail(name);
  await expect(name.locator('.diagnosis-searched')).toHaveText(
    'Procurou em glossario a partir da pasta deste arquivo, depois pelo diretório aberto e por nome ou sufixo único no projeto.',
  );
  // Codes stay out of the main text.
  await expect(name.locator('.diagnosis')).not.toContainText('unresolved-name');
  // Without a path from the instructions: from how many starts it followed the references.
  const orphan = auditFiles(page)
    .filter({ hasText: 'docs/antigo.md' })
    .locator('.file-observation');
  await openAuditDetail(orphan);
  await expect(orphan.locator('.diagnosis-searched')).toContainText('e não chegou aqui.');
  // The same button closes the line again.
  await orphan.getByRole('button', { name: /^Fechar detalhe/ }).click();
  await expect(page.locator('.audit-observations .diagnosis')).toHaveCount(0);
  // A candidate of the diagnosis is navigable.
  await openAuditDetail(ambiguous);
  await diagnosis
    .locator('.diagnosis-candidates')
    .getByRole('button', { name: 'docs/checklist.md' })
    .click();
  await expect(page.locator('.copy-path code')).toHaveText(join(loja, 'docs/checklist.md'));
  expect(errors).toEqual([]);
  await close();
});

test('D.3 markers and inspector: count and tone in the tree and the Estrutura, the diagnosis of the file, and "não existe" × "nome sem arquivo" in the relations', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { loja, infra } = fixture();
  const close = await openOnly(page, [loja, infra]);
  await page.goto('/');
  // Home lists the projects, without the explorer: the tree is in a project.
  await enterProject(page);
  const explorer = page.locator('.explorer');
  const agents = join(loja, 'AGENTS.md');

  // Tree: the count in the strongest tone, no icon, the observations in words.
  const treeRow = (path: string) =>
    explorer.locator('.tree-file-row', { has: page.getByTitle(path, { exact: true }) });
  const marker = treeRow(agents).locator('.observation-marker');
  // The number counts problems and warnings (2), and so do the name and the tooltip; the informative one
  // is there too, apart, out of the number.
  await expect(marker).toHaveText('2');
  await expect(marker).toHaveClass(/tone-problem/);
  await expect(marker.locator('svg')).toHaveCount(0);
  expect(await colorOf(marker)).toBe(await toneColor(page, 'problem'));
  await expect(marker).toHaveAccessibleName(
    '2 problemas: referência ausente (2) · 1 informativo: nome citado sem arquivo. Ver diagnóstico',
  );
  await expect(marker).toHaveAttribute(
    'title',
    '2 problemas: referência ausente (2) · 1 informativo: nome citado sem arquivo',
  );
  await expect(
    treeRow(join(loja, 'agent-architecture.json')).locator('.observation-marker'),
  ).toHaveCount(0);

  // Estrutura of the project: the same marker in the reserved slot; a file with informative ones only
  // has none (they stay in the inspector, the Auditoria and the filter of the tree).
  await explorer.getByRole('button', { name: 'Voltar ao diretório loja' }).click();
  const structure = page.getByRole('region', { name: 'Estrutura de loja' });
  const row = (name: string) =>
    structure.locator('.structure-row', {
      has: page.locator('.structure-open', { hasText: new RegExp(`^${name}$`) }),
    });
  await expect(row('AGENTS.md').locator('[data-slot="marker"] .observation-marker')).toHaveText(
    '2',
  );
  await structure.getByRole('button', { name: 'Mostrar conteúdo de docs' }).click();
  await expect(row('antigo.md')).toBeVisible();
  await expect(row('antigo.md').locator('[data-slot="marker"]')).toBeEmpty();
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    for (const selector of [
      '.structure-view .observation-marker.tone-problem',
      '.explorer .observation-marker',
    ])
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`markers-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }

  // Clicking the marker opens the file with its observations in the inspector: a summary by tone, one
  // group per type (problems first, the first one open), the type explained once, one line per occurrence.
  await row('AGENTS.md').locator('.observation-marker').click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  const block = page.locator('.inspector .file-observations');
  await expect(block.locator('.observations-count')).toHaveText(['2 problemas', '1 informativo']);
  // The words of each tone in its colour, no icon.
  await expect(block.locator(ALERT_ICONS)).toHaveCount(0);
  expect(await colorOf(block.locator('.observations-count.tone-problem'))).toBe(
    await toneColor(page, 'problem'),
  );
  expect(await colorOf(block.locator('.observations-count.tone-info'))).toBe(
    await toneColor(page, 'info'),
  );
  const heads = block.locator('.observation-group-head');
  await expect(heads.locator('strong')).toHaveText([
    'Referência ausente',
    'Nome citado sem arquivo',
  ]);
  await expect(heads.locator('.observation-group-count')).toHaveText(['· 2', '· 1']);
  await expect(heads.locator('.observation-group-tone')).toHaveText(['problema', 'informativo']);
  expect(await colorOf(heads.first().locator('.observation-group-tone'))).toBe(
    await toneColor(page, 'problem'),
  );
  await expect(heads.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(heads.last()).toHaveAttribute('aria-expanded', 'false');
  await expect(block.locator('.observation-group-meaning')).toHaveCount(1);
  await expect(block.locator('.file-observation-row')).toHaveText([
    /^L5\s*\.\/docs\/velho\.md$/,
    /^L6\s*config\/segredos\.yaml$/,
  ]);
  // The reader message that repeats the title is gone; the tone word is in the group, not on each line.
  await expect(block).not.toContainText('Destino não encontrado');
  // Facts of one occurrence on click: how it was written (it changes the reading) and where it looked.
  const mention = block.locator('.file-observation', { hasText: 'config/segredos.yaml' });
  await expect(mention.locator('.diagnosis')).toHaveCount(0);
  await mention.locator('.file-observation-open').click();
  await expect(mention.locator('.diagnosis-citation')).toHaveText(
    ' · menção a caminho (em crase ou no texto)',
  );
  await expect(mention.locator('.diagnosis-searched')).toContainText(
    'Procurou em config/segredos.yaml',
  );
  // The line number highlights the line of the observation in the file below.
  await mention.getByRole('button', { name: 'Ir para a linha 6' }).click();
  await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', '6');
  // A reference with a relation opens its own evidence at that line.
  await expect(page.locator('.source-context')).toContainText(
    'AGENTS.md → segredos.yaml · linha 6',
  );
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    for (const selector of [
      '.observations-count.tone-problem',
      '.observations-count.tone-info',
      '.observation-group-head strong',
      '.observation-group-tone',
      '.observation-group-meaning',
      '.file-observation-line',
      '.file-observation-target',
      '.file-observations .diagnosis-searched',
      '.file-observations .diagnosis-citation',
      '.file-observations .expected-button',
    ])
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await page
      .locator('.inspector')
      .screenshot({ path: test.info().outputPath(`inspector-diagnosis-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  // Hidden under its summary until shown again; the summary stays.
  await block.getByRole('button', { name: 'Ocultar observações do arquivo' }).click();
  await expect(block.locator('.observation-group')).toHaveCount(0);
  await expect(block.locator('.observations-count')).toHaveCount(2);
  await block.getByRole('button', { name: 'Mostrar observações do arquivo' }).click();
  await expect(block.locator('.observation-group')).toHaveCount(2);

  // Relations: a missing destination says whether it does not exist or is a name without a file.
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const outgoing = page.locator('.relation-list').first();
  const relation = (text: string) => outgoing.locator('.relation-row', { hasText: text });
  await expect(relation('glossario').locator('.name-dot')).toHaveText('· nome sem arquivo');
  await expect(relation('glossario').locator('.name-dot')).toHaveAttribute(
    'title',
    /pode ser intencional/,
  );
  await expect(relation('velho.md').locator('.missing-dot')).toHaveText('· não existe');
  await expect(relation('velho.md').locator('.missing-dot svg')).toHaveCount(0);
  expect(await colorOf(relation('velho.md').locator('.missing-dot-text'))).toBe(
    await toneColor(page, 'problem'),
  );
  // The separator stays muted, as in "· nome sem arquivo".
  expect(await colorOf(relation('velho.md').locator('.missing-dot'))).toBe(
    await toneColor(page, 'info'),
  );
  await expect(relation('velho.md').locator('.missing-dot')).toHaveAttribute(
    'title',
    /não existe no caminho escrito/,
  );
  await expect(relation('glossario').locator('.missing-dot')).toHaveCount(0);
  await expect(relation('MEMORY.md')).not.toContainText('não existe');
  // Its evidence carries the diagnosis of that reference.
  await relation('velho.md').locator('.relation-evidence').click();
  await expect(page.locator('.evidence-item')).toHaveCount(1);
  await expect(page.locator('.evidence-diagnosis .observation-title strong')).toHaveText(
    'Referência ausente',
  );
  await expect(page.locator('.evidence-diagnosis .diagnosis-meaning')).toHaveText(
    observationCodes.broken.meaning,
  );
  await expect(page.locator('.evidence-diagnosis')).toContainText(
    'Procurou só em docs/velho.md (caminho ancorado).',
  );

  // Map: at most one discreet badge per file with observations (the map of the selection, by its switch:
  // the marker opened the file in the inspector and the Estrutura stayed).
  await page.getByRole('button', { name: 'Mapa de loja', exact: true }).click();
  const tile = page.locator('.react-flow__node-file', {
    has: page.locator(`strong[title="${agents}"]`),
  });
  await expect(tile.locator('.tile-observations')).toHaveCount(1);
  await expect(tile.locator('.tile-observations')).toHaveText('2');
  await expect(
    page.locator('.react-flow__node-file', { hasText: 'MEMORY.md' }).locator('.tile-observations'),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
  await close();
});

test('D.5–D.6 classes: one selector with counts filters the tree and the Estrutura, class icons in the tree, and memory and skill with their own colors in both themes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { loja, infra } = fixture();
  const close = await openOnly(page, [loja, infra]);
  await page.goto('/');
  // Home lists the projects, without the explorer: the tree is in a project.
  await enterProject(page);
  const explorer = page.locator('.explorer');
  const chips = explorer.getByRole('group', { name: 'Filtrar arquivos por classe' });
  const classes = chips.getByRole('combobox', { name: 'Classe dos arquivos' });
  await expect(classes.locator('option')).toHaveText([
    'Todos · 10',
    'Instruções · 2',
    'Memória · 2',
    'Skills · 1',
    'Manifestos · 1',
    'Outros · 4',
  ]);
  await expect(chips.getByRole('button', { name: /^Com observações/ })).toHaveText(
    'Com observações · 6',
  );
  await expect(classes).toHaveValue('');
  // The logical objects tab says what it lists.
  await expect(explorer.locator('.small-tabs button').nth(1)).toHaveText('Skills e objetos 1');

  // The class of each file in the tree, by icon (tooltip with the class name).
  const icon = (path: string) => explorer.getByTitle(path, { exact: true }).locator('.file-class');
  await explorer.getByRole('button', { name: 'Expandir pasta memory' }).click();
  await expect(icon(join(loja, 'AGENTS.md'))).toHaveClass(/kind-entry/);
  await expect(icon(join(loja, 'memory/MEMORY.md'))).toHaveClass(/kind-memory/);
  await expect(icon(join(loja, 'memory/MEMORY.md'))).toHaveAttribute('title', 'Memória');
  await expect(icon(join(loja, 'agent-architecture.json'))).toHaveClass(/kind-manifest/);

  // One class keeps its files and the folders on the way (opened); other projects say they have none.
  await classes.selectOption('memory');
  await expect(classes).toHaveValue('memory');
  const files = explorer.locator('.tree-file-row .tree-item');
  await expect(files).toHaveText(['decisoes.md', 'MEMORY.md']);
  await expect(explorer.locator('.tree-directory-row .tree-item')).toHaveText(['memory']);
  await expect(explorer.locator('.root-section', { hasText: 'infra' })).toContainText(
    'Nenhum arquivo deste filtro neste projeto.',
  );
  // The Estrutura follows the same filter.
  await explorer.getByRole('button', { name: 'Voltar ao diretório loja' }).click();
  const structure = page.getByRole('region', { name: 'Estrutura de loja' });
  await expect(structure.locator('.structure-open')).toHaveText(['memory']);
  // Its summary counts the files the filter keeps here and below, never "0 arquivos" above them.
  const summary = structure.locator('.structure-summary');
  await expect(summary).toContainText(
    'Filtro de classe: 2 arquivos nesta pasta e nas subpastas (de 9)',
  );
  await expect(summary).not.toContainText('0 arquivos');
  await classes.selectOption('skill');
  await expect(files).toHaveText(['SKILL.md']);
  await expect(structure.locator('.structure-open')).toHaveText(['.claude']);
  await expect(summary).toContainText(
    'Filtro de classe: 1 arquivo nesta pasta e nas subpastas (de 9)',
  );
  await expect(icon(join(loja, '.claude/skills/gerar-release/SKILL.md'))).toHaveClass(/kind-skill/);

  // "Com observações" combines with the class or works alone.
  await classes.selectOption('');
  await chips.getByRole('button', { name: /^Com observações/ }).click();
  await expect(files).toHaveText([
    'SKILL.md',
    'checklist.md',
    'antigo.md',
    'checklist.md',
    'AGENTS.md',
    'AGENTS.md',
  ]);
  // The filter keeps the informative ones too: a file with only those is listed, without a marker.
  await expect(
    explorer.locator('.tree-file-row', { has: page.getByTitle(join(loja, 'docs/antigo.md')) }),
  ).not.toHaveClass(/has-marker/);
  await expect(
    explorer.locator('.tree-file-row', { has: page.getByTitle(join(loja, 'AGENTS.md')) }),
  ).toHaveClass(/has-marker/);
  await expect(structure.locator('.structure-row.is-file .structure-open')).toHaveText([
    'AGENTS.md',
  ]);
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    for (const selector of ['.class-filter select', '.class-filter button[aria-pressed="true"]'])
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await explorer.screenshot({ path: test.info().outputPath(`class-filter-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  await explorer.getByRole('button', { name: 'Limpar filtro de classe' }).click();
  await expect(classes).toHaveValue('');
  await expect(chips.getByRole('button', { name: /^Com observações/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(structure.locator('.structure-open')).toHaveText([
    '.claude',
    'docs',
    'memory',
    'scripts',
    'agent-architecture.json',
    'AGENTS.md',
  ]);

  // The legend names memory and skill apart, with the colors of their tiles, in both themes (the map of
  // the file chosen in the tree, by the switch: a new selection keeps the Estrutura).
  await explorer.getByTitle(join(loja, 'memory/MEMORY.md'), { exact: true }).click();
  await page.getByRole('button', { name: 'Mapa de loja', exact: true }).click();
  const legend = page.locator('.canvas-legend').first();
  await legend.locator('summary').click();
  await expect(legend.locator(':scope > div > span')).toHaveText([
    'Instruções',
    'Memória',
    'Skill',
    'Manifesto',
    '→ Direção da referência',
  ]);
  const background = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const memory = await background(legend.locator('.legend-memory'));
    const skill = await background(legend.locator('.purple'));
    expect(memory, theme).not.toBe(skill);
    // The memory tile carries the memory color.
    expect(
      await page
        .locator('.file-tile.memory:not(.focused)')
        .first()
        .evaluate((element) => getComputedStyle(element).borderTopColor),
      theme,
    ).toBe(memory);
    expect(
      await readable(legend.locator(':scope > div > span').nth(1)),
      `legend (${theme})`,
    ).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`legend-classes-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  expect(errors).toEqual([]);
  await close();
});
