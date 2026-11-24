import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditRows, auditTab, showAudit } from './audit-list';
import {
  ALERT_ICONS,
  closeAllProjects,
  colorOf,
  enterProject,
  expectAuditLineColours,
  readable,
  selectFile,
  sessionHeaders,
  showMap,
  toneColor,
  writeTree,
} from './helpers';
import { runMoreAction } from './more-menu';

// An alert is said by colour alone: no triangle and no circled "i" marks a tone on the surfaces that show
// observations, partial readings and failures. The number or the words that were next to the icon take the
// tone's colour, readable at 4.5:1 in both themes, and the accessible names still say what the icon meant.
// The icons that are controls or kinds of object stay.

/** A project with a problem (broken), a warning (ambiguous with a folder) and an info (ambiguous name). */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-alert-colour-'));
  const root = join(base, 'tons');
  writeTree(root, {
    'AGENTS.md':
      '# Entrada\n[Falta](falta.md)\n[Política](pol/Politica.md)\n[[Guia]]\n[Notas](notas.md)\n',
    'notas.md': '# Notas\n',
    'a/pol/Politica.md': '# A\n',
    'b/pol/Politica.md': '# B\n',
    'a/Guia.md': '# A\n',
    'b/Guia.md': '# B\n',
    'so-info.md': '# Só informativo\n[[Guia]]\n',
    // A warning with informative ones (the ambiguous name; no file references it, an orphan).
    'aviso.md': '# Aviso\n[Política](pol/Politica.md)\n[[Guia]]\n',
    // Over the 1 MiB limit of one text: listed, not read; the inspector says so in the warning colour.
    'grande.md': `# Grande\n${'linha sem referências\n'.repeat(60000)}`,
    'ligado.md': '# Ligado\n',
  });
  // A second name for ligado.md (a hard link): editing it is refused, in a note of the inspector.
  linkSync(join(root, 'ligado.md'), join(base, 'outro-nome.md'));
  // A second project without observations, to reorder the projects.
  writeTree(join(base, 'outro'), { 'AGENTS.md': '# Outro\n' });
  // A name that is not UTF-8: its folder is read in part, which the footer and the Structure say.
  mkdirSync(join(root, 'notas-parciais'));
  writeFileSync(join(root, 'notas-parciais', 'a.md'), '# A\n');
  writeFileSync(
    Buffer.concat([
      Buffer.from(`${root}/notas-parciais/`),
      Buffer.from([0x6e, 0xff, 0x2e, 0x6d, 0x64]),
    ]),
    '# x\n',
  );
  // A saved project whose folder is gone: "indisponível" on Home.
  const gone = join(base, 'sumida');
  writeTree(gone, { 'AGENTS.md': '# x\n' });
  return { root, gone, other: join(base, 'outro') };
}

async function open(page: Page) {
  const { root, gone, other } = fixture();
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  for (const path of [gone, root])
    expect((await page.request.post('/api/open', { headers, data: { path } })).status()).toBe(200);
  await page.request.post('/api/close', { headers, data: { path: gone } });
  rmSync(gone, { recursive: true, force: true });
  await page.goto('/');
  return {
    root,
    other,
    headers,
    close: async () => {
      await page.request.post('/api/edit/disable', { headers, data: { root } });
      for (const path of [root, gone, other])
        await page.request.post('/api/close', { headers, data: { path } });
    },
  };
}

/** No icon of a tone inside any of the surfaces. */
async function noAlertIcon(surfaces: Locator[]) {
  for (const surface of surfaces) await expect(surface.locator(ALERT_ICONS)).toHaveCount(0);
}

