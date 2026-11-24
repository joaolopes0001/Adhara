// The room of the map of a folder, measured on the screen: the boxes of the cards and of the numbers
// and the lines of the arrows are read from the page. Two folders made for this run: seven items with
// 23 arrows between them (five that all reference each other, two only referenced), and sixty folders
// that all reference each other. The same measures on the layout: tests/ui/folder-map-logic.spec.ts.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { enterProject, openOnly, writeTree } from './helpers';

/** A folder whose items reference each other: `[source, target, references]`; a folder item writes in its `index.md`. */
function summed(root: string, arrows: [string, string, number][], more: Record<string, string>) {
  const file = (name: string) => (name.includes('.') ? name : `${name}/index.md`);
  const files: Record<string, string> = {};
  for (const [source, target, count] of arrows) {
    const from = file(source),
      to = file(target);
    files[from] ??= `# ${source}\n`;
    files[to] ??= `# ${target}\n`;
    const link = relative(dirname(join(root, from)), join(root, to));
    for (let i = 0; i < count; i++) files[from] += `[${target} ${i}](${link})\n`;
  }
  writeTree(root, { ...files, ...more });
}

/** Shows the map of the root `root` in the only view. */
async function mapOf(page: Page, root: string) {
  await openOnly(page, [root]);
  await page.goto('/');
  const name = root.split('/').at(-1)!;
  await enterProject(page, name);
  await page.getByRole('button', { name: `Mapa de ${name}`, exact: true }).click();
  const map = page.locator('.folder-map');
  await expect(map.locator('.react-flow__node-file').first()).toBeVisible();
  // Until the framing stops.
  let last = '';
  await expect
    .poll(async () => {
      const now = await map
        .locator('.react-flow__viewport')
        .evaluate((element) => (element as HTMLElement).style.transform);
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  return map;
}

/**
 * In the page: the boxes that meet (numbers with numbers, numbers with cards, cards with cards), the
 * numbers that are not on the line of their own arrow, and the arrows drawn.
 */
const room = (map: Locator) =>
  map.evaluate((root) => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const meet = (a: Box, b: Box) =>
      a.left < b.right - 0.5 &&
      b.left < a.right - 0.5 &&
      a.top < b.bottom - 0.5 &&
      b.top < a.bottom - 0.5;
    const seen = (element: Element) => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && Number(style.opacity) > 0.5;
    };
    const cards = [
      ...root.querySelectorAll('.react-flow__node-file, .react-flow__node-outside'),
    ].map((element) => element.getBoundingClientRect());
    const numbers = [...root.querySelectorAll<HTMLElement>('.folder-arrow-count')]
      .filter(seen)
      .map((element) => ({ arrow: element.dataset.arrow!, box: element.getBoundingClientRect() }));
    const arrows = [...root.querySelectorAll<SVGGElement>('g.folder-arrow')];
    let numberNumber = 0,
      numberCard = 0,
      cardCard = 0,
      astray = 0;
    for (let a = 0; a < numbers.length; a++)
      for (let b = a + 1; b < numbers.length; b++)
        if (meet(numbers[a].box, numbers[b].box)) numberNumber++;
    for (const number of numbers) {
      numberCard += cards.filter((card) => meet(number.box, card)).length;
      // The line of its arrow passes through the box of the number.
      const group = arrows.find(
        (arrow) => `${arrow.dataset.source}>${arrow.dataset.target}` === number.arrow,
      );
      const path = group?.querySelector<SVGPathElement>('path.react-flow__edge-path');
      let through = false;
      if (path) {
        const length = path.getTotalLength(),
          matrix = path.getScreenCTM()!;
        for (let at = 0; at <= length && !through; at += 1) {
          const point = path.getPointAtLength(at);
          const { x, y } = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          through =
            x >= number.box.left - 1 &&
            x <= number.box.right + 1 &&
            y >= number.box.top - 1 &&
            y <= number.box.bottom + 1;
        }
      }
      if (!through) astray++;
    }
    for (let a = 0; a < cards.length; a++)
      for (let b = a + 1; b < cards.length; b++) if (meet(cards[a], cards[b])) cardCard++;
    return {
      cards: cards.length,
      numbers: numbers.length,
      arrows: arrows.length,
      numberNumber,
      numberCard,
      cardCard,
      astray,
    };
  });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: false, bottom: false }));
  });
});

