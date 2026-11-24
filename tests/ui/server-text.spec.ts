import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setLanguage } from '../../src/i18n';
import { ptBR, ptBRServer } from '../../src/i18n/pt-BR';
import { shortText } from '../../src/observations';
import { messageText, serverFact, serverText, wordPhrase } from '../../src/serverText';
import type { ServerPhrase } from '../../src/serverText';

// The sentences of the server in the language of the interface (src/serverText.ts): the rule without a
// browser, with the Portuguese pack of the server, and then the screen, with a mocked model.

// The packs of a Portuguese interface, in the order a server phrase is looked up.
const packs = [ptBRServer, ptBR];

const said = (phrase: string, params: Record<string, unknown> = {}) => ({
  message: phrase.replace(/\{(\w+)\}/g, (whole, name) =>
    name in params && typeof params[name] !== 'object' ? String(params[name]) : whole,
  ),
  messagePhrase: { phrase, params } as ServerPhrase,
});
/** Paths and names that a careless formatter would mangle. */
const STRANGE = [
  'a{b}c',
  '{raw}',
  '100%',
  '%s %(x)s {0}',
  'ação "aspas" \'simples\'',
  '<b>x</b>',
  '$1 $&',
];

test('server text: a phrase the pack has is worded with its parameters whole; one it lacks stays English', () => {
  for (const raw of STRANGE) {
    const phrase = { phrase: 'Target not found: {raw}', params: { raw } };
    expect(wordPhrase('pt', packs, phrase)).toBe(`Destino não encontrado: ${raw}`);
    expect(wordPhrase('en', undefined, phrase)).toBe(`Target not found: ${raw}`);
    // A code of message this pack does not know: the English phrase, with the same parameters, and no error.
    const unknown = { phrase: 'A sentence of a newer server about {raw}.', params: { raw } };
    expect(wordPhrase('pt', packs, unknown)).toBe(`A sentence of a newer server about ${raw}.`);
  }
  // Only the pack's own entries count, never what every object inherits.
  expect(wordPhrase('pt', packs, { phrase: 'toString' })).toBe('toString');
  expect(wordPhrase('pt', packs, { phrase: 'constructor' })).toBe('constructor');
  // A parameter without a value stays written; a phrase without `params`, or with a wrong one, does not break.
  expect(wordPhrase('pt', packs, { phrase: 'Target not found: {raw}' })).toBe(
    'Destino não encontrado: {raw}',
  );
  expect(
    wordPhrase('pt', packs, {
      phrase: 'Target not found: {raw}',
      params: null,
    } as unknown as ServerPhrase),
  ).toBe('Destino não encontrado: {raw}');
});

test('server text: a phrase inside a phrase is worded on its own, and a number for the language', () => {
  const nested = {
    phrase:
      'Baseline not saved in the state directory of the app ({directory}): {reason}. It holds only until the server restarts.',
    params: {
      directory: '/s',
      reason: { phrase: 'write failure ({cause})', params: { cause: { phrase: 'disk full' } } },
    },
  };
  expect(wordPhrase('pt', packs, nested)).toBe(
    'Referência não salva no diretório de estado do aplicativo (/s): falha de gravação (disco cheio). Ela vale só até reiniciar o servidor.',
  );
  // A sentence the pack lacks keeps its English and still words what it holds.
  expect(
    wordPhrase('pt', packs, {
      phrase: 'Newer wrapper: {reason}',
      params: { reason: { phrase: 'disk full' } },
    }),
  ).toBe('Newer wrapper: disco cheio');
  const limit = {
    phrase:
      'Limit of {limit} marks in this project reached. Marks without a matching observation count too ({orphans} now) and can be removed in the Audit; remove marks before creating others.',
    params: { limit: { number: 5000 }, orphans: 12000 },
  };
  expect(wordPhrase('pt', packs, limit)).toContain('Limite de 5.000 marcações');
  expect(wordPhrase('en', undefined, limit)).toContain('Limit of 5,000 marks');
  // Any other number keeps the digits the server sent.
  expect(wordPhrase('pt', packs, limit)).toContain('(12000 agora)');
  // A sentence the interface pack already has (the screen says it too) is found there.
  expect(wordPhrase('pt', packs, { phrase: 'Could not save the file. Nothing was saved.' })).toBe(
    'Não foi possível gravar o arquivo. Nada foi gravado.',
  );
  expect(wordPhrase('pt', [], { phrase: 'Could not save the file. Nothing was saved.' })).toBe(
    'Could not save the file. Nothing was saved.',
  );
  // A fact is read by name, only when it is a text, a number or a flag.
  const item = {
    messagePhrase: { phrase: 'x', params: { hidden: 2, minimum: false, inner: { phrase: 'y' } } },
  };
  expect([
    serverFact(item, 'hidden'),
    serverFact(item, 'minimum'),
    serverFact(item, 'inner'),
  ]).toEqual([2, false, undefined]);
  expect(serverFact({}, 'hidden')).toBeUndefined();
  expect(serverFact(item, 'toString')).toBeUndefined();
});

