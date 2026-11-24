// The map of a folder as pure functions (src/folderMap.ts): sums, columns, routes, limits and cost.
// Each expectation below was worked out by hand from the fixture before running the code.
import { expect, test } from '@playwright/test';
import {
  ARROW_HEAD,
  FOLDER_MAP_LIMIT,
  GRID_ROWS,
  folderArrowFocus,
  folderBoundary,
  folderFocus,
  folderLayers,
  folderLayout,
  folderSums,
  inboundBoxHeight,
  NARROW,
  relativeTo,
  WIDE,
} from '../../src/folderMap';
import type { CardPlace, FolderArrow, FolderLayout } from '../../src/folderMap';
import type { FileNode, Model, Relation } from '../../src/types';
import { randomCase, stressCases } from './folder-map-cases';
import type { FolderCase } from './folder-map-cases';

const node = (path: string, kind = 'file', status = 'resolved', root = '/r'): FileNode => ({
  id: path,
  path,
  name: path.split('/').at(-1)!,
  relative: path,
  kind,
  status,
  root,
  roots: [root],
  analysis: kind === 'file' || kind === 'entry' ? 'parsed' : undefined,
});
let line = 0;
const edge = (source: string, target: string, kind = 'markdown'): Relation => ({
  id: `${source}>${target}#${++line}`,
  source,
  target,
  kind,
  line,
  origin: source,
  raw: target,
  evidence: target,
  confidence: 'deterministic',
  resolvedBy: 'file',
});
const model = (nodes: FileNode[], edges: Relation[], roots = ['/r']): Model =>
  ({
    nodes,
    edges,
    roots: roots.map((path) => ({
      path,
      name: path.split('/').at(-1)!,
      parent: null,
      level: 0,
      entries: [],
    })),
    savedCases: [],
    objects: [],
    issues: [],
    signals: [],
    scope: { source: null, patterns: [] },
    notes: {},
    expected: {},
    restoreErrors: [],
    delta: null,
    stats: { files: nodes.length, parsed: nodes.length, edges: edges.length } as Model['stats'],
    policy: { excluded: [], maxNodes: 20000, maxFileBytes: 1, maxTextBytes: 1, ai: false },
  }) as unknown as Model;

/** The fixture of the sums: a folder with instructions, folders with inner references and outside ones. */
function fixture() {
  const nodes = [
    node('/r', 'directory'),
    node('/r/AGENTS.md', 'entry'),
    node('/r/docs', 'directory'),
    node('/r/docs/a.md'),
    node('/r/docs/b.md'),
    node('/r/docs/sub', 'directory'),
    node('/r/docs/sub/c.md'),
    node('/r/notes.md'),
    node('/r/lonely', 'directory'),
    node('/r/lonely/x.md'),
    { ...node('/r/img.png'), analysis: undefined },
    node('/r/missing.md', 'unresolved', 'missing'),
    node('/other', 'directory', 'resolved', '/other'),
    node('/other/x.md', 'file', 'resolved', '/other'),
    node('/outside/y.md', 'unresolved', 'external', null as unknown as string),
  ];
  const edges = [
    edge('/r/AGENTS.md', '/r/docs/a.md'), // 1 → docs
    edge('/r/AGENTS.md', '/r/docs/sub/c.md'), // 2 → docs (deeper)
    edge('/r/AGENTS.md', '/r/notes.md'), // 3
    edge('/r/AGENTS.md', '/r/notes.md'), // 4
    edge('/r/docs/a.md', '/r/docs/b.md'), // 5 inside docs
    edge('/r/docs/b.md', '/r/notes.md'), // 6
    edge('/r/notes.md', '/r/notes.md'), // 7 a file to itself
    edge('/r/AGENTS.md', '/r'), // 8 the folder itself
    edge('/r/AGENTS.md', '/r/missing.md'), // 9 missing
    edge('/r/docs/a.md', '/other/x.md'), // 10 another open project
    edge('/r/lonely/x.md', '/r/lonely'), // 11 inside lonely (its own folder as a node)
    edge('/r/AGENTS.md', '/r/docs/sub/c.md', 'scope'), // 12 convention
    edge('/outside/y.md', '/r/AGENTS.md'), // 13 starts outside: not a reference of /r
  ];
  return model(nodes, edges, ['/r', '/other']);
}

test('folder map sums: items, summed arrows, internal and outside references add up to every written one', () => {
  const sums = folderSums(fixture(), '/r', false);
  expect(sums.items.map((item) => item.id)).toEqual([
    '/r/docs',
    '/r/lonely',
    '/r/AGENTS.md',
    '/r/img.png',
    '/r/notes.md',
  ]);
  const item = (id: string) => sums.items.find((entry) => entry.id === id)!;
  expect(item('/r/docs')).toMatchObject({ files: 3, internal: 1, incoming: 2, outgoing: 1 });
  expect(item('/r/lonely')).toMatchObject({ files: 1, internal: 1, incoming: 0, outgoing: 0 });
  expect(item('/r/notes.md')).toMatchObject({ internal: 1, selfReferences: 1, incoming: 3 });
  expect(item('/r/AGENTS.md')).toMatchObject({ outgoing: 4, internal: 0 });
  expect(sums.arrows.map((a) => [a.source, a.target, a.relations.length])).toEqual([
    ['/r/docs', '/r/notes.md', 1],
    ['/r/AGENTS.md', '/r/docs', 2],
    ['/r/AGENTS.md', '/r/notes.md', 2],
  ]);
  expect(
    sums.outside.map((g) => [g.kind, g.relations.length, g.targets.map((t) => t.label), g.sources]),
  ).toEqual([
    ['self', 1, [], ['/r/AGENTS.md']],
    ['other-project', 1, ['other/x.md'], ['/r/docs']],
    ['missing', 1, ['missing.md'], ['/r/AGENTS.md']],
  ]);
  expect(sums.totals).toEqual({
    written: 11,
    between: 5,
    outside: 3,
    internal: 3,
    selfReferences: 1,
    // The reference from /outside/y.md starts at a placeholder, not at a file of the reading.
    inbound: 0,
  });
  // Conventions on: the convention joins the arrow it shares, and the total.
  const withConventions = folderSums(fixture(), '/r', true);
  expect(withConventions.totals.written).toBe(12);
  const toDocs = withConventions.arrows.find((a) => a.target === '/r/docs')!;
  expect(toDocs.relations).toHaveLength(3);
  expect(toDocs.conventions).toBe(false);
});

test('folder map sums: a subfolder sends its parent and its project to the outside box, with paths seen from it', () => {
  const sums = folderSums(
    (() => {
      const m = fixture();
      m.edges.push(edge('/r/docs/b.md', '/r/AGENTS.md'), edge('/r/docs/b.md', '/r/docs'));
      return m;
    })(),
    '/r/docs',
    false,
  );
  expect(sums.items.map((item) => item.id)).toEqual([
    '/r/docs/sub',
    '/r/docs/a.md',
    '/r/docs/b.md',
  ]);
  expect(sums.outside.map((g) => [g.kind, g.targets.map((t) => t.label)])).toEqual([
    ['self', []],
    ['project', ['../AGENTS.md', '../notes.md']],
    ['other-project', ['other/x.md']],
  ]);
  expect(relativeTo('/r/docs', '/r/AGENTS.md')).toBe('../AGENTS.md');
  expect(relativeTo('/r', '/r/docs/a.md')).toBe('docs/a.md');
  expect(relativeTo('/r/docs', '/r/docs')).toBe('.');
});

test('folder map sums: kept per reading, computed again only for another reading', () => {
  const m = fixture();
  expect(folderSums(m, '/r', false)).toBe(folderSums(m, '/r', false));
  expect(folderLayout(m, '/r', false)).toBe(folderLayout(m, '/r', false));
  expect(folderSums(fixture(), '/r', false)).not.toBe(folderSums(m, '/r', false));
});

