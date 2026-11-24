import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { closeAllProjects, enterProject, sessionHeaders, writeTree } from './helpers';

// The audit opens on what asks for action: tabs by level with their counts, one collapsed group per file
// (20 files and 10 lines at a time), one short line per observation, the meaning of a type said once, the
// counting notes in one collapsed section, and the same detail as the inspector under a click.
function project(files: Record<string, string>) {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-audit-levels-')), 'projeto');
  writeTree(root, files);
  return root;
}

// openOnly of helpers.ts for one root, and then it reloads the page.
async function openOnly(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  await page.goto('/');
  return async () => {
    await page.request.post('/api/close', { headers, data: { path: root } });
  };
}
const openAudit = (page: Page) =>
  page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
/** The count of a level tab, as a number. */
async function tabCount(page: Page, name: string) {
  const tab = auditTab(page, name);
  if (!(await tab.count())) return 0;
  return Number(await tab.locator('.audit-level-count').innerText());
}
/** Every file of the tree, with its text: nothing the audit does writes into the project. */
function snapshot(root: string) {
  return readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((name) => {
      try {
        return [name, readFileSync(join(root, name), 'utf8')];
      } catch {
        return [name, null];
      }
    });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 520 }),
      );
  });
});

test('audit levels (a): it opens on problems, else warnings, else informative ones, and the tabs add up to the total', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Problems and informative ones: opens on the problems.
  const withProblems = project({
    'AGENTS.md': '# Entrada\n[Falta](falta.md)\nTermos: [glossário](glossario).\n',
    'solto.md': '# Solto\n',
  });
  let close = await openOnly(page, withProblems);
  await openAudit(page);
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Avisos')).toHaveCount(0);
  const problems = await tabCount(page, 'Problemas');
  const informative = await tabCount(page, 'Informativos');
  expect(problems).toBe(1);
  expect(informative).toBeGreaterThanOrEqual(2);
  expect(await tabCount(page, 'Todas')).toBe(problems + informative);
  const model = await (
    await page.request.get('/api/workspace', {
      headers: await sessionHeaders(page),
    })
  ).json();
  expect(problems + informative).toBe(model.issues.length);
  await close();

  // No problem, one warning (no entry point): opens on the warnings.
  close = await openOnly(page, project({ 'nota.md': '# Nota\n' }));
  await openAudit(page);
  await expect(auditTab(page, 'Problemas')).toHaveCount(0);
  await expect(auditTab(page, 'Avisos')).toHaveAttribute('aria-selected', 'true');
  expect(await tabCount(page, 'Todas')).toBe(
    (await tabCount(page, 'Avisos')) + (await tabCount(page, 'Informativos')),
  );
  await expect(auditRow(page, 'Sem ponto de entrada')).toHaveCount(1);
  await close();

  // Only informative ones: opens on them.
  close = await openOnly(
    page,
    project({ 'AGENTS.md': '# Entrada\nTermos: [glossário](glossario).\n' }),
  );
  await openAudit(page);
  await expect(auditTab(page, 'Problemas')).toHaveCount(0);
  await expect(auditTab(page, 'Avisos')).toHaveCount(0);
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Informativos')).toHaveText('Informativos 1');
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 1');
  await expect(auditRows(page)).toHaveCount(1);
  await expect(auditRows(page).locator('.file-observation-target')).toHaveText('glossario');
  await close();
  expect(errors).toEqual([]);
});

