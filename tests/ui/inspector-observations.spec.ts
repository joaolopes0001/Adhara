import { expect, test } from '@playwright/test';
import { auditRow, openAuditDetail, showAudit } from './audit-list';
import type { Locator } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOnly, selectFile, writeTree } from './helpers';

// Observations of a file in the inspector: a summary by tone, one group per type with its meaning once,
// one line per occurrence, eight at a time, the facts of an occurrence on click; the candidates of an
// ambiguity counted by the reader's total; the address a line address or a `./` mention really names;
// the header with the path in one line; and none of the generic advice.
const many = Array.from({ length: 11 }, (_, index) => `[f${index}](falta-${index}.md)`).join('\n');
const tree: Record<string, string> = {
  'AGENTS.md':
    '# Projeto\n[Muitas](docs/muitas.md)\n[Nomes](docs/nomes.md)\n[Linhas](docs/linhas.md)\n[Limpo](docs/limpo.md)\n[Só nomes](docs/so-info.md)\n[Grande](docs/grande.md)\n',
  'docs/muitas.md': `# Muitas ausências\n${many}\n`,
  'docs/nomes.md': '# Nomes\nVeja `alvo.md` e [[ident]].\n',
  'docs/linhas.md': '# Endereços\nVeja `dup.md:41`.\nE `nome-ausente.md:41`.\nE `./nada.md`.\n',
  'docs/limpo.md': '# Limpo\n[Volta](../AGENTS.md)\n',
  'docs/so-info.md': '# Só informativos\nSaída em `relatorio-final.md`.\n',
  'docs/grande.md': `# Grande\n${'texto de enchimento '.repeat(60000)}\n`,
  'a/dup.md': '# A\n',
  'b/dup.md': '# B\n',
};
for (let index = 0; index < 25; index++) {
  tree[`alvos/p${String(index).padStart(2, '0')}/alvo.md`] = '# Alvo\n';
  tree[`idents/i${String(index).padStart(2, '0')}.md`] = '---\nname: ident\n---\n# Ident\n';
}

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-inspector-observations-')), 'projeto');
  writeTree(root, tree);
  return root;
}

/** The occurrence whose written destination is exactly `target`. */
const occurrence = (block: Locator, target: string) =>
  block.locator('.file-observation', {
    has: block.page().locator('.file-observation-target', {
      hasText: new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    }),
  });