/** `action` with the interface in `language`, then back in English. */
function inLanguage<T>(language: 'en' | 'pt', action: () => T): T {
  setLanguage(language);
  try {
    return action();
  } finally {
    setLanguage('en');
  }
}
const placeholders = (phrase: string) =>
  Object.fromEntries([...phrase.matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, `«${name}»`]));

test('server text: each phrase with two or more parameters puts them where the earlier server did', () => {
  // The Portuguese the server wrote before it wrote English, with the value «name» for each parameter `name`
  // (tests/test_server_texts.py checks the same with the Python reading of the pack). A translation with two
  // parameters swapped keeps the same set of parameters, and differs here.
  const before: Record<string, string> = JSON.parse(
    readFileSync('tests/server_phrases_before_english.json', 'utf8'),
  );
  expect(Object.keys(before)).toHaveLength(46);
  for (const [phrase, portuguese] of Object.entries(before))
    expect(wordPhrase('pt', packs, { phrase, params: placeholders(phrase) }), phrase).toBe(
      portuguese,
    );
});

type SavedFinding = {
  code: string;
  message: string;
  messagePhrase?: ServerPhrase;
  path?: string;
  target?: string;
  count?: number;
  bytes?: number;
  earlier?: boolean;
};

/** The line of a finding from its fields only: what is left when nothing of its message is read. */
const fieldsOnly = (item: SavedFinding) =>
  item.code === 'limit' && typeof item.count === 'number' && typeof item.bytes === 'number'
    ? `${item.count} text file${item.count === 1 ? '' : 's'} listed but not analyzed (${item.bytes.toLocaleString('en')} bytes)`
    : shortText({ ...item, message: '', messagePhrase: undefined });

test('server text: a finding the earlier server saved in a baseline shows as it did in Portuguese, and only its fields in English', () => {
  // Each finding of tests/findings_before_english.json, as the earlier server saved it in a baseline (Portuguese,
  // without a phrase; the delta marks it `earlier`), and the one this server reads for it (same id). Its message
  // is never read: in Portuguese the line is the one of the finding of this server, which is the line the earlier
  // interface showed; in English it is what its fields say (destination, pattern, class, counts), or nothing.
  const pairs: { before: SavedFinding; now: SavedFinding }[] = JSON.parse(
    execFileSync('python3', ['-B', 'tests/findings_before_english.py', '--pairs'], {
      encoding: 'utf8',
    }),
  );
  expect(pairs).toHaveLength(110);
  for (const { before, now } of pairs) {
    const saved = { ...before, earlier: true };
    expect(before.messagePhrase).toBeUndefined();
    expect(
      inLanguage('pt', () => [messageText(saved), shortText(saved)]),
      before.message,
    ).toEqual(inLanguage('pt', () => [before.message, shortText(now)]));
    expect(
      inLanguage('en', () => [messageText(saved), shortText(saved)]),
      before.message,
    ).toEqual(inLanguage('en', () => ['', fieldsOnly(now)]));
  }
  // The line of the inventory limit, read in Portuguese as the interface of the earlier server read it.
  const limits = pairs
    .map(({ before }) => ({ ...before, earlier: true }))
    .filter((item) => item.message.startsWith('Limite de inventário'));
  expect(inLanguage('pt', () => limits.map((item) => shortText(item)))).toEqual([
    'Limite de 10 itens por projeto: 1 pasta lida em parte, 6 não lidas, 71 itens fora',
    'Limite de 10 itens por projeto: 1 pasta lida em parte, 6 não lidas, pelo menos 71 itens fora',
  ]);
  expect(inLanguage('en', () => limits.map((item) => shortText(item)))).toEqual(['', '']);
});

