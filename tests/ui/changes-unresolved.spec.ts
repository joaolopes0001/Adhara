import { expect, test } from '@playwright/test';
import { auditFiles, auditRows, auditTab, showAudit } from './audit-list';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALERT_ICONS,
  enterProject,
  expectAuditLineColours,
  openOnlyWithWorkspace,
  readable,
  writeTree,
} from './helpers';
import { runMoreAction } from './more-menu';

// Package with real files, reference placeholders that look like files, a twin skill
// pair (.agents × .claude) and two high-fanout hubs emitted smallest first.
const hub = (count: number) =>
  '# Hub\n' +
  Array.from({ length: count }, (_, index) => `[Destino ${index}](destinos/d${index}.md)\n`).join(
    '',
  );
const files: Record<string, string> = {
  'AGENTS.md':
    '# Pacote\n[Política](.agents/skills/_shared/politica-editorial.md)\n[Peças](.agents/skills/pecas/SKILL.md)\n[Projeção](.claude/skills/pecas/SKILL.md)\n[A](a-hub.md)\n[Z](z-hub.md)\n',
  '.agents/skills/_shared/politica-editorial.md': '# Política editorial\n',
  '.agents/skills/pecas/SKILL.md':
    '# Peças Processuais\nLeia [a política](./_shared/politica-editorial.md).\n',
  '.claude/skills/pecas/SKILL.md':
    '# Pecas Processuais\nLeia [a política](./.agents/skills/_shared/politica-editorial.md).\n',
  'a-hub.md': hub(13),
  'z-hub.md': hub(15),
};

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-unresolved-')), 'pacote');
  writeTree(root, files);
  mkdirSync(join(root, 'destinos'), { recursive: true });
  for (let index = 0; index < 15; index++)
    writeFileSync(join(root, 'destinos', `d${index}.md`), `# D${index}\n`);
  return root;
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

