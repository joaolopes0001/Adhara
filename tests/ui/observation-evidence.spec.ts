import { expect, test } from '@playwright/test';
import { auditRow, auditRows, auditTab, openAllAuditFiles, showAudit } from './audit-list';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, readable, sessionHeaders, writeTree } from './helpers';
import { runMoreAction } from './more-menu';

// Two references on one line (an ambiguous one and a missing one): each observation opens its own
// evidence. The footer count of unresolved destinations opens the audit on the references without a
// resolved destination, and the note says how the two counts differ.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-observation-evidence-'));
  const tree: Record<string, string> = {
    'loja/AGENTS.md':
      '# Loja\nSkill: [gerar](.claude/skills/gerar-release/SKILL.md).\nRevisão: [revisar](.claude/skills/revisar-pr/checklist.md) e [docs](docs/checklist.md).\nTermos: [glossário](glossario).\nFora: [vizinho](../vizinho/guia.md) e [outro](../vizinho/ausente.md).\nAusente: [deploy](docs/deploy.md).\nDe novo: [deploy](docs/deploy.md).\nE outra vez: [deploy](docs/deploy.md).\n',
    'loja/.claude/skills/gerar-release/SKILL.md':
      '---\nname: gerar-release\ndescription: Gera notas.\n---\n# Gerar release\n\nUse [o checklist](checklist.md) e escreva o resultado em [notas](notas.md).\n',
    'loja/.claude/skills/revisar-pr/checklist.md': '# Checklist da skill\n',
    'loja/docs/checklist.md': '# Checklist de revisão\n',
    'vizinho/guia.md': '# Guia fora do diretório aberto\n',
  };
  writeTree(base, tree);
  return join(base, 'loja');
}

/** Text color against the first opaque background up the tree. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 360 }),
      );
  });
});

test('observations: each reference of a line opens its own evidence, and the footer count opens the audit on unresolved references', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const skill = join(root, '.claude/skills/gerar-release/SKILL.md');
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Footer and search count the same thing: distinct destinations that are not inventoried files.
  await expect(page.locator('.status-bar .status-files')).toHaveText(/ de 4 arquivos lidos$/);
  await expect(page.locator('.status-bar .status-unresolved')).toHaveText(
    '5 citados não encontrados',
  );
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('/');
  await expect(page.locator('.search-unresolved summary')).toHaveText('5 citados não encontrados');
  await page.getByLabel('Limpar busca').click();

  // The footer count opens the audit on the references without a resolved destination.
  const link = page
    .locator('.status-bar')
    .getByRole('button', { name: '5 citados não encontrados' });
  await expect(link).toHaveAttribute('title', /Abre na Auditoria/);
  await link.click();
  // Every level, with the type that gathers them.
  await expect(auditTab(page, 'Todas')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 6');
  await expect(page.getByLabel('Tipo de observação')).toHaveValue('unresolved-targets');
  await expect(
    page.getByLabel('Tipo de observação').locator('option[value="unresolved-targets"]'),
  ).toHaveText('Referências sem destino encontrado (6)');
  await openAllAuditFiles(page);
  await expect(auditRows(page)).toHaveCount(6);
  // Why the footer and the list differ: in "Como estes números são contados", closed by default.
  const counting = page.locator('details.audit-counting');
  await expect(counting).not.toHaveAttribute('open', /.*/);
  await counting.locator('summary').click();
  const note = page.locator('.unresolved-note');
  // The footer counts distinct destinations; the list counts references, the ambiguous one without a destination.
  await expect(note).toHaveText(
    'Rodapé: 5 destinos distintos (3 não existem, 2 fora dos diretórios abertos). Auditoria: 6 referências (4 ausentes, 1 nome sem arquivo, 1 ambígua, sem destino escolhido).',
  );
  await expect(note).not.toContainText('unresolved-name');

  // SKILL.md:7 cites checklist.md (ambiguous) and notas.md (missing): each opens its own evidence.
  // The line number opens the file at the line.
  await auditRow(page, 'checklist.md').locator('.file-observation-line').click();
  await expect(page.locator('.inspector h2')).toHaveText('SKILL.md');
  // The path is said once, in the header; the text below is this file's.
  await expect(page.locator('.inspector .copy-path code')).toHaveText(skill);
  await expect(page.locator('.source-path')).toHaveCount(0);
  await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', '7');
  const observation = page.locator('.observation-context');
  await expect(observation).toContainText('Linha 7: checklist.md');
  // "Ver detalhe" opens that occurrence in the observations above, even inside a collapsed informative group.
  await observation.getByRole('button', { name: 'Ver detalhe' }).click();
  const opened = page.locator('.inspector .file-observation.open');
  await expect(opened).toHaveCount(1);
  await expect(opened.locator('.file-observation-target')).toHaveText('checklist.md');
  await expect(opened.locator('.diagnosis-candidates li')).toHaveCount(2);
  await expect(observation.getByRole('button', { name: 'Ver detalhe' })).toHaveCount(0);
  await expect(page.locator('.source-context')).toHaveCount(1);
  await expect(page.locator('.source-context')).not.toContainText('notas.md');
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of ['.status-link', '.unresolved-note', '.observation-context'])
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`observation-ambiguous-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }

  await auditRow(page, 'notas.md').locator('.file-observation-line').click();
  await expect(page.locator('.source-context')).toHaveText(
    /^Evidência de SKILL\.md → notas\.md · linha 7/,
  );
  await expect(observation).toHaveCount(0);
  await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', '7');
  await page.getByRole('button', { name: 'Evidências', exact: true }).click();
  await expect(page.locator('.evidence-item')).toHaveCount(1);
  await expect(page.locator('.evidence-item')).toContainText('[notas](notas.md)');

  // Back to the ambiguous one: its context again, not the missing reference of the same line.
  await auditRow(page, 'checklist.md').locator('.file-observation-line').click();
  await expect(observation).toContainText('Linha 7: checklist.md');
  await expect(page.locator('.source-context')).not.toContainText('notas.md');
  await observation.getByRole('button', { name: 'Limpar destaque' }).click();
  await expect(page.locator('.highlight-line')).toHaveCount(0);
  await expect(observation).toHaveCount(0);

  // A missing destination cited on several lines: the chosen observation opens its own line.
  await showAudit(page, 'Problemas', 'broken');
  await expect(auditRows(page)).toHaveCount(4);
  await auditRow(page, 'docs/deploy.md').first().locator('.file-observation-line').click();
  await expect(page.locator('.source-context')).toContainText('AGENTS.md → deploy.md · linha 6');
  expect(errors).toEqual([]);
  await page.request.post('/api/close', { headers, data: { path: root } });
});