/** The inventory limit as the earlier server wrote it, from its sentence recorded with «name» for each parameter. */
const before: Record<string, string> = JSON.parse(
  readFileSync('tests/server_phrases_before_english.json', 'utf8'),
);
const savedLimit = (
  root: string,
  budget: number,
  partial: number,
  unread: number,
  omitted: number,
) =>
  before[
    'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; folders not read: {unread}; items left out of the inventory: {omitted}. The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. Open a subfolder for a complete scan.'
  ]
    .replace('«root»', root)
    .replace('«budget»', String(budget))
    .replace('«partial»', String(partial))
    .replace('«unread»', String(unread))
    .replace('«omitted»', String(omitted));

test('server text: the inventory limit of a project named like a copy reads as it did, and its name is never a sentence', () => {
  // Names a file manager gives to copies, one of them a word of the pack ("manifesto"); before, a name with " ("
  // lost the line, and "manifesto (cópia)" came out as "manifest (cópia)" in English.
  for (const name of ['agente (cópia)', 'manifesto (cópia)', 'Projeto (2)', 'disco cheio']) {
    const saved = { code: 'limit', message: savedLimit(name, 10, 1, 7, 53), earlier: true };
    expect(
      inLanguage('pt', () => [shortText(saved), messageText(saved)]),
      name,
    ).toEqual([
      'Limite de 10 itens por projeto: 1 pasta lida em parte, 7 não lidas, 53 itens fora',
      saved.message,
    ]);
    expect(
      inLanguage('en', () => [shortText(saved), messageText(saved)]),
      name,
    ).toEqual(['', '']);
  }
  // Longer than the earlier server could write it, the sentence is not read, and shows as it came.
  const long = {
    code: 'limit',
    message: savedLimit('a'.repeat(9000), 10, 1, 7, 53),
    earlier: true,
  };
  expect(inLanguage('pt', () => shortText(long))).toBe(long.message);
});

test('server text: a reason an earlier server saved is never read: as it came in Portuguese, a phrase of this server in English', () => {
  // `texts.restored` sends the reason of a refused update kept by an earlier server next to a phrase of its own.
  const phrase = {
    phrase:
      'The last update of this baseline was not saved in the state directory of the app ({directory}): {reason}. The comparison uses the baseline saved before it; this warning leaves when a new baseline is saved.',
    params: {
      directory: '/s',
      reason: { phrase: 'reason recorded by an earlier version of the app', earlier: '' },
    },
  };
  const sent =
    'The last update of this baseline was not saved in the state directory of the app (/s): reason recorded by an earlier version of the app. The comparison uses the baseline saved before it; this warning leaves when a new baseline is saved.';
  for (const reason of ['falha de gravação (disco cheio)', '<b>x</b> {y} 100%', 'manifesto']) {
    phrase.params.reason.earlier = reason;
    expect(inLanguage('en', () => serverText(sent, phrase))).toBe(sent);
    expect(inLanguage('pt', () => serverText(sent, phrase))).toBe(
      `A última atualização desta referência não foi salva no diretório de estado do aplicativo (/s): ${reason}. A comparação usa a referência salva antes dela; este aviso sai quando uma nova referência for salva.`,
    );
  }
  // A message without a phrase that the pack does not have shows as it came, in both languages.
  for (const message of ['Destino não encontrado: x.md', "[Errno 13] Permission denied: 'docs'"])
    for (const language of ['en', 'pt'] as const)
      expect(inLanguage(language, () => serverText(message))).toBe(message);
});

test('server text: a phrase that lacks a parameter it names, or holds one that cannot be written, shows as sent', () => {
  const sent = 'Target not found: x.md';
  const phrase = 'Target not found: {raw}';
  const deep: ServerPhrase = { phrase: '{a}', params: { a: 'x' } };
  let nested = deep;
  for (let level = 0; level < 9; level++) nested = { phrase: '{a}', params: { a: nested } };
  for (const params of [
    { raw: null },
    { raw: { other: 1 } },
    { raw: Number.NaN },
    {},
    [] as unknown,
    'raw',
    { raw: nested },
  ])
    expect(
      inLanguage('pt', () => serverText(sent, { phrase, params } as unknown as ServerPhrase)),
      JSON.stringify(params),
    ).toBe(sent);
  // Control: the same phrase, well made; a parameter the phrase does not name is a fact, never checked.
  expect(
    inLanguage('pt', () => serverText(sent, { phrase, params: { raw: 'x.md', fact: null } })),
  ).toBe('Destino não encontrado: x.md');
});