test('audit levels (b, c): 20 files and 10 lines at a time, and the meaning of a type said once, never per line', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const files: Record<string, string> = {
    'AGENTS.md':
      '# Entrada\n' +
      Array.from({ length: 12 }, (_, index) => `[f${index}](falta-${index}.md)`).join('\n') +
      '\n',
  };
  for (let index = 0; index < 25; index++)
    files[`docs/d${String(index).padStart(2, '0')}.md`] = `# D${index}\n[x](ausente-${index}.md)\n`;
  const root = project(files);
  const before = snapshot(root);
  const close = await openOnly(page, root);
  await openAudit(page);
  await expect(auditTab(page, 'Problemas')).toHaveText('Problemas 37');

  // (b) 26 files: 20 groups, then "Mostrar mais"; the file with most observations first and open.
  await expect(auditFiles(page)).toHaveCount(20);
  const heads = auditFiles(page).locator('.observation-group-head');
  await expect(heads.first()).toContainText('AGENTS.md');
  await expect(heads.first().locator('.observation-group-count')).toHaveText('· 12');
  await expect(heads.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(heads.nth(1)).toHaveAttribute('aria-expanded', 'false');
  const moreFiles = page.getByRole('button', { name: /^Mostrar mais 6 arquivos/ });
  await expect(moreFiles).toHaveText('Mostrar mais 6 arquivos · faltam 6');
  // 12 lines in the open file: 10, then "Mostrar mais".
  await expect(auditRows(page)).toHaveCount(10);
  await expect(auditRows(page).locator('.file-observation-line')).toHaveText(
    Array.from({ length: 10 }, (_, index) => `L${index + 2}`),
  );
  const moreLines = auditFiles(page).first().locator('.observation-more');
  await expect(moreLines).toHaveText('Mostrar mais 2 · faltam 2');
  await moreLines.click();
  await expect(auditRows(page)).toHaveCount(12);
  await expect(moreLines).toHaveCount(0);
  await moreFiles.click();
  await expect(auditFiles(page)).toHaveCount(26);
  await expect(moreFiles).toHaveCount(0);

  // (c) One type in the list: its meaning once, above it, and neither on the lines nor in an open line.
  const meaning = observationCodes.broken.meaning;
  const panel = page.locator('.audit-content');
  await expect(page.locator('.audit-type-meaning')).toHaveText(meaning);
  await expect(panel.getByText(meaning, { exact: true })).toHaveCount(1);
  // The line is short: no reader message, no tone word, no type repeated.
  const first = auditRows(page).first();
  await expect(first.locator('.file-observation-open')).toHaveText('falta-0.md');
  await expect(panel.locator('.audit-observations')).not.toContainText('Destino não encontrado');
  await expect(panel.locator('.audit-observations')).not.toContainText('problema');
  await openAuditDetail(first);
  await expect(panel.getByText(meaning, { exact: true })).toHaveCount(1);
  await expect(first.locator('.diagnosis-meaning')).toHaveCount(0);
  await openAllAuditFiles(page);
  await expect(panel.getByText(meaning, { exact: true })).toHaveCount(1);

  // Every level (problems and the informative documents without a path): no meaning above the list;
  // an open line says it, once.
  await showAudit(page, 'Todas');
  await expect(page.locator('.audit-type-meaning')).toHaveCount(0);
  await expect(panel.getByText(meaning, { exact: true })).toHaveCount(0);
  await expect(auditRow(page, 'falta-0.md').locator('.file-observation-type')).toHaveText(
    'Referência ausente',
  );
  await openAuditDetail(auditRow(page, 'falta-0.md'));
  await expect(panel.getByText(meaning, { exact: true })).toHaveCount(1);
  expect(snapshot(root)).toEqual(before);
  await close();
  expect(errors).toEqual([]);
});