test('23 arrows between seven items: no number over another number or over a card, in a wide and in a small window', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-room-')), 'workspace');
  summed(
    root,
    [
      ['agents', 'knowledge', 230],
      ['agents', 'operations', 36],
      ['agents', 'templates', 28],
      ['agents', 'README.md', 11],
      ['agents', 'standards', 48],
      ['agents', 'archive', 9],
      ['knowledge', 'agents', 6],
      ['knowledge', 'operations', 5],
      ['knowledge', 'templates', 4],
      ['knowledge', 'README.md', 2],
      ['knowledge', 'standards', 9],
      ['README.md', 'agents', 5],
      ['README.md', 'knowledge', 3],
      ['README.md', 'operations', 2],
      ['README.md', 'templates', 3],
      ['README.md', 'standards', 7],
      ['README.md', 'archive', 1],
      ['operations', 'agents', 10],
      ['operations', 'knowledge', 17],
      ['operations', 'templates', 6],
      ['operations', 'README.md', 2],
      ['operations', 'standards', 37],
      ['templates', 'knowledge', 1],
    ],
    // Two items without references with the others, and references that leave the folder.
    {
      'CHANGELOG.md': '# Changes\n',
      'scratch/a.md': '# A\n[B](b.md)\n',
      'scratch/b.md': '# B\n',
      'agents/away.md':
        '# Away\n' +
        Array.from({ length: 40 }, (_, i) => `[Gone ${i}](../missing/page-${i % 8}.md)\n`).join(''),
    },
  );
  for (const size of [
    { width: 1512, height: 694, arrows: 22, undrawn: '1 seta não desenhada' },
    { width: 749, height: 396, arrows: 18, undrawn: '5 setas não desenhadas' },
  ]) {
    await page.setViewportSize(size);
    const map = await mapOf(page, root);
    const found = await room(map);
    // 7 cards and the box of what leaves the folder. 17 loops between the five items share one
    // corridor, which draws 16 at rest (12 in the narrow map of the small window): the line under the
    // map counts the others.
    expect({ ...found, numbers: 0 }).toEqual({
      cards: 8,
      numbers: 0,
      arrows: size.arrows,
      numberNumber: 0,
      numberCard: 0,
      cardCard: 0,
      astray: 0,
    });
    await expect(map.locator('.folder-strip-undrawn:not(.folder-strip-quiet)')).toHaveText(
      size.undrawn,
    );
    // A number for each arrow drawn with more than one reference, but those the line counts as waiting.
    const counts = await map
      .locator('g.folder-arrow')
      .evaluateAll((groups) => groups.map((group) => Number(group.getAttribute('data-count'))));
    const quiet = Number(
      /\d+/.exec((await map.locator('.folder-strip-quiet').allTextContents()).join(''))?.[0] ?? 0,
    );
    expect(found.numbers).toBe(counts.filter((count) => count > 1).length - quiet);
    if (!quiet)
      await expect(map.locator('.folder-strip-legend')).toHaveText('Seta sem número: 1 referência');
    else await expect(map.locator('.folder-strip-legend')).toHaveCount(0);
    // The pointer on a card shows its 5 arrows, the one that waits included, and their 4 numbers
    // (templates → knowledge has one reference), apart from each other and from the lines.
    if (size.width < 1000) await map.getByRole('button', { name: /^Enquadrar/ }).click();
    await map.locator('.react-flow__node-file', { hasText: 'templates' }).hover();
    await expect.poll(async () => (await room(map)).numbers).toBe(4);
    const focus = await room(map);
    expect([focus.numberNumber, focus.numberCard, focus.astray]).toEqual([0, 0, 0]);
    await page.mouse.move(2, 2);
    await expect.poll(async () => (await room(map)).numbers).toBe(found.numbers);
    // Nothing with text lies over the map but its cards and numbers: the credit is in the legend.
    await expect(map.locator('.react-flow__attribution')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`seven-items-${size.width}x${size.height}.png`),
    });
  }
  // The pointer on a card: its arrows stay, the others step back; out of it, all come back.
  await page.setViewportSize({ width: 1512, height: 694 });
  const map = await mapOf(page, root);
  const edges = map.locator('.react-flow__edge');
  await map.locator('.react-flow__node-file', { hasText: 'templates' }).hover();
  // templates: referenced by agents, knowledge, README.md and operations; references knowledge.
  await expect(edges.locator('xpath=self::*[contains(@class,"lit")]')).toHaveCount(5);
  await expect(edges.locator('xpath=self::*[contains(@class,"faded")]')).toHaveCount(18);
  await page.mouse.move(2, 2);
  await expect(edges.locator('xpath=self::*[contains(@class,"faded")]')).toHaveCount(0);
  // The legend says what the width of an arrow is and names the library that draws the map.
  await map.locator('.canvas-legend summary').click();
  await expect(map.locator('.canvas-legend > div > small')).toHaveText(
    'Seta mais grossa: mais referências',
  );
  await expect(map.locator('.canvas-legend > div > a')).toHaveText('React Flow');
});

