import { expect, test } from '@playwright/test';
import { auditRows, auditTab, openAllAuditFiles, showAudit } from './audit-list';
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionHeaders, writeTree } from './helpers';
import { runProjectsAction } from './more-menu';

test('maintenance audit: overlapping roots preserve ambiguity and stale paths never redirect to a namesake', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-atlas-maintenance-')), 'atlas-agent');
  const files: Record<string, string> = {
    'AGENTS.md': '# Atlas\n[[runbook]]\n[[retired/runbook]]\n',
    'operations/AGENTS.md': '# Operations entry\n',
    'operations/runbook.md': '# Operational procedure\n',
    'compliance/runbook.md': '# Unrelated compliance procedure\n',
  };
  writeTree(root, files);
  const initialListing = readdirSync(root, { recursive: true }).sort();
  const unchanged = () => {
    for (const [name, text] of Object.entries(files))
      expect(readFileSync(join(root, name), 'utf8')).toBe(text);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(
      initialListing.filter(
        (name) => name !== 'operations/runbook.md' || 'operations/runbook.md' in files,
      ),
    );
  };
  const headers = await sessionHeaders(page);
  const workspace = async () =>
    await (await page.request.get('/api/workspace', { headers })).json();
  for (const old of (await workspace()).roots)
    await page.request.post('/api/close', { headers, data: { path: old.path } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  async function open(path: string) {
    await runProjectsAction(page, 'Adicionar diretório');
    await page.getByLabel('Caminho do diretório').fill(path);
    await page.getByRole('button', { name: 'Abrir este diretório' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  async function refresh() {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/refresh'));
    await page.getByRole('button', { name: 'Reler diretórios' }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Reler diretórios' })).toBeEnabled();
  }
  await open(root);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await showAudit(page, 'Todas', 'ambiguous');
  await expect(auditRows(page)).toHaveCount(1);
  await open(join(root, 'operations'));
  await openAllAuditFiles(page);
  await expect(auditRows(page)).toHaveCount(1);
  await auditRows(page).locator('.file-observation-line').click();
  await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', '2');
  await expect(page.locator('.highlight-line')).toContainText('[[runbook]]');
  const overlapping = await workspace();
  expect(
    overlapping.edges.filter(
      (edge: any) => edge.kind === 'wiki' && edge.target.endsWith('/runbook.md'),
    ),
  ).toEqual([]);
  expect(
    overlapping.nodes.filter((node: any) => node.path === join(root, 'operations/runbook.md')),
  ).toHaveLength(1);
  unchanged();

  // Simulate a maintainer fixing the exact address in their editor, then reread.
  files['AGENTS.md'] = '# Atlas\n[[operations/runbook]]\n[[retired/runbook]]\n';
  writeFileSync(join(root, 'AGENTS.md'), files['AGENTS.md']);
  await refresh();
  // No ambiguity is left: the chosen type gives way to the opening rule, which lists no ambiguity.
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('button', {
      name: /^Ver detalhe: (Nome com vários arquivos possíveis|Referência ambígua)/,
    }),
  ).toHaveCount(0);
  const repaired = await workspace();
  expect(
    repaired.edges
      .filter((edge: any) => edge.kind === 'wiki')
      .map((edge: any) => edge.target)
      .sort(),
  ).toEqual([join(root, 'operations/runbook.md'), join(root, 'retired/runbook')]);
  unchanged();

  // Retiring the target must expose absence, never choose compliance/runbook.md.
  unlinkSync(join(root, 'operations/runbook.md'));
  delete files['operations/runbook.md'];
  await refresh();
  await showAudit(page, 'Todas', 'broken');
  await expect(auditRows(page)).toHaveCount(2);
  const final = await workspace();
  expect(final.edges.some((edge: any) => edge.target === join(root, 'compliance/runbook.md'))).toBe(
    false,
  );
  expect(
    final.issues.filter((issue: any) => issue.code === 'broken').map((issue: any) => issue.line),
  ).toEqual([2, 3]);
  unchanged();
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('retired-paths.png') });
  writeFileSync(
    test.info().outputPath('maintenance-verification.json'),
    JSON.stringify(
      {
        root,
        phases: ['ambiguous', 'overlapping-roots', 'exact-path-repaired', 'target-retired'],
        changesOnlyByFixture: true,
        noNamesakeRedirection: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  for (const path of [join(root, 'operations'), root])
    await page.request.post('/api/close', { headers, data: { path } });
});
