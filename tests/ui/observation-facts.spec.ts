import { expect, test } from '@playwright/test';
import { auditRow, auditTab, openAuditDetail, showAudit } from './audit-list';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, selectFile, writeTree } from './helpers';

// The screen says only what the model gives: the reader's caveat "não conclusivo" on the line and in the
// facts, where the reader looked (never a search it did not make), a destination above the opened folder with
// its repository and decoded path, the candidates past the inventory, and the counts of the footers and
// markers. Each case has a control that must not get the caveat or the sentence.

function write(root: string, tree: Record<string, string>) {
  writeTree(root, tree);
  return root;
}
const fixture = (name: string, tree: Record<string, string>) =>
  write(join(mkdtempSync(join(tmpdir(), 'aae-observation-facts-')), name), tree);

const block = (page: Page) => page.locator('.inspector .file-observations');
/** Opens every group of the inspector block. */
async function openGroups(page: Page) {
  const closed = block(page).locator('.observation-group-head[aria-expanded="false"]');
  for (let left = await closed.count(); left > 0; left = await closed.count())
    await closed.first().click();
}
/** The inspector occurrence whose line text is `text`, with its facts open. */
async function openOccurrence(page: Page, text: string): Promise<Locator> {
  await openGroups(page);
  const item = block(page).locator('.file-observation', {
    has: page.locator('.file-observation-open', { hasText: text }),
  });
  await item.locator('.file-observation-open').click();
  await expect(item.locator('.diagnosis')).toBeVisible();
  return item;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('observation facts: "não conclusivo" in a partial reading, the footer cause, the marker count and the Structure line', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const tree = {
    'AGENTS.md': '# P\n[Grande](grande.md)\n[A](ausente.md)\nSaída em `nome-solto.md`.\n',
    'orfa.md': '# Órfã\n',
  };
  // A text above 1 MiB makes the reading partial; the control has none.
  const partial = fixture('parcial', {
    ...tree,
    'grande.md': `# Grande\n${'texto de enchimento '.repeat(60000)}\n`,
  });
  const complete = fixture('completo', { ...tree, 'grande.md': '# Pequeno\n' });
  let close = await openOnly(page, [partial]);
  await page.goto('/');
  // Home lists the projects, without the tree: into the project.
  await enterProject(page);

  // The footer names the cause and its count, and opens the audit on the limits.
  const link = page.locator('.status-bar .status-partial');
  await expect(link).toHaveText('1 arquivo não lido');
  await expect(link).toHaveAttribute(
    'title',
    'Leitura parcial (limite de texto): pode faltar observação.',
  );

  // The marker counts the problem only (1), and so do the tooltip and the name; the informative one is
  // there too, apart, out of the number.
  const marker = page
    .getByRole('button', {
      name: '1 problema: referência ausente · 1 informativo: nome citado sem arquivo. Ver diagnóstico',
    })
    .first();
  await expect(marker).toHaveText('1');
  await expect(marker).toHaveAttribute(
    'title',
    '1 problema: referência ausente · 1 informativo: nome citado sem arquivo',
  );

  // Inspector: the line says the caveat, the group header does not affirm without it, the facts say it.
  await selectFile(page, join(partial, 'orfa.md'));
  const orphan = await openOccurrence(page, 'órfão · nenhum arquivo o cita');
  await expect(orphan.locator('.file-observation-open')).toContainText(
    'não conclusivo: leitura parcial',
  );
  await expect(block(page).locator('.observation-group-meaning')).toContainText(
    'Não conclusivo: leitura parcial.',
  );
  await expect(orphan.locator('.diagnosis-inconclusive')).toHaveText(
    /^Não conclusivo: a leitura deste diretório é parcial/,
  );
  await expect(orphan.locator('.diagnosis-searched')).toHaveText(
    /^Seguiu as referências a partir de 1 ponto de partida do projeto e não chegou aqui\.$/,
  );

  // Audit: the same mark on the line, the caveat in the facts and over the list of the type.
  await link.click();
  await expect(auditTab(page, 'Avisos')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Tipo de observação')).toHaveValue('limit');
  await showAudit(page, 'Informativos', 'unreachable');
  const row = auditRow(page, 'órfão');
  await expect(row.locator('.file-observation-open')).toContainText(
    'não conclusivo: leitura parcial',
  );
  await expect(page.locator('.audit-type-meaning')).toContainText(
    'Não conclusivo: leitura parcial.',
  );
  await openAuditDetail(row);
  await expect(row.locator('.diagnosis-inconclusive')).toBeVisible();

  // The Structure: anywhere on a file's line selects it, as its name does. The folder opens in the mode
  // of its view (the map of the file chosen by the search); its Estrutura is one switch away.
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await page.getByRole('button', { name: 'Voltar ao diretório parcial' }).click();
  await page.getByRole('button', { name: 'Estrutura de parcial', exact: true }).click();
  const fileLine = page.locator('.structure-row.is-file', {
    has: page.locator('.structure-open', { hasText: /^orfa\.md$/ }),
  });
  await fileLine.locator('.structure-count').first().click();
  await expect(page.locator('.inspector .copy-path code')).toHaveText(join(partial, 'orfa.md'));
  await close();

  // Control: a complete reading has no caveat anywhere and no footer link.
  close = await openOnly(page, [complete]);
  await page.goto('/');
  await expect(link).toHaveCount(0);
  await selectFile(page, join(complete, 'orfa.md'));
  const sure = await openOccurrence(page, 'órfão · nenhum arquivo o cita');
  await expect(sure.locator('.file-observation-open')).not.toContainText('não conclusivo');
  await expect(block(page).locator('.observation-group-meaning')).not.toContainText(
    'Não conclusivo',
  );
  await expect(sure.locator('.diagnosis-inconclusive')).toHaveCount(0);
  expect(errors).toEqual([]);
  await close();
});

test('observation facts: where the reader looked, never a search it did not make; "Mostrar mais" to the end; relations per line', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const targets = Array.from({ length: 105 }, (_, index) => `t${String(index).padStart(3, '0')}`);
  const tree: Record<string, string> = {
    'AGENTS.md':
      '# Projeto\n[P](docs/p.md)\n[Vinte](docs/vinte.md)\n[Muitos](docs/muitos.md)\n[Guia](docs/guia.md)\nVeja `guia.md`.\n[Guia de novo](docs/guia.md)\n',
    'docs/p.md':
      '# Provas\nVeja `sub/../../fora.md`.\n[[v1.2-notas]]\nVeja `./sub/x.md`.\n[l](./y.md)\nVeja `./nada.md`.\n[g](./gerados)\nVeja `./gerados/saida.md`.\n',
    'docs/sub/outro.md': '# Outro\n',
    'docs/guia.md': '# Guia\n',
    'docs/vinte.md': `# Vinte\n${Array.from({ length: 20 }, (_, i) => `[f${i}](falta-${i}.md)`).join('\n')}\n`,
    'docs/muitos.md': `# Muitos\n${[...targets, ...targets].map((name) => `[${name}](../alvos/${name}.md)`).join('\n')}\n`,
    'z/fora.md': '# Fora, o único com esse nome\n',
    'notas/v1.2-notas.md': '# O único com esse nome\n',
    'sub/x.md': '# Existe a partir do diretório aberto\n',
    'y.md': '# Existe a partir do diretório aberto\n',
  };
  for (const name of targets) tree[`alvos/${name}.md`] = `# ${name}\n`;
  const root = fixture('provas', tree);
  const close = await openOnly(page, [root]);
  await page.goto('/');

  await selectFile(page, join(root, 'docs/p.md'));
  // A path that climbs out of its folder once normalized is anchored: no cascade, no name search.
  const climbs = await openOccurrence(page, 'sub/../../fora.md');
  await expect(climbs.locator('.diagnosis-searched')).toHaveText(
    'Procurou só em fora.md (caminho ancorado).',
  );
  // A wikilink whose name has an extension: no .md added, no search by name.
  const dotted = await openOccurrence(page, 'v1.2-notas');
  await expect(dotted.locator('.diagnosis-searched')).toHaveText(
    'Procurou um arquivo do projeto que declare name: v1.2-notas, depois docs/v1.2-notas.',
  );
  // `./sub/x.md` with `sub/` next to the file: only there, never from the opened root.
  const beside = await openOccurrence(page, './sub/x.md');
  await expect(beside.locator('.diagnosis-searched')).toHaveText(
    'Procurou só em docs/sub/x.md: a pasta sub/ existe ao lado deste arquivo.',
  );
  // A `./` Markdown link is anchored: never from the opened root.
  const link = await openOccurrence(page, './y.md');
  await expect(link.locator('.diagnosis-searched')).toHaveText(
    'Procurou só em docs/y.md (caminho ancorado).',
  );
  // Control: a `./` mention whose first folder is not next to the file also tries the opened root.
  const both = await openOccurrence(page, './nada.md');
  await expect(both.locator('.diagnosis-searched')).toHaveText(
    'Procurou em docs/nada.md (a partir da pasta deste arquivo) e em nada.md (a partir do diretório aberto).',
  );

  // `docs/gerados` is only the placeholder of a missing destination (`[g](./gerados)`), not a folder: the
  // reader tried the opened root too, and the screen never says the folder is there.
  const placeholder = await openOccurrence(page, './gerados/saida.md');
  await expect(placeholder.locator('.diagnosis-searched')).toHaveText(
    'Procurou em docs/gerados/saida.md (a partir da pasta deste arquivo) e em gerados/saida.md (a partir do diretório aberto).',
  );

  // Twenty missing destinations: "Mostrar mais" goes past the second page to the last line, and the
  // focus stays in the list when the button leaves.
  await selectFile(page, join(root, 'docs/vinte.md'));
  const rows = block(page).locator('.file-observation-row');
  await expect(rows).toHaveCount(8);
  const more = block(page).getByRole('button', { name: /^Mostrar mais/ });
  await more.click();
  await expect(rows).toHaveCount(16);
  await expect(more).toHaveText('Mostrar mais 4 · faltam 4');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(20);
  await expect(rows.last()).toHaveText(/^L21\s*falta-19\.md$/);
  await expect(more).toHaveCount(0);
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /falta-16\.md/);

  // Relations: the resolution by name belongs to its citation; the page counts lines, each complete.
  await selectFile(page, join(root, 'AGENTS.md'));
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const guide = page.locator('.relation-row', {
    has: page.locator('.relation-target', { hasText: /^guia\.md/ }),
  });
  await expect(guide.locator('.relation-lines')).toHaveText(
    'L5, L6 (resolvida por nome único), L7',
  );
  await expect(guide.locator('.relation-path')).not.toContainText('resolvida');
  await selectFile(page, join(root, 'docs/muitos.md'));
  await page.getByRole('button', { name: 'Relações', exact: true }).click();
  const relations = page.locator('.inspector .relation-list').first();
  await expect(relations.locator('.relation-row')).toHaveCount(100);
  for (const index of [0, 99])
    await expect(
      relations.locator('.relation-row').nth(index).locator('.relation-evidence'),
    ).toHaveCount(2);
  const page2 = relations.getByRole('button', { name: /^Mostrar mais/ });
  await expect(page2).toHaveText('Mostrar mais 5 destinos · faltam 5');
  await page2.click();
  await expect(relations.locator('.relation-row')).toHaveCount(105);
  await expect(relations.locator('.relation-row').last().locator('.relation-evidence')).toHaveCount(
    2,
  );
  await expect(page.locator(':focus')).toHaveText(/t100\.md/);
  expect(errors).toEqual([]);
  await close();
});

