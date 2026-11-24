// The map of a folder: the items of the folder with the
// written references summed between them, in columns from the instructions, with routes that never pass
// behind a card. The numbers of the `aurora` laboratory come from its definition
// (tests/create_audit_lab.py), not from the code under test.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, readable, sessionHeaders, writeTree } from './helpers';
import { menuButton, runMoreAction } from './more-menu';

/** The synthetic audit laboratory, created for this run. */
function laboratory() {
  const { lab } = JSON.parse(
    execFileSync(
      'python3',
      [
        'tests/create_audit_lab.py',
        '--destination',
        join(mkdtempSync(join(tmpdir(), 'aae-folder-map-')), 'lab'),
      ],
      { encoding: 'utf8' },
    ),
  );
  return lab as string;
}

const pane = (page: Page, scope: string) => page.locator(`.scope-pane[data-scope="${scope}"]`);
const card = (scope: Locator, path: string) =>
  scope.locator('.react-flow__node-file', { has: scope.page().locator(`strong[title="${path}"]`) });
const arrow = (scope: Locator, source: string, target: string) =>
  scope.locator(`g.folder-arrow[data-source="${source}"][data-target="${target}"]`);

/** Opens `roots`, shows the folder `folder` of the first one in the map, the other views minimized. */
async function mapOf(page: Page, roots: string[], folder = roots[0]) {
  await openOnly(page, roots);
  await page.goto('/');
  const name = roots[0].split('/').at(-1)!;
  // From Home, the list of projects, by the row of the project.
  await enterProject(page, name);
  for (const other of roots.slice(1)) {
    const minimize = page.getByRole('button', {
      name: `Minimizar vista ${other.split('/').at(-1)}`,
      exact: true,
    });
    if (await minimize.count()) await minimize.click();
  }
  if (folder !== roots[0]) {
    await page
      .locator('.structure-row .structure-open', {
        hasText: new RegExp(`^${folder.split('/').at(-1)}$`),
      })
      .first()
      .click();
    await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText(
      folder.split('/').at(-1)!,
    );
  }
  await page.getByRole('button', { name: `Mapa de ${name}`, exact: true }).click();
  const view = pane(page, roots[0]);
  await expect(view.locator('.folder-map')).toBeVisible();
  return view;
}

/**
 * By geometry, in the page: each arrow goes to a card at its right or in its own column, and no point
 * of its line lies inside a card (or the box outside) that is not one of its two ends.
 */
async function routeProblems(scope: Locator) {
  return scope.evaluate((root) => {
    const boxes = [
      ...root.querySelectorAll(
        '.react-flow__node-file, .react-flow__node-outside, .react-flow__node-inbound',
      ),
    ].map((element) => ({
      id: element.getAttribute('data-id')!,
      rect: element.getBoundingClientRect(),
    }));
    const problems = new Set<string>();
    const arrows = [...root.querySelectorAll<SVGGElement>('g.folder-arrow')];
    for (const group of arrows) {
      const source = group.dataset.source!,
        target = group.dataset.target!;
      const from = boxes.find((box) => box.id === source)!.rect,
        to = boxes.find((box) => box.id === target)!.rect;
      if (to.left < from.left - 1) problems.add(`${source} → ${target} goes left`);
      const path = group.querySelector<SVGPathElement>('path.react-flow__edge-path')!;
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      for (let k = 0; k <= 80; k++) {
        const point = path.getPointAtLength((length * k) / 80);
        const { x, y } = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        for (const box of boxes)
          if (
            box.id !== source &&
            box.id !== target &&
            x > box.rect.left + 1 &&
            x < box.rect.right - 1 &&
            y > box.rect.top + 1 &&
            y < box.rect.bottom - 1
          )
            problems.add(`${source} → ${target} crosses ${box.id}`);
      }
    }
    return { problems: [...problems], arrows: arrows.length, cards: boxes.length };
  });
}

/** The numbers written on the cards ("2 internas"), summed. */
async function internalOnCards(scope: Locator) {
  const facts = await scope.locator('.item-tile .item-facts').allTextContents();
  return facts.reduce((sum, text) => sum + Number(/(\d+) internas?/.exec(text)?.[1] ?? 0), 0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: false, bottom: false }));
  });
});