const root = '/tmp/aae-server-text';
const strangePath = `${root}/pasta {x} 100% "aspas" ação`;
const model = {
  savedCases: [{ path: root, name: 'frases', available: true }],
  roots: [{ path: root, name: 'frases', parent: null, level: 0, entries: [`${root}/AGENTS.md`] }],
  nodes: ['', 'AGENTS.md', 'a.md', 'b.md', 'c.md', 'd.md'].map((relative) => ({
    id: `${root}${relative ? `/${relative}` : ''}`,
    path: `${root}${relative ? `/${relative}` : ''}`,
    name: relative || 'frases',
    relative: relative || '.',
    kind: relative === '' ? 'directory' : relative === 'AGENTS.md' ? 'entry' : 'file',
    status: 'resolved',
    root,
    roots: [root],
    ...(relative ? { analysis: 'parsed', lines: 1 } : { listing: 'complete' }),
  })),
  edges: [],
  objects: [],
  issues: [
    // A sentence of the server this interface has in its pack, with a strange parameter.
    {
      id: 'i1',
      code: 'manifest',
      node: `${root}/a.md`,
      line: null,
      ...said('Invalid manifest: {reason}', { reason: '{x} 100% "aspas" ação' }),
    },
    // A sentence of a newer server: the pack does not have it.
    {
      id: 'i2',
      code: 'limit',
      node: `${root}/b.md`,
      line: null,
      ...said('A limit of a newer server was reached in {path}.', { path: strangePath }),
    },
    // A sentence without a phrase that the pack does not have (the text of a system error): as sent.
    {
      id: 'i3',
      code: 'unreadable',
      node: `${root}/c.md`,
      line: null,
      message: "[Errno 13] Permission denied: 'c.md'",
    },
    // A sentence without parameters is its own phrase.
    {
      id: 'i4',
      code: 'limit',
      node: `${root}/d.md`,
      line: null,
      message: 'File listed, but not analyzed: text size limit.',
    },
  ],
  signals: [],
  notes: {},
  expected: {},
  restoreErrors: [
    `Folder unavailable: ${strangePath}`,
    'Invalid saved path ignored.',
    'A restore error of a newer server.',
  ],
  restoreErrorsPhrase: [
    { phrase: 'Folder unavailable: {path}', params: { path: strangePath } },
    null,
    null,
  ],
  delta: null,
  scope: { source: null, patterns: [] },
  stats: { files: 5, parsed: 5, edges: 0, entries: 1 },
  policy: {
    excluded: [],
    maxNodes: 20000,
    maxFileBytes: 1048576,
    maxTextBytes: 33554432,
    ai: false,
  },
};

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'session')
      return route.fulfill({
        json: { token: 'test-session', home: '/tmp', defaultParent: '/tmp' },
      });
    if (path === 'workspace') return route.fulfill({ json: model });
    // A refusal with a parameter, as the server answers it.
    if (path === 'refresh')
      return route.fulfill({
        status: 400,
        json: {
          error: `Not a folder: ${strangePath}`,
          errorPhrase: { phrase: 'Not a folder: {path}', params: { path: strangePath } },
        },
      });
    return route.fulfill({ status: 404, json: { error: 'Route not found.' } });
  });
  await page.goto('/');
  await expect(page.locator('.error-banner')).toBeVisible();
  return errors;
}

/** Every text of the strip under the top bar, its list opened when it has one. */
async function strip(page: Page) {
  const more = page.locator('.error-banner .strip-action[aria-expanded="false"]');
  if (await more.count()) await more.first().click();
  return page.locator('.error-banner').innerText();
}