test('observation facts: a destination above the opened folder names its repository and the path as on disk', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = mkdtempSync(join(tmpdir(), 'aae-observation-facts-'));
  const repository = join(base, 'repo');
  write(repository, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    'acima/meu arquivo.md': '# Acima\n',
    'pacote/AGENTS.md': '# Pacote\n[l](acima/meu%20arquivo.md)\n',
  });
  // Control: the same folder with no repository above it is a missing destination.
  const loose = join(base, 'solto');
  write(loose, {
    'acima/meu arquivo.md': '# Acima\n',
    'pacote/AGENTS.md': '# Pacote\n[l](acima/meu%20arquivo.md)\n',
  });
  let close = await openOnly(page, [join(repository, 'pacote')]);
  await page.goto('/');
  await selectFile(page, join(repository, 'pacote/AGENTS.md'));
  const above = await openOccurrence(page, 'acima/meu%20arquivo.md');
  await expect(above.locator('.diagnosis-searched')).toHaveText(
    `Existe 1 nível acima do diretório aberto, em ../acima/meu arquivo.md, no repositório ${repository} (com .git); o leitor só conferiu a existência.`,
  );
  await close();
  close = await openOnly(page, [join(loose, 'pacote')]);
  await page.goto('/');
  await selectFile(page, join(loose, 'pacote/AGENTS.md'));
  const missing = await openOccurrence(page, 'acima/meu%20arquivo.md');
  await expect(missing.locator('.diagnosis-searched')).toHaveText(
    /^Procurou em acima\/meu arquivo\.md /,
  );
  await expect(missing).not.toContainText('repositório');
  expect(errors).toEqual([]);
  await close();
});