test('the root of aurora shows its items, the 42 references summed and placed, and no arrow behind a card', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const lab = laboratory();
  const root = join(lab, 'aurora');
  const view = await mapOf(page, [root, join(lab, 'compartilhado'), join(lab, 'sem-entrada')]);
  const at = (relative: string) => join(root, relative);

  // One sentence says what is seen, and the counts close on the references written in aurora.
  const model = await (
    await page.request.get('/api/workspace', { headers: await sessionHeaders(page) })
  ).json();
  const written = model.edges.filter(
    (edge: { source: string; kind: string }) =>
      edge.source.startsWith(root + '/') && edge.kind !== 'scope',
  ).length;
  expect(written).toBe(42);
  const caption = view.locator('.canvas-caption');
  await expect(caption.locator('> span').first()).toHaveText(
    'Referências somadas entre os itens de aurora',
  );
  await expect(caption.locator('> span:last-child')).toHaveText(
    '18 itens · 42 referências (33 entre itens · 3 para fora · 6 dentro de pastas)',
  );
  const drawn = (await view
    .locator('g.folder-arrow')
    .evaluateAll((groups) =>
      groups.map((group) => Number(group.getAttribute('data-count'))),
    )) as number[];
  const outside = Number(await view.locator('.outside-total').textContent());
  expect(drawn.reduce((a, b) => a + b, 0) + outside + (await internalOnCards(view))).toBe(written);

  // The summed arrows, from the files of one item to the files of another.
  const expected: [string, string, number][] = [
    ['AGENTS.md', 'atalho.md', 1],
    ['AGENTS.md', 'ciclos', 1],
    ['AGENTS.md', 'convencao', 1],
    ['AGENTS.md', 'documentos', 1],
    ['AGENTS.md', 'equipes', 1],
    ['AGENTS.md', 'fluxos', 2],
    ['AGENTS.md', 'hostil.md', 1],
    ['AGENTS.md', 'hub.md', 1],
    ['AGENTS.md', 'skills', 1],
    ['agent-architecture.json', 'fluxos', 4],
    ['fluxos', 'memory', 1],
    ['hub.md', 'hub', 12],
    ['links.md', 'documentos', 3],
    ['links.md', 'skills', 3],
  ];
  await expect(view.locator('g.folder-arrow')).toHaveCount(expected.length);
  for (const [source, target, count] of expected)
    await expect(arrow(view, at(source), at(target))).toHaveAttribute('data-count', String(count));
  await expect(view.locator('.react-flow__node-file')).toHaveCount(14);

  // Columns from the instructions, each with a short title about references.
  await expect(view.locator('.folder-lane')).toHaveText([
    'Instruções desta pasta',
    'Citados diretamente',
    'Citados em 2 passos',
    'Outros que citam',
  ]);
  const left = async (relative: string) => (await card(view, at(relative)).boundingBox())!.x;
  const first = await left('AGENTS.md');
  expect(await left('agent-architecture.json')).toBeCloseTo(first, 0);
  expect(await left('links.md')).toBeCloseTo(first, 0);
  for (const cited of ['hub.md', 'fluxos', 'documentos', 'atalho.md'])
    expect(await left(cited)).toBeGreaterThan(first + 100);
  for (const twoSteps of ['hub', 'memory'])
    expect(await left(twoSteps)).toBeGreaterThan((await left('hub.md')) + 100);

  // Measured on the screen.
  const geometry = await routeProblems(view);
  expect(geometry.problems).toEqual([]);
  expect(geometry.arrows).toBe(14);
  console.log(
    `aurora: crossings between columns ${await view.locator('.folder-map').getAttribute('data-crossings')}`,
  );

  // The number of an arrow (more than one reference) and its tooltip; the list leads to the evidence.
  const hub = arrow(view, at('hub.md'), at('hub'));
  await expect(hub.locator('title')).toHaveText(
    '12 referências escritas de hub.md para arquivos de hub',
  );
  await expect(
    arrow(view, at('agent-architecture.json'), at('fluxos')).locator('title'),
  ).toHaveText('4 referências escritas de agent-architecture.json para arquivos de fluxos');
  await expect(arrow(view, at('AGENTS.md'), at('hostil.md')).locator('title')).toHaveText(
    '1 referência escrita de AGENTS.md para hostil.md',
  );
  // A number only where there is more than one reference (the order of the labels follows the edges).
  await expect(view.locator('.folder-arrow-count')).toHaveCount(5);
  expect((await view.locator('.folder-arrow-count').allTextContents()).sort()).toEqual([
    '12',
    '2',
    '3',
    '3',
    '4',
  ]);
  await view
    .getByRole('button', { name: '12 referências escritas de hub.md para arquivos de hub' })
    .click();
  const list = view.getByRole('region', { name: 'Referências da seta' });
  await expect(list.locator('> div > button')).toHaveCount(12);
  await expect(list.locator('> div > button').first()).toContainText('hub.md · linha 2');
  await expect(list.locator('> div > button').first()).toContainText(
    '[Destino 0](hub/destino-00.md)',
  );
  await list.locator('> div > button').nth(3).click();
  await expect(page.locator('.inspector')).toBeVisible();
  // The evidence is read in the inspector, on its file (as every evidence of the app); back returns.
  await expect(page.locator('.inspector')).toContainText('[Destino 3](hub/destino-03.md)');
  await runMoreAction(page, 'Recolher inspetor');
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(view.locator('.canvas-caption > span').first()).toHaveText(
    'Referências somadas entre os itens de aurora',
  );

  // Items without any reference with the other items leave the grid for one line, still clickable.
  const strip = view.locator('.folder-strip');
  await expect(strip.locator('.folder-strip-label')).toHaveText(
    'Sem ligação com outros itens desta pasta',
  );
  await expect(strip.locator('.folder-strip-item')).toHaveText([
    'invalido1 arquivo',
    'limites2 arquivos',
    'politicas2 arquivos',
    'atalho-pastalink simbólico',
  ]);
  for (const name of ['invalido', 'limites', 'politicas', 'atalho-pasta'])
    await expect(card(view, at(name))).toHaveCount(0);

  // References that leave the folder, by what they reach, with the count and who writes them.
  const box = view.locator('.react-flow__node-outside');
  await expect(box.locator('.outside-group')).toHaveCount(3);
  await expect(box.locator('.outside-group[data-kind="other-project"]')).toHaveText(
    'Outro projeto aberto: compartilhado · 1compartilhado/contrato.mdde AGENTS.md',
  );
  await expect(box.locator('.outside-group[data-kind="unread"]')).toHaveText(
    'Em pasta não lida · 1node_modules/ignorado.mdde AGENTS.md',
  );
  await expect(box.locator('.outside-group[data-kind="missing"]')).toHaveText(
    'Ausente · 1ausente.mdde AGENTS.md',
  );
  await expect(view.locator('g.folder-arrow[data-target="outside"]')).toHaveCount(0);

  // A folder says how many files it has, its own instructions and its internal references; the sums.
  const facts = (relative: string) => card(view, at(relative)).locator('.item-facts');
  await expect(facts('fluxos')).toHaveText('2 arquivos · 2 internas');
  await expect(facts('convencao')).toHaveText('2 arquivos · CLAUDE.md próprio');
  await expect(facts('equipes')).toHaveText('2 arquivos · 1 interna');
  await expect(facts('hub')).toHaveText('12 arquivos');
  await expect(facts('AGENTS.md')).toHaveText('Instruções');
  await expect(card(view, at('fluxos')).locator('.tile-foot > span:last-child')).toHaveText(
    '↙ 6 ↗ 1',
  );
  await expect(card(view, at('AGENTS.md')).locator('.tile-foot > span:last-child')).toHaveText(
    '↙ 0 ↗ 10',
  );
  expect(await internalOnCards(view)).toBe(6);

  // Both themes: the words of the map are readable.
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const selector of [
      '.canvas-caption > span:last-child',
      '.folder-lane',
      '.item-tile .tile-name strong',
      '.item-tile .item-facts',
      '.outside-group .outside-kind',
      '.folder-strip-label',
    ])
      expect(
        await readable(view.locator(selector).first()),
        `${selector} (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`aurora-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }

  // A folder card shows the map of that folder (the view keeps Mapa); a file card, its map; a
  // double click selects and opens the inspector.
  await card(view, at('fluxos')).click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('fluxos');
  await expect(page.getByRole('button', { name: 'Mapa de aurora', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(view.locator('.canvas-caption > span').first()).toHaveText(
    'Referências somadas entre os itens de fluxos',
  );
  await expect(arrow(view, at('fluxos/inicio.md'), at('fluxos/revisao.md'))).toHaveAttribute(
    'data-count',
    '2',
  );
  // A file of the parent folder goes outside, written from here.
  await expect(view.locator('.outside-group[data-kind="project"]')).toContainText(
    '../memory/decisoes.md',
  );
  await card(view, at('fluxos/inicio.md')).click();
  await expect(view.locator('.file-tile.focused strong')).toHaveAttribute(
    'title',
    at('fluxos/inicio.md'),
  );
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await expect(view.locator('.folder-map')).toBeVisible();
  await card(view, at('fluxos/revisao.md')).dblclick();
  await expect(page.locator('.inspector h2')).toHaveText('revisao.md');
  expect(errors).toEqual([]);
});

test('skips, cycles, loops, self-references, the folder itself, long names and folders without references', async ({
  page,
}) => {
  const base = mkdtempSync(join(tmpdir(), 'aae-folder-cases-'));
  const root = join(base, 'casa');
  const long = 'Relatório de avaliação contínua com um nome muito, muito comprido e acentuação.md';
  const control = 'controle\u0001nome.md';
  writeTree(root, {
    'AGENTS.md':
      '# Casa\n[A](a.md)\n[Y](y.md)\n[Z](z.md)\n[L](<' +
      long +
      '>)\n[Pasta](.)\n[Si](si.md)\n[Sub](sub/s.md)\n',
    'a.md': '# A\n[B](b.md)\n',
    'b.md': '# B\n[A](a.md)\n',
    'y.md': '# Y\n[W](w.md)\n',
    'w.md': '# W\n[Z](z.md)\n',
    'z.md': '# Z\n',
    [long]: '# Longo\n',
    'si.md': '# Si\n[Eu](si.md)\n',
    'interna/x.md': '# X\n[Y](y2.md)\n',
    'interna/y2.md': '# Y2\n',
    'sub/s.md': '# S\n[Aqui](.)\n[Mãe](../AGENTS.md)\n[T](t.md)\n',
    'sub/t.md': '# T\n',
    'solta/p.md': '# P\n',
    'solta/q.md': '# Q\n',
    'sem-instrucoes/p.md': '# P\n[Q](q.md)\n',
    'sem-instrucoes/q.md': '# Q\n',
    'ciclo/a.md': '# A\n[B](b.md)\n',
    'ciclo/b.md': '# B\n[A](a.md)\n[C](c.md)\n',
    'ciclo/c.md': '# C\n',
  });
  writeFileSync(join(root, control), '# Controle\n[Casa](AGENTS.md)\n');
  const view = await mapOf(page, [root]);
  const at = (relative: string) => join(root, relative);

  // An arrow that skips a column, a cycle and loops inside a column, none behind a card.
  expect((await routeProblems(view)).problems).toEqual([]);
  await expect(arrow(view, at('AGENTS.md'), at('z.md'))).toHaveAttribute('data-shape', 'skip');

  // A cites B and B cites A: both cards in one column, two arrows apart.
  const ab = arrow(view, at('a.md'), at('b.md')),
    ba = arrow(view, at('b.md'), at('a.md'));
  await expect(ab).toHaveAttribute('data-shape', 'same');
  await expect(ba).toHaveAttribute('data-shape', 'same');
  expect((await card(view, at('a.md')).boundingBox())!.x).toBeCloseTo(
    (await card(view, at('b.md')).boundingBox())!.x,
    0,
  );
  const [one, two] = [
    (await ab.locator('path.react-flow__edge-path').boundingBox())!,
    (await ba.locator('path.react-flow__edge-path').boundingBox())!,
  ];
  expect(Math.abs(one.x + one.width - (two.x + two.width))).toBeGreaterThan(4);

  // No arrow to itself; the count is on the card. A folder whose references stay inside it is an
  // item without arrows, with its count.
  await expect(view.locator(`g.folder-arrow[data-source="${at('si.md')}"]`)).toHaveCount(0);
  await expect(card(view, at('si.md')).locator('.item-facts')).toHaveText('1 para si mesmo');
  await expect(view.locator(`.folder-strip-item[title="${at('interna')}"]`)).toHaveText(
    'interna2 arquivos · 1 interna',
  );
  await expect(view.locator('.canvas-caption > span:last-child')).toContainText('dentro de itens');

  // The folder itself goes outside as "Este diretório (.)".
  await expect(view.locator('.outside-group[data-kind="self"]')).toHaveText(
    'Este diretório (.) · 1de AGENTS.md',
  );

  // A long name and a control character cut with an ellipsis; the whole name in the tooltip.
  for (const name of [long, control]) {
    const strong = card(view, at(name)).locator('.tile-name strong');
    await expect(strong).toHaveAttribute('title', at(name));
    expect(await strong.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(
      true,
    );
    expect((await card(view, at(name)).boundingBox())!.height).toBeLessThan(62);
  }
  expect(
    await card(view, at(long))
      .locator('.tile-name strong')
      .evaluate((element) => [
        element.scrollWidth > element.clientWidth,
        getComputedStyle(element).textOverflow,
      ]),
  ).toEqual([true, 'ellipsis']);

  // In a subfolder: the folder itself and a file of the parent folder, each with its label.
  await card(view, at('sub')).click();
  await expect(view.locator('.outside-group[data-kind="self"]')).toContainText(
    'Este diretório (.)',
  );
  await expect(view.locator('.outside-group[data-kind="project"]')).toHaveText(
    'Em outro lugar deste projeto · 1../AGENTS.mdde s.md',
  );

  // A folder without instructions starts with who references; one where nothing references.
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await view.locator(`.folder-strip-item[title="${at('solta')}"]`).click();
  // Without arrows between the items, the items are cards under the sentence that says so; the line
  // under the map does not list them again, and the cards have no ↙ ↗ (0 and 0 would say nothing).
  await expect(view.locator('.folder-lane')).toHaveText(
    'Nenhuma referência entre os itens desta pasta.',
  );
  await expect(view.locator('.folder-map-empty')).toHaveCount(0);
  // The sentence says it once: the count does not add "0 referências (0 entre itens …)".
  await expect(view.locator('.canvas-caption > span:last-child')).toHaveText('2 itens');
  await expect(view.locator('.react-flow__node-file')).toHaveCount(2);
  await expect(view.locator('.folder-strip-item')).toHaveCount(0);
  await expect(card(view, at('solta/p.md')).locator('.tile-foot')).toHaveText('');
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await card(view, at('sem-instrucoes'))
    .or(view.locator(`.folder-strip-item[title="${at('sem-instrucoes')}"]`))
    .click();
  await expect(view.locator('.folder-lane')).toHaveText([
    'Citam sem ser citados',
    'Citados diretamente',
  ]);
  // Items that cite each other start the map too: each one is referenced, and the title says so.
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await card(view, at('ciclo'))
    .or(view.locator(`.folder-strip-item[title="${at('ciclo')}"]`))
    .click();
  await expect(view.locator('.folder-lane')).toHaveText([
    'Citam e são citados',
    'Citados diretamente',
  ]);
  for (const name of ['a.md', 'b.md'])
    await expect(
      card(view, at(`ciclo/${name}`)).locator('.tile-foot > span:last-child'),
    ).toHaveText(/^↙ 1/);
});

test('sixty folders that all reference each other, the limit of cards and a long list of references', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-dense-')), 'denso');
  const folders = Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  const files: Record<string, string> = {
    'AGENTS.md': '# Denso\n[D0](d00/x.md)\n[D1](d01/x.md)\n[D2](d02/x.md)\n',
    // A folder whose two files share 60 references, apart from the others.
    'lista/muitas.md':
      '# Muitas\n' + Array.from({ length: 60 }, (_, i) => `[Linha ${i}](alvo.md)\n`).join(''),
    'lista/alvo.md': '# Alvo\n',
  };
  for (const folder of folders)
    files[`${folder}/x.md`] =
      `# ${folder}\n` +
      folders
        .filter((other) => other !== folder)
        .map((other) => `[${other}](../${other}/x.md)\n`)
        .join('');
  writeTree(root, files);
  const view = await mapOf(page, [root]);
  const model = await (
    await page.request.get('/api/workspace', { headers: await sessionHeaders(page) })
  ).json();
  const written = model.edges.filter(
    (edge: { source: string; kind: string }) =>
      edge.source.startsWith(root + '/') && edge.kind !== 'scope',
  ).length;
  expect(written).toBe(3 + 60 + 60 * 59);

  // 24 cards; the other linked items are "+N itens", exact, and their references are counted.
  await expect(view.locator('.react-flow__node-file')).toHaveCount(24);
  const toggle = view.locator('.folder-strip-toggle').first();
  await expect(toggle).toHaveText(/^\+37 itens · [\d.]+ referências não desenhadas$/);
  const hidden = Number(
    /· ([\d.]+) refer/.exec((await toggle.textContent())!)![1].replaceAll('.', ''),
  );
  const drawn = (await view
    .locator('g.folder-arrow')
    .evaluateAll((groups) =>
      groups.map((group) => Number(group.getAttribute('data-count'))),
    )) as number[];
  // The 23 folders of the map reference each other: 506 arrows in one column, which draws 16 at rest.
  // The line under the map counts the others; each is one reference here.
  await expect(view.locator('.folder-strip-undrawn')).toHaveText('490 setas não desenhadas');
  // The 60 references of lista stay inside it (on its line under the map).
  expect(drawn.reduce((a, b) => a + b, 0) + 490 + hidden + 60).toBe(written);
  await expect(view.locator('.canvas-caption > span:last-child')).toContainText(
    `${hidden.toLocaleString('pt-BR')} com itens fora do mapa`,
  );
  await toggle.click();
  await expect(
    view.locator('.folder-strip-line').first().locator('.folder-strip-item'),
  ).toHaveCount(37);

  // Legible inside the limit: cards apart, no arrow behind a card; crossings counted.
  const geometry = await routeProblems(view);
  expect(geometry.problems).toEqual([]);
  const rects = await view
    .locator('.react-flow__node-file')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  for (let a = 0; a < rects.length; a++)
    for (let b = a + 1; b < rects.length; b++)
      expect(
        rects[a].right <= rects[b].left ||
          rects[b].right <= rects[a].left ||
          rects[a].bottom <= rects[b].top ||
          rects[b].bottom <= rects[a].top,
      ).toBe(true);
  console.log(
    `${geometry.cards} cards, ${geometry.arrows} arrows, crossings between columns ${await view.locator('.folder-map').getAttribute('data-crossings')}`,
  );
  await page.screenshot({ path: test.info().outputPath('dense.png') });

  // A long list loads in pages.
  await view.locator(`.folder-strip-item[title="${join(root, 'lista')}"]`).click();
  await expect(view.locator('.canvas-caption > span').first()).toHaveText(
    'Referências somadas entre os itens de lista',
  );
  await view
    .getByRole('button', { name: '60 referências escritas de muitas.md para alvo.md' })
    .click();
  const list = view.getByRole('region', { name: 'Referências da seta' });
  await expect(list.locator('> div > button:not(.load-more)')).toHaveCount(50);
  await list.getByRole('button', { name: 'Mostrar mais 10 · faltam 10' }).click();
  await expect(list.locator('> div > button:not(.load-more)')).toHaveCount(60);
  await expect(list.locator('.load-more')).toHaveCount(0);
});

test('conventions, filters and trace beside the folder map; the Estrutura sums folders; nested projects count once', async ({
  page,
}) => {
  const lab = laboratory();
  const root = join(lab, 'aurora');
  const at = (relative: string) => join(root, relative);
  // Aurora and its nested project equipes/pesquisa, both open: the same sums.
  const view = await mapOf(page, [root, at('equipes/pesquisa')]);
  // compartilhado is not open here: its contract is outside the open projects, still one reference out.
  await expect(view.locator('.canvas-caption > span:last-child')).toHaveText(
    '18 itens · 42 referências (33 entre itens · 3 para fora · 6 dentro de pastas)',
  );
  await expect(card(view, at('equipes')).locator('.item-facts')).toHaveText(
    '2 arquivos · 1 interna',
  );

  // Convenções adds the convention relations to the sums (dashed when they are all there is).
  await page.getByRole('checkbox', { name: 'Convenções' }).check();
  await expect(view.locator('.canvas-caption > span:last-child')).toContainText('44 referências');
  await expect(arrow(view, at('AGENTS.md'), at('convencao'))).toHaveAttribute('data-count', '2');
  expect((await routeProblems(view)).problems).toEqual([]);
  await page.getByRole('checkbox', { name: 'Convenções' }).uncheck();
  await expect(view.locator('.canvas-caption > span:last-child')).toContainText('42 referências');

  // The trace opens beside and gives the folder map back when cleared.
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await page.getByLabel('Arquivo de origem A').fill(at('AGENTS.md'));
  await page.getByLabel('Arquivo de destino B').fill(at('memory/decisoes.md'));
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('.trace-summary')).toContainText('Caminho encontrado');
  // A state is said by its words: no check mark before them.
  await expect(page.locator('.trace-summary > svg')).toHaveCount(0);
  await page.locator('.trace-clear').click();
  await expect(view.locator('.folder-map')).toBeVisible();
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();

  // A filter highlights in its own box; the folder map stays.
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByLabel('Nome do filtro', { exact: true }).fill('Entrada');
  await page.getByLabel('Buscar arquivo para filtro').fill('AGENTS.md');
  await page.locator(`.filter-candidates button[title="${at('AGENTS.md')}"]`).click();
  await page.getByRole('button', { name: 'Salvar e destacar', exact: true }).click();
  await expect(
    page.locator('.workspace-pane[data-pane-id^="highlight:"] .filter-pane'),
  ).toBeVisible();
  // While the highlight is in front, the view waits in its tab; closing it gives the folder map back.
  await page.getByRole('button', { name: 'Fechar destaque Entrada' }).click();
  await expect(view.locator('.folder-map')).toBeVisible();

  // The folder rows of the Estrutura say what crosses each folder, in distinct files.
  await page.getByRole('button', { name: 'Estrutura de aurora', exact: true }).click();
  const structure = view.getByRole('region', { name: 'Estrutura de aurora' });
  const counts = async (name: string) =>
    (
      await structure
        .locator('.structure-row.is-folder', {
          has: page.locator('.structure-open', { hasText: new RegExp(`^${name}$`) }),
        })
        .locator('.structure-count > span[aria-hidden="true"]')
        .allTextContents()
    ).join(' ');
  const expected: Record<string, string> = {
    ciclos: '0 1',
    convencao: '0 1',
    documentos: '0 2',
    equipes: '0 1',
    fluxos: '1 2',
    hub: '0 1',
    invalido: '0 0',
    limites: '0 0',
    memory: '0 1',
    politicas: '0 0',
    skills: '0 2',
  };
  for (const [name, value] of Object.entries(expected))
    expect(await counts(name), name).toBe(value);
  await expect(
    structure
      .locator('.structure-row.is-folder', {
        has: page.locator('.structure-open', { hasText: /^fluxos$/ }),
      })
      .locator('.structure-count .visually-hidden'),
  ).toHaveText(['aponta para 1 arquivo fora da pasta', 'citado por 2 arquivos fora da pasta']);
});