const group = (block: Locator, title: string) =>
  block.locator('.observation-group', {
    has: block.page().locator('.observation-group-head strong', { hasText: title }),
  });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('inspector observations: eight per group with "Mostrar mais", the total in the group, marking from the inspector, and no generic advice', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const close = await openOnly(page, [root]);
  await page.goto('/');
  const block = page.locator('.inspector .file-observations');

  // (d) A file without observations has no block.
  await selectFile(page, join(root, 'docs/limpo.md'));
  await expect(block).toHaveCount(0);

  // (a) Eleven missing destinations: the group counts 11, shows 8 in line order, then the rest.
  await selectFile(page, join(root, 'docs/muitas.md'));
  await expect(block.locator('.observations-count')).toHaveText(['11 problemas']);
  const missing = group(block, 'Referência ausente');
  await expect(missing.locator('.observation-group-count')).toHaveText('· 11');
  await expect(missing.locator('.observation-group-meaning')).toHaveCount(1);
  const rows = missing.locator('.file-observation-row');
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toHaveText(/^L2\s*falta-0\.md$/);
  await expect(rows.last()).toHaveText(/^L9\s*falta-7\.md$/);
  const more = missing.getByRole('button', { name: /^Mostrar mais/ });
  await expect(more).toHaveText('Mostrar mais 3 · faltam 3');
  await more.click();
  await expect(rows).toHaveCount(11);
  await expect(rows.last()).toHaveText(/^L12\s*falta-10\.md$/);
  await expect(more).toHaveCount(0);
  // No cut at 50 items sending to the audit.
  await expect(block).not.toContainText('A Auditoria lista todas');

  // (e) Marking from the inspector: the occurrence leaves its group, which counts one less.
  const last = missing.locator('.file-observation', { hasText: 'falta-10.md' });
  await last.locator('.file-observation-open').click();
  await last.getByRole('button', { name: /^Marcar como esperada:/ }).click();
  await last.getByLabel('Motivo (opcional)').fill('Gerado na execução');
  await last.getByRole('button', { name: 'Marcar como esperada', exact: true }).click();
  await expect(missing.locator('.observation-group-count')).toHaveText('· 10');
  await expect(missing.locator('.file-observation', { hasText: 'falta-10.md' })).toHaveCount(0);
  await expect(block.locator('.observations-count')).toHaveText([
    '10 problemas',
    '1 marcada como esperada',
  ]);
  await expect(block.locator('.observation-group.expected .expected-note')).toContainText(
    'Gerado na execução',
  );
  await block.getByRole('button', { name: /^Desmarcar:/ }).click();
  await expect(missing.locator('.observation-group-count')).toHaveText('· 11');

  // The declaration opens only on request.
  const first = missing.locator('.file-observation').first();
  await first.locator('.file-observation-open').click();
  await expect(first.locator('.diagnosis-scope')).toHaveCount(0);
  await first.getByRole('button', { name: 'Declarar no projeto…' }).click();
  await expect(first.locator('.diagnosis-scope .scope-choice')).toBeVisible();

  // (f) None of the labelled blocks of generic advice, in the inspector or in the audit.
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await showAudit(page, 'Problemas');
  await openAuditDetail(auditRow(page, 'falta-0.md'));
  await expect(page.locator('.audit-observations .diagnosis')).toHaveCount(1);
  for (const label of [
    'Por que importa',
    'O que fazer',
    'O que significa',
    'Tipo de citação',
    'Onde procurou',
  ])
    await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  await close();
});