test('observation facts: a reading cut by the inventory limit (mocked): "./" past the inventory, candidates past it, the limit in numbers and the read count', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = '/tmp/aae-observation-facts-limit';
  const node = (relative: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id: `${root}${relative ? `/${relative}` : ''}`,
    path: `${root}${relative ? `/${relative}` : ''}`,
    name: relative.split('/').at(-1) || 'limite',
    relative: relative || '.',
    kind,
    status: 'resolved',
    root,
    roots: [root],
    ...extra,
  });
  const at = (relative: string, line: number, target: string, extra: Record<string, unknown>) => ({
    node: `${root}/${relative}`,
    line,
    target,
    evidence: `Veja \`${target}\`.`,
    syntax: 'path',
    form: 'path',
    ...extra,
  });
  // A sentence as the server sends it: in English, with its phrase and parameters next to it. The
  // interface (Portuguese here) words the phrase from its pack and reads the facts from the parameters.
  const said = (phrase: string, params: Record<string, unknown>) => ({
    message: phrase.replace(/\{(\w+)\}/g, (whole, name) =>
      name in params ? String(params[name]) : whole,
    ),
    messagePhrase: { phrase, params },
  });
  const model = {
    savedCases: [{ path: root, name: 'limite', available: true }],
    roots: [{ path: root, name: 'limite', parent: null, level: 0, entries: [`${root}/AGENTS.md`] }],
    nodes: [
      node('', 'directory', { listing: 'partial', omitted: 3739 }),
      node('AGENTS.md', 'entry', { analysis: 'parsed', lines: 3 }),
      // `a/` was listed in part: its `sub/` may exist past the inventory.
      node('a', 'directory', { listing: 'partial', omitted: 10 }),
      node('a/c.md', 'file', { analysis: 'parsed', lines: 2 }),
      // `b/` was listed in full: no `sub/` next to `b/d.md`.
      node('b', 'directory', { listing: 'complete' }),
      node('b/d.md', 'file', { analysis: 'parsed', lines: 2 }),
      node('alvos', 'directory', { listing: 'complete' }),
      node('alvos/alvo.md', 'file', { analysis: 'parsed', lines: 1 }),
      node('alvos/comum.md', 'file', { analysis: 'parsed', lines: 1 }),
      node('outros/comum.md', 'file', { analysis: 'parsed', lines: 1 }),
    ],
    edges: [],
    objects: [],
    issues: [
      {
        id: 'b1',
        code: 'broken',
        ...said('Target not found: {raw}', { raw: './sub/x.md' }),
        ...at('a/c.md', 2, './sub/x.md', {}),
      },
      {
        id: 'b2',
        code: 'broken',
        ...said('Target not found: {raw}', { raw: './sub/x.md' }),
        ...at('b/d.md', 2, './sub/x.md', {}),
      },
      {
        id: 'm1',
        code: 'ambiguous',
        ...said(
          'Ambiguous reference: {raw} ({total} candidates, {hidden} beyond the inventory; none was chosen).',
          { raw: 'alvo.md', total: 3, hidden: 2 },
        ),
        ...at('AGENTS.md', 2, 'alvo.md', {
          form: 'name',
          candidates: [`${root}/alvos/alvo.md`, `${root}/z1/alvo.md`, `${root}/z2/alvo.md`],
          candidatesTotal: 3,
        }),
      },
      {
        id: 'm2',
        code: 'ambiguous',
        ...said(
          'Ambiguous reference: {raw} ({total} candidates in the inventory; none was chosen).',
          { raw: 'comum.md', total: 2 },
        ),
        ...at('AGENTS.md', 3, 'comum.md', {
          form: 'name',
          candidates: [`${root}/alvos/comum.md`, `${root}/outros/comum.md`],
          candidatesTotal: 2,
        }),
      },
      {
        // Longer than the narrowest row holds: the facts repeat it whole.
        id: 'u1',
        code: 'unreadable',
        ...said('Could not analyze: {reason}', { reason: 'permissão negada ao abrir' }),
        node: `${root}/b/d.md`,
        line: null,
      },
      {
        id: 'l1',
        code: 'limit',
        // The numbers of the cut come as facts with the message (`minimum` is not written in the sentence).
        ...said(
          'Inventory limit reached in {root} ({budget} items per root in this workspace): folders read in part: {partial}; folders not read: {unread}; items left out of the inventory: {omitted}. Entry or skill files (AGENTS.md, CLAUDE.md, SKILL.md) left out: {entries}, such as {example}. The cut affects both sides: findings may be missing in those folders, and references into them are checked only for existence. Open a subfolder for a complete scan.',
          {
            root,
            budget: 6666,
            partial: 1,
            unread: 1,
            omitted: 3739,
            minimum: false,
            entries: 1,
            example: 'fundo/AGENTS.md',
          },
        ),
        node: root,
        line: null,
      },
    ],
    signals: [
      {
        id: 's1',
        code: 'cycle',
        ...said(
          'Structural cycle: {count} files in a group with a way back through explicit references ({sample}). It does not prove repetition when an agent runs.',
          { count: 2, sample: 'a.md, b.md' },
        ),
        node: `${root}/AGENTS.md`,
        line: 2,
        count: 2,
        files: ['a.md', 'b.md'],
      },
      {
        id: 's2',
        code: 'repeated-reference',
        ...said(
          'Reference repeated in {count} evidence locations: {source} → {target}. It may be intentional; it does not prove runtime noise.',
          { count: 2, source: 'AGENTS.md', target: `${root}/alvos/alvo.md` },
        ),
        node: `${root}/AGENTS.md`,
        line: 3,
        count: 2,
        to: `${root}/alvos/alvo.md`,
      },
      {
        id: 's3',
        code: 'high-fanout',
        ...said(
          'Concentration of references: {count} distinct explicit targets (threshold: {threshold}). Review the organization; a count does not prove inefficiency.',
          { count: 12, threshold: 12 },
        ),
        node: `${root}/AGENTS.md`,
        line: null,
        count: 12,
      },
    ],
    notes: {},
    expected: {},
    restoreErrors: [],
    delta: null,
    scope: { source: null, patterns: [] },
    stats: {
      structure: {
        cycles: 1,
        selfReferences: 0,
        repeatedReferences: 1,
        highFanout: 1,
        fanoutThreshold: 12,
        maxFanout: null,
      },
      files: 6,
      parsed: 5,
      edges: 0,
      entries: 1,
      inventory: {
        complete: false,
        lookupComplete: true,
        omitted: 3739,
        omittedFiles: 3000,
        byTopLevel: [],
      },
    },
    policy: {
      excluded: [],
      maxNodes: 6666,
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
    if (path === 'content')
      return route.fulfill({ json: { text: '# x\nVeja.\nVeja.', truncated: false } });
    return route.fulfill({ status: 404, json: { error: `Operação inesperada ${path}` } });
  });
  await page.goto('/');

  // The bottom bar says the files read once, counting the files left out of the inventory.
  await expect(page.locator('.status-bar .status-files')).toHaveText('5 de 3.006 arquivos lidos');
  await expect(page.locator('.explorer-footer')).toHaveCount(0);

  await page.locator('.error-banner').getByRole('button', { name: 'Ver limites' }).click();
  // The limit of the inventory in its numbers, and the facts do not repeat the line.
  await showAudit(page, 'Avisos', 'limit');
  const limit = auditRow(page, 'Limite de 6.666 itens por projeto');
  await expect(limit.locator('.file-observation-open')).toContainText(
    'Limite de 6.666 itens por projeto: 1 pasta lida em parte, 1 não lida, 3.739 itens fora',
  );
  await openAuditDetail(limit);
  // The row may cut the numbers: the facts say them whole.
  await expect(limit.locator('.diagnosis-message')).toHaveText(
    'Limite de 6.666 itens por projeto: 1 pasta lida em parte, 1 não lida, 3.739 itens fora. 1 arquivo de entrada ou de skill ficou fora, como fundo/AGENTS.md.',
  );
  await expect(limit.locator('.occurrence-detail')).not.toContainText('Limite de inventário');

  // A read failure longer than the narrowest row: repeated whole in the facts.
  await showAudit(page, 'Avisos', 'unreadable');
  const failure = await openAuditDetail(auditRow(page, 'Não foi possível analisar'));
  await expect(failure.locator('.diagnosis-message')).toHaveText(
    'Não foi possível analisar: permissão negada ao abrir',
  );

  // Signals: the whole line of each kind is the fact, read in full.
  await showAudit(page, 'Sinais');
  await expect(page.locator('.audit-observations .file-observation-text')).toHaveText([
    '2 arquivos: a.md, b.md',
    '2 vezes → alvos/alvo.md',
    '12 destinos (limiar 12)',
  ]);

  await showAudit(page, 'Todas');
  // `./sub/x.md` in a folder listed in part: no claim that the opened root was tried, or not.
  const cut = await openAuditDetail(
    page.locator('.audit-file-group', { hasText: 'a/c.md' }).locator('.file-observation').first(),
  );
  await expect(cut.locator('.diagnosis-searched')).toHaveText(
    'Procurou em a/sub/x.md (a partir da pasta deste arquivo).',
  );
  // Control: the folder listed in full has no `sub/`, so the opened root was tried too.
  const full = await openAuditDetail(
    page
      .locator('.audit-file-group', { hasText: 'b/d.md' })
      .locator('.file-observation', { hasText: './sub/x.md' }),
  );
  await expect(full.locator('.diagnosis-searched')).toHaveText(
    'Procurou em b/sub/x.md (a partir da pasta deste arquivo) e em sub/x.md (a partir do diretório aberto).',
  );
  // Candidates past the inventory are counted, as the reader says; the control has none.
  const hidden = await openAuditDetail(auditRow(page, /^alvo\.md/));
  await expect(hidden.locator('.diagnosis-searched')).toHaveText(
    'Não existe em alvo.md (a partir da pasta deste arquivo); 3 arquivos do projeto correspondem ao que está escrito. 2 deles não foram listados, sem leitura.',
  );
  const listed = await openAuditDetail(auditRow(page, /^comum\.md/));
  await expect(listed.locator('.diagnosis-searched')).not.toContainText('não foram listados');
  expect(errors).toEqual([]);
});

