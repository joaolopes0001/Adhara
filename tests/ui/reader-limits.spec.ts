import { expect, test } from '@playwright/test';
import { enterProject } from './helpers';
import { auditRow, auditRows, auditTab, showAudit } from './audit-list';
import { runMenuAction, runMoreAction } from './more-menu';

// A reading cut by the inventory limit, served by a mocked API: folders not read are never shown as
// empty, the footer says "X de Y arquivos", a strip below the header says how many items were left out,
// and the new codes have names and tones. Then relations cut by the cap: a footer link says so instead.
// Other causes of a partial reading, read from real folders, are in partial-reading.spec.ts.
test('reader limits: cut folders, partial reading warning and the new observation codes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = '/tmp/aae-reader-limits-fixture';
  const entry = `${root}/AGENTS.md`;
  const node = (relative: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id: `${root}${relative ? `/${relative}` : ''}`,
    path: `${root}${relative ? `/${relative}` : ''}`,
    name: relative.split('/').at(-1) || 'limites',
    relative: relative || '.',
    kind,
    status: 'resolved',
    root,
    roots: [root],
    ...extra,
  });
  const reference = { evidence: '`x`', syntax: 'path' };
  const model = {
    savedCases: [{ path: root, name: 'limites', available: true }],
    roots: [{ path: root, name: 'limites', parent: null, level: 0, entries: [entry] }],
    nodes: [
      node('', 'directory', { listing: 'complete', omitted: 3 }),
      node('AGENTS.md', 'entry', { analysis: 'parsed', lines: 4 }),
      node('cortada', 'directory', { listing: 'unread', omitted: 2 }),
      node('parcial', 'directory', { listing: 'partial', omitted: 1 }),
      node('parcial/a.md', 'file', { analysis: 'parsed', lines: 1 }),
    ],
    edges: [],
    objects: [],
    issues: [
      {
        id: 'o1',
        code: 'outside-root',
        message: 'A referência memoria/x.md não resolve dentro do diretório aberto.',
        node: entry,
        line: 2,
        target: 'memoria/x.md',
        form: 'path',
        ancestor: '/tmp',
        levels: 1,
        ...reference,
      },
      {
        id: 'o2',
        code: 'unverified',
        message: 'Ausência não verificável: docs/y.md.',
        node: entry,
        line: 3,
        target: 'docs/y.md',
        form: 'path',
        reason: 'lookup',
        ...reference,
      },
      {
        id: 'o3',
        code: 'ambiguous',
        message: 'Referência ambígua: comum.md (2 candidatos no inventário; nenhum foi escolhido).',
        node: entry,
        line: 4,
        target: 'comum.md',
        form: 'name',
        candidates: [`${root}/parcial/a.md`, `${root}/cortada/a.md`],
        ...reference,
      },
    ],
    signals: [],
    notes: {},
    expected: {},
    restoreErrors: [],
    delta: null,
    scope: { source: null, patterns: [] },
    stats: {
      files: 2,
      parsed: 2,
      edges: 0,
      entries: 1,
      inventory: {
        complete: false,
        lookupComplete: true,
        omitted: 3,
        omittedFiles: 3,
        byTopLevel: [],
      },
    },
    policy: { excluded: [], maxNodes: 4, maxFileBytes: 1048576, maxTextBytes: 33554432, ai: false },
  };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'session')
      return route.fulfill({
        json: { token: 'test-session', home: '/tmp', defaultParent: '/tmp' },
      });
    if (path === 'workspace' || path === 'refresh') return route.fulfill({ json: model });
    if (path === 'content') return route.fulfill({ json: { text: '# x', truncated: false } });
    return route.fulfill({ status: 404, json: { error: `Operação inesperada ${path}` } });
  });
  await page.goto('/');

  // Footer: real files of the reading out of those on disk. The warning is one strip, below the header.
  const footer = page.locator('.status-bar');
  await expect(footer.locator('.status-files')).toHaveText(/^\d+ de 5 arquivos lidos$/);
  const strip = page.locator('.error-banner');
  await expect(strip).toHaveCount(1);
  await expect(strip).toHaveText('Leitura parcial: 3 itens não listados.Ver limites');
  await expect(footer.locator('.status-partial')).toHaveCount(0);

  // Structure of the root: a folder not read and one read in part, never "0 itens". From Home, the list of
  // projects, by the row of the project.
  await enterProject(page, 'limites');
  const structure = page
    .getByRole('region', { name: 'Estrutura de aae-reader-limits-fixture' })
    .first();
  const folder = (name: string) =>
    structure.locator('.structure-row.is-folder', { hasText: name }).locator('.structure-listing');
  await expect(folder('cortada')).toHaveText('não lida · 2 itens no disco');
  await expect(folder('parcial')).toHaveText('lida em parte · 1 item fora');
  await expect(structure.getByText('0 itens')).toHaveCount(0);

  // The strip opens the limits of the audit; the new codes have their tone.
  await strip.getByRole('button', { name: 'Ver limites' }).click();
  await expect(auditTab(page, 'Avisos')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Tipo de observação')).toHaveValue('limit');
  // This model has no limit observation (only the cut inventory): the type is kept, with an empty list.
  await expect(auditRows(page)).toHaveCount(0);
  await expect(page.locator('.audit-empty')).toHaveText('Nenhuma observação deste tipo.');
  // Every observation: the tone of each new code is in its line's class, the word in the tab.
  await showAudit(page, 'Todas');
  await expect(auditRows(page)).toHaveCount(3);
  const tone = (text: string) => auditRow(page, text).locator('.audit-line');
  await expect(tone('memoria/x.md')).toHaveClass(/tone-warning/);
  await expect(tone('docs/y.md')).toHaveClass(/tone-info/);
  await expect(tone('comum.md')).toHaveClass(/tone-info/);
  await expect(
    page.getByRole('button', { name: /Ver detalhe: Nome com vários arquivos possíveis/ }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: /Ver detalhe: Destino acima do diretório aberto/ }),
  ).toHaveCount(1);
  // Relations cut by the cap, with a complete inventory: the same warning, which says what was cut.
  Object.assign(model.stats, {
    inventory: { ...model.stats.inventory, complete: true, omitted: 0, omittedFiles: 0 },
    relations: { complete: false, omitted: 7, max: 100000 },
  });
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/refresh'));
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await refreshed;
  await expect(footer.locator('.status-files')).toHaveText('2 de 2 arquivos lidos');
  await expect(footer).not.toContainText('de 5 arquivos');
  await expect(strip).toHaveCount(0);
  await expect(footer.locator('.status-partial')).toHaveText('relações cortadas');
  await expect(footer.locator('.status-partial')).toHaveAttribute(
    'title',
    'Leitura parcial (teto de relações): pode faltar observação.',
  );
  expect(errors).toEqual([]);
});