test('unresolved destinations: search and filter suggestions collapse them, the footer counts them apart, objects show full paths and signals open with the largest', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  const workspace = await openOnlyWithWorkspace(page, root);
  const model = await workspace();
  const ghosts = model.nodes.filter((node: any) => node.kind === 'unresolved');
  const real = model.nodes.filter((node: any) => !['directory', 'unresolved'].includes(node.kind));
  expect(ghosts.map((node: any) => node.relative).sort()).toEqual([
    '.agents/skills/pecas/_shared/politica-editorial.md',
    '.claude/skills/pecas/.agents/skills/_shared/politica-editorial.md',
  ]);
  expect(real).toHaveLength(21);
  expect([model.stats.files, model.stats.unresolvedTargets]).toEqual([21, 2]); // real files only; placeholders are counted apart
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Bottom bar: the files read of the real files, and the unresolved destinations apart.
  await expect(page.locator('.status-bar .status-files')).toHaveText(
    `${model.stats.parsed} de 21 arquivos lidos`,
  );
  await expect(page.locator('.status-bar .status-unresolved')).toHaveText(
    '2 citados não encontrados',
  );

  // Search: one real file; the two placeholders are collapsed in one line, marked as not existing.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('politica-editorial');
  await expect(page.locator('.search-results > p').first()).toHaveText('1 arquivo');
  await expect(page.locator('.search-results button')).toHaveCount(1);
  await expect(page.locator('.search-results button')).toHaveAttribute(
    'title',
    join(root, '.agents/skills/_shared/politica-editorial.md'),
  );
  const group = page.locator('.search-unresolved');
  await expect(group.locator('summary')).toHaveText('2 citados não encontrados');
  await expect(group.locator('.unresolved-item').first()).toBeHidden();
  await page
    .locator('.explorer')
    .screenshot({ path: test.info().outputPath('search-collapsed-dark.png') });
  await runMoreAction(page, 'Ativar tema claro');
  await page
    .locator('.explorer')
    .screenshot({ path: test.info().outputPath('search-collapsed-light.png') });
  await group.locator('summary').click();
  await expect(group.locator('.unresolved-item')).toHaveCount(2);
  await expect(group.locator('.unresolved-tag')).toHaveText(['não existe', 'não existe']);
  for (const theme of ['light', 'dark']) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of [
      '.search-unresolved summary',
      '.search-unresolved .unresolved-tag',
      '.search-unresolved .unresolved-item small',
      '.status-bar .status-files',
    ]) {
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    await page
      .locator('.explorer')
      .screenshot({ path: test.info().outputPath(`search-expanded-${theme}.png`) });
    if (theme === 'light') await runMoreAction(page, 'Ativar tema escuro');
  }
  await group.locator('.unresolved-item').first().click();
  await expect(page.locator('.file-status')).toContainText('Ausente');

  // Objects: full relative path distinguishes the skill from its projection.
  await page.getByLabel('Limpar busca').click();
  await page.locator('.explorer .small-tabs button', { hasText: 'Objetos' }).click();
  await expect(page.locator('.object-list small')).toContainText([
    'skill · .agents/skills/pecas/SKILL.md',
    'skill · .claude/skills/pecas/SKILL.md',
  ]);

  // Filter suggestions: same separation (a real file is selected, so it starts the draft).
  await page.locator('.object-list button').first().click();
  await page.getByRole('button', { name: 'Filtros do mapa' }).click();
  await page.getByLabel('Buscar arquivo para filtro').fill('politica-editorial');
  await expect(page.locator('.filter-candidates button')).toHaveCount(1);
  await expect(page.locator('.filter-unresolved summary')).toHaveText('2 citados não encontrados');
  await expect(page.locator('.filter-unresolved .unresolved-item').first()).toBeHidden();
  await page.locator('.filter-unresolved summary').click();
  await expect(page.locator('.filter-unresolved .unresolved-tag')).toHaveText([
    'não existe',
    'não existe',
  ]);
  await page
    .locator('.modal')
    .screenshot({ path: test.info().outputPath('filter-unresolved-dark.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);

  // Audit: "Muitas saídas" opens with the largest number; a type without occurrences is not offered.
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await showAudit(page, 'Sinais', 'high-fanout');
  await expect(auditRows(page)).toHaveCount(2);
  await expect(auditRows(page).first()).toContainText('15 destinos');
  await expect(auditFiles(page).first().locator('.observation-group-head')).toContainText(
    'z-hub.md',
  );
  await expect(auditRows(page).nth(1)).toContainText('13 destinos');
  await showAudit(page, 'Todas');
  await expect(
    page.getByLabel('Tipo de observação').locator('option[value="unresolved-name"]'),
  ).toHaveCount(0);
  await showAudit(page, 'Todas', 'broken');
  await expect(auditRows(page)).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('model extensions from a newer backend: unresolved-name issues, skill-relative resolutions and unknown modes do not break the interface', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  await openOnlyWithWorkspace(page, root);
  const entry = join(root, 'AGENTS.md'),
    policy = join(root, '.agents/skills/_shared/politica-editorial.md');
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    const model = await response.json();
    const edges = model.edges.filter((edge: any) => edge.target === policy);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    edges[0].resolvedBy = 'skill-basename';
    model.edges.find(
      (edge: any) => edge.source === entry && edge.raw === '.agents/skills/pecas/SKILL.md',
    ).resolvedBy = 'skill-suffix';
    model.edges.find((edge: any) => edge.source === entry && edge.raw === 'a-hub.md').resolvedBy =
      'modo-futuro';
    const named = (id: string, node: string, line: number) => ({
      id,
      code: 'unresolved-name',
      message: `Nome citado sem diretório não corresponde a nenhum arquivo do inventário: nome-${line}.md.`,
      node,
      line,
      target: `nome-${line}.md`,
    });
    model.issues.push(
      named('mock-a', entry, 3),
      named('mock-b', join(root, 'z-hub.md'), 5),
      named('mock-c', join(root, 'z-hub.md'), 2),
    );
    await route.fulfill({ response, json: model });
  });
  await page.goto('/');
  // Home lists the projects, without the explorer: the tree is in a project.
  await enterProject(page);
  await page.locator('.explorer').getByTitle(entry, { exact: true }).click();
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const outgoing = page.locator('.relation-list').first();
  await expect(
    outgoing
      .locator('.relation-row', { hasText: 'politica-editorial.md' })
      .locator('.resolution-mark'),
  ).toContainText('resolvida por nome único na própria skill');
  await expect(
    outgoing
      .locator('.relation-row', { hasText: '.agents/skills/pecas/SKILL.md' })
      .locator('.resolution-mark'),
  ).toContainText('resolvida por sufixo único na própria skill');
  await expect(
    outgoing.locator('.relation-row', { hasText: 'a-hub.md' }).locator('.resolution-mark'),
  ).toContainText('resolvida por um modo não reconhecido (modo-futuro)');
  await outgoing
    .locator('.relation-row', { hasText: 'politica-editorial.md' })
    .locator('.relation-evidence')
    .click();
  await expect(page.locator('.evidence-item .resolution-note')).toContainText(
    'Resolvida por nome único na própria skill.',
  );
  await expect(page.locator('.evidence-item .resolution-note')).toContainText(
    'Confira se é o destino pretendido',
  );
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await showAudit(page, 'Informativos', 'unresolved-name');
  // Grouped by the source file with most observations in the selection, then by line.
  // One group per file, with the path relative to the project (the absolute path in the tooltip).
  const heads = auditFiles(page).locator('.observation-group-head');
  await expect(heads.locator('strong')).toHaveText(['z-hub.md', 'AGENTS.md']);
  await expect(heads.locator('.observation-group-count')).toHaveText(['· 2', '· 1']);
  await expect(heads.last()).toHaveAttribute('title', entry);
  await expect(auditRows(page).locator('.file-observation-line')).toHaveText(['L2', 'L5', 'L3']);
  await expect(auditRows(page).last().locator('.file-observation-line')).toHaveAttribute(
    'title',
    `Abrir ${entry} na linha 3`,
  );
  // Informative lines: no icon; what is written in the normal colour, the rest muted.
  await expect(page.locator('.audit-line').locator(ALERT_ICONS)).toHaveCount(0);
  await expect(page.locator('.audit-line.tone-info')).toHaveCount(3);
  expect(await expectAuditLineColours(page)).toBe(3);
  await expect(auditRows(page)).toHaveCount(3);
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');
  await page
    .locator('.tool-panel')
    .screenshot({ path: test.info().outputPath('audit-unresolved-name-dark.png') });
  expect(errors).toEqual([]);
});