test('both windows and themes, inspector open and closed: the columns fit or the map says part is out of view', async ({
  page,
}) => {
  const lab = laboratory();
  const root = join(lab, 'aurora');
  const view = await mapOf(page, [root]);
  for (const size of [
    { width: 1536, height: 960 },
    { width: 749, height: 396 },
  ])
    for (const inspector of [false, true])
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize(size);
        // The menu says what the inspector is: it offers the other state.
        await menuButton(page, 'Mais').click();
        const menu = page.getByRole('menu', { name: 'Mais' });
        const item = menu.getByRole('menuitem', {
          name: inspector ? 'Mostrar inspetor' : 'Recolher inspetor',
          exact: true,
        });
        if (await item.count()) await item.click();
        else await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        if ((await page.locator('html').getAttribute('data-theme')) !== theme)
          await runMoreAction(page, theme === 'light' ? 'Ativar tema claro' : 'Ativar tema escuro');
        await expect(view.locator('.folder-map')).toBeVisible();
        // No horizontal overflow of the page.
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          size.width,
        );
        // Either every card (the box of what leaves the folder included) is in the map's view, or the
        // corner offers to frame it all.
        const area = (await view.locator('.folder-map-area').boundingBox())!;
        await expect
          .poll(async () => {
            const rects = await view
              .locator('.react-flow__node-file, .react-flow__node-outside')
              .evaluateAll((elements) =>
                elements.map((element) => element.getBoundingClientRect().toJSON()),
              );
            const outside = rects.some(
              (rect) =>
                rect.left < area.x - 2 ||
                rect.top < area.y - 2 ||
                rect.right > area.x + area.width + 2 ||
                rect.bottom > area.y + area.height + 2,
            );
            const notice = await view.locator('.canvas-offscreen').count();
            return outside === notice > 0;
          })
          .toBe(true);
        await page.screenshot({
          path: test
            .info()
            .outputPath(
              `aurora-${size.width}x${size.height}-${theme}-${inspector ? 'inspector' : 'closed'}.png`,
            ),
        });
        const notice = view.locator('.canvas-offscreen');
        if (await notice.count()) {
          await notice.click();
          await expect
            .poll(async () =>
              (
                await view
                  .locator('.react-flow__node-file, .react-flow__node-outside')
                  .evaluateAll((elements) =>
                    elements.map((element) => element.getBoundingClientRect().toJSON()),
                  )
              ).every(
                (rect) =>
                  rect.left >= area.x - 2 &&
                  rect.top >= area.y - 2 &&
                  rect.right <= area.x + area.width + 2 &&
                  rect.bottom <= area.y + area.height + 2,
              ),
            )
            .toBe(true);
          await page.getByRole('button', { name: 'Estrutura de aurora', exact: true }).click();
          await page.getByRole('button', { name: 'Mapa de aurora', exact: true }).click();
        }
      }
});