test('folder map columns: instructions first, what they reference next, cycles share a column, nothing goes left', () => {
  const layers = (ids: string[], arrows: [string, string][], entries: string[] = []) =>
    Object.fromEntries(
      folderLayers(
        ids,
        arrows.map(([source, target]) => ({ source, target })),
        new Set(entries),
      ),
    );
  // E references A; A and B reference each other; B references C.
  expect(
    layers(
      ['E', 'A', 'B', 'C'],
      [
        ['E', 'A'],
        ['A', 'B'],
        ['B', 'A'],
        ['B', 'C'],
      ],
      ['E'],
    ),
  ).toEqual({
    E: 0,
    A: 1,
    B: 1,
    C: 2,
  });
  // An item that references the instructions back joins their column.
  expect(
    layers(
      ['E', 'X', 'Y'],
      [
        ['E', 'X'],
        ['X', 'E'],
        ['E', 'Y'],
      ],
      ['E'],
    ),
  ).toEqual({ E: 0, X: 0, Y: 1 });
  // No instructions: who references without being referenced starts; a cycle alone starts too.
  expect(
    layers(
      ['S', 'A', 'P', 'Q'],
      [
        ['S', 'A'],
        ['P', 'Q'],
        ['Q', 'P'],
      ],
    ),
  ).toEqual({
    S: 0,
    A: 1,
    P: 0,
    Q: 0,
  });
  // Z is referenced directly by E and by W, two steps away: it goes to W's column, the arrow E → Z skips one.
  expect(
    layers(
      ['E', 'Y', 'W', 'Z'],
      [
        ['E', 'Y'],
        ['Y', 'W'],
        ['W', 'Z'],
        ['E', 'Z'],
      ],
      ['E'],
    ),
  ).toEqual({
    E: 0,
    Y: 1,
    W: 2,
    Z: 2,
  });
  // Something that only references the instructions starts with them.
  expect(
    layers(
      ['E', 'R', 'A'],
      [
        ['R', 'E'],
        ['E', 'A'],
      ],
      ['E'],
    ),
  ).toEqual({ E: 0, R: 0, A: 1 });
});

test('folder map column titles: a title says only what is true of every card of its column', () => {
  /** The titles of the folder /t made of these files and arrows (one reference each unless repeated). */
  const titles = (
    files: string[],
    arrows: [string, string][],
    { entry = '', limit = FOLDER_MAP_LIMIT }: { entry?: string; limit?: number } = {},
  ) => {
    const nodes = [
      node('/t', 'directory'),
      ...files.map((id) => node(`/t/${id}.md`, id === entry ? 'entry' : 'file')),
    ];
    const layout = folderLayout(
      model(
        nodes,
        arrows.map(([a, b]) => edge(`/t/${a}.md`, `/t/${b}.md`)),
        ['/t'],
      ),
      '/t',
      false,
      WIDE,
      limit,
    );
    return {
      columns: layout.columns.map((c) =>
        c.kind === 'range'
          ? `range ${c.steps}-${c.upTo}`
          : c.kind === 'steps'
            ? `steps ${c.steps}`
            : c.kind,
      ),
      others: layout.others,
      shown: layout.shown.map((id) => id.slice(3, -3)).sort(),
    };
  };
  // Negative: no cycle, no instructions; nobody references S and P, A is one step away.
  expect(
    titles(
      ['S', 'P', 'A'],
      [
        ['S', 'A'],
        ['P', 'A'],
      ],
    ).columns,
  ).toEqual(['sources', 'direct']);
  // A cycle alone: each one references and is referenced, so "without being referenced" would lie.
  expect(
    titles(
      ['A', 'B'],
      [
        ['A', 'B'],
        ['B', 'A'],
      ],
    ).columns,
  ).toEqual(['both']);
  // The cycle leads on: C is one step from B.
  expect(
    titles(
      ['A', 'B', 'C'],
      [
        ['A', 'B'],
        ['B', 'A'],
        ['B', 'C'],
      ],
    ).columns,
  ).toEqual(['both', 'direct']);
  // A source beside a cycle: all they share is that each references.
  expect(
    titles(
      ['S', 'P', 'Q', 'A'],
      [
        ['S', 'A'],
        ['P', 'Q'],
        ['Q', 'P'],
      ],
    ).columns,
  ).toEqual(['referencing', 'direct']);
  // With instructions: 2 steps for every card of column 2, 1 for column 1.
  expect(
    titles(
      ['E', 'Y', 'W'],
      [
        ['E', 'Y'],
        ['Y', 'W'],
      ],
      { entry: 'E' },
    ).columns,
  ).toEqual(['entries', 'direct', 'steps 2']);
  // A cycle in column 1: B is reached from E through A.
  expect(
    titles(
      ['E', 'A', 'B'],
      [
        ['E', 'A'],
        ['A', 'B'],
        ['B', 'A'],
      ],
      { entry: 'E' },
    ).columns,
  ).toEqual(['entries', 'range 1-2']);
  // Over the limit: X is referenced only by items left out, so it starts the map referencing nothing.
  const omitted = (extra: [string, string][], files: string[]) =>
    titles(['X', 'Y1', 'Y2', 'Y3', ...files], [['Y1', 'X'], ['Y2', 'X'], ['Y3', 'X'], ...extra], {
      limit: 3,
    });
  // Beside a pair that cites each other, all that holds is that each card is referenced.
  const pair = omitted(
    [
      ['P', 'Q'],
      ['P', 'Q'],
      ['Q', 'P'],
      ['Q', 'P'],
    ],
    ['P', 'Q'],
  );
  expect(pair.shown).toEqual(['P', 'Q', 'X']);
  expect(pair.columns).toEqual(['referenced']);
  // Beside a source, nothing holds for both: no title.
  const source = omitted(
    [
      ['S', 'T'],
      ['S', 'T'],
    ],
    ['S', 'T'],
  );
  expect(source.shown).toEqual(['S', 'T', 'X']);
  expect(source.columns).toEqual(['none', 'direct']);
  // With instructions, the label above the others says they reference only when each one does.
  const others = titles(
    ['E', 'A', 'X', 'Y1', 'Y2', 'Y3'],
    [
      ['E', 'A'],
      ['E', 'A'],
      ['Y1', 'X'],
      ['Y2', 'X'],
      ['Y3', 'X'],
    ],
    { entry: 'E', limit: 3 },
  );
  expect(others.shown).toEqual(['A', 'E', 'X']);
  expect(others.others).toMatchObject({ referencing: false });
  expect(
    titles(
      ['E', 'R', 'A'],
      [
        ['R', 'E'],
        ['E', 'A'],
      ],
      { entry: 'E' },
    ).others,
  ).toMatchObject({
    referencing: true,
  });
});

/** Points of an SVG path made of M, L, Q and C commands (the shapes the layout writes). */
function samples(d: string, step = 2) {
  const tokens = d.match(/[MCLQ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g)!;
  const points: { x: number; y: number }[] = [];
  let x = 0,
    y = 0;
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++];
    const read = () => [Number(tokens[i++]), Number(tokens[i++])];
    if (command === 'M') {
      [x, y] = read();
      points.push({ x, y });
    } else if (command === 'L') {
      const [x2, y2] = read();
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x, y2 - y) / step));
      for (let k = 1; k <= n; k++)
        points.push({ x: x + ((x2 - x) * k) / n, y: y + ((y2 - y) * k) / n });
      [x, y] = [x2, y2];
    } else if (command === 'Q') {
      const [x1, y1] = read(),
        [x2, y2] = read();
      for (let k = 1; k <= 8; k++) {
        const t = k / 8,
          u = 1 - t;
        points.push({
          x: u * u * x + 2 * u * t * x1 + t * t * x2,
          y: u * u * y + 2 * u * t * y1 + t * t * y2,
        });
      }
      [x, y] = [x2, y2];
    } else {
      const [x1, y1] = read(),
        [x2, y2] = read(),
        [x3, y3] = read();
      for (let k = 1; k <= 80; k++) {
        const t = k / 80,
          u = 1 - t;
        points.push({
          x: u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          y: u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        });
      }
      [x, y] = [x3, y3];
    }
  }
  return points;
}

/** On the layout: no route enters a card other than its two ends; no route goes to a column on the left. */
function checkRoutes(layout: FolderLayout) {
  const { cardWidth } = layout.geometry;
  const column = new Map(layout.cards.map((card) => [card.id, card.column]));
  const problems: string[] = [];
  const boxes = [
    ...layout.cards.map((card) => ({
      id: card.id,
      x: card.x,
      y: card.y,
      w: cardWidth,
      h: card.height,
    })),
    ...(
      [
        ['outside', layout.outsideBox],
        ['inbound', layout.inboundBox],
      ] as const
    ).flatMap(([id, box]) => (box ? [{ id, ...box, w: box.width, h: box.height }] : [])),
  ];
  for (const route of layout.routes) {
    if (column.get(route.arrow.target)! < column.get(route.arrow.source)!)
      problems.push(`${route.arrow.id} goes left`);
    const points = samples(route.d);
    for (const box of boxes) {
      if (box.id === route.arrow.source || box.id === route.arrow.target) continue;
      if (
        points.some(
          (point) =>
            point.x > box.x + 0.5 &&
            point.x < box.x + box.w - 0.5 &&
            point.y > box.y + 0.5 &&
            point.y < box.y + box.h - 0.5,
        )
      )
        problems.push(`${route.arrow.id} crosses ${box.id}`);
    }
  }
  // Cards never overlap each other nor the outside box.
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++)
      if (
        !(
          boxes[a].x + boxes[a].w <= boxes[b].x ||
          boxes[b].x + boxes[b].w <= boxes[a].x ||
          boxes[a].y + boxes[a].h <= boxes[b].y ||
          boxes[b].y + boxes[b].h <= boxes[a].y
        )
      )
        problems.push(`${boxes[a].id} overlaps ${boxes[b].id}`);
  expect(problems).toEqual([]);
}