/** The short text of every line of the Audit, all levels, every file open. */
async function auditLines(page: Page) {
  await page
    .getByRole('button', { name: /^(Auditoria|Audit)$/ })
    .first()
    .click();
  await page.getByRole('tab', { name: /^(Todas|All)\b/ }).click();
  const closed = page.locator(
    '.audit-observations button.observation-group-head[aria-expanded="false"]',
  );
  for (let left = await closed.count(); left > 0; left = await closed.count())
    await closed.first().click();
  return page.locator('.audit-observations .file-observation-text').allInnerTexts();
}

test('server text on the screen, in Portuguese: the pack words what it has, and what it lacks shows as sent', async ({
  page,
}) => {
  const errors = await open(page);
  const shown = await strip(page);
  expect(shown).toContain(`Diretório indisponível: ${strangePath}`);
  expect(shown).toContain('Caminho salvo inválido ignorado.');
  expect(shown).toContain('A restore error of a newer server.');
  expect(await auditLines(page)).toEqual([
    'Manifesto inválido: {x} 100% "aspas" ação',
    `A limit of a newer server was reached in ${strangePath}.`,
    "[Errno 13] Permission denied: 'c.md'",
    'Arquivo listado, mas não analisado: limite de tamanho de texto.',
  ]);
  // A refusal of the API, with its parameter whole.
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText(`Não é um diretório: ${strangePath}`);
  expect(errors).toEqual([]);
});

test.describe('in English', () => {
  // A new profile, in English (as tests/ui/language.spec.ts).
  test.use({ storageState: { cookies: [], origins: [] } });

  test('server text on the screen, in English: every sentence as the server sent it', async ({
    page,
  }) => {
    const errors = await open(page);
    const shown = await strip(page);
    expect(shown).toContain(`Folder unavailable: ${strangePath}`);
    expect(shown).toContain('Invalid saved path ignored.');
    expect(await auditLines(page)).toEqual([
      'Invalid manifest: {x} 100% "aspas" ação',
      `A limit of a newer server was reached in ${strangePath}.`,
      "[Errno 13] Permission denied: 'c.md'",
      'File listed, but not analyzed: text size limit.',
    ]);
    await page
      .locator('.top-actions button, header button')
      .filter({ hasText: /^(Reler|Rescan)$/ })
      .first()
      .click();
    await expect(page.locator('.error-banner')).toContainText(`Not a folder: ${strangePath}`);
    expect(errors).toEqual([]);
  });
});