test('alerts by colour: no tone icon on the main surfaces, the tone in the colour of the words and numbers, names kept', async ({
  page,
}) => {
  const { root, close } = await open(page);
  try {
    // Home: the count of the problems and warnings of the project in the problem colour; its accessible
    // name says the same count, where it counts, and the informative ones apart; the unavailable folder in
    // the warning colour.
    const home = page.locator('.home-list');
    const homeMarker = home.locator('.home-row.is-folder .observation-marker');
    await expect(homeMarker).toHaveText(/^\d+$/);
    const name = (await homeMarker.getAttribute('aria-label'))!;
    const counted = name.match(/^(\d+) problemas?, (\d+) avisos? nos arquivos deste projeto: /);
    expect(counted, name).not.toBeNull();
    expect(Number(await homeMarker.textContent())).toBe(Number(counted![1]) + Number(counted![2]));
    expect(name).toMatch(/ · \d+ informativos?: .*\. Abrir na Auditoria$/);
    expect(await colorOf(homeMarker)).toBe(await toneColor(page, 'problem'));
    const unavailable = home.locator('.home-row.is-closed .structure-listing');
    await expect(unavailable).toHaveText('indisponível');
    expect(await colorOf(unavailable)).toBe(await toneColor(page, 'warning'));
    await noAlertIcon([home]);

    // Structure and tree: markers and the folder read in part.
    await enterProject(page, 'tons');
    const structure = page.getByRole('region', { name: 'Estrutura de tons' });
    const row = (name: string) =>
      structure.locator('.structure-row', {
        has: page.locator('.structure-open', { hasText: new RegExp(`^${name}$`) }),
      });
    // The number counts the problems and the warnings, and the words say the same count; the
    // informative one apart, after them.
    const marker = row('AGENTS.md').locator('.observation-marker');
    await expect(marker).toHaveText('2');
    await expect(marker).toHaveAccessibleName(
      '1 problema, 1 aviso: referência ausente, referência ambígua · 1 informativo: nome com vários arquivos possíveis. Ver diagnóstico',
    );
    await expect(marker).toHaveAttribute(
      'title',
      '1 problema, 1 aviso: referência ausente, referência ambígua · 1 informativo: nome com vários arquivos possíveis',
    );
    expect(await colorOf(marker)).toBe(await toneColor(page, 'problem'));
    // A warning with informative ones: the number of the warning, in its colour.
    const warned = row('aviso.md').locator('.observation-marker');
    await expect(warned).toHaveText('1');
    await expect(warned).toHaveAccessibleName(
      /^1 aviso: referência ambígua · 2 informativos: .+\. Ver diagnóstico$/,
    );
    expect(await colorOf(warned)).toBe(await toneColor(page, 'warning'));
    // Informative ones alone: no marker, in the Structure and in the tree.
    await expect(row('so-info.md').locator('[data-slot="marker"]')).toBeEmpty();
    const treeRow = (name: string) =>
      page.locator('.explorer .tree-file-row', {
        has: page.getByTitle(join(root, name), { exact: true }),
      });
    await expect(treeRow('so-info.md')).toBeVisible();
    await expect(treeRow('so-info.md').locator('.observation-marker')).toHaveCount(0);
    await expect(treeRow('aviso.md').locator('.observation-marker')).toHaveText('1');
    const listing = row('notas-parciais').locator('.structure-listing');
    await expect(listing).toContainText('lida em parte');
    expect(await colorOf(listing)).toBe(await toneColor(page, 'warning'));
    // The footer link of the partial reading: its words in the warning colour, its name kept.
    const partial = page.locator('.status-bar .status-partial');
    await expect(partial).toHaveAccessibleName(/^Leitura parcial: /);
    expect(await colorOf(partial)).toBe(await toneColor(page, 'warning'));
    await noAlertIcon([
      structure,
      page.locator('.explorer'),
      page.locator('.status-bar .status-link'),
    ]);

    // Inspector: the counts by tone in their colours, the word of each group's tone in its colour.
    await selectFile(page, join(root, 'AGENTS.md'));
    const block = page.locator('.inspector .file-observations');
    await expect(block.locator('.observations-count')).toHaveText([
      '1 problema',
      '1 aviso',
      '1 informativo',
    ]);
    for (const tone of ['problem', 'warning', 'info'] as const)
      expect(await colorOf(block.locator(`.observations-count.tone-${tone}`))).toBe(
        await toneColor(page, tone),
      );
    await expect(block.locator('.observation-group-tone')).toHaveText([
      'problema',
      'aviso',
      'informativo',
    ]);
    for (const [index, tone] of (['problem', 'warning', 'info'] as const).entries())
      expect(await colorOf(block.locator('.observation-group-tone').nth(index))).toBe(
        await toneColor(page, tone),
      );
    // Problem and warning have the same weight and differ only in hue, as they did under the same
    // triangle: their words are what sets them apart without the colour.
    await noAlertIcon([block, page.locator('.inspector-identity')]);
    // Without the icon, the title of a group stays on one axis with its meaning and its lines' targets.
    const left = async (locator: Locator) => (await locator.boundingBox())!.x;
    const first = block.locator('.observation-group').first();
    const axis = await left(first.locator('.observation-group-meaning'));
    expect(await left(first.locator('.observation-group-head strong'))).toBeCloseTo(axis, 0);
    expect(await left(first.locator('.file-observation-target').first())).toBeCloseTo(axis, 0);

    // Relations: "· não existe" in the problem colour.
    await page.getByRole('button', { name: 'Relações', exact: true }).click();
    const missing = page.locator('.inspector .missing-dot').first();
    await expect(missing).toHaveText('· não existe');
    // The words in the problem tone; the separator stays muted, as in "· nome sem arquivo".
    expect(await colorOf(missing.locator('.missing-dot-text'))).toBe(
      await toneColor(page, 'problem'),
    );
    expect(await colorOf(missing)).toBe(await toneColor(page, 'info'));
    await noAlertIcon([page.locator('.inspector .relation-list').first()]);

    // The map: the count of the tile in the problem colour, its words in the name.
    await showMap(page);
    const badge = page.locator('.react-flow__node button.tile-observations').first();
    await expect(badge).toHaveText('2');
    await expect(badge).toHaveAccessibleName(
      /^1 problema, 1 aviso: .+ · 1 informativo: .+\. Ver diagnóstico$/,
    );
    expect(await colorOf(badge)).toBe(await toneColor(page, 'problem'));
    await noAlertIcon([page.locator('.react-flow__nodes')]);

    // Audit: the name of each tab in its tone, what is written on each line in the line's tone.
    await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
    await showAudit(page, 'Todas');
    expect(await colorOf(auditTab(page, 'Problemas'))).toBe(await toneColor(page, 'problem'));
    expect(await colorOf(auditTab(page, 'Avisos'))).toBe(await toneColor(page, 'warning'));
    const line = (text: string) =>
      auditRows(page).filter({ hasText: text }).first().locator('.file-observation-target');
    expect(await colorOf(line('falta.md'))).toBe(await toneColor(page, 'problem'));
    expect(await colorOf(line('pol/Politica.md'))).toBe(await toneColor(page, 'warning'));
    for (const tone of ['problem', 'warning'] as const)
      expect(await colorOf(line('Guia'))).not.toBe(await toneColor(page, tone));
    await noAlertIcon([page.locator('.audit-levels'), page.locator('.audit-observations')]);
    // Every line strictly in the colour of its own tone: an informative line has nothing in a tone's
    // colour, not even the note of a partial reading.
    // The reading is partial, so an orphan line says "não conclusivo": muted, in an informative line.
    await expect(
      page.locator('.audit-line.tone-info .file-observation-type.inconclusive').first(),
    ).toBeVisible();
    expect(await expectAuditLineColours(page)).toBeGreaterThan(3);

    // Contrast of every coloured text against its real background, in both themes: the tile in the map,
    // the rest with the Structure back in the view.
    const coloured = [
      '.structure-view .observation-marker.tone-problem',
      '.structure-view .observation-marker.tone-warning',
      '.structure-view .structure-listing',
      '.status-bar .status-partial',
      '.audit-levels .audit-level.tone-problem',
      '.audit-levels .audit-level.tone-warning',
      '.audit-line.tone-problem .file-observation-target',
      '.audit-line.tone-warning .file-observation-target',
      '.inspector .missing-dot-text',
    ];
    const mode = (name: RegExp) =>
      page.locator('#top-view-mode').getByRole('button', { name }).click();
    for (const [theme, next] of [
      ['dark', 'claro'],
      ['light', 'escuro'],
    ]) {
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await readable(badge), `tile badge (${theme})`).toBeGreaterThanOrEqual(4.5);
      await mode(/^Estrutura de /);
      await expect(page.locator('.structure-view')).toBeVisible();
      for (const selector of coloured)
        expect(
          await readable(page.locator(selector).first()),
          `${selector} (${theme})`,
        ).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({ path: test.info().outputPath(`alerts-${theme}.png`) });
      await runMoreAction(page, `Ativar tema ${next}`);
      await mode(/^Mapa de /);
    }
  } finally {
    await close();
  }
});