test('an empty folder, a folder whose files are not read, and a partial reading', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-empty-')), 'vazios');
  writeTree(root, {
    'AGENTS.md': '# Vazios\n[Img](imagens/a.png)\n',
    'imagens/a.png': 'png',
    'imagens/b.py': 'print(1)\n',
  });
  mkdirSync(join(root, 'nada'));
  const view = await mapOf(page, [root]);
  // imagens is cited by AGENTS.md: a card; nada is an item without references.
  await view.locator(`.folder-strip-item[title="${join(root, 'nada')}"]`).click();
  await expect(view.locator('.folder-map-empty')).toHaveText(
    'Esta pasta não tem itens nesta leitura.',
  );
  await page.getByRole('button', { name: 'Voltar seleção' }).click();
  await card(view, join(root, 'imagens')).click();
  // Files not read: cards all the same, under the sentence; the reference of AGENTS.md reaches the map
  // in the box from outside.
  await expect(view.locator('.folder-lane')).toHaveText(
    'Nenhuma referência entre os itens desta pasta. Nenhum dos arquivos dela foi lido em busca de referências.',
  );
  await expect(view.locator('.react-flow__node-file .item-facts')).toHaveText([
    'não lido',
    'não lido',
  ]);
  await expect(view.locator('.folder-strip-item')).toHaveCount(0);
  await expect(view.locator('.inbound-group[data-kind="project"]')).toHaveText(
    'Em outro lugar deste projeto · 1../AGENTS.mdpara a.png',
  );
  await expect(view.locator('.canvas-caption > span:last-child')).toHaveText('2 itens · 1 de fora');

  // A reading cut by the inventory limit (served by a mocked API, as reader-limits.spec does).
  const fixture = '/tmp/aae-folder-partial-fixture';
  const node = (relative: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id: `${fixture}${relative ? `/${relative}` : ''}`,
    path: `${fixture}${relative ? `/${relative}` : ''}`,
    name: relative.split('/').at(-1) || 'parcial',
    relative: relative || '.',
    kind,
    status: 'resolved',
    root: fixture,
    roots: [fixture],
    ...extra,
  });
  const edge = (id: string, source: string, target: string) => ({
    id,
    source: `${fixture}/${source}`,
    target: `${fixture}/${target}`,
    kind: 'markdown',
    line: 2,
    evidence: `[x](${target})`,
    raw: target,
    origin: `${fixture}/${source}`,
    confidence: 'deterministic',
    resolvedBy: 'file',
  });
  const model = {
    savedCases: [{ path: fixture, name: 'parcial', available: true }],
    roots: [
      { path: fixture, name: 'parcial', parent: null, level: 0, entries: [`${fixture}/AGENTS.md`] },
    ],
    nodes: [
      node('', 'directory', { listing: 'complete' }),
      node('AGENTS.md', 'entry', { analysis: 'parsed', lines: 3 }),
      node('lida', 'directory', { listing: 'partial', omitted: 4 }),
      node('lida/a.md', 'file', { analysis: 'parsed', lines: 1 }),
      node('cortada', 'directory', { listing: 'unread', omitted: 2 }),
      { ...node('cortada/b.md', 'unresolved'), status: 'unscanned' },
    ],
    edges: [edge('e1', 'AGENTS.md', 'lida/a.md'), edge('e2', 'AGENTS.md', 'cortada/b.md')],
    objects: [],
    issues: [],
    signals: [],
    notes: {},
    expected: {},
    restoreErrors: [],
    delta: null,
    scope: { source: null, patterns: [] },
    stats: {
      files: 2,
      parsed: 2,
      edges: 2,
      entries: 1,
      inventory: {
        complete: false,
        lookupComplete: true,
        omitted: 6,
        omittedFiles: 6,
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
  await enterProject(page, 'parcial');
  await page
    .getByRole('button', { name: 'Mapa de aae-folder-partial-fixture', exact: true })
    .click();
  const partial = pane(page, fixture);
  await expect(partial.locator('.canvas-caption .folder-partial')).toHaveText(
    'Leitura parcial: as somas podem estar incompletas',
  );
  await expect(card(partial, `${fixture}/lida`).locator('.item-facts')).toHaveText(
    'lida em parte · 4 itens fora · 1 arquivo',
  );
  await expect(partial.locator('.outside-group[data-kind="unread"]')).toContainText('cortada/b.md');
  await expect(partial.locator(`.folder-strip-item[title="${fixture}/cortada"]`)).toHaveText(
    'cortada0 arquivos',
  );
});

test('the list of an arrow: Esc closes it and gives the focus back; each excerpt starts at its first character', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-excerpts-')), 'trechos');
  // Forty references from a.md to b.md, each in a table row much longer than the list is wide.
  const rows = Array.from(
    { length: 40 },
    (_, i) => `| ${i} | [Fonte ${i}](b.md) | ${'texto longo da linha '.repeat(20)}|\n`,
  );
  writeTree(root, { 'a.md': `# A\n${rows.join('')}`, 'b.md': '# B\n' });
  const view = await mapOf(page, [root]);
  const name = '40 referências escritas de a.md para b.md';
  const number = view.getByRole('button', { name, exact: true });
  await number.click();
  const list = view.getByRole('region', { name: 'Referências da seta' });
  await expect(list.locator('> div > button')).toHaveCount(40);
  const geometry = await list.evaluate((section) => {
    const paths = [...section.querySelectorAll(':scope > p')].map(
      (p) => p.getBoundingClientRect().height,
    );
    const span = section.querySelector<HTMLElement>('.evidence-excerpt')!;
    const box = span.getBoundingClientRect();
    const button = span.parentElement!.getBoundingClientRect();
    const text = span.firstChild!;
    const at = text.textContent!.indexOf('[Fonte 0](b.md)');
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + '[Fonte 0](b.md)'.length);
    const link = range.getBoundingClientRect();
    return {
      paths,
      start: span.textContent!.slice(0, 5),
      title: span.title === span.textContent,
      left: box.left - button.left,
      wide: span.scrollWidth - span.clientWidth,
      lines: Math.round(box.height / parseFloat(getComputedStyle(span).lineHeight)),
      linkInside:
        link.left >= box.left - 0.5 &&
        link.right <= box.right + 0.5 &&
        link.bottom <= box.bottom + 0.5,
    };
  });
  // The two paths under the title keep a whole line each (they were squashed to 1 px).
  for (const height of geometry.paths) expect(height).toBeGreaterThan(12);
  // The excerpt starts at its first character, at the left of its row, cut only after its third line,
  // with the written link in view and the whole text in the tooltip.
  expect(geometry.start).toBe('| 0 |');
  expect(geometry.left).toBeLessThan(8);
  expect(geometry.wide).toBeLessThanOrEqual(0);
  expect(geometry.lines).toBeLessThanOrEqual(3);
  expect(geometry.linkInside).toBe(true);
  expect(geometry.title).toBe(true);
  // Esc closes it and the focus is back on the number that opened it; Enter opens it again, × too.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(number).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: 'Fechar as referências da seta' }).click();
  await expect(list).toHaveCount(0);
  await expect(number).toBeFocused();
});