// Changes with a baseline saved by the earlier server: the projects are named as a file manager names copies.
const copies = ['agente (cópia)', 'manifesto (cópia)', 'Projeto (2)'];
const base = '/tmp/aae-server-text-changes';
const [agent, manifest, project] = copies.map((name) => `${base}/${name}`);
const savedFinding = (code: string, node: string | null, message: string, extra = {}) => ({
  id: `${code}${node}${message.length}`.replace(/\W/g, '').slice(-16),
  code,
  severity: 'incomplete',
  message,
  node,
  earlier: true,
  ...extra,
});
/** A model whose Changes lists `resolved` (findings of a baseline of the earlier server) and the warning of a refused update. */
function changesModel(resolved: ReturnType<typeof savedFinding>[], reason: string) {
  const paths = [agent, manifest, project];
  return {
    ...model,
    savedCases: paths.map((path, index) => ({ path, name: copies[index], available: true })),
    roots: paths.map((path, index) => ({
      path,
      name: copies[index],
      parent: null,
      level: 0,
      entries: [`${path}/AGENTS.md`],
    })),
    nodes: paths.flatMap((path, index) => [
      { ...model.nodes[0], id: path, path, name: copies[index], root: path, roots: [path] },
      {
        ...model.nodes[1],
        id: `${path}/AGENTS.md`,
        path: `${path}/AGENTS.md`,
        root: path,
        roots: [path],
      },
    ]),
    issues: [],
    restoreErrors: [],
    restoreErrorsPhrase: [],
    delta: {
      version: 1,
      reference: { at: '2026-11-17T10:00:00-03:00', uniform: true },
      current: { at: '2026-11-18T10:00:00-03:00' },
      roots: paths.map((path, index) => ({
        path,
        name: copies[index],
        referenceAt: '2026-11-17T10:00:00-03:00',
        referenceOrigin: 'persisted',
        referenceSaved: true,
        context: 'same',
      })),
      warnings: [
        {
          root: agent,
          code: 'reference-update-not-saved',
          message:
            'The last update of this baseline was not saved in the state directory of the app (/s): reason recorded by an earlier version of the app. The comparison uses the baseline saved before it; this warning leaves when a new baseline is saved.',
          messagePhrase: {
            phrase:
              'The last update of this baseline was not saved in the state directory of the app ({directory}): {reason}. The comparison uses the baseline saved before it; this warning leaves when a new baseline is saved.',
            params: {
              directory: '/s',
              reason: {
                phrase: 'reason recorded by an earlier version of the app',
                earlier: reason,
              },
            },
          },
        },
      ],
      limit: 500,
      files: {
        added: [],
        removed: [],
        changed: [],
        totals: { added: 0, removed: 0, changed: 0 },
        unverified: 0,
        uncompared: 0,
      },
      relations: {
        added: [],
        removed: [],
        totals: { added: 0, removed: 0 },
        uncompared: 0,
        unanalysed: 0,
      },
      findings: {
        status: 'pass',
        new: [],
        resolved,
        persisting: 0,
        totals: { new: 0, resolved: resolved.length },
        uncompared: 0,
        unanalysed: 0,
        byCode: Object.fromEntries(
          [...new Set(resolved.map((item) => item.code))].map((code) => [
            code,
            {
              new: 0,
              resolved: resolved.filter((item) => item.code === code).length,
              persisting: 0,
            },
          ]),
        ),
        context: [],
      },
    },
  };
}
const savedFindings = [
  savedFinding('limit', agent, savedLimit(copies[0], 10, 1, 6, 22)),
  savedFinding('limit', manifest, savedLimit(copies[1], 10, 1, 7, 23)),
  savedFinding('limit', project, savedLimit(copies[2], 10, 1, 5, 23)),
  savedFinding(
    'limit',
    agent,
    'Orçamento de texto da leitura atingido: 5 arquivo(s) de texto listado(s), mas não analisado(s) (3605 bytes). Referências e achados dentro deles não entram nesta leitura; cada um tem análise “skipped” e a lista completa está no relatório audit.',
    { count: 5, bytes: 3605 },
  ),
  savedFinding(
    'unreadable',
    `${project}/docs`,
    'Nome que não é UTF-8 válido, deixado fora da leitura: x\\xff.md',
  ),
  savedFinding(
    'manifest',
    `${manifest}/ruim/agent-architecture.json`,
    'Manifesto inválido: objects e relationships devem ser listas.',
  ),
  savedFinding(
    'analysis-partial',
    null,
    'Inventário ou análise parcial: ausência de achados ou de caminhos não é conclusiva.',
  ),
  savedFinding('broken', `${manifest}/AGENTS.md`, 'Destino não encontrado: manifesto', {
    severity: 'warning',
    line: 2,
    target: 'manifesto',
  }),
];

/** Changes opened on a mocked model; the time from the click until its lines show, and their text. */
async function changesLines(page: Page, mocked: object) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'session')
      return route.fulfill({
        json: { token: 'test-session', home: '/tmp', defaultParent: '/tmp' },
      });
    if (path === 'workspace') return route.fulfill({ json: mocked });
    return route.fulfill({ status: 404, json: { error: 'Route not found.' } });
  });
  await page.goto('/');
  const start = Date.now();
  await page
    .getByRole('button', { name: /^(Alterações|Changes)$/ })
    .first()
    .click();
  await expect(page.locator('.change-tag').first()).toBeVisible({ timeout: 20000 });
  const elapsed = Date.now() - start;
  const lines = await page
    .locator('.change-tag')
    .evaluateAll((tags) =>
      tags.map((tag) => tag.parentElement?.innerText.replace(/\s+/g, ' ').trim() ?? ''),
    );
  const warnings = await page.locator('.changes-warning').allInnerTexts();
  const panel = await page.locator('.changes-content').innerText();
  return { lines, warnings, panel, elapsed, errors };
}