test('alerts by colour (negative): informative alone takes no tone colour, and the icons that are controls stay', async ({
  page,
}) => {
  const { root, close } = await open(page);
  try {
    await enterProject(page, 'tons');
    await selectFile(page, join(root, 'so-info.md'));
    const block = page.locator('.inspector .file-observations');
    await expect(block.locator('.observations-count')).toHaveText(['2 informativos']);
    await expect(block.locator('.tone-problem, .tone-warning')).toHaveCount(0);
    for (const tone of ['problem', 'warning'] as const)
      expect(await colorOf(block.locator('.observations-count'))).not.toBe(
        await toneColor(page, tone),
      );
    // Not alerts: the chevron of each group and the kinds of file in the tree keep their icons.
    const heads = block.locator('.observation-group-head');
    await expect(heads.locator('svg')).toHaveCount(await heads.count());
    await expect(heads.locator('svg:not(.lucide-chevron-right, .lucide-chevron-down)')).toHaveCount(
      0,
    );
    await expect(page.locator('.explorer .tree-file-row svg').first()).toBeVisible();
    // Its tile in the map of the file has no badge; the inspector above still lists them.
    await showMap(page);
    const tile = page.locator('.react-flow__node-file', {
      has: page.locator(`strong[title="${join(root, 'so-info.md')}"]`),
    });
    await expect(tile).toBeVisible();
    await expect(tile.locator('.tile-observations')).toHaveCount(0);
    await page
      .locator('#top-view-mode')
      .getByRole('button', { name: /^Estrutura de / })
      .click();

    // The line of a file not read, under its name: its words in the warning colour in both themes (the
    // light theme mutes the other lines of the identity, and must not mute this one).
    await selectFile(page, join(root, 'grande.md'));
    const note = page.locator('.inspector .analysis-note');
    await expect(note).toHaveText('não lido: limite de tamanho (1 MiB)');
    for (const next of ['claro', 'escuro']) {
      expect(await colorOf(note)).toBe(await toneColor(page, 'warning'));
      expect(await readable(note)).toBeGreaterThanOrEqual(4.5);
      await runMoreAction(page, `Ativar tema ${next}`);
    }
  } finally {
    await close();
  }
});