test('sixty folders that all reference each other: cards apart, the arrows counted at rest and drawn for the card in focus', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-room-')), 'dense');
  const folders = Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  const files: Record<string, string> = {
    'AGENTS.md': '# Dense\n[D0](d00/x.md)\n[D1](d01/x.md)\n[D2](d02/x.md)\n',
  };
  for (const folder of folders)
    files[`${folder}/x.md`] =
      `# ${folder}\n` +
      folders
        .filter((other) => other !== folder)
        // Two references to each of the next three folders: numbers on some arrows.
        .map((other, i) => `[${other}](../${other}/x.md)\n`.repeat(i < 3 ? 2 : 1))
        .join('');
  writeTree(root, files);
  const map = await mapOf(page, root);
  const rest = await room(map);
  expect(rest.cards).toBe(24);
  expect([rest.numberNumber, rest.numberCard, rest.cardCard, rest.astray]).toEqual([0, 0, 0, 0]);
  // 23 folders in one column reference each other: 506 arrows; the corridor draws the 16 with the
  // most references at rest (each has one or two), the line under the map counts the others.
  await expect(map.locator('.folder-strip-undrawn')).toHaveText('490 setas não desenhadas');
  expect(rest.arrows).toBe(16 + 3);
  // The pointer on a folder lights its 22 arrows out and its 22 arrows in, numbers apart.
  const folder = map.locator('.react-flow__node-file', {
    has: page.locator('strong', { hasText: /^d05$/ }),
  });
  const lit = map.locator('.react-flow__edge.lit');
  await folder.hover();
  await expect(lit).toHaveCount(44);
  const focus = await room(map);
  expect(focus.numbers).toBeGreaterThan(0);
  expect([focus.numberNumber, focus.numberCard, focus.cardCard, focus.astray]).toEqual([
    0, 0, 0, 0,
  ]);
  await page.screenshot({ path: test.info().outputPath('dense-focus.png') });
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await room(map)).arrows).toBe(rest.arrows);
  await expect(lit).toHaveCount(0);
  // The keyboard focus does the same.
  await folder.focus();
  await expect(lit).toHaveCount(44);
});

