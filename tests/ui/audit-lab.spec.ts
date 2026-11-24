import { expect, test } from '@playwright/test';
import { auditRows, showAudit } from './audit-list';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionHeaders } from './helpers';
import { runProjectsAction } from './more-menu';

// Inspect entries without following symlinks; atime is intentionally excluded.
function fingerprint(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  function visit(path: string, relative: string) {
    const stat = lstatSync(path);
    result[relative] = {
      mode: stat.mode,
      mtime: stat.mtimeMs,
      content: stat.isSymbolicLink()
        ? readlinkSync(path)
        : stat.isFile()
          ? createHash('sha256').update(readFileSync(path)).digest('hex')
          : null,
    };
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
  }
  visit(root, '.');
  return result;
}

test('fictional audit lab: real evidence, negative trace, ambiguous source and complete filesystem preservation', async ({
  page,
}) => {
  const { lab } = JSON.parse(
    execFileSync(
      'python3',
      [
        'tests/create_audit_lab.py',
        '--destination',
        join(mkdtempSync(join(tmpdir(), 'aae-audit-lab-')), 'lab'),
      ],
      { encoding: 'utf8' },
    ),
  );
  const root = join(lab, 'aurora');
  const before = fingerprint(lab);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const opened of previous.roots)
    await page.request.post('/api/close', { headers, data: { path: opened.path } });
  try {
    await page.goto('/');
    await runProjectsAction(page, 'Adicionar diretório');
    await page.getByLabel('Caminho do diretório').fill(root);
    await page.getByRole('button', { name: 'Abrir este diretório' }).click();
    // Opening selects no file (structure first): the view lists the folder.
    await expect(page.getByRole('region', { name: 'Estrutura de aurora' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: 'Caminho', exact: true }).click();
    await page.getByLabel('Arquivo de origem A').fill(join(root, 'AGENTS.md'));
    await page.getByLabel('Arquivo de destino B').fill(join(root, 'memory/decisoes.md'));
    await page.getByRole('button', { name: 'Traçar', exact: true }).click();
    await expect(page.locator('.trace-summary')).toContainText('3 passos');
    await page.screenshot({ path: test.info().outputPath('aurora-directed.png') });
    await page.getByLabel('Arquivo de origem A').fill(join(root, 'memory/decisoes.md'));
    await page.getByLabel('Arquivo de destino B').fill(join(root, 'AGENTS.md'));
    await page.getByRole('button', { name: 'Traçar', exact: true }).click();
    await expect(page.locator('.bottom-content')).toHaveText('Nenhum caminho seguindo as setas.');
    await page.getByLabel('Direção do caminho').selectOption('undirected');
    await page.getByRole('button', { name: 'Traçar', exact: true }).click();
    await expect(page.locator('.trace-summary')).toContainText('3 passos');
    await expect(page.locator('.trace-result')).toContainText('sentido inverso');

    await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
    await showAudit(page, 'Todas', 'ambiguous');
    await expect(auditRows(page)).not.toHaveCount(0);
    // The line number opens the file at the line.
    await auditRows(page).first().locator('.file-observation-line').click();
    await expect(page.locator('.highlight-line')).toContainText('[[');
    await page.screenshot({ path: test.info().outputPath('aurora-ambiguity.png') });

    await page.getByRole('button', { name: 'Anotações', exact: true }).click();
    await page
      .getByLabel('Anotação do arquivo')
      .fill('Auditoria sintética: verificar ambiguidade.');
    await page.getByRole('button', { name: 'Salvar anotação' }).click();
    await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
    await page.reload();
    const model = await (await page.request.get('/api/workspace', { headers })).json();
    expect(Object.values(model.notes)).toContain('Auditoria sintética: verificar ambiguidade.');
    expect(fingerprint(lab)).toEqual(before);
    expect(errors).toEqual([]);
    writeFileSync(
      test.info().outputPath('aurora-integrity.json'),
      JSON.stringify(
        {
          testedAt: new Date().toISOString(),
          entriesChecked: Object.keys(before).length,
          completeFilesystemUnchanged: true,
          directedSteps: 3,
          reverseDirectedFound: false,
          undirectedSteps: 3,
          ambiguityLineVisible: true,
          browserErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.request.post('/api/close', { headers, data: { path: root } });
    expect(fingerprint(lab)).toEqual(before);
  }
});