test('observation facts: the audit filter of a project without observations keeps its controls; the opening rule comes back when a choice is left empty; arrows move between levels', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = mkdtempSync(join(tmpdir(), 'aae-observation-facts-'));
  const withIssues = write(join(base, 'projA'), {
    'AGENTS.md': '# A\n[Ausente](ausente.md)\n',
    'orfa.md': '# Órfã\n',
  });
  const clean = write(join(base, 'projC'), { 'AGENTS.md': '# C\n' });
  const close = await openOnly(page, [withIssues, clean]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('aria-selected', 'true');

  // Only the project without observations: the selector stays, and the empty list names the project.
  const project = page.getByLabel('Projeto da auditoria');
  await project.selectOption({ label: 'Só projC' });
  await expect(page.locator('.audit-empty')).toHaveText('Nenhuma observação em projC.');
  await expect(project).toBeVisible();
  await project.selectOption({ label: 'Todos os projetos' });
  await expect(auditTab(page, 'Problemas')).toBeVisible();

  // Arrows move between the levels and select them; one tab stop.
  await auditTab(page, 'Problemas').focus();
  await page.keyboard.press('ArrowRight');
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Informativos')).toBeFocused();
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Home');
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('aria-selected', 'true');

  // Control: a chosen level that keeps observations stays chosen after a new reading.
  await auditTab(page, 'Informativos').click();
  const reread = async () => {
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/refresh'));
    await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
    await refreshed;
  };
  await reread();
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');
  // A chosen level left empty by a new reading: the opening rule again.
  await auditTab(page, 'Problemas').click();
  writeFileSync(join(withIssues, 'AGENTS.md'), '# A\nSem referências.\n');
  await reread();
  await expect(auditTab(page, 'Problemas')).toHaveCount(0);
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');

  // The same with the Auditoria off the screen (another tool open): the rule applies when it opens again.
  writeFileSync(join(withIssues, 'AGENTS.md'), '# A\n[Ausente](ausente.md)\n');
  await reread();
  await auditTab(page, 'Problemas').click();
  await page.getByRole('button', { name: 'Alterações', exact: true }).first().click();
  await expect(auditTab(page, 'Problemas')).toHaveCount(0);
  writeFileSync(join(withIssues, 'AGENTS.md'), '# A\nSem referências.\n');
  await reread();
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');
  await expect(auditTab(page, 'Problemas')).toHaveCount(0);

  // Marking the last observation of a level: the tab changes by the rule, and the confirmation stays.
  writeFileSync(join(withIssues, 'AGENTS.md'), '# A\n[Ausente](ausente.md)\n');
  await reread();
  await expect(auditTab(page, 'Problemas')).toHaveAttribute('aria-selected', 'true');
  const last = await openAuditDetail(auditRow(page, 'ausente.md'));
  await last.getByRole('button', { name: /^Marcar como esperada:/ }).click();
  await last.getByRole('button', { name: 'Marcar como esperada', exact: true }).click();
  await expect(auditTab(page, 'Informativos')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.audit-expected-status')).toHaveText(
    /^Marcada como esperada: Referência ausente \(ausente\.md\) em .*AGENTS\.md:2\.$/,
  );
  expect(errors).toEqual([]);
  await close();
});

test('observation facts: in Alterações, a new observation that is not conclusive says so on its line', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture('alteracoes', { 'AGENTS.md': '# A\n' });
  const close = await openOnly(page, [root]);
  await page.goto('/');
  // A text above 1 MiB makes the reading partial; a file nobody cites is an orphan, not conclusive.
  writeFileSync(join(root, 'grande.md'), `# Grande\n${'texto de enchimento '.repeat(60000)}\n`);
  writeFileSync(join(root, 'orfa.md'), '# Órfã\n');
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/refresh'));
  await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
  await refreshed;
  await page.getByRole('button', { name: 'Alterações', exact: true }).first().click();
  const rows = page.locator('.changes-section[aria-label="Observações"] .change-row');
  await expect(rows.filter({ hasText: 'orfa.md' })).toContainText(
    'órfão · nenhum arquivo o cita · não conclusivo: leitura parcial',
  );
  // Control: an observation that is not about reachability (the limit of the big text) has no caveat.
  const others = rows.filter({ hasNotText: 'órfão' });
  await expect(others).not.toHaveCount(0);
  await expect(others.first()).not.toContainText('não conclusivo');
  expect(errors).toEqual([]);
  await close();
});