test('folder map layout: arrows to the next column, across a column, inside a column and in a cycle never cross a card', () => {
  const ids = ['E', 'Y', 'W', 'Z', 'A', 'B', 'K', 'L', 'M'];
  const nodes = [
    node('/f', 'directory'),
    ...ids.map((id) => node(`/f/${id}.md`, id === 'E' ? 'entry' : 'file')),
  ];
  const p = (id: string) => `/f/${id}.md`;
  const edges = [
    ['E', 'Y'],
    ['Y', 'W'],
    ['W', 'Z'],
    ['E', 'Z'], // skips the column of Y
    ['E', 'A'],
    ['A', 'B'],
    ['B', 'A'], // a cycle: A and B share a column
    ['E', 'K'],
    ['E', 'L'],
    ['K', 'L'], // same column
    ['E', 'M'],
    ['M', 'E'], // back to the instructions: M joins column 0
  ].map(([a, b]) => edge(p(a), p(b)));
  edges.push(edge(p('E'), '/f/gone.md'));
  nodes.push(node('/f/gone.md', 'unresolved', 'missing', '/f'));
  const m = model(nodes, edges, ['/f']);
  for (const geometry of [WIDE, NARROW]) {
    const layout = folderLayout(m, '/f', false, geometry);
    const columnOf = Object.fromEntries(
      layout.cards.map((card) => [card.id.slice(3, -3), card.column]),
    );
    expect(columnOf).toEqual({ E: 0, M: 0, Y: 1, A: 1, B: 1, K: 1, L: 1, W: 2, Z: 2 });
    expect(
      layout.routes.find((r) => r.arrow.source === p('E') && r.arrow.target === p('Z'))!.shape,
    ).toBe('skip');
    expect(layout.routes.find((r) => r.arrow.source === p('A'))!.shape).toBe('same');
    expect(layout.routes.find((r) => r.arrow.source === p('M'))!.shape).toBe('same');
    // The two arrows of the cycle are two routes, apart.
    const ab = layout.routes.find((r) => r.arrow.source === p('A'))!;
    const ba = layout.routes.find((r) => r.arrow.source === p('B'))!;
    expect(ab.d).not.toBe(ba.d);
    expect(space(layout).along).toBe(0);
    // One reference: no number.
    expect(ab.label).toBeNull();
    expect(layout.outsideBox).not.toBeNull();
    // The titles say only what holds for every card: B is reached from E through A (2 steps) though
    // it shares column 1 with what E references; Z, referenced by E, is pushed to W's column (2 steps).
    expect(layout.columns.map((c) => [c.kind, c.steps, c.upTo])).toEqual([
      ['entries', 0, 0],
      ['range', 1, 2],
      ['range', 1, 2],
    ]);
    expect(layout.others).toMatchObject({ referencing: true });
    checkRoutes(layout);
  }
});

/**
 * The room of a drawing, measured on the layout as tests/ui/folder-map-space.spec.ts measures it on the
 * screen: boxes that meet (numbers, cards), how far a number is from its own arrow, numbers over the
 * line of another arrow, and the share of the length of the arrows that runs less than 3 px from
 * another one (`near`) and, of that, in its direction (`along`: the two share a line).
 */
function space(
  layout: FolderLayout,
  routes = layout.routes,
  numbers = restNumbers(routes),
  /** Routes that share their lines on purpose (those drawn only in focus): not counted in `along`. */
  shared = new Set<string>(),
) {
  type Box = { id: string; left: number; top: number; right: number; bottom: number };
  const meet = (a: Box, b: Box) =>
    a.left < b.right - 0.5 &&
    b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 &&
    b.top < a.bottom - 0.5;
  const cards: Box[] = layout.cards.map((card) => ({
    id: card.id,
    left: card.x,
    top: card.y,
    right: card.x + layout.geometry.cardWidth,
    bottom: card.y + card.height,
  }));
  for (const [id, box] of [
    ['outside', layout.outsideBox],
    ['inbound', layout.inboundBox],
  ] as const)
    if (box)
      cards.push({
        id,
        left: box.x,
        top: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
      });
  const lines = routes.map((route) => ({ id: route.arrow.id, points: samples(route.d, 1.5) }));
  let numberNumber = 0,
    numberCard = 0,
    cardCard = 0,
    farthest = 0,
    foreign = 0;
  for (let a = 0; a < numbers.length; a++)
    for (let b = a + 1; b < numbers.length; b++) if (meet(numbers[a], numbers[b])) numberNumber++;
  for (const number of numbers) {
    numberCard += cards.filter((card) => meet(number, card)).length;
    let nearest = Infinity,
      crossed = false;
    for (const line of lines)
      for (const p of line.points) {
        const distance = Math.hypot(
          Math.max(number.left - p.x, 0, p.x - number.right),
          Math.max(number.top - p.y, 0, p.y - number.bottom),
        );
        if (line.id === number.id) nearest = Math.min(nearest, distance);
        else if (distance === 0 && p.x > number.left + 1 && p.x < number.right - 1)
          crossed ||= p.y > number.top + 1 && p.y < number.bottom - 1;
      }
    farthest = Math.max(farthest, nearest);
    if (crossed) foreign++;
  }
  for (let a = 0; a < cards.length; a++)
    for (let b = a + 1; b < cards.length; b++) if (meet(cards[a], cards[b])) cardCard++;
  const NEAR = 3;
  const grid = new Map<string, { x: number; y: number; line: number; angle: number }[]>();
  const angles = lines.map((line) =>
    line.points.map((_, k) => {
      const next = line.points[Math.min(k + 1, line.points.length - 1)],
        before = line.points[Math.max(k - 1, 0)];
      return Math.atan2(next.y - before.y, next.x - before.x);
    }),
  );
  lines.forEach((line, index) =>
    line.points.forEach((p, k) => {
      const key = `${Math.floor(p.x / NEAR)},${Math.floor(p.y / NEAR)}`;
      const cell = grid.get(key);
      const entry = { x: p.x, y: p.y, line: index, angle: angles[index][k] };
      if (cell) cell.push(entry);
      else grid.set(key, [entry]);
    }),
  );
  let total = 0,
    near = 0,
    along = 0;
  lines.forEach((line, index) =>
    line.points.forEach((p, k) => {
      total++;
      let isNear = false,
        isAlong = false;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const q of grid.get(
            `${Math.floor(p.x / NEAR) + dx},${Math.floor(p.y / NEAR) + dy}`,
          ) ?? []) {
            if (q.line === index || Math.hypot(q.x - p.x, q.y - p.y) >= NEAR) continue;
            if (shared.has(lines[q.line].id) && shared.has(line.id)) continue;
            isNear = true;
            let turn = Math.abs(q.angle - angles[index][k]) % Math.PI;
            if (turn > Math.PI / 2) turn = Math.PI - turn;
            if (turn < Math.PI / 6) isAlong = true;
          }
      if (isNear) near++;
      if (isAlong) along++;
    }),
  );
  return {
    numberNumber,
    numberCard,
    cardCard,
    farthest,
    foreign,
    near: total ? near / total : 0,
    along: total ? along / total : 0,
  };
}
type NumberAt = { id: string; left: number; top: number; right: number; bottom: number };
const boxOf = (
  id: string,
  box: NonNullable<FolderLayout['routes'][number]['label']>,
): NumberAt => ({
  id,
  left: box.x - box.width / 2,
  top: box.y - box.height / 2,
  right: box.x + box.width / 2,
  bottom: box.y + box.height / 2,
});
/** The numbers on the screen at rest: every one that does not wait for the focus. */
const restNumbers = (routes: FolderLayout['routes']) =>
  routes.flatMap((route) =>
    route.label && !route.label.quiet ? [boxOf(route.arrow.id, route.label)] : [],
  );
/** The numbers of the arrows of a card in focus (`folderFocus`): every one, the waiting ones included. */
const focusNumbers = (routes: FolderLayout['routes']) =>
  routes.flatMap((route) => (route.label ? [boxOf(route.arrow.id, route.label)] : []));

/**
 * The map on the screen with `card` in focus: its arrows (`folderFocus`) lit, with their numbers; the
 * other arrows faded, without their numbers. What a number may not cover in focus: another number, a
 * card, a lit line of another arrow. And lit lines run along each other only where they are both
 * drawn for the focus alone, on the lines they share on purpose.
 */
function focusRoom(layout: FolderLayout, card: string) {
  const lit = folderFocus(layout, card);
  const numbers = focusNumbers(lit);
  const waiting = new Set(lit.filter((route) => route.waits).map((route) => route.arrow.id));
  const own = space(layout, lit, numbers, waiting);
  return {
    lit,
    numbers,
    numberNumber: own.numberNumber,
    numberCard: own.numberCard,
    foreign: own.foreign,
    farthest: own.farthest,
    along: own.along,
  };
}