test.describe('in English', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the folder map speaks of references, never of loading, calling or depending', async ({
    page,
  }) => {
    // Without the suite's storage the line under the map starts folded; this test reads it open.
    await page.addInitScript(() => localStorage.setItem('aae-folder-strip', 'open'));
    const lab = laboratory();
    const root = join(lab, 'aurora');
    await openOnly(page, [root]);
    await page.goto('/');
    await enterProject(page, 'aurora');
    await page.getByRole('button', { name: 'Map of aurora', exact: true }).click();
    const view = pane(page, root);
    await expect(view.locator('.canvas-caption > span').first()).toHaveText(
      'Summed references between the items of aurora',
    );
    await expect(view.locator('.canvas-caption > span:last-child')).toHaveText(
      '18 items · 42 references (33 between items · 3 outside · 6 inside folders)',
    );
    await expect(view.locator('.folder-lane')).toHaveText([
      'Instructions of this folder',
      'Referenced directly',
      'Referenced in 2 steps',
      'Others that reference',
    ]);
    await expect(view.locator('.folder-strip-label')).toHaveText(
      'Not linked to other items of this folder',
    );
    await expect(arrow(view, join(root, 'hub.md'), join(root, 'hub')).locator('title')).toHaveText(
      '12 written references from hub.md to files of hub',
    );
    const text = (await view.locator('.folder-map').textContent()) ?? '';
    const titles = (await view.locator('g.folder-arrow title').allTextContents()).join(' ');
    for (const word of [/depend/i, /\bload/i, /\bcall/i]) {
      expect(text).not.toMatch(word);
      expect(titles).not.toMatch(word);
    }
    // ciclos: a.md and b.md cite each other, so neither starts "without being referenced".
    await card(view, join(root, 'ciclos')).click();
    await expect(view.locator('.canvas-caption > span').first()).toHaveText(
      'Summed references between the items of ciclos',
    );
    await expect(view.locator('.folder-lane')).toHaveText(['Reference and are referenced']);
  });
});