test('Changes with a baseline of the earlier server, in Portuguese: each line as that version showed it', async ({
  page,
}) => {
  const { lines, warnings, errors } = await changesLines(
    page,
    changesModel(savedFindings, 'falha de gravação (sem permissão)'),
  );
  expect(lines).toEqual([
    'resolvida Limite de 10 itens por projeto: 1 pasta lida em parte, 6 não lidas, 22 itens fora estava em agente (cópia)/. na leitura de referência · Limite de leitura',
    'resolvida Limite de 10 itens por projeto: 1 pasta lida em parte, 7 não lidas, 23 itens fora estava em manifesto (cópia)/. na leitura de referência · Limite de leitura',
    'resolvida Limite de 10 itens por projeto: 1 pasta lida em parte, 5 não lidas, 23 itens fora estava em Projeto (2)/. na leitura de referência · Limite de leitura',
    'resolvida Orçamento de texto da leitura atingido: 5 arquivo(s) de texto listado(s), mas não analisado(s) (3605 bytes). Referências e achados dentro deles não entram nesta leitura; cada um tem análise “skipped” e a lista completa está no relatório audit. estava em agente (cópia)/. na leitura de referência · Limite de leitura',
    'resolvida Nome que não é UTF-8 válido, deixado fora da leitura: x\\xff.md estava em Projeto (2)/docs na leitura de referência · Falha de leitura',
    'resolvida Manifesto inválido: objects e relationships devem ser listas. estava em manifesto (cópia)/ruim/agent-architecture.json na leitura de referência · Manifesto inválido',
    'resolvida Inventário ou análise parcial: ausência de achados ou de caminhos não é conclusiva. estava em sem arquivo na leitura de referência · Leitura parcial',
    'resolvida manifesto estava em manifesto (cópia)/AGENTS.md:2 na leitura de referência · Referência ausente',
  ]);
  expect(warnings.join('\n')).toContain(
    'agente (cópia): A última atualização desta referência não foi salva no diretório de estado do aplicativo (/s): falha de gravação (sem permissão). A comparação usa',
  );
  expect(errors).toEqual([]);
});

test.describe('Changes in English', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Changes with a baseline of the earlier server, in English: what the fields say, never its Portuguese nor a path of the machine', async ({
    page,
  }) => {
    const { lines, panel, errors } = await changesLines(
      page,
      changesModel(savedFindings, 'falha de gravação (sem permissão)'),
    );
    expect(lines).toEqual([
      'resolved was at agente (cópia)/. in the baseline scan · Scan limit',
      'resolved was at manifesto (cópia)/. in the baseline scan · Scan limit',
      'resolved was at Projeto (2)/. in the baseline scan · Scan limit',
      'resolved 5 text files listed but not analyzed (3,605 bytes) was at agente (cópia)/. in the baseline scan · Scan limit',
      'resolved was at Projeto (2)/docs in the baseline scan · Read failure',
      'resolved was at manifesto (cópia)/ruim/agent-architecture.json in the baseline scan · Invalid manifest',
      'resolved was at no file in the baseline scan · Partial scan',
      // The destination is a field: as written, never a word of the pack.
      'resolved manifesto was at manifesto (cópia)/AGENTS.md:2 in the baseline scan · Broken reference',
    ]);
    expect(panel).toContain(
      'agente (cópia): The last update of this baseline was not saved in the state directory of the app (/s): reason recorded by an earlier version of the app.',
    );
    for (const piece of [
      'Limite',
      'nventário',
      'Nome que',
      'Orçamento',
      'inválido',
      'falha',
      ' não ',
      base,
    ])
      expect(panel, piece).not.toContain(piece);
    expect(errors).toEqual([]);
  });

  test('Changes with a saved message of 200,000 characters shows at once, in both languages', async ({
    page,
  }) => {
    // A saved baseline is untrusted: a message made of the separators of many sentences, and an inventory limit
    // longer than the earlier server could write, are shown or left out, never searched.
    const long = 'x: o caminho x não existe; provável causa: x'.repeat(4600);
    const huge = [
      savedFinding('unreadable', `${project}/docs`, long),
      savedFinding(
        'limit',
        agent,
        `Limite de inventário atingido em ${' (1 elementos por raiz'.repeat(9100)}`,
      ),
    ];
    for (const language of ['en', 'pt']) {
      await page.addInitScript((lang) => localStorage.setItem('aae-lang', lang), language);
      const { lines, elapsed, errors } = await changesLines(page, changesModel(huge, long));
      console.log(`Changes with ${long.length} characters, ${language}: ${elapsed} ms`);
      expect(lines).toHaveLength(2);
      expect(elapsed).toBeLessThan(5000);
      expect(errors).toEqual([]);
      await page.unrouteAll();
    }
  });
});