test('changes: a link swapped outside the interface is exactly one relation added and one removed, with file and line, in both themes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = mkdtempSync(join(tmpdir(), 'aae-changes-'));
  const { root } = JSON.parse(
    execFileSync('python3', ['tests/create_builder_lab.py', '--destination', join(base, 'lab')], {
      encoding: 'utf8',
    }),
  );
  const workspace = await openOnlyWithWorkspace(page, root);
  const cli = (...args: string[]) =>
    JSON.parse(execFileSync('python3', ['-B', '-m', 'server.cli', ...args], { encoding: 'utf8' }));
  const audit = (name: string) => {
    const path = join(base, name);
    try {
      writeFileSync(
        path,
        execFileSync('python3', ['-B', '-m', 'server.cli', 'audit', '--root', root], {
          encoding: 'utf8',
        }),
      );
    } catch (error: any) {
      writeFileSync(path, error.stdout);
    }
    return path;
  };
  const before = audit('antes.json');
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // First reading of the root in this server: it is the reference, nothing changed yet.
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await expect(page.locator('.changes-times')).toContainText('Referência: leitura de');
  await expect(page.locator('.changes-times')).toContainText('Leitura atual:');
  await expect(page.locator('.changes-empty')).toHaveText('Nenhuma alteração.');
  // A reference set by this server is saved in the app state: it survives a restart.
  await expect(page.locator('.changes-origin')).toHaveText('desta sessão');
  await expect(page.locator('.changes-origin.unsaved')).toHaveCount(0);
  await expect(page.locator('.changes-content')).toContainText(
    'continua valendo depois de reiniciar o servidor',
  );
  expect((await workspace()).delta.roots[0]).toMatchObject({
    referenceOrigin: 'first-reading',
    referenceSaved: true,
  });
  await expect(page.getByRole('button', { name: 'Atualizar referência' })).toBeDisabled();
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();

  // Swap one link outside the interface, then reread.
  const agents = join(root, 'AGENTS.md');
  const text = readFileSync(agents, 'utf8');
  writeFileSync(
    agents,
    text.replace(
      '[Contrato repetido](core/contrato.md)',
      '[Nova dependência](honeypot/irrelevante.md)',
    ),
  );
  const after = audit('depois.json');
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  const notice = page.locator('.change-notice');
  await expect(notice).toContainText('1 relação adicionada · 1 relação removida');
  await page
    .locator('.app-header')
    .screenshot({ path: test.info().outputPath('change-notice-dark.png') });
  await notice.locator('button').first().click();
  await expect(notice).toHaveCount(0);

  const relations = page.locator('.changes-section[aria-label="Relações"]');
  await expect(relations.locator('h3')).toContainText('1 adicionada · 1 removida');
  await expect(relations.locator('.change-row')).toHaveCount(2);
  const added = relations.locator('.change-row.added'),
    removed = relations.locator('.change-row.removed');
  await expect(added).toContainText('AGENTS.md:4 → honeypot/irrelevante.md');
  await expect(added).toContainText('[Nova dependência](honeypot/irrelevante.md)');
  await expect(removed).toContainText('AGENTS.md:4 → core/contrato.md');
  await expect(removed).toContainText('estava na linha 4 da leitura de referência');
  await expect(removed).toContainText('core/contrato.md');
  await expect(page.locator('.changes-section[aria-label="Arquivos"] .change-row')).toHaveText([
    /alterado.*AGENTS\.md/,
  ]);

  // Observations: the same set compare-audit returns for the two states.
  const comparison = cli('compare-audit', '--before', before, '--after', after);
  const delta = (await workspace()).delta;
  expect(delta.findings.new.map((item: any) => item.id).sort()).toEqual(
    comparison.new.map((item: any) => item.id).sort(),
  );
  expect(delta.findings.resolved.map((item: any) => item.id).sort()).toEqual(
    comparison.resolved.map((item: any) => item.id).sort(),
  );
  expect(comparison.new.length + comparison.resolved.length).toBe(1);
  // Dock count: 2 relations, 1 changed file and the observation set.
  await expect(page.locator('.dock-tools .dock-count')).toHaveText(
    String(3 + comparison.new.length + comparison.resolved.length),
  );
  const observations = page.locator('.changes-section[aria-label="Observações"] .change-row');
  await expect(observations).toHaveCount(comparison.new.length + comparison.resolved.length);
  await expect(observations.first()).toContainText('honeypot/irrelevante.md');

  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of [
      '.changes-times',
      '.changes-times strong',
      '.changes-adopt',
      '.change-tag.added',
      '.change-tag.removed',
      '.change-tag.changed',
      '.change-row small',
      '.changes-section h3',
      '.changes-section h3 > span',
      '.changes-about summary',
      '.dock-count',
    ]) {
      expect(
        await readable(page.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    await page
      .locator('.tool-panel')
      .screenshot({ path: test.info().outputPath(`changes-${theme}.png`) });
    await page.screenshot({ path: test.info().outputPath(`changes-window-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }

  // The added relation opens its evidence line; the removed one opens the file where it was.
  await added.click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await expect(page.locator('.highlight-line')).toContainText(
    '[Nova dependência](honeypot/irrelevante.md)',
  );
  await expect(page.locator('.highlight-line span')).toHaveText('4');

  // Rereading again keeps the delta (fixed reference); with the tool open no extra notice is needed.
  const current = await page.locator('.changes-times > span').nth(1).textContent();
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reler diretórios', exact: true })).toBeEnabled();
  await expect(page.locator('.change-notice')).toHaveCount(0);
  await expect(relations.locator('.change-row')).toHaveCount(2);
  expect(current).toContain('Leitura atual:');
  const reference = await page.locator('.changes-times > span').first().textContent();
  await page.getByRole('button', { name: 'Atualizar referência' }).click();
  await expect(page.locator('.changes-confirmation')).toContainText(
    'Referência atualizada: leitura de',
  );
  await expect(page.locator('.changes-empty')).toHaveText('Nenhuma alteração.');
  await expect(page.locator('.dock-tools .dock-count')).toHaveCount(0);
  const adopted = (await workspace()).delta;
  expect(adopted.reference.at).toBe(adopted.current.at);
  expect(adopted.roots[0].referenceOrigin).toBe('user');
  expect(reference).toContain('Referência: leitura de');
  // The interface never wrote into the inspected root.
  expect(readFileSync(agents, 'utf8')).toBe(
    text.replace(
      '[Contrato repetido](core/contrato.md)',
      '[Nova dependência](honeypot/irrelevante.md)',
    ),
  );
  expect(errors).toEqual([]);
});