test('the card with the keyboard focus has a ring, and stays the focus of the map when the pointer passes over another card', async ({
  page,
}) => {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-room-')), 'keys');
  summed(
    root,
    [
      ['AGENTS.md', 'a.md', 3],
      ['AGENTS.md', 'b.md', 2],
      ['a.md', 'c.md', 4],
      ['b.md', 'c.md', 1],
    ],
    {},
  );
  const map = await mapOf(page, root);
  const card = (name: string) => map.locator('.react-flow__node-file', { hasText: name });
  const lit = map.locator('.react-flow__edge.lit');
  await card('a.md').focus();
  await page.keyboard.press('Shift');
  // a.md: referenced by AGENTS.md, references c.md.
  await expect(lit).toHaveCount(2);
  expect(
    await card('a.md').evaluate((element) => ({
      visible: element.matches(':focus-visible'),
      outline: getComputedStyle(element).outlineStyle,
    })),
  ).toEqual({ visible: true, outline: 'solid' });
  // The pointer on b.md: its arrows; out of the map, a.md again.
  await card('b.md').hover();
  await expect(lit).toHaveCount(2);
  await expect(
    map.locator('.react-flow__edge.lit g.folder-arrow[data-source$="/b.md"]'),
  ).toHaveCount(1);
  await page.mouse.move(2, 2);
  await expect(lit).toHaveCount(2);
  await expect(
    map.locator('.react-flow__edge.lit g.folder-arrow[data-source$="/a.md"]'),
  ).toHaveCount(1);
  // Out of the card, nothing is in focus.
  await page.keyboard.press('Escape');
  await map.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await expect(lit).toHaveCount(0);
});

/**
 * The map of a folder of two columns with a corridor of loops at the left (wider than half of the
 * window), in a view beside the view of a second project, once the framing stops.
 */