test('audit levels (d, e): the counting notes start collapsed in one section; a project without observations says so in one sentence, and a complete reading has no limit', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A reference resolved by its unique name (the CLI counts it) and a missing one (the footer counts it).
  let close = await openOnly(
    page,
    project({
      'AGENTS.md': '# Entrada\n[Único](unico.md)\n[Falta](falta.md)\n',
      'docs/unico.md': '# Único\n',
    }),
  );
  await openAudit(page);
  const counting = page.locator('details.audit-counting');
  await expect(counting.locator('summary')).toHaveText('Como estes números são contados');
  await expect(counting).not.toHaveAttribute('open', /.*/);
  await expect(counting.locator('.audit-cli-note')).toBeHidden();
  await expect(counting.locator('.unresolved-note')).toBeHidden();
  // Out of the fixed view: no note above the list.
  await expect(page.locator('.audit-content > .audit-cli-note')).toHaveCount(0);
  await expect(page.locator('.audit-content > .audit-note')).toHaveCount(0);
  await counting.locator('summary').click();
  await expect(counting.locator('.audit-cli-note')).toContainText(
    'O aae audit conta 2: esta observação e 1 resolução por nome ou sufixo único.',
  );
  await expect(counting.locator('.unresolved-note')).toContainText('Rodapé: 1 destino distinto');
  // A complete reading: no limit anywhere, no partial-reading link.
  await expect(page.locator('.status-bar .status-partial')).toHaveCount(0);
  await expect(page.getByLabel('Tipo de observação').locator('option[value="limit"]')).toHaveCount(
    0,
  );
  await expect(auditTab(page, 'Avisos')).toHaveCount(0);
  await expect(page.locator('.audit-content')).not.toContainText('Limite de leitura');
  await close();

  // Nothing to show: one sentence, no tab at zero calling for attention.
  close = await openOnly(page, project({ 'AGENTS.md': '# Entrada\n[B](b.md)\n', 'b.md': '# B\n' }));
  await openAudit(page);
  await expect(page.locator('.audit-empty')).toHaveText('Nenhuma observação nesta leitura.');
  await expect(page.locator('.audit-level')).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Nível das observações' })).toHaveText('');
  await expect(page.getByLabel('Tipo de observação')).toHaveCount(0);
  await expect(auditRows(page)).toHaveCount(0);
  await close();
  expect(errors).toEqual([]);
});

test('audit levels (f): marking as expected from the audit takes the line out of its file, lowers the tab and lists it under "Esperadas"', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = project({ 'AGENTS.md': '# Entrada\n[A](falta-a.md)\n[B](falta-b.md)\n' });
  const close = await openOnly(page, root);
  await openAudit(page);
  await expect(auditTab(page, 'Problemas')).toHaveText('Problemas 2');
  const head = auditFiles(page).first().locator('.observation-group-head');
  await expect(head.locator('.observation-group-count')).toHaveText('· 2');
  // The action is not on the lines: it is in the open line.
  await expect(page.locator('.audit-observations .expected-button')).toHaveCount(0);
  const line = await openAuditDetail(auditRow(page, 'falta-a.md'));
  await line
    .getByRole('button', {
      name: 'Marcar como esperada: Referência ausente (falta-a.md) em AGENTS.md:2',
    })
    .click();
  // The form has one sentence; one form at a time: the declaration closes it, and back.
  const form = line.locator('.expected-form');
  await expect(form.locator('p')).toHaveText(['Só neste aplicativo; a CLI continua relatando.']);
  await expect(line.locator('.diagnosis-scope')).toHaveCount(0);
  await line.getByRole('button', { name: 'Declarar no projeto…' }).click();
  await expect(line.locator('.diagnosis-scope')).toBeVisible();
  await expect(form).toHaveCount(0);
  // The options in words, without the code next to them; no notes in a list.
  await expect(line.locator('.scope-choice label')).toHaveText([
    'Gerado na execução',
    'Arquivo local',
  ]);
  await expect(line.locator('.diagnosis-scope li')).toHaveCount(0);
  await line
    .getByRole('button', {
      name: 'Marcar como esperada: Referência ausente (falta-a.md) em AGENTS.md:2',
    })
    .click();
  await expect(line.locator('.diagnosis-scope')).toHaveCount(0);
  await line.getByLabel('Motivo (opcional)').fill('Gerado na execução');
  await line.getByRole('button', { name: 'Marcar como esperada', exact: true }).click();
  await expect(page.locator('.audit-expected-status')).toHaveText(
    'Marcada como esperada: Referência ausente (falta-a.md) em AGENTS.md:2.',
  );
  // The line left the list: the focus stays in it, on the next line.
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /falta-b\.md/);
  await expect(auditRow(page, 'falta-a.md')).toHaveCount(0);
  await expect(auditRows(page)).toHaveCount(1);
  await expect(head.locator('.observation-group-count')).toHaveText('· 1');
  await expect(auditTab(page, 'Problemas')).toHaveText('Problemas 1');
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 1');
  const expected = page.locator('details.audit-expected:not(.audit-orphans)');
  await expect(expected.locator('summary')).toContainText('Esperadas (1)');
  await page.locator('.audit-summary').getByRole('button', { name: '1 esperada' }).click();
  await expect(expected).toHaveAttribute('open', '');
  await expect(expected.locator('.audit-expected-item')).toContainText(
    'Referência ausente · falta-a.md',
  );
  await expect(expected.locator('.expected-note')).toContainText('Gerado na execução');
  // Undone, it comes back to its file and its tab.
  await expected
    .getByRole('button', {
      name: 'Desmarcar: Referência ausente (falta-a.md) em AGENTS.md:2',
    })
    .click();
  await expect(auditTab(page, 'Problemas')).toHaveText('Problemas 2');
  await openAllAuditFiles(page);
  await expect(auditRow(page, 'falta-a.md')).toHaveCount(1);
  await close();
  expect(errors).toEqual([]);
});

