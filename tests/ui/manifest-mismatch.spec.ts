import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observationCodes } from '../../src/observations';
import { auditRow, auditRows, auditTab, openAllAuditFiles, openAuditDetail } from './audit-list';
import { openOnly, selectFile, writeTree } from './helpers';

// A manifest with "linkedRelationships": true and its links disagree both ways: a relationship whose source has
// no link (on the manifest line) and a link between two objects without a relationship (on the link line). The
// interface names the type in Portuguese (the code only in a tooltip), opens each evidence from the line number,
// says the pair from the structured fields, and marks one as expected.
const node = (name: string, ...relations: string[]) =>
  `# ${name}\n\n## Relations\n\n${relations.join('\n') || 'None yet.'}\n`;
const manifest = JSON.stringify(
  {
    version: 1,
    linkedRelationships: true,
    objects: ['a/a.md', 'b/b.md', 'c/c.md'].map((path) => ({
      name: path.slice(2, 3),
      type: 'document',
      path,
    })),
    relationships: [{ source: 'a/a.md', target: 'b/b.md', type: 'reads' }],
  },
  null,
  2,
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('manifest mismatch: both directions in the audit and the inspector, each line opens its evidence, and it can be marked as expected', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = join(mkdtempSync(join(tmpdir(), 'aae-manifest-mismatch-')), 'pacote');
  writeTree(root, {
    'AGENTS.md': '# Entrada\n[m](agent-architecture.json)\n[a](a/a.md)\n[b](b/b.md)\n[c](c/c.md)\n',
    'a/a.md': node('a'),
    'b/b.md': node('b'),
    'c/c.md': node('c', '- references: [a](../a/a.md)'),
    'agent-architecture.json': manifest + '\n',
  });
  const relationLine =
    readFileSync(join(root, 'agent-architecture.json'), 'utf8')
      .split('\n')
      .findIndex((line) => line.includes('"source": "a/a.md"')) + 1;
  const close = await openOnly(page, [root]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();

  // No problem: the audit opens on the warnings, one type, its meaning said once above the list.
  await expect(auditTab(page, 'Avisos')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Avisos')).toHaveText('Avisos 2');
  const meaning = observationCodes['manifest-mismatch'].meaning;
  await expect(page.locator('.audit-type-meaning')).toHaveText(meaning);
  await openAllAuditFiles(page);
  await expect(auditRows(page)).toHaveCount(2);
  // What is written: the relationship as the manifest writes it, the link as the node writes it.
  const relation = auditRow(page, 'a/a.md → b/b.md');
  const link = auditRow(page, '../a/a.md');
  await expect(relation.locator('.file-observation-line')).toHaveText(`L${relationLine}`);
  await expect(link.locator('.file-observation-line')).toHaveText('L5');
  // No internal code on screen (it is only in the tooltip of the type).
  await expect(page.locator('.audit-content')).not.toContainText('manifest-mismatch');

  // The facts come from the fields of the observation: the pair, and for the relationship its evidence.
  const relationDetail = await openAuditDetail(relation);
  await expect(relationDetail.locator('.diagnosis-written')).toHaveText(
    'a/a.md → b/b.md (reads) · relação declarada no manifesto',
  );
  await expect(relationDetail.locator('.diagnosis-searched')).toHaveText(
    'O manifesto declara a/a.md → b/b.md, mas o leitor não achou em a/a.md um link explícito para o destino (bloco de código não conta).',
  );
  await expect(relationDetail.locator('.diagnosis-message')).toHaveCount(0);
  const linkDetail = await openAuditDetail(link);
  await expect(linkDetail.locator('.diagnosis-written')).toHaveText('- references: [a](../a/a.md)');
  await expect(linkDetail.locator('.diagnosis-searched')).toHaveText(
    'c/c.md tem um link explícito para a/a.md, os dois são objetos de agent-architecture.json, e nenhuma relação dele vai de um para o outro.',
  );

  // The line number opens the file at the line with the evidence of its own relation.
  await relation.locator('.file-observation-line').click();
  await expect(page.locator('.inspector h2')).toHaveText('agent-architecture.json');
  await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', String(relationLine));
  await expect(page.locator('.source-context')).toHaveText(
    new RegExp(`^Evidência de a\\.md → b\\.md · linha ${relationLine}`),
  );
  // The inspector of the manifest has the same observation, under the same title and meaning.
  const block = page.locator('.inspector .file-observations');
  await expect(block.locator('.observation-group-head strong')).toHaveText(
    'Manifesto diverge dos links',
  );
  await expect(block.locator('.observation-group-head strong')).toHaveAttribute(
    'title',
    'Código no aae audit: manifest-mismatch',
  );
  await expect(block.locator('.observation-group-meaning')).toHaveText(meaning);
  await expect(block.locator('.file-observation-target')).toHaveText('a/a.md → b/b.md');
  await link.locator('.file-observation-line').click();
  await expect(page.locator('.inspector h2')).toHaveText('c.md');
  await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', '5');
  await expect(page.locator('.source-context')).toHaveText(/^Evidência de c\.md → a\.md · linha 5/);

  // Marked as expected: out of the tab count, into "Esperadas"; the other one stays.
  // The detail of the link is still the open one (one occurrence at a time).
  const opened = link;
  await expect(opened.locator('.occurrence-detail')).toBeVisible();
  await opened
    .getByRole('button', {
      name: 'Marcar como esperada: Manifesto diverge dos links (../a/a.md) em c/c.md:5',
    })
    .click();
  await opened.getByLabel('Motivo (opcional)').fill('Link de exemplo');
  await opened.getByRole('button', { name: 'Marcar como esperada', exact: true }).click();
  await expect(auditTab(page, 'Avisos')).toHaveText('Avisos 1');
  await expect(auditRows(page)).toHaveCount(1);
  const expected = page.locator('details.audit-expected:not(.audit-orphans)');
  await expect(expected.locator('summary')).toContainText('Esperadas (1)');
  // The mark is kept by key: after Reler it still holds.
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await expect(auditTab(page, 'Avisos')).toHaveText('Avisos 1');
  await expect(expected.locator('summary')).toContainText('Esperadas (1)');
  await selectFile(page, join(root, 'c/c.md'));
  await expect(
    page.locator('.inspector .file-observations .observation-group.expected'),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
  await close();
});

test('manifest not compared: a link through a symbolic link is never a mismatch, and the audit says the relationship was not compared', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = join(mkdtempSync(join(tmpdir(), 'aae-manifest-unchecked-')), 'pacote');
  writeTree(root, {
    'AGENTS.md': '# Entrada\n[m](agent-architecture.json)\n[a](a/a.md)\n[b](b/b.md)\n[c](c/c.md)\n',
    'a/a.md': node('a', '- reads: [b](../atalho/b.md)'),
    'b/b.md': node('b'),
    'c/c.md': node('c'),
    'agent-architecture.json': manifest + '\n',
  });
  symlinkSync(join(root, 'b'), join(root, 'atalho'));
  const close = await openOnly(page, [root]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  // Informative only: no problem, no warning about the pair.
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Avisos')).toHaveCount(0);
  const select = page.getByLabel('Tipo de observação');
  if (await select.count()) await select.selectOption('manifest-unchecked');
  await openAllAuditFiles(page);
  const row = auditRow(page, 'a/a.md → b/b.md');
  const detail = await openAuditDetail(row);
  await expect(detail.locator('.diagnosis-searched')).toHaveText(
    'O arquivo de origem tem um link que o leitor não resolveu (link simbólico, ausência não verificável ou candidatos além dos listados), e ele pode ser o desta relação.',
  );
  await expect(page.locator('.audit-content')).not.toContainText('manifest-unchecked');
  expect(errors).toEqual([]);
  await close();
});