test('inspector observations: candidates counted by the total, line addresses and ./ mentions searched where the reader looks, informative-only files collapsed', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const close = await openOnly(page, [root]);
  await page.goto('/');
  const block = page.locator('.inspector .file-observations');

  // (b) 25 files named alvo.md: the reader lists 20 and counts 25; the screen says 25 and "20 de 25".
  await selectFile(page, join(root, 'docs/nomes.md'));
  const names = group(block, 'Nome com vários arquivos possíveis');
  await expect(names.locator('.observation-group-count')).toHaveText('· 2');
  await names.locator('.observation-group-head').click();
  const alvo = occurrence(names, 'alvo.md');
  await alvo.locator('.file-observation-open').click();
  await expect(alvo.locator('.diagnosis-searched')).toContainText(
    '25 arquivos do projeto correspondem ao que está escrito',
  );
  await expect(alvo.locator('.diagnosis-candidates-count')).toHaveText('20 de 25 candidatos:');
  await expect(alvo.locator('.diagnosis-candidates li')).toHaveCount(20);
  // 25 files declare `name: ident`: the 20 listed are not taken as all of them.
  const ident = occurrence(names, 'ident');
  await ident.locator('.file-observation-open').click();
  await expect(ident.locator('.diagnosis-searched')).toHaveText(
    '25 arquivos do projeto correspondem a esse nome; os 20 listados declaram name: ident no frontmatter.',
  );
  await expect(ident.locator('.diagnosis-candidates-count')).toHaveText('20 de 25 candidatos:');
  // The audit opens the same facts, with the same total.
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await showAudit(page, 'Todas', 'ambiguous');
  const audited = await openAuditDetail(auditRow(page, 'alvo.md'));
  await expect(audited.locator('.diagnosis-searched')).toContainText(
    '25 arquivos do projeto correspondem ao que está escrito',
  );
  await expect(audited.locator('.diagnosis-candidates-count')).toHaveText('20 de 25 candidatos:');
  // dup.md:41: two files, all listed; the name compared is the address, without the line.
  const dupLine = await openAuditDetail(auditRow(page, 'dup.md:41'));
  await expect(dupLine.locator('.diagnosis-candidates li')).toHaveCount(2);
  await expect(dupLine.locator('.diagnosis-candidates-count')).toHaveCount(0);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();

  // (c) A line address is not part of the path: `dup.md:41` and `nome-ausente.md:41`.
  await selectFile(page, join(root, 'docs/linhas.md'));
  // Problems first and open; the two informative groups start collapsed.
  await expect(block.locator('.observation-group-head strong')).toHaveText([
    'Referência ausente',
    'Nome com vários arquivos possíveis',
    'Nome citado sem arquivo',
  ]);
  await expect(block.locator('.observation-group-head[aria-expanded="true"] strong')).toHaveText([
    'Referência ausente',
  ]);
  const dup = occurrence(block, 'dup.md:41');
  await expect(dup).toHaveCount(0);
  await group(block, 'Nome com vários').locator('.observation-group-head').click();
  await dup.locator('.file-observation-open').click();
  await expect(dup.locator('.diagnosis-searched')).toContainText(
    'Não existe em docs/dup.md (a partir da pasta deste arquivo)',
  );
  await expect(dup.locator('.diagnosis-searched')).not.toContainText(':41');
  const named = occurrence(block, 'nome-ausente.md:41');
  await group(block, 'Nome citado sem arquivo').locator('.observation-group-head').click();
  await named.locator('.file-observation-open').click();
  await expect(named.locator('.diagnosis-searched')).toContainText(
    'Procurou em docs/nome-ausente.md a partir da pasta deste arquivo',
  );
  await expect(named.locator('.diagnosis-searched')).not.toContainText(':41');
  // A `./` mention tries the opened root too, and the screen says so.
  const dot = occurrence(block, './nada.md');
  await dot.locator('.file-observation-open').click();
  await expect(dot.locator('.diagnosis-searched')).toHaveText(
    'Procurou em docs/nada.md (a partir da pasta deste arquivo) e em nada.md (a partir do diretório aberto).',
  );

  // (d) Only informative observations: the group starts collapsed, no icon, nothing in a tone's colour.
  await selectFile(page, join(root, 'docs/so-info.md'));
  await expect(block.locator('.observations-count')).toHaveText(['1 informativo']);
  await expect(block.locator('.observations-count svg')).toHaveCount(0);
  await expect(block.locator('.observation-group-head')).toHaveAttribute('aria-expanded', 'false');
  await expect(block.locator('.file-observation')).toHaveCount(0);
  await expect(block.locator('.tone-problem, .tone-warning')).toHaveCount(0);
  await expect(block.locator('.observation-group-head svg')).toHaveCount(1);
  const muted = await block
    .locator('.observations-count')
    .evaluate((element) => getComputedStyle(element).color);
  expect(
    await block
      .locator('.observation-group-tone')
      .evaluate((element) => getComputedStyle(element).color),
  ).toBe(muted);

  // Header: the path in one line, cut at the start; the whole path in the tooltip and the copy.
  const copy = page.locator('.inspector .copy-path');
  await expect(copy).toHaveAttribute('title', new RegExp(`^${join(root, 'docs/so-info.md')}`));
  const box = await copy.boundingBox();
  expect(box!.height).toBeLessThan(24);
  await expect(page.locator('.inspector .file-details')).toHaveCount(0);
  await expect(page.locator('.inspector .source-path')).toHaveCount(0);
  await expect(page.locator('.inspector-name .type-label')).toHaveText('Arquivo');
  // A file left out by its size says so next to its name, as a warning line.
  await selectFile(page, join(root, 'docs/grande.md'));
  await expect(page.locator('.inspector .analysis-note')).toHaveText(
    'não lido: limite de tamanho (1 MiB)',
  );
  await expect(page.locator('.inspector .preview-note')).toHaveText('prévia limitada a 1 MiB');
  for (const [name, text] of Object.entries(tree))
    expect(readFileSync(join(root, name), 'utf8')).toBe(text);
  expect(errors).toEqual([]);
  await close();
});