test('audit levels (g): "Leitura parcial" opens the warnings on the limits, and the footer count opens every level on the unresolved references', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = project({
    'AGENTS.md':
      '# Entrada\n[Grande](grande.md)\n[Falta](falta.md)\nTermos: [glossário](glossario).\n',
    // Over the 1 MiB limit of one text: listed, not analysed.
    'grande.md': `# Grande\n${'linha sem referências\n'.repeat(60000)}`,
  });
  const close = await openOnly(page, root);
  // Opened first on the problems, so that the links have something to change.
  await openAudit(page);
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.status-bar').getByRole('button', { name: 'Leitura parcial' }).click();
  await expect(auditTab(page, 'Avisos')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Tipo de observação')).toHaveValue('limit');
  await expect(page.locator('.audit-type-meaning')).toHaveText(observationCodes.limit.meaning);
  await expect(auditFiles(page)).toHaveCount(1);
  await expect(auditFiles(page).locator('.observation-group-head')).toContainText('grande.md');
  await expect(auditRows(page)).toHaveCount(1);
  // The footer count of unresolved destinations: every level, the type that gathers them.
  await page
    .locator('.status-bar')
    .getByRole('button', { name: /citados? não encontrados?/ })
    .click();
  await expect(auditTab(page, 'Todas')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Tipo de observação')).toHaveValue('unresolved-targets');
  await openAllAuditFiles(page);
  await expect(auditRows(page).locator('.file-observation-target')).toHaveText([
    'falta.md',
    'glossario',
  ]);
  await close();
  expect(errors).toEqual([]);
});

test('audit levels (h): in the Relações tab, two citations of one file are one line with two numbers, each opening its own evidence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = project({
    'AGENTS.md':
      '# Entrada\n[Início](fluxos/inicio.md)\n[De novo](fluxos/inicio.md)\n[Raiz](b.md)\n',
    'fluxos/inicio.md': '# Início\n',
    'b.md': '# B\n',
  });
  const close = await openOnly(page, root);
  // Home lists the projects; the tree is in the project.
  await enterProject(page);
  await page.locator('.explorer').getByTitle(join(root, 'AGENTS.md'), { exact: true }).click();
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const rows = page.locator('.relation-list').first().locator('.relation-row');
  await expect(rows).toHaveCount(2);
  const inicio = rows.filter({ hasText: 'inicio.md' });
  // The path only when it differs from the name; the numbers of the two citations together.
  await expect(inicio.locator('.relation-path')).toHaveText('fluxos/inicio.md');
  await expect(rows.filter({ hasText: 'b.md' }).locator('.relation-path')).toHaveCount(0);
  await expect(inicio.locator('.relation-lines')).toHaveText('L2, L3');
  // At most two heights: the name line and the path line.
  const height = await inicio.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThan(48);
  await inicio.getByRole('button', { name: 'Evidência: Link Markdown na linha 3' }).click();
  await expect(page.locator('.evidence-item')).toHaveCount(1);
  await expect(page.locator('.evidence-item')).toContainText('[De novo](fluxos/inicio.md)');
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  await inicio.getByRole('button', { name: 'Evidência: Link Markdown na linha 2' }).click();
  await expect(page.locator('.evidence-item')).toHaveCount(1);
  await expect(page.locator('.evidence-item')).toContainText('[Início](fluxos/inicio.md)');
  await close();
  expect(errors).toEqual([]);
});