// The cause of a folder read in part is what happened in that folder (`leftOutBy`), never a fact of the
// whole reading: the limit cut `b` only, and `a` is out only for a name that is not UTF-8 (the minimal
// case). `c` has both causes and keeps the guidance of the limit; `d` holds a folder of
// illegible name, so its count is a minimum. Control: `b`, cut by the limit, keeps the words it had.
test('reader limits: each folder says its own cause, and a minimum says "pelo menos"', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = '/tmp/aae-reader-causes-fixture';
  const entry = `${root}/AGENTS.md`;
  const node = (relative: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id: `${root}${relative ? `/${relative}` : ''}`,
    path: `${root}${relative ? `/${relative}` : ''}`,
    name: relative.split('/').at(-1) || 'causas',
    relative: relative || '.',
    kind,
    status: 'resolved',
    root,
    roots: [root],
    ...extra,
  });
  const unreadable = (folder: string, name: string) => ({
    id: `u-${folder}`,
    code: 'unreadable',
    message: `Nome que não é UTF-8 válido, deixado fora da leitura: ${name}`,
    node: `${root}/${folder}`,
    line: null,
  });
  const model = {
    savedCases: [{ path: root, name: 'causas', available: true }],
    roots: [{ path: root, name: 'causas', parent: null, level: 0, entries: [entry] }],
    nodes: [
      node('', 'directory', { listing: 'complete', omitted: 48, omittedMinimum: true }),
      node('AGENTS.md', 'entry', { analysis: 'parsed', lines: 1 }),
      node('a', 'directory', { listing: 'partial', omitted: 1, leftOutBy: ['unreadable'] }),
      node('a/x.md', 'file', { analysis: 'parsed', lines: 1 }),
      node('b', 'directory', { listing: 'partial', omitted: 24, leftOutBy: ['limit'] }),
      node('b/f00.md', 'file', { analysis: 'parsed', lines: 1 }),
      node('c', 'directory', {
        listing: 'partial',
        omitted: 22,
        leftOutBy: ['limit', 'unreadable'],
      }),
      node('c/f00.md', 'file', { analysis: 'parsed', lines: 1 }),
      node('d', 'directory', {
        listing: 'partial',
        omitted: 1,
        leftOutBy: ['unreadable'],
        omittedMinimum: true,
      }),
      node('d/y.md', 'file', { analysis: 'parsed', lines: 1 }),
    ],
    edges: [],
    objects: [],
    issues: [
      unreadable('a', 'n\\xff.md'),
      unreadable('c', 'm\\xff.md'),
      unreadable('d', 'dados\\xff'),
    ],
    signals: [],
    notes: {},
    expected: {},
    restoreErrors: [],
    delta: null,
    scope: { source: null, patterns: [] },
    stats: {
      files: 5,
      parsed: 5,
      edges: 0,
      entries: 1,
      inventory: {
        complete: false,
        lookupComplete: true,
        omitted: 48,
        omittedFiles: 47,
        byTopLevel: [],
      },
    },
    policy: {
      excluded: [],
      maxNodes: 10,
      maxFileBytes: 1048576,
      maxTextBytes: 33554432,
      ai: false,
    },
  };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'session')
      return route.fulfill({
        json: { token: 'test-session', home: '/tmp', defaultParent: '/tmp' },
      });
    if (path === 'workspace' || path === 'refresh') return route.fulfill({ json: model });
    if (path === 'content') return route.fulfill({ json: { text: '# x', truncated: false } });
    return route.fulfill({ status: 404, json: { error: `Operação inesperada ${path}` } });
  });
  await page.goto('/');
  // From Home, the list of projects, by the row of the project.
  await enterProject(page, 'causas');
  const structure = page
    .getByRole('region', { name: 'Estrutura de aae-reader-causes-fixture' })
    .first();
  const folder = (name: string) =>
    structure
      .locator('.structure-row.is-folder')
      .filter({ has: page.locator('.structure-open', { hasText: new RegExp(`^${name}$`) }) })
      .locator('.structure-listing');

  // `a`: only the illegible name, though the reading hit the limit elsewhere.
  await expect(folder('a')).toHaveText('lida em parte · 1 item fora');
  await expect(folder('a')).toHaveAttribute('title', /não é UTF-8 válido/);
  await expect(folder('a')).not.toHaveAttribute('title', /limite de itens/);
  // Control `b`: the limit only, the words of the limit.
  await expect(folder('b')).toHaveText('lida em parte · 24 itens fora');
  await expect(folder('b')).toHaveAttribute(
    'title',
    '1 item. O limite de itens parou no meio desta pasta: parte dos itens não foi listada nem lida. Pode faltar observação aqui, e referências para dentro dela são conferidas só por existência. Abra-a como diretório para lê-la inteira.',
  );
  await expect(folder('b')).not.toHaveAttribute('title', /UTF-8/);
  // `c`: both causes, and the guidance of the limit stays.
  await expect(folder('c')).toHaveAttribute('title', /limite de itens.*UTF-8/);
  await expect(folder('c')).toHaveAttribute('title', /conferidas só por existência/);
  await expect(folder('c')).toHaveAttribute('title', /Abra-a como diretório para lê-la inteira/);
  // `d`: a minimum.
  await expect(folder('d')).toHaveText('lida em parte · pelo menos 1 item fora');
  await expect(folder('d')).toHaveAttribute('title', /O número é um mínimo/);

  // The inspector of each folder: a file opens it, then the folder shows its overview there.
  const overview = async (name: string, text: string) => {
    await page.locator('.explorer .tree-item', { hasText: new RegExp(`^${name}$`) }).click();
    await expect(page.locator('.directory-overview h2')).toHaveText(name);
    await expect(page.locator('.directory-listing')).toHaveText(text);
  };
  await page.locator('.explorer .tree-item', { hasText: 'AGENTS.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await overview(
    'a',
    'Lida em parte · 1 item fora (nome que não é UTF-8 válido: veja a observação abaixo).',
  );
  await overview(
    'b',
    'Lida em parte · 24 itens fora (limite de itens: abra esta pasta como diretório para lê-la inteira).',
  );
  await overview(
    'c',
    'Lida em parte · 22 itens fora (nome que não é UTF-8 válido e limite de itens: abra esta pasta como diretório para lê-la inteira; veja a observação abaixo).',
  );
  await overview(
    'd',
    'Lida em parte · pelo menos 1 item fora (nome que não é UTF-8 válido: veja a observação abaixo).',
  );
  expect(errors).toEqual([]);
});

// The Help said the item limit was "per project": it is one budget, divided among the open projects
// (docs/modelo-e-leitura.md, "Inventário").
test('help: the item limit is divided among the open projects, in both languages', async ({
  page,
}) => {
  await page.goto('/');
  await runMoreAction(page, 'Ajuda');
  const pt = page.getByRole('dialog').locator('details', { hasText: 'Limites da leitura' });
  await pt.locator('summary').click();
  await expect(pt).toContainText(
    '20.000 itens repartidos pelos projetos, 1 MiB por arquivo, 32 MiB de texto por leitura.',
  );
  await expect(pt).not.toContainText('por projeto');
  await page.keyboard.press('Escape');
  await runMenuAction(page, 'Mais', 'English');
  await runMenuAction(page, 'More', 'Help');
  const en = page.getByRole('dialog').locator('details', { hasText: 'Scan limits' });
  await en.locator('summary').click();
  await expect(en).toContainText(
    '20,000 items divided among the open projects, 1 MiB per file, 32 MiB of text per scan.',
  );
  await expect(en).not.toContainText('per project');
});