async function besideMap(page: Page, viewport: { width: number; height: number }) {
  const base = mkdtempSync(join(tmpdir(), 'aae-folder-room-'));
  const root = join(base, 'wide');
  const files = Array.from({ length: 6 }, (_, i) => `step-${i}.md`);
  summed(
    root,
    files.flatMap((file, i): [string, string, number][] => [
      [file, files[(i + 1) % files.length], 2 + i],
      [file, files[(i + 3) % files.length], 1],
      [file, 'tools', 1 + i],
    ]),
    {},
  );
  const side = join(base, 'side');
  writeTree(side, { 'AGENTS.md': '# Side\n[Note](note.md)\n', 'note.md': '# Note\n' });
  await page.setViewportSize(viewport);
  await openOnly(page, [root, side]);
  await page.goto('/');
  await enterProject(page, 'wide');
  // Entering a project leaves the view of the other one in the strip: back beside it.
  await page.locator('.workspace-view-strip .workspace-view-tab.is-minimized').click();
  await expect(page.locator('.scope-pane:visible')).toHaveCount(2);
  await page.getByRole('button', { name: 'Mapa de wide', exact: true }).click();
  const map = page.locator('.folder-map');
  await expect(map.locator('.react-flow__node-file').first()).toBeVisible();
  let last = '';
  await expect
    .poll(async () => {
      const now = await map
        .locator('.react-flow__viewport')
        .evaluate((element) => (element as HTMLElement).style.transform);
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  return map;
}
const zoomOf = (map: Locator) =>
  map
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
/** The size, in px of the screen, of the smallest text of a card: CSS size × zoom × device pixel ratio. */
const smallestOnScreen = async (map: Locator) =>
  (await map
    .locator('.react-flow__node-file .tile-foot')
    .first()
    .evaluate(
      (element) => parseFloat(getComputedStyle(element).fontSize) * window.devicePixelRatio,
    )) * (await zoomOf(map));

test('two views on a screen without scaling: the map of a folder opens at 100%, where the text of its cards keeps 11 px of the screen, and says what is out of view', async ({
  page,
}) => {
  const map = await besideMap(page, { width: 1512, height: 671 });
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  expect(await zoomOf(map)).toBe(1);
  expect(await smallestOnScreen(map)).toBe(11);
  // The map is wider than its view: the header line says part of it is out of view, and a click
  // there frames it all, smaller.
  await expect(map.locator('.canvas-offscreen')).toHaveCount(1);
  await map.locator('.canvas-offscreen').click();
  await expect.poll(() => zoomOf(map)).toBeLessThan(1);
});

test.describe('a screen scaled to 125%', () => {
  test.use({ deviceScaleFactor: 1.25 });

  test('two views: the map of a folder opens below 100%, never below the zoom where the text of its cards keeps 11 px of the screen, and its second column is in view', async ({
    page,
  }) => {
    const map = await besideMap(page, { width: 1512, height: 671 });
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.25);
    // The floor is 11 / (11 × 1.25) = 0.8; the columns fit above it, so the framing fits them.
    const zoom = await zoomOf(map);
    expect(zoom).toBeGreaterThanOrEqual(0.8);
    expect(zoom).toBeLessThan(1);
    expect(await smallestOnScreen(map)).toBeGreaterThanOrEqual(11);
    const area = (await map.locator('.folder-map-area').boundingBox())!;
    const tools = (await map
      .locator('.react-flow__node-file', { has: page.locator('strong', { hasText: /^tools$/ }) })
      .boundingBox())!;
    expect(tools.x + tools.width).toBeLessThanOrEqual(area.x + area.width);
    await expect(map.locator('.canvas-offscreen')).toHaveCount(0);
  });
});

for (const scale of [1, 1.25])
  test.describe(`a screen at scale ${scale}`, () => {
    test.use({ deviceScaleFactor: scale });

    test(`two views in a compact window: the map of a folder much wider than its view opens at the floor, 11 px of the screen (scale ${scale})`, async ({
      page,
    }) => {
      const map = await besideMap(page, { width: 749, height: 396 });
      // 100% without scaling, never more; 80% at 125% (a hair above: the library rounds the margin of
      // the framing down to whole px).
      const floor = Math.min(1, 1 / scale);
      const zoom = await zoomOf(map);
      expect(zoom).toBeGreaterThanOrEqual(floor);
      expect(zoom).toBeLessThan(floor + 0.01);
      if (scale === 1) expect(zoom).toBe(1);
      const onScreen = await smallestOnScreen(map);
      expect(onScreen).toBeGreaterThanOrEqual(11);
      expect(onScreen).toBeLessThan(11.15);
      await expect(map.locator('.canvas-offscreen')).toHaveCount(1);
    });
  });

test('a small window frames every column, also when the second one starts far down', async ({
  page,
}) => {
  // Eight files in a cycle fill the first column; the folder they all reference sits beside its middle,
  // below what a low window shows of the first rows.
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-room-')), 'cycle');
  const files = Array.from({ length: 8 }, (_, i) => `step-${i}.md`);
  summed(
    root,
    files.flatMap((file, i): [string, string, number][] => [
      [file, files[(i + 1) % files.length], 2],
      [file, 'tools', 1 + i],
    ]),
    {},
  );
  await page.setViewportSize({ width: 749, height: 396 });
  const map = await mapOf(page, root);
  const area = (await map.locator('.folder-map-area').boundingBox())!;
  const title = (await map.locator('.react-flow__node-lane[data-id="lane:1"]').boundingBox())!;
  // The title of the second column and the place of its cards are inside the area, left and right.
  const zoom = await map
    .locator('.react-flow__viewport')
    .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  expect(title.x).toBeGreaterThanOrEqual(area.x);
  expect(title.x + 216 * zoom).toBeLessThanOrEqual(area.x + area.width + 1);
  // Its card is below the rows in view: the header line says part of the map is out of view.
  await expect(map.locator('.canvas-offscreen')).toHaveCount(1);
  const found = await room(map);
  expect([found.numberNumber, found.numberCard, found.cardCard, found.astray]).toEqual([
    0, 0, 0, 0,
  ]);
});