/**
 * Where each arrow starts and ends: its first point on an edge of the card it leaves, inside the
 * height of that card; the tip of its head (the head is ARROW_HEAD long, from 1 px before the end of
 * the line) on an edge of the card it reaches, inside its height, pointing into it.
 */
function ends(layout: FolderLayout, routes = layout.routes) {
  const card = new Map(layout.cards.map((c) => [c.id, c]));
  const width = layout.geometry.cardWidth;
  const onEdge = (p: { x: number; y: number }, id: string) => {
    const c = card.get(id);
    if (!c) return '';
    if (p.y < c.y - 0.01 || p.y > c.y + c.height + 0.01) return '';
    return Math.abs(p.x - c.x) < 0.6 ? 'left' : Math.abs(p.x - (c.x + width)) < 0.6 ? 'right' : '';
  };
  const problems: string[] = [];
  for (const route of routes) {
    const points = samples(route.d, 1);
    const start = points[0],
      end = points[points.length - 1];
    let k = points.length - 2;
    while (k > 0 && Math.hypot(end.x - points[k].x, end.y - points[k].y) < 1.5) k--;
    const dx = end.x - points[k].x,
      dy = end.y - points[k].y,
      length = Math.hypot(dx, dy) || 1;
    const tip = {
      x: end.x + (dx / length) * (ARROW_HEAD - 1),
      y: end.y + (dy / length) * (ARROW_HEAD - 1),
    };
    const name = `${route.arrow.source} > ${route.arrow.target}`;
    if (!onEdge(start, route.arrow.source)) problems.push(`${name} does not start on its source`);
    const side = onEdge(tip, route.arrow.target);
    if (!side) problems.push(`${name} does not end on its target`);
    else if (side === 'left' ? dx <= 0 : dx >= 0) problems.push(`${name} points out of its target`);
  }
  return problems;
}

/** A folder `/s` whose items reference each other: `[source, target, references]`, a file per item. */
function summed(
  items: string[],
  arrows: [string, string, number][],
  entry: string | string[] = '',
) {
  const entries = new Set([entry].flat());
  const file = (name: string) => (name.includes('.') ? `/s/${name}` : `/s/${name}/index.md`);
  const nodes = [
    node('/s', 'directory', 'resolved', '/s'),
    ...items.flatMap((name) =>
      name.includes('.')
        ? [node(file(name), entries.has(name) ? 'entry' : 'file', 'resolved', '/s')]
        : [
            node(`/s/${name}`, 'directory', 'resolved', '/s'),
            node(file(name), 'file', 'resolved', '/s'),
          ],
    ),
  ];
  const edges = arrows.flatMap(([source, target, count]) =>
    Array.from({ length: count }, () => edge(file(source), file(target))),
  );
  return model(nodes, edges, ['/s']);
}
/** Five items that all reference each other, two that are only referenced: 23 arrows, 482 references. */
const FIVE_AND_TWO: [string, string, number][] = [
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
];
const FIVE_AND_TWO_ITEMS = [
  'agents',
  'knowledge',
  'README.md',
  'operations',
  'templates',
  'archive',
  'standards',
];

test('folder map room: 23 arrows between seven items: at rest the loops with the most references and the arrows to the next column, each on a line of its own, every number in a place of its own', () => {
  for (const geometry of [WIDE, NARROW]) {
    const layout = folderLayout(summed(FIVE_AND_TWO_ITEMS, FIVE_AND_TWO), '/s', false, geometry);
    expect(layout.cards.filter((card) => card.column === 0)).toHaveLength(5);
    expect(layout.cards.filter((card) => card.column === 1)).toHaveLength(2);
    // 17 loops between the five items run in one corridor, which draws 16 at rest (12 in the narrow
    // map): those that wait have no more references than any drawn. The 6 arrows to the next column
    // are all drawn.
    const loops = (routes: { arrow: FolderArrow }[]) =>
      routes.filter((route) => !/archive|standards/.test(route.arrow.target));
    expect(loops(layout.routes)).toHaveLength(geometry === WIDE ? 16 : 12);
    expect(layout.routes.length + layout.undrawn.length).toBe(23);
    const fewest = Math.min(...loops(layout.routes).map((route) => route.arrow.relations.length));
    for (const arrow of layout.undrawn) expect(arrow.relations.length).toBeLessThanOrEqual(fewest);
    expect(layout.undrawn.map((arrow) => arrow.id)).toContain('sum:/s/templates>/s/knowledge');
    // Every arrow drawn with more than one reference has a number; in the wide map all are on the
    // screen at rest.
    const numbered = layout.routes.filter((route) => route.arrow.relations.length > 1);
    expect(layout.routes.filter((route) => route.label)).toHaveLength(numbered.length);
    expect(restNumbers(layout.routes).length + layout.quiet).toBe(numbered.length);
    if (geometry === WIDE) expect(layout.quiet).toBe(0);
    for (const card of layout.cards) {
      // With a card in focus, every arrow of it and every number: none meets another or a card.
      const room = focusRoom(layout, card.id);
      expect([room.numberNumber, room.numberCard, room.foreign]).toEqual([0, 0, 0]);
      expect(room.farthest).toBeLessThanOrEqual(1);
    }
    const room = space(layout);
    expect(room.numberNumber).toBe(0);
    expect(room.numberCard).toBe(0);
    expect(room.cardCard).toBe(0);
    // A number sits on a stretch of its own arrow, and on no other one.
    expect(room.farthest).toBeLessThanOrEqual(1);
    expect(room.foreign).toBe(0);
    // No two arrows share a line; what is left of `near` are crossings, at right angles.
    expect(room.along).toBe(0);
    expect(room.near).toBeLessThan(0.06);
    checkRoutes(layout);
    // The first column starts at x 0. Its loops run at its left, the arrows to the next column at
    // its right.
    expect(Math.min(...layout.cards.map((card) => card.x))).toBe(0);
    expect(layout.left).toBeLessThan(-100);
    for (const route of layout.routes) {
      const xs = samples(route.d).map((point) => point.x);
      if (route.shape === 'same') expect(Math.max(...xs)).toBeLessThanOrEqual(0);
      else expect(Math.min(...xs)).toBeGreaterThanOrEqual(geometry.cardWidth);
    }
    // The line is as wide as its references are many: 1, 6 and 230 references.
    const stroke = (source: string, target: string) =>
      layout.routes.find(
        (route) => route.arrow.source.includes(source) && route.arrow.target.includes(target),
      )!.stroke;
    expect(stroke('README.md', 'archive')).toBeLessThan(stroke('operations', 'templates'));
    expect(stroke('operations', 'templates')).toBeLessThan(stroke('agents', 'knowledge'));
    // The same reading read again gives the same drawing.
    const again = folderLayout(summed(FIVE_AND_TWO_ITEMS, FIVE_AND_TWO), '/s', false, geometry);
    expect(again).not.toBe(layout);
    const drawing = (l: FolderLayout) =>
      JSON.stringify([l.cards, l.routes.map((r) => [r.arrow.id, r.d, r.label, r.stroke])]);
    expect(drawing(again)).toBe(drawing(layout));
  }
});

test('folder map room: a cycle of five files and a folder of three items keep every number at rest', () => {
  const cycle = folderLayout(
    summed(
      ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
      [
        ['a.md', 'b.md', 3],
        ['b.md', 'c.md', 12],
        ['c.md', 'd.md', 1],
        ['d.md', 'e.md', 7],
        ['e.md', 'a.md', 2],
      ],
    ),
    '/s',
    false,
  );
  // One column: the loops run at its right, each on a lane of its own where they meet in height.
  expect(new Set(cycle.cards.map((card) => card.column))).toEqual(new Set([0]));
  expect(Math.min(...cycle.cards.map((card) => card.x))).toBe(0);
  const small = folderLayout(
    summed(
      ['AGENTS.md', 'docs', 'notes.md'],
      [
        ['AGENTS.md', 'docs', 4],
        ['AGENTS.md', 'notes.md', 1],
        ['docs', 'notes.md', 2],
      ],
      'AGENTS.md',
    ),
    '/s',
    false,
  );
  for (const layout of [cycle, small]) {
    const room = space(layout);
    expect([room.numberNumber, room.numberCard, room.cardCard, room.foreign]).toEqual([0, 0, 0, 0]);
    expect(room.farthest).toBeLessThanOrEqual(1);
    expect(room.along).toBe(0);
    expect(room.near).toBeLessThan(0.06);
    expect(layout.quiet).toBe(0);
    expect(layout.undrawn).toHaveLength(0);
    // Nothing waits: the focus draws the arrows of the card where they are at rest.
    for (const card of layout.cards)
      expect(
        folderFocus(layout, card.id)
          .map((route) => `${route.arrow.id} ${route.d} ${route.waits ?? ''}`)
          .sort(),
      ).toEqual(
        layout.routes
          .filter((route) => route.arrow.source === card.id || route.arrow.target === card.id)
          .map((route) => `${route.arrow.id} ${route.d} `)
          .sort(),
      );
    checkRoutes(layout);
  }
  expect(folderFocus(small, '/s/not-an-item.md')).toEqual([]);
});