test('alerts by colour: the strip, the folder map note, the evidence title, Changes, the order error and the editor refusal have no tone icon', async ({
  page,
}) => {
  const { root, other, headers, close } = await open(page);
  try {
    // A second open project, for reordering; then the strip of a failed reread: its sentence in the
    // problem tone, no icon (the × that dismisses it is a control).
    expect(
      (await page.request.post('/api/open', { headers, data: { path: other } })).status(),
    ).toBe(200);
    await page.goto('/');
    await page.route('**/api/refresh', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Falha simulada ao reler.' }),
      }),
    );
    await page.getByRole('button', { name: 'Reler diretórios' }).click();
    const strip = page.locator('.error-banner');
    await expect(strip.locator('.strip-text.tone-problem')).toHaveText('Falha simulada ao reler.');
    expect(await colorOf(strip.locator('.strip-text'))).toBe(await toneColor(page, 'problem'));
    await noAlertIcon([strip]);
    await page.unroute('**/api/refresh');
    await page.getByRole('button', { name: 'Dispensar erro' }).click();

    // The error of a refused reorder, by the list of projects: the sentence in the problem tone.
    await enterProject(page, 'tons');
    await page.route('**/api/reorder', (route) =>
      route.fulfill({ status: 400, json: { error: 'Ordem recusada no teste.' } }),
    );
    await page.getByRole('button', { name: /^Reordenar tons / }).focus();
    await page.keyboard.press('ArrowDown');
    const order = page.locator('.explorer .project-order-error');
    await expect(order).toContainText('Ordem recusada no teste.');
    expect(await colorOf(order.locator('span').first())).toBe(await toneColor(page, 'problem'));
    await noAlertIcon([order]);
    await page.unroute('**/api/reorder');
    await page.getByRole('button', { name: 'Dispensar erro da ordem dos projetos' }).click();

    // The folder map of a project read in part, alone in the window: its note in the warning tone.
    await page.request.post('/api/close', { headers, data: { path: other } });
    await page.goto('/');
    await enterProject(page, 'tons');
    await showMap(page);
    const note = page.locator('.folder-partial');
    await expect(note).toBeVisible();
    expect(await colorOf(note)).toBe(await toneColor(page, 'warning'));
    await noAlertIcon([page.locator('.canvas-caption')]);
    await page
      .locator('#top-view-mode')
      .getByRole('button', { name: /^Estrutura de / })
      .click();

    // The evidence of a relation to a missing file: the title of its observation, the tone in words.
    await selectFile(page, join(root, 'AGENTS.md'));
    await page.getByRole('button', { name: 'Relações', exact: true }).click();
    await page
      .locator('.relation-list')
      .first()
      .locator('.relation-row', { hasText: 'falta.md' })
      .locator('.relation-evidence')
      .click();
    const title = page.locator('.evidence-diagnosis .observation-title');
    await expect(title.locator('strong')).toHaveText('Referência ausente');
    expect(await colorOf(title.locator('.tone-chip'))).toBe(await toneColor(page, 'problem'));
    await noAlertIcon([title]);

    // Changes: the projects open are not those of the baseline, which it says in the warning tone.
    await page.getByRole('button', { name: 'Reler diretórios' }).click();
    await page.getByRole('button', { name: 'Alterações', exact: true }).click();
    const warnings = page.locator('.changes-content .changes-warning');
    await expect(warnings.first()).toBeVisible();
    for (const warning of await warnings.all()) {
      expect(await colorOf(warning)).toBe(await toneColor(page, 'warning'));
      expect(await readable(warning)).toBeGreaterThanOrEqual(4.5);
    }
    await noAlertIcon([warnings]);

    // The editor refuses a file with two names: its sentence in the problem tone, no icon.
    await page.request.post('/api/edit/enable', { headers, data: { root } });
    await page.reload();
    if (await page.locator('.home-list').isVisible()) await enterProject(page, 'tons');
    await selectFile(page, join(root, 'ligado.md'));
    // Editing on is a state, not a warning: its pencil in the colour of its words, in both themes.
    const editingOn = page.locator('.app-footer .status-editing');
    await expect(editingOn).toContainText('Edição ligada: tons');
    for (const next of ['claro', 'escuro']) {
      expect(await colorOf(editingOn.locator('svg').first())).toBe(await colorOf(editingOn));
      expect(await colorOf(editingOn.locator('svg').first())).not.toBe(
        await toneColor(page, 'warning'),
      );
      await runMoreAction(page, `Ativar tema ${next}`);
    }
    await page.locator('.inspector .edit-button').click();
    const refusal = page.locator('.inspector-scroll > .edit-note[role="alert"]');
    await expect(refusal).toContainText('link físico');
    expect(await colorOf(refusal.locator('.tone-problem'))).toBe(await toneColor(page, 'problem'));
    await noAlertIcon([refusal]);
  } finally {
    await close();
  }
});