test('folder map room: a card with more arrows than fit on its side grows, a port for each', () => {
  const notes = Array.from({ length: 23 }, (_, i) => `n${String(i).padStart(2, '0')}.md`);
  const layout = folderLayout(
    summed(
      ['AGENTS.md', ...notes],
      notes.map((note, i): [string, string, number] => ['AGENTS.md', note, 1 + (i % 4)]),
      'AGENTS.md',
    ),
    '/s',
    false,
  );
  // 23 arrows in one corridor: the 16 with the most references are drawn at rest, from 16 ports.
  expect(layout.routes).toHaveLength(16);
  expect(layout.undrawn).toHaveLength(7);
  const hub = layout.cards.find((card) => card.id === '/s/AGENTS.md')!;
  expect(hub.height).toBe(2 * 10 + 15 * 6);
  expect(layout.cards.filter((card) => card !== hub).every((card) => card.height === 58)).toBe(
    true,
  );
  // The 16 arrows leave the card 6 px apart, inside it.
  const starts = layout.routes
    .map((route) => samples(route.d)[0])
    .sort((a, b) => a.y - b.y)
    .map((point) => point.y);
  expect(starts[0]).toBeGreaterThanOrEqual(hub.y + 10);
  expect(starts.at(-1)!).toBeLessThanOrEqual(hub.y + hub.height - 10);
  for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeCloseTo(6, 5);
  const room = space(layout);
  expect([room.numberNumber, room.numberCard, room.cardCard, room.foreign]).toEqual([0, 0, 0, 0]);
  expect(room.along).toBe(0);
  expect(ends(layout)).toEqual([]);
  checkRoutes(layout);
  // In focus, the card shows its 23 arrows, the 7 that wait on the line they share.
  const lit = folderFocus(layout, hub.id);
  expect(lit).toHaveLength(23);
  expect(lit.filter((route) => route.waits)).toHaveLength(7);
  expect(ends(layout, lit)).toEqual([]);
});

test('folder map room: a corridor draws at rest the arrows it has lanes for, from the most references; the card in focus shows all of its own', () => {
  const complete = (count: number, references: number) => {
    const items = Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
    return summed(
      items,
      items.flatMap((a) =>
        items.filter((b) => b !== a).map((b): [string, string, number] => [a, b, references]),
      ),
    );
  };
  for (const [count, total] of [
    [8, 56],
    [12, 132],
  ]) {
    // Every file references every other one three times: all loops of one column, all alike.
    const layout = folderLayout(complete(count, 3), '/s', false);
    expect(layout.routes).toHaveLength(WIDE.lanes);
    expect(layout.undrawn).toHaveLength(total - WIDE.lanes);
    expect(space(layout).along).toBe(0);
    expect(space(layout).cardCard).toBe(0);
    checkRoutes(layout);
    for (const card of layout.cards) {
      // In focus: what the card references and what references it, each with its number.
      const room = focusRoom(layout, card.id);
      expect(room.lit).toHaveLength(2 * (count - 1));
      expect(room.numbers).toHaveLength(2 * (count - 1));
      expect([room.numberNumber, room.numberCard, room.foreign]).toEqual([0, 0, 0]);
      expect(room.farthest).toBeLessThanOrEqual(1);
      expect(ends(layout, room.lit)).toEqual([]);
    }
  }
});

test('folder map strip: only the items without an arrow to or from another item of the folder; arrows that wait for the focus still link', () => {
  // Twelve files that reference each other: most arrows wait for the focus. Two more files: one that
  // only references outside the folder, one only referenced from outside it.
  const items = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
  const m = summed(
    [...items, 'out.md', 'in.md'],
    items.flatMap((a) =>
      items.filter((b) => b !== a).map((b): [string, string, number] => [a, b, 1]),
    ),
  );
  m.nodes.push(node('/elsewhere', 'directory', 'resolved', '/elsewhere'));
  m.nodes.push(node('/elsewhere/x.md', 'file', 'resolved', '/elsewhere'));
  m.edges.push(edge('/s/out.md', '/elsewhere/x.md'), edge('/elsewhere/x.md', '/s/in.md'));
  const layout = folderLayout(m, '/s', false);
  expect(layout.undrawn.length).toBeGreaterThan(0);
  // A card whose arrows all wait for the focus is still a card, never an unlinked item.
  const waiting = items.filter(
    (name) =>
      !layout.routes.some((route) =>
        [route.arrow.source, route.arrow.target].includes(`/s/${name}`),
      ),
  );
  expect(layout.shown).toEqual(items.map((name) => `/s/${name}`));
  expect(layout.unlinked).toEqual(['/s/in.md', '/s/out.md']);
  console.log(`strip: ${waiting.length} card(s) with every arrow waiting for the focus`);
  // The one that references outside the folder goes to the box outside; neither has an arrow here.
  const sums = folderSums(m, '/s', false);
  expect(sums.outside.flatMap((group) => group.sources)).toEqual(['/s/out.md']);
});

test('folder map layout: over the limit, the instructions and the nearest items stay; the rest is counted', () => {
  const notes = Array.from({ length: 30 }, (_, i) => `/f/n${String(i).padStart(2, '0')}.md`);
  const nodes = [
    node('/f', 'directory'),
    node('/f/AGENTS.md', 'entry'),
    ...notes.map((p) => node(p)),
  ];
  const edges = notes.map((p) => edge('/f/AGENTS.md', p));
  edges.push(edge(notes[0], notes[29]), edge(notes[29], notes[0]));
  const layout = folderLayout(model(nodes, edges, ['/f']), '/f', false);
  expect(layout.linked).toHaveLength(31);
  expect(layout.shown).toHaveLength(FOLDER_MAP_LIMIT);
  expect(layout.shown).toContain('/f/AGENTS.md');
  expect(layout.omitted).toHaveLength(31 - FOLDER_MAP_LIMIT);
  // Every reference of an omitted item is counted, none lost: 7 arrows from AGENTS.md, plus the pair
  // n00 ↔ n29 when one of them is left out.
  const omitted = new Set(layout.omitted);
  const expected = edges.filter((e) => omitted.has(e.source) || omitted.has(e.target)).length;
  expect(layout.hidden).toBe(expected);
  const drawn = layout.routes.reduce((sum, r) => sum + r.arrow.relations.length, 0);
  const waiting = layout.undrawn.reduce((sum, a) => sum + a.relations.length, 0);
  expect(drawn + waiting + layout.hidden).toBe(edges.length);
  checkRoutes(layout);
});

test('folder map layout: sixty folders that all reference each other stay inside the limit, with no arrow behind a card', () => {
  const folders = Array.from({ length: 60 }, (_, i) => `/f/d${String(i).padStart(2, '0')}`);
  const nodes = [
    node('/f', 'directory'),
    ...folders.flatMap((d) => [node(d, 'directory'), node(`${d}/x.md`)]),
  ];
  const edges = folders.flatMap((a) =>
    folders.filter((b) => b !== a).map((b) => edge(`${a}/x.md`, `${b}/x.md`)),
  );
  const started = performance.now();
  const layout = folderLayout(model(nodes, edges, ['/f']), '/f', false);
  const elapsed = performance.now() - started;
  expect(layout.shown).toHaveLength(FOLDER_MAP_LIMIT);
  expect(layout.omitted).toHaveLength(60 - FOLDER_MAP_LIMIT);
  // 552 arrows in one column: the corridor draws 16 at rest, the others are counted. All have one
  // reference: the shortest come in, each between two neighbouring cards of the column, never a fan
  // out of the first name.
  expect(layout.routes).toHaveLength(WIDE.lanes);
  expect(layout.undrawn).toHaveLength(FOLDER_MAP_LIMIT * (FOLDER_MAP_LIMIT - 1) - WIDE.lanes);
  const row = new Map(
    [...layout.cards].sort((a, b) => a.y - b.y).map((card, i) => [card.id, i] as const),
  );
  for (const route of layout.routes)
    expect(Math.abs(row.get(route.arrow.source)! - row.get(route.arrow.target)!)).toBe(1);
  expect(new Set(layout.routes.map((route) => route.arrow.source)).size).toBeGreaterThan(2);
  // An arrow that waits takes no port: with a few drawn arrows on each side, no card grows.
  expect(layout.cards.filter((card) => card.height > WIDE.cardHeight)).toHaveLength(0);
  checkRoutes(layout);
  // In focus, a card shows its 23 arrows out and its 23 arrows in, on two lines beside the column.
  const focused = layout.cards[5].id;
  const shown = folderFocus(layout, focused);
  expect(shown).toHaveLength(2 * (FOLDER_MAP_LIMIT - 1));
  expect(shown.every((r) => r.arrow.source === focused || r.arrow.target === focused)).toBe(true);
  checkRoutes({ ...layout, routes: shown });
  console.log(
    `layout: ${layout.columns.length} column(s), ${layout.routes.length} arrows, ${layout.crossings} crossings between columns, ${elapsed.toFixed(1)} ms`,
  );
});

test('folder map room: arrows with as many references come in at rest from the shortest, then by name; more references still come first', () => {
  // Eight files that reference each other once: one column, f00 to f07 from the top, cards 74 px
  // apart (58 of card, 16 of gap); f00 references f07, the farthest card, twice.
  const items = Array.from({ length: 8 }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
  const arrows = items.flatMap((a, i) =>
    items
      .filter((b) => b !== a)
      .map((b): [string, string, number] => [a, b, i === 0 && b === 'f07.md' ? 2 : 1]),
  );
  const layout = folderLayout(summed(items, arrows), '/s', false);
  const name = (id: string) => id.split('/').at(-1)!;
  expect([...layout.cards].sort((a, b) => a.y - b.y).map((card) => name(card.id))).toEqual(items);
  const drawn = layout.routes.map((r) => `${name(r.arrow.source)}>${name(r.arrow.target)}`);
  // 16 lanes: the arrow of two references, though the longest; the 14 between neighbouring cards
  // (74 px); and, of the twelve two cards apart (148 px), the first by name.
  const neighbours = items.slice(1).flatMap((b, i) => [`${items[i]}>${b}`, `${b}>${items[i]}`]);
  expect(drawn.sort()).toEqual(['f00.md>f07.md', 'f00.md>f02.md', ...neighbours].sort());
  // Negative: by name alone, f00 would have sent seven of them.
  expect(drawn.filter((pair) => pair.startsWith('f00.md>'))).toHaveLength(3);
  // The same reading gives the same choice.
  const again = folderLayout(summed(items, arrows), '/s', false);
  expect(again.routes.map((r) => r.arrow.id)).toEqual(layout.routes.map((r) => r.arrow.id));
  checkRoutes(layout);
});

test('folder boundary: distinct files outside each folder that it references, and that reference it', () => {
  const m = fixture();
  expect(folderBoundary(m, '/r/docs', false)).toEqual({ out: 2, into: 1 });
  expect(folderBoundary(m, '/r/docs/sub', false)).toEqual({ out: 0, into: 1 });
  expect(folderBoundary(m, '/r/lonely', false)).toEqual({ out: 0, into: 0 });
  expect(folderBoundary(m, '/r', false)).toEqual({ out: 1, into: 1 });
});

test('folder map cost: a reading of 100,000 relations sums and lays out the root in less than 300 ms', () => {
  // 20,000 files in 40 folders of 10 subfolders; 100,000 references between them (fixed pseudo-random).
  const nodes: FileNode[] = [
    node('/big', 'directory', 'resolved', '/big'),
    node('/big/AGENTS.md', 'entry', 'resolved', '/big'),
  ];
  const files: string[] = [];
  for (let a = 0; a < 40; a++) {
    nodes.push(node(`/big/f${a}`, 'directory', 'resolved', '/big'));
    for (let b = 0; b < 10; b++) {
      nodes.push(node(`/big/f${a}/s${b}`, 'directory', 'resolved', '/big'));
      for (let c = 0; c < 50; c++) {
        const path = `/big/f${a}/s${b}/n${c}.md`;
        nodes.push(node(path, 'file', 'resolved', '/big'));
        files.push(path);
      }
    }
  }
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const edges: Relation[] = [];
  for (let i = 0; i < 100000; i++)
    edges.push(
      edge(files[Math.floor(random() * files.length)], files[Math.floor(random() * files.length)]),
    );
  const m = model(nodes, edges, ['/big']);
  const runs: number[] = [];
  for (let run = 0; run < 3; run++) {
    const copy = { ...m };
    const started = performance.now();
    const layout = folderLayout(copy, '/big', false);
    runs.push(performance.now() - started);
    expect(layout.shown.length).toBe(FOLDER_MAP_LIMIT);
  }
  const started = performance.now();
  folderBoundary({ ...m }, '/big/f1', false);
  const boundary = performance.now() - started;
  const median = [...runs].sort((a, b) => a - b)[1];
  console.log(
    `root of 100,000 relations: ${runs.map((r) => r.toFixed(1)).join(', ')} ms (median ${median.toFixed(1)}); folder edges of the Estrutura: ${boundary.toFixed(1)} ms`,
  );
  expect(median).toBeLessThan(300);
});

/** The model of a case of tests/ui/folder-map-cases.ts: the folder `/s`. */
const caseModel = (c: FolderCase) => summed(c.items, c.arrows, c.entries);
/** The seeds of 44 random folders, and 160 more. */
const REVIEW_SEEDS = Array.from({ length: 44 }, (_, k) => 1000 + k);
const MORE_SEEDS = Array.from({ length: 160 }, (_, k) => 5000 + k);

test('folder map ends: every arrow starts on the card it leaves and its head ends on the card it reaches, pointing in, at rest and in focus', () => {
  for (const c of [...stressCases(), ...REVIEW_SEEDS.map(randomCase)])
    for (const geometry of [WIDE, NARROW]) {
      const layout = folderLayout(caseModel(c), '/s', false, geometry);
      expect(ends(layout), c.id).toEqual([]);
      for (const card of layout.cards)
        expect(ends(layout, folderFocus(layout, card.id)), `${c.id}: ${card.id}`).toEqual([]);
    }
});

test('folder map focus: a card in focus shows every arrow it has with the other cards, and their references add up to its sums', () => {
  for (const c of [...stressCases(), ...REVIEW_SEEDS.map(randomCase)]) {
    const m = caseModel(c);
    const sums = folderSums(m, '/s', false);
    const layout = folderLayout(m, '/s', false);
    const shown = new Set(layout.shown);
    const onMap = (a: { source: string; target: string }) =>
      shown.has(a.source) && shown.has(a.target);
    for (const card of layout.cards) {
      const lit = folderFocus(layout, card.id);
      expect(lit.map((route) => route.arrow.id).sort(), `${c.id}: ${card.id}`).toEqual(
        sums.arrows
          .filter((a) => (a.source === card.id || a.target === card.id) && onMap(a))
          .map((a) => a.id)
          .sort(),
      );
      // ↙ and ↗ of the card: the references of its arrows in focus, and of those to items the limit
      // left out of the map.
      const item = sums.items.find((entry) => entry.id === card.id)!;
      const total = (side: 'source' | 'target', routes: { arrow: FolderArrow }[]) =>
        routes
          .filter((route) => route.arrow[side] === card.id)
          .reduce((sum, route) => sum + route.arrow.relations.length, 0);
      const away = sums.arrows.filter((a) => !onMap(a)).map((arrow) => ({ arrow }));
      expect(total('source', lit) + total('source', away)).toBe(item.outgoing);
      expect(total('target', lit) + total('target', away)).toBe(item.incoming);
    }
  }
  // An arrow that skips a column over a full corridor, with fewer references than the arrows in it,
  // waits at rest, and both of its cards show it.
  const crowded = stressCases()[0];
  const layout = folderLayout(
    caseModel({
      ...crowded,
      arrows: crowded.arrows.map(([a, b, count]): [string, string, number] =>
        a === 'src1.md' && b === 'xfar.md' ? [a, b, 1] : [a, b, count],
      ),
    }),
    '/s',
    false,
  );
  const skip = (route: { arrow: FolderArrow }) =>
    route.arrow.source === '/s/src1.md' && route.arrow.target === '/s/xfar.md';
  expect(layout.routes.some(skip)).toBe(false);
  expect(layout.undrawn.some((arrow) => skip({ arrow }))).toBe(true);
  for (const card of ['/s/src1.md', '/s/xfar.md']) {
    const route = folderFocus(layout, card).find(skip)!;
    expect(route.shape).toBe('skip');
    expect(route.waits).toBe(true);
    expect(ends(layout, [route])).toEqual([]);
  }
});

test('folder map focus: no number over another number, a card or the lit line of another arrow, each on its own line', () => {
  for (const c of [...stressCases(), ...REVIEW_SEEDS.map(randomCase)])
    for (const geometry of [WIDE, NARROW]) {
      const layout = folderLayout(caseModel(c), '/s', false, geometry);
      for (const card of layout.cards) {
        const room = focusRoom(layout, card.id);
        const name = `${c.id}: ${card.id}`;
        expect([room.numberNumber, room.numberCard, room.foreign], name).toEqual([0, 0, 0]);
        expect(room.farthest, name).toBeLessThanOrEqual(1);
        // Every arrow of the card with more than one reference shows its number.
        expect(room.numbers.length, name).toBe(
          room.lit.filter((route) => route.arrow.relations.length > 1).length,
        );
        // Lit lines run along each other only where both wait for the focus (their shared lines).
        expect(room.along, name).toBe(0);
      }
      // The pointer on one arrow: its number, also one that waits at rest.
      for (const route of layout.routes) {
        const lit = folderArrowFocus(layout, route.arrow.id)!;
        if (route.arrow.relations.length < 2) continue;
        const room = space(layout, [lit], focusNumbers([lit]));
        expect([room.numberCard, room.farthest <= 1], `${c.id}: ${route.arrow.id}`).toEqual([
          0,
          true,
        ]);
      }
    }
});

test('folder map room, property: at rest no two arrows run along each other and no number covers a line, a number or a card, in the 44 folders of the review and 160 more', () => {
  for (const c of [...stressCases(), ...[...REVIEW_SEEDS, ...MORE_SEEDS].map(randomCase)])
    for (const geometry of [WIDE, NARROW]) {
      const layout = folderLayout(caseModel(c), '/s', false, geometry);
      const room = space(layout);
      expect(
        {
          along: room.along,
          numberNumber: room.numberNumber,
          numberCard: room.numberCard,
          cardCard: room.cardCard,
          foreign: room.foreign,
        },
        c.id,
      ).toEqual({ along: 0, numberNumber: 0, numberCard: 0, cardCard: 0, foreign: 0 });
      expect(room.farthest, c.id).toBeLessThanOrEqual(1);
      checkRoutes(layout);
      // A folder without arrows between its items is a grid of cards, without routes.
      if (layout.grid) {
        expect(layout.routes, c.id).toEqual([]);
        continue;
      }
      if (!layout.cards.length) continue;
      // A folder with arrows draws some at rest, the one with the most references first.
      const top = [...layout.routes, ...layout.undrawn.map((arrow) => ({ arrow }))].reduce(
        (most, route) =>
          route.arrow.relations.length > most.arrow.relations.length ? route : most,
      );
      expect(
        layout.routes.some((route) => route.arrow.relations.length === top.arrow.relations.length),
        c.id,
      ).toBe(true);
    }
});

test('folder map stability: one reference more keeps every card in its column, order and height; only corridors widen', () => {
  const cards = (layout: FolderLayout) => new Map(layout.cards.map((card) => [card.id, card]));
  const compare = (name: string, before: FolderLayout, after: FolderLayout) => {
    const a = cards(before),
      b = cards(after);
    expect([...b.keys()].sort(), name).toEqual([...a.keys()].sort());
    if ([...a].some(([id, card]) => b.get(id)!.column !== card.column)) return false;
    for (let column = 0; column < before.columns.length; column++) {
      const order = (map: Map<string, CardPlace>) =>
        [...map.values()]
          .filter((card) => card.column === column)
          .sort((x, y) => x.y - y.y)
          .map((card) => card.id);
      expect(order(b), `${name}: column ${column}`).toEqual(order(a));
      const same = order(a).every((id) => a.get(id)!.height === b.get(id)!.height);
      // The cards of a column keep their heights: none moves up or down.
      if (same)
        for (const id of order(a)) expect(b.get(id)!.y, `${name}: ${id}`).toBe(a.get(id)!.y);
    }
    return true;
  };
  let compared = 0;
  for (const c of [
    ...[1003, 1007, 1010, 1016, 1019, 1028, 1042].map(randomCase),
    stressCases()[4],
  ]) {
    const before = folderLayout(caseModel(c), '/s', false);
    // An arrow of one reference gets a second one.
    const one = c.arrows.findIndex(([, , count]) => count === 1);
    if (one >= 0) {
      const arrows = c.arrows.map((arrow, i): [string, string, number] =>
        i === one ? [arrow[0], arrow[1], 2] : arrow,
      );
      if (compare(`${c.id} +1`, before, folderLayout(caseModel({ ...c, arrows }), '/s', false)))
        compared++;
    }
    // A new arrow between two items of one column.
    const column = new Map(
      before.cards.map((card) => [card.id.slice(3).replace(/\/index\.md$/, ''), card.column]),
    );
    const pairs = new Set(c.arrows.map(([a, b]) => `${a}>${b}`));
    const fresh = [...column.keys()]
      .flatMap((a) => [...column.keys()].map((b) => [a, b]))
      .find(([a, b]) => a !== b && column.get(a) === column.get(b) && !pairs.has(`${a}>${b}`));
    if (fresh) {
      const arrows: [string, string, number][] = [...c.arrows, [fresh[0], fresh[1], 1]];
      if (compare(`${c.id} new`, before, folderLayout(caseModel({ ...c, arrows }), '/s', false)))
        compared++;
    }
  }
  expect(compared).toBeGreaterThanOrEqual(8);
});

test('folder map layout: the box of what leaves the folder sits at the end of the last column', () => {
  const m = summed(
    ['AGENTS.md', 'a.md', 'b.md', 'c.md', 'd.md'],
    [
      ['AGENTS.md', 'a.md', 2],
      ['AGENTS.md', 'b.md', 3],
      ['AGENTS.md', 'c.md', 1],
      ['a.md', 'd.md', 4],
    ],
    'AGENTS.md',
  );
  m.nodes.push(node('/s/gone.md', 'unresolved', 'missing', '/s'));
  m.edges.push(edge('/s/a.md', '/s/gone.md'), edge('/s/d.md', '/s/gone.md'));
  const layout = folderLayout(m, '/s', false);
  const last = layout.columns.length - 1;
  const bottom = Math.max(
    ...layout.cards.filter((card) => card.column === last).map((card) => card.y + card.height),
  );
  expect(layout.outsideBox).toMatchObject({ x: layout.columns[last].x });
  expect(layout.outsideBox!.y).toBeGreaterThanOrEqual(bottom + 16);
});

/**
 * A folder `/r/tools` reached from outside: a script that is not read, a subfolder, references from
 * the project, from another open project, to the folder itself, a convention, and two that do not
 * count (a placeholder that writes, a missing file inside the folder).
 */
function inboundFixture() {
  const nodes = [
    node('/r', 'directory'),
    node('/r/AGENTS.md', 'entry'),
    node('/r/notes.md'),
    node('/r/docs', 'directory'),
    node('/r/docs/x.md'),
    node('/r/tools', 'directory'),
    { ...node('/r/tools/run.py'), analysis: undefined },
    node('/r/tools/lib', 'directory'),
    node('/r/tools/lib/a.md'),
    node('/r/tools/gone.py', 'unresolved', 'missing'),
    node('/other', 'directory', 'resolved', '/other'),
    node('/other/y.md', 'file', 'resolved', '/other'),
    node('/outside/z.md', 'unresolved', 'external', null as unknown as string),
  ];
  const edges = [
    edge('/r/AGENTS.md', '/r/tools'), // the folder itself
    edge('/r/AGENTS.md', '/r/tools/run.py'),
    edge('/r/docs/x.md', '/r/tools/run.py'),
    edge('/r/docs/x.md', '/r/tools/run.py'),
    edge('/r/docs/x.md', '/r/tools/lib/a.md'), // reaches the item lib
    edge('/other/y.md', '/r/tools/run.py'), // another open project
    edge('/r/notes.md', '/r/tools/run.py', 'scope'), // a convention
    edge('/r/docs/x.md', '/r/tools/gone.py'), // missing: not in the folder
    edge('/outside/z.md', '/r/tools/run.py'), // a placeholder writes: not a file of the reading
    edge('/r/tools/lib/a.md', '/r/AGENTS.md'), // written in the folder: the box outside
  ];
  return model(nodes, edges, ['/r', '/other']);
}

test('folder map sums from outside: by where the file that writes is, with the files and the items reached', () => {
  const sums = folderSums(inboundFixture(), '/r/tools', false);
  expect(
    sums.inbound.map((g) => [
      g.kind,
      g.relations.length,
      g.sources.map((s) => [s.label, s.relations]),
      g.targets,
      g.projects,
    ]),
  ).toEqual([
    ['self', 1, [['../AGENTS.md', 1]], [], []],
    [
      'project',
      4,
      [
        ['../docs/x.md', 3],
        ['../AGENTS.md', 1],
      ],
      ['/r/tools/run.py', '/r/tools/lib'],
      [],
    ],
    ['other-project', 1, [['other/y.md', 1]], ['/r/tools/run.py'], ['other']],
  ]);
  // Not written in the folder: its own total, never part of `written`.
  expect(sums.totals).toMatchObject({ written: 1, outside: 1, inbound: 6 });
  const item = (id: string) => sums.items.find((entry) => entry.id === id)!;
  expect(item('/r/tools/run.py')).toMatchObject({ inbound: 4, incoming: 0, outside: 0 });
  expect(item('/r/tools/lib')).toMatchObject({ inbound: 1, outside: 1 });
  // Conventions on: the convention joins its group; sources with as many references go by label.
  const withConventions = folderSums(inboundFixture(), '/r/tools', true);
  expect(withConventions.totals.inbound).toBe(7);
  expect(
    withConventions.inbound.find((g) => g.kind === 'project')!.sources.map((s) => s.label),
  ).toEqual(['../docs/x.md', '../AGENTS.md', '../notes.md']);
  // Seen from the parent folder, the same references are written inside it: nothing from outside
  // but the one of the other project.
  const parent = folderSums(inboundFixture(), '/r', false);
  expect(parent.inbound.map((g) => [g.kind, g.targets])).toEqual([['other-project', ['/r/tools']]]);
});

test('folder map layout from outside: the box sits above the first column, over its title, and moves no card', () => {
  const arrows: [string, string, number][] = [
    ['AGENTS.md', 'a.md', 2],
    ['a.md', 'b.md', 1],
  ];
  const m = summed(['AGENTS.md', 'a.md', 'b.md'], arrows, 'AGENTS.md');
  m.nodes.push(node('/elsewhere', 'directory', 'resolved', '/elsewhere'));
  for (let i = 0; i < 3; i++) {
    m.nodes.push(node(`/elsewhere/n${i}.md`, 'file', 'resolved', '/elsewhere'));
    m.edges.push(edge(`/elsewhere/n${i}.md`, '/s/b.md'));
  }
  m.roots.push({ ...m.roots[0], path: '/elsewhere', name: 'elsewhere' });
  for (const geometry of [WIDE, NARROW]) {
    const layout = folderLayout(m, '/s', false, geometry);
    const sums = folderSums(m, '/s', false);
    expect(sums.inbound.map((g) => [g.kind, g.sources.length, g.targets])).toEqual([
      ['other-project', 3, ['/s/b.md']],
    ]);
    const height = inboundBoxHeight(sums.inbound);
    // Title, one group: its kind, two files, "+1 other source", the line of the items reached.
    expect(height).toBe(10 * 2 + 24 + 6 + 20 + 2 * 17 + 16 + 18);
    expect(layout.inboundBox).toEqual({
      x: layout.columns[0].x,
      y: -48 - height,
      width: geometry.cardWidth,
      height,
    });
    // The titles of the columns are 32 px above the cards: the box ends 16 px above them.
    expect(layout.inboundBox!.y + height).toBeLessThanOrEqual(-32 - 16);
    expect(layout.top).toBe(layout.inboundBox!.y);
    const plain = folderLayout(
      summed(['AGENTS.md', 'a.md', 'b.md'], arrows, 'AGENTS.md'),
      '/s',
      false,
      geometry,
    );
    expect(plain.inboundBox).toBeNull();
    expect(layout.cards).toEqual(plain.cards);
    expect(layout.routes.map((r) => r.d)).toEqual(plain.routes.map((r) => r.d));
    checkRoutes(layout);
  }
});

test('folder map without arrows between its items: every item a card, in columns of up to six, the boxes around them', () => {
  // A folder whose single child holds every reference (inside it): a card, not an empty map.
  const one = model(
    [
      node('/p', 'directory', 'resolved', '/p'),
      node('/p/.agents', 'directory', 'resolved', '/p'),
      node('/p/.agents/skills', 'directory', 'resolved', '/p'),
      node('/p/.agents/skills/a/SKILL.md', 'skill', 'resolved', '/p'),
      node('/p/.agents/skills/b/SKILL.md', 'skill', 'resolved', '/p'),
    ],
    [
      edge('/p/.agents/skills/a/SKILL.md', '/p/.agents/skills/b/SKILL.md'),
      edge('/p/.agents/skills/b/SKILL.md', '/p/.agents/skills/a/SKILL.md'),
    ],
    ['/p'],
  );
  const single = folderLayout(one, '/p/.agents', false);
  expect(single).toMatchObject({
    grid: true,
    shown: ['/p/.agents/skills'],
    omitted: [],
    unlinked: [],
    routes: [],
    inboundBox: null,
    outsideBox: null,
  });
  expect(single.cards).toEqual([
    { id: '/p/.agents/skills', column: 0, x: 0, y: 0, height: WIDE.cardHeight, group: 'cited' },
  ]);
  expect(folderSums(one, '/p/.agents', false).items[0]).toMatchObject({ internal: 2 });

  // Thirty files, none referencing another of the folder: the last five by name have references
  // (inside, to outside, from outside), the limit keeps them; the grid takes the order of the
  // Structure, four columns of six.
  const names = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
  const many = model(
    [
      node('/r', 'directory'),
      node('/r/g', 'directory'),
      node('/r/g/gone.md', 'unresolved', 'missing'),
      node('/r/elsewhere.md'),
      ...names.map((name) => node(`/r/g/${name}`)),
    ],
    [
      edge('/r/g/f25.md', '/r/g/f25.md'),
      edge('/r/g/f26.md', '/r/g/gone.md'),
      edge('/r/elsewhere.md', '/r/g/f27.md'),
      edge('/r/elsewhere.md', '/r/g/f28.md'),
      edge('/r/elsewhere.md', '/r/g/f29.md'),
    ],
  );
  for (const geometry of [WIDE, NARROW]) {
    const layout = folderLayout(many, '/r/g', false, geometry);
    expect(layout.grid).toBe(true);
    expect(layout.shown).toHaveLength(FOLDER_MAP_LIMIT);
    expect(layout.shown).toEqual(expect.arrayContaining(names.slice(25).map((n) => `/r/g/${n}`)));
    expect(layout.omitted).toEqual(names.slice(19, 25).map((n) => `/r/g/${n}`));
    expect(layout.unlinked).toEqual([]);
    const columns = Math.ceil(FOLDER_MAP_LIMIT / GRID_ROWS);
    expect(layout.columns.map((c) => [c.x, c.kind])).toEqual(
      Array.from({ length: columns }, (_, c) => [
        c * (geometry.cardWidth + geometry.corridor),
        'none',
      ]),
    );
    layout.cards.forEach((card, i) => {
      expect(card.id).toBe(layout.shown[i]);
      expect([card.column, card.y]).toEqual([
        Math.floor(i / GRID_ROWS),
        (i % GRID_ROWS) * (geometry.cardHeight + geometry.gap),
      ]);
    });
    // The box from outside above the first column, the box outside under the last one.
    expect(layout.inboundBox).toMatchObject({ x: 0 });
    expect(layout.inboundBox!.y + layout.inboundBox!.height).toBeLessThanOrEqual(-48);
    expect(layout.outsideBox).toMatchObject({ x: layout.columns[columns - 1].x });
    expect(layout.width).toBe(columns * geometry.cardWidth + (columns - 1) * geometry.corridor);
    checkRoutes(layout);
    // The same reading gives the same drawing.
    expect(JSON.stringify(folderLayout({ ...many }, '/r/g', false, geometry))).toBe(
      JSON.stringify(layout),
    );
  }
  // Seven items: two columns as full as each other (four and three), not six and one.
  const seven = model(
    [node('/h', 'directory'), ...names.slice(0, 7).map((name) => node(`/h/${name}`))],
    [],
    ['/h'],
  );
  expect(folderLayout(seven, '/h', false).cards.map((card) => card.column)).toEqual([
    0, 0, 0, 0, 1, 1, 1,
  ]);
  // Thirteen: three columns of 5, 4 and 4 (not 5, 5 and 3); twenty-two: four of 6, 6, 5 and 5. Each
  // column from the top, in the order of the Structure.
  for (const [count, sizes] of [
    [13, [5, 4, 4]],
    [22, [6, 6, 5, 5]],
  ] as const) {
    const grid = model(
      [node('/k', 'directory'), ...names.slice(0, count).map((name) => node(`/k/${name}`))],
      [],
      ['/k'],
    );
    const layout = folderLayout(grid, '/k', false);
    expect(
      layout.columns.map((c) => layout.cards.filter((card) => card.column === c.column).length),
    ).toEqual(sizes);
    let i = 0;
    sizes.forEach((size, column) => {
      for (let row = 0; row < size; row++, i++)
        expect(layout.cards[i]).toMatchObject({
          id: `/k/${names[i]}`,
          column,
          x: column * (WIDE.cardWidth + WIDE.corridor),
          y: row * (WIDE.cardHeight + WIDE.gap),
        });
    });
    checkRoutes(layout);
  }
  // A folder without items keeps its sentence alone: no card, no grid.
  const empty = model([node('/e', 'directory'), node('/e/x', 'directory')], [], ['/e']);
  expect(folderLayout(empty, '/e/x', false)).toMatchObject({ grid: false, cards: [] });
});
