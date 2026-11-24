/**
 * The map of a folder, computed in the client from the model already loaded. Three pure steps:
 *
 * 1. `folderSums`: sums by item the references written in the folder's files. An arrow from A to B adds
 *    the references from the files of A (at any depth) to the files of B. A reference inside one item
 *    is "internal"; one that leaves the folder or reaches something that is not an item (a missing
 *    file, an unread folder, the folder itself) goes to the group "outside this folder". The three
 *    parts add up to the total. References written outside the folder that reach it are summed apart,
 *    by where they are written (the box "from outside this folder").
 * 2. `folderLayers`: the column of each linked item. The instructions of the folder and the items that
 *    reference without being referenced start on the left; the others follow by distance. Items of a
 *    cycle share a column, so every arrow goes to a column on its right or stays in its own.
 * 3. `folderLayout`: positions and routes. A folder without arrows between its items is a grid of cards
 *    (`gridLayout`). Otherwise the order of the cards comes from every arrow, so which arrows are drawn
 *    never moves a card. At rest the arrows come in from the most references to the fewest (a tie: the
 *    shortest first) while their corridors have a lane left; each has its own ports and lane. No route
 *    crosses a card, and no two drawn at rest share a line. `folderFocus` draws every arrow of a card
 *    in focus.
 *
 * Results are kept per model, so moving around the map never computes them again.
 */
import type { FileNode, Model, Relation } from './types';
import { outsideInventory } from './types';
import { dirname } from './scopeNavigation';

/** Cards in the grid of a folder map; the rest is counted. */
export const FOLDER_MAP_LIMIT = 24;

/** What a reference that does not reach another item of the folder reaches, in the order shown. */
export type OutsideKind =
  | 'self'
  | 'project'
  | 'other-project'
  | 'outside'
  | 'unread'
  | 'missing'
  | 'declared'
  | 'unverified';
export const OUTSIDE_ORDER: OutsideKind[] = [
  'self',
  'project',
  'other-project',
  'outside',
  'unread',
  'missing',
  'declared',
  'unverified',
];
const PLACEHOLDER: Record<string, OutsideKind> = {
  missing: 'missing',
  external: 'outside',
  unscanned: 'unread',
  declared: 'declared',
  unverified: 'unverified',
};

export type FolderItem = {
  id: string;
  node: FileNode;
  folder: boolean;
  /** Inventoried files inside a folder, at any depth (0 for a file). */
  files: number;
  /** Of `files`, those whose text was read for references. */
  read: number;
  /** AGENTS.md / CLAUDE.md directly inside a folder item. */
  ownEntries: string[];
  /** References from files of this item to files of this item (a file to itself included). */
  internal: number;
  /** Of `internal`, a file referencing itself. */
  selfReferences: number;
  /** References arriving from other items and leaving to other items (the sums of its arrows). */
  incoming: number;
  outgoing: number;
  /** References from files of this item to the box "outside this folder". */
  outside: number;
  /** References from files outside the folder to files of this item (the box "from outside"). */
  inbound: number;
};
export type FolderArrow = {
  id: string;
  source: string;
  target: string;
  relations: Relation[];
  /** Every relation is a convention (`scope`): drawn dashed. */
  conventions: boolean;
};
export type OutsideTarget = {
  id: string;
  /** The destination as seen from the folder: relative to it (`../AGENTS.md`), or `project/path`. */
  label: string;
  relations: number;
};
export type OutsideGroup = {
  kind: OutsideKind;
  relations: Relation[];
  targets: OutsideTarget[];
  /** Items of the folder whose files write these references. */
  sources: string[];
  /** For `other-project`: the projects reached. */
  projects: string[];
};
/** Where the file that writes a reference into the folder is; `self`: it reaches the folder itself. */
export type InboundKind = 'self' | 'project' | 'other-project' | 'outside';
export const INBOUND_ORDER: InboundKind[] = ['self', 'project', 'other-project', 'outside'];
export type InboundSource = {
  id: string;
  /** The file that writes the references, seen from the folder: `../x.md`, or `project/path`. */
  label: string;
  relations: number;
};
export type InboundGroup = {
  kind: InboundKind;
  relations: Relation[];
  /** From the file with the most references to the fewest (as many: by label). */
  sources: InboundSource[];
  /** Items of the folder reached, from the most references (none for `self`). */
  targets: string[];
  /** The projects of the files that write them, when another open project. */
  projects: string[];
};
export type FolderSums = {
  folder: string;
  /** The opened project the folder belongs to (the most specific one). */
  project: string | null;
  /** Every inventoried child, in the order of the Structure (folders first, then by name). */
  items: FolderItem[];
  arrows: FolderArrow[];
  internal: Map<string, Relation[]>;
  outside: OutsideGroup[];
  /** References written in files outside the folder that reach it, by where those files are. */
  inbound: InboundGroup[];
  totals: {
    /** References written in files of the folder: between + outside + internal. */
    written: number;
    between: number;
    outside: number;
    internal: number;
    selfReferences: number;
    /** References written in files outside the folder to it or to its items (not part of `written`). */
    inbound: number;
  };
};

/** A real item of the reading (file, folder or symlink), never a reference placeholder. */
export const inventoried = (node: FileNode) =>
  node.kind !== 'unresolved' && !outsideInventory.has(node.status);

const indexes = new WeakMap<Model, Map<string, FileNode>>();
function nodeById(model: Model) {
  let index = indexes.get(model);
  if (!index) indexes.set(model, (index = new Map(model.nodes.map((node) => [node.id, node]))));
  return index;
}
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;

/** `to` written from the folder `from`: `a/b.md`, `../c.md`, `.` for the folder itself. */
export function relativeTo(from: string, to: string) {
  if (to === from) return '.';
  const a = from.split('/').filter(Boolean),
    b = to.split('/').filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return [...Array(a.length - common).fill('..'), ...b.slice(common)].join('/') || '.';
}

/** The most specific opened project that holds `path`. */
function projectOf(model: Model, path: string) {
  let best: string | null = null;
  for (const root of model.roots)
    if (
      (path === root.path || path.startsWith(root.path + '/')) &&
      root.path.length > (best?.length ?? -1)
    )
      best = root.path;
  return best;
}

type Cache<T> = WeakMap<Model, Map<string, T>>;
function cached<T>(cache: Cache<T>, model: Model, key: string, compute: () => T) {
  let entries = cache.get(model);
  if (!entries) cache.set(model, (entries = new Map()));
  let value = entries.get(key);
  if (value === undefined) entries.set(key, (value = compute()));
  return value;
}
const sumsCache: Cache<FolderSums> = new WeakMap();

/** The items of `folder` and the references written in its files, summed by item (see the top). */
export function folderSums(model: Model, folder: string, conventions: boolean): FolderSums {
  return cached(sumsCache, model, `${conventions}\n${folder}`, () =>
    computeSums(model, folder, conventions),
  );
}

function computeSums(model: Model, folder: string, conventions: boolean): FolderSums {
  const byId = nodeById(model);
  const prefix = folder.endsWith('/') ? folder : folder + '/';
  /** The child of the folder a path lies in (the path itself for a child), or null outside it. */
  const itemOf = (path: string) => {
    if (!path.startsWith(prefix)) return null;
    const slash = path.indexOf('/', prefix.length);
    return slash < 0 ? path : path.slice(0, slash);
  };
  const items = new Map<string, FolderItem>();
  const children = model.nodes
    .filter((node) => inventoried(node) && node.path !== folder && dirname(node.path) === folder)
    .sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name),
    );
  for (const node of children)
    items.set(node.id, {
      id: node.id,
      node,
      folder: node.kind === 'directory',
      files: 0,
      read: 0,
      ownEntries: [],
      internal: 0,
      selfReferences: 0,
      incoming: 0,
      outgoing: 0,
      outside: 0,
      inbound: 0,
    });
  for (const node of model.nodes) {
    if (!inventoried(node) || node.kind === 'directory') continue;
    const item = itemOf(node.path);
    const owner = item && item !== node.path ? items.get(item) : undefined;
    if (!owner) continue;
    owner.files++;
    if (node.analysis === 'parsed' || node.analysis === 'partial') owner.read++;
    if (node.kind === 'entry' && dirname(node.path) === owner.id) owner.ownEntries.push(node.name);
  }
  const project = projectOf(model, folder);
  const pairs = new Map<string, FolderArrow>();
  const internal = new Map<string, Relation[]>();
  const outside = new Map<OutsideKind, OutsideGroup>();
  const outsideTargets = new Map<string, OutsideTarget>();
  const totals = {
    written: 0,
    between: 0,
    outside: 0,
    internal: 0,
    selfReferences: 0,
    inbound: 0,
  };
  // `label` null: the group says it all (the folder itself), no destination is listed.
  const away = (
    kind: OutsideKind,
    edge: Relation,
    source: string,
    label: string | null,
    other?: string,
  ) => {
    let group = outside.get(kind);
    if (!group)
      outside.set(kind, (group = { kind, relations: [], targets: [], sources: [], projects: [] }));
    group.relations.push(edge);
    if (!group.sources.includes(source)) group.sources.push(source);
    if (other && !group.projects.includes(other)) group.projects.push(other);
    items.get(source)!.outside++;
    totals.outside++;
    if (label === null) return;
    const key = `${kind}\n${edge.target}`;
    let target = outsideTargets.get(key);
    if (!target) {
      outsideTargets.set(key, (target = { id: edge.target, label, relations: 0 }));
      group.targets.push(target);
    }
    target.relations++;
  };
  const inbound = new Map<InboundKind, InboundGroup>();
  const inboundSources = new Map<string, InboundSource>();
  const inboundTargets = new Map<string, number>();
  /**
   * A reference written outside the folder: kept when a real file writes it to the folder itself or to
   * a real file or folder of one of its items (a missing destination is not in the folder).
   */
  const into = (edge: Relation) => {
    const from = byId.get(edge.source),
      to = byId.get(edge.target);
    if (!from || !to || !inventoried(from) || !inventoried(to)) return;
    let target: FolderItem | null = null;
    if (edge.target !== folder) {
      const id = itemOf(edge.target);
      target = (id !== null && items.get(id)) || null;
      if (!target) return;
    }
    const other = from.root ?? projectOf(model, from.path);
    const kind: InboundKind = !target
      ? 'self'
      : other && other === project
        ? 'project'
        : other
          ? 'other-project'
          : 'outside';
    let group = inbound.get(kind);
    if (!group)
      inbound.set(kind, (group = { kind, relations: [], sources: [], targets: [], projects: [] }));
    group.relations.push(edge);
    // A file of another open project is written from that project, as the box outside writes it.
    const elsewhere = other && other !== project ? other : null;
    if (elsewhere && !group.projects.includes(basename(elsewhere)))
      group.projects.push(basename(elsewhere));
    const key = `${kind}\n${from.path}`;
    let source = inboundSources.get(key);
    if (!source) {
      const label = elsewhere
        ? `${basename(elsewhere)}/${relativeTo(elsewhere, from.path)}`
        : relativeTo(folder, from.path);
      inboundSources.set(key, (source = { id: from.path, label, relations: 0 }));
      group.sources.push(source);
    }
    source.relations++;
    if (target) {
      target.inbound++;
      const pair = `${kind}\n${target.id}`;
      if (!inboundTargets.has(pair)) group.targets.push(target.id);
      inboundTargets.set(pair, (inboundTargets.get(pair) ?? 0) + 1);
    }
    totals.inbound++;
  };
  for (const edge of model.edges) {
    if (!conventions && edge.kind === 'scope') continue;
    const sourceItem = itemOf(edge.source);
    const source = sourceItem ? items.get(sourceItem) : undefined;
    if (!source) {
      if (sourceItem === null && edge.source !== folder) into(edge);
      continue;
    }
    totals.written++;
    const node = byId.get(edge.target);
    const placeholder = !node || node.kind === 'unresolved' || outsideInventory.has(node.status);
    if (placeholder) {
      away(
        PLACEHOLDER[node?.status ?? 'missing'] ?? 'missing',
        edge,
        source.id,
        relativeTo(folder, edge.target),
      );
      continue;
    }
    if (edge.target === folder) {
      away('self', edge, source.id, null);
      continue;
    }
    const targetItem = itemOf(edge.target);
    if (targetItem !== null) {
      const target = items.get(targetItem);
      if (!target) {
        // Inside the folder but under no inventoried child: only a reading that lost a folder.
        away('unread', edge, source.id, relativeTo(folder, edge.target));
        continue;
      }
      if (target === source) {
        const list = internal.get(source.id);
        if (list) list.push(edge);
        else internal.set(source.id, [edge]);
        source.internal++;
        totals.internal++;
        if (edge.source === edge.target) {
          source.selfReferences++;
          totals.selfReferences++;
        }
        continue;
      }
      const key = `${source.id}\n${target.id}`;
      let arrow = pairs.get(key);
      if (!arrow)
        pairs.set(
          key,
          (arrow = {
            id: `sum:${source.id}>${target.id}`,
            source: source.id,
            target: target.id,
            relations: [],
            conventions: true,
          }),
        );
      arrow.relations.push(edge);
      if (edge.kind !== 'scope') arrow.conventions = false;
      source.outgoing++;
      target.incoming++;
      totals.between++;
      continue;
    }
    const other = node.root ?? projectOf(model, node.path);
    if (other && other === project) away('project', edge, source.id, relativeTo(folder, node.path));
    else if (other)
      away(
        'other-project',
        edge,
        source.id,
        `${basename(other)}/${relativeTo(other, node.path)}`,
        basename(other),
      );
    else away('outside', edge, source.id, relativeTo(folder, node.path));
  }
  const order = new Map([...items.keys()].map((id, i) => [id, i]));
  const rank = (id: string) => order.get(id) ?? -1;
  for (const group of outside.values()) {
    group.targets.sort((a, b) => b.relations - a.relations || a.label.localeCompare(b.label));
    group.sources.sort((a, b) => rank(a) - rank(b));
  }
  for (const group of inbound.values()) {
    group.sources.sort((a, b) => b.relations - a.relations || a.label.localeCompare(b.label));
    const reached = (id: string) => inboundTargets.get(`${group.kind}\n${id}`) ?? 0;
    group.targets.sort((a, b) => reached(b) - reached(a) || rank(a) - rank(b));
  }
  return {
    folder,
    project,
    items: [...items.values()],
    arrows: [...pairs.values()].sort(
      (a, b) => rank(a.source) - rank(b.source) || rank(a.target) - rank(b.target),
    ),
    internal,
    outside: OUTSIDE_ORDER.filter((kind) => outside.has(kind)).map((kind) => outside.get(kind)!),
    inbound: INBOUND_ORDER.filter((kind) => inbound.has(kind)).map((kind) => inbound.get(kind)!),
    totals,
  };
}

/**
 * Columns of the linked items. Column 0 holds the instructions of the folder (AGENTS.md, CLAUDE.md), the
 * items that reference without being referenced here, and whatever leads back to them; the others take
 * their distance in steps from column 0, pushed right when an item of a later column references them.
 * The items of a cycle share a column (strongly connected components), so no arrow goes left.
 */
export function folderLayers(
  ids: string[],
  arrows: { source: string; target: string }[],
  entries: Set<string>,
) {
  const index = new Map(ids.map((id, i) => [id, i]));
  const next: number[][] = ids.map(() => []);
  for (const arrow of arrows) {
    const a = index.get(arrow.source),
      b = index.get(arrow.target);
    if (a !== undefined && b !== undefined && a !== b) next[a].push(b);
  }
  // Tarjan's strongly connected components, iterative.
  const component = new Array<number>(ids.length).fill(-1);
  const low = new Array<number>(ids.length).fill(0);
  const order = new Array<number>(ids.length).fill(-1);
  const stack: number[] = [];
  const onStack = new Array<boolean>(ids.length).fill(false);
  let counter = 0,
    components = 0;
  for (let start = 0; start < ids.length; start++) {
    if (order[start] >= 0) continue;
    const work: [number, number][] = [[start, 0]];
    order[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = true;
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      if (i < next[v].length) {
        frame[1]++;
        const w = next[v][i];
        if (order[w] < 0) {
          order[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], order[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === order[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          component[w] = components;
        } while (w !== v);
        components++;
      }
    }
  }
  const forward: Set<number>[] = Array.from({ length: components }, () => new Set());
  const backward: Set<number>[] = Array.from({ length: components }, () => new Set());
  next.forEach((targets, a) =>
    targets.forEach((b) => {
      if (component[a] !== component[b]) {
        forward[component[a]].add(component[b]);
        backward[component[b]].add(component[a]);
      }
    }),
  );
  // Column 0: components with an entry or with nothing pointing at them, and every ancestor of those.
  const first = new Set<number>();
  for (let c = 0; c < components; c++) if (!backward[c].size) first.add(c);
  ids.forEach((id, i) => entries.has(id) && first.add(component[i]));
  const queue = [...first];
  for (let i = 0; i < queue.length; i++)
    for (const up of backward[queue[i]])
      if (!first.has(up)) {
        first.add(up);
        queue.push(up);
      }
  // Distance from column 0, then pushed right by any component pointing at it (topological order).
  const distance = new Array<number>(components).fill(Infinity);
  const bfs = [...first];
  bfs.forEach((c) => (distance[c] = 0));
  for (let i = 0; i < bfs.length; i++)
    for (const down of forward[bfs[i]])
      if (distance[down] === Infinity) {
        distance[down] = distance[bfs[i]] + 1;
        bfs.push(down);
      }
  const layer = new Array<number>(components).fill(0);
  const pending = backward.map((set) => set.size);
  const ready = pending.flatMap((count, c) => (count ? [] : [c]));
  for (let i = 0; i < ready.length; i++) {
    const c = ready[i];
    if (!first.has(c)) layer[c] = Math.max(layer[c], distance[c] === Infinity ? 1 : distance[c]);
    for (const down of forward[c]) {
      layer[down] = Math.max(layer[down], layer[c]);
      if (--pending[down] === 0) ready.push(down);
    }
  }
  return new Map(ids.map((id, i) => [id, layer[component[i]]]));
}

export type Geometry = {
  cardWidth: number;
  /** Height of a card; one with more arrows on a side than fit there grows by one port at a time. */
  cardHeight: number;
  /** Least space between two columns; it grows with the lanes of the arrows that run in it. */
  corridor: number;
  /** Vertical space between two cards of a column. */
  gap: number;
  /**
   * Arrows a corridor draws at rest. They come in from the most references to the fewest (a tie: the
   * shortest first, then by the names of their two items) while every corridor they run in has one
   * left; the others are drawn for the card in focus.
   */
  lanes: number;
  /**
   * Room, in a corridor, for its lanes when some carry their number (a lane with a number is as wide as
   * it). Numbers come in the same order while it lasts; the others wait for the focus.
   */
  numbered: number;
};
export const WIDE: Geometry = {
  cardWidth: 252,
  cardHeight: 58,
  corridor: 108,
  gap: 16,
  lanes: 16,
  numbered: 320,
};
export const NARROW: Geometry = {
  cardWidth: 216,
  cardHeight: 58,
  corridor: 80,
  gap: 14,
  lanes: 12,
  numbered: 200,
};
/** Height of the slot an arrow takes in a column it only crosses, and of the label of a group. */
const PASS = 8;
/** How far down (in rows) the instructions of a folder may sit, centred on what they reference. */
const ENTRY_ROWS = 4;
const LABEL = 24;
/** Rows of the box "outside this folder" (the CSS gives them these heights). */
export const OUTSIDE_BOX = { pad: 10, title: 24, kind: 20, target: 17, more: 16, from: 18, gap: 6 };
export const OUTSIDE_TARGETS_SHOWN = 2;
export function outsideBoxHeight(groups: OutsideGroup[]) {
  const { pad, title, kind, target, more, from, gap } = OUTSIDE_BOX;
  return (
    pad * 2 +
    title +
    groups.reduce(
      (sum, group) =>
        sum +
        gap +
        kind +
        Math.min(OUTSIDE_TARGETS_SHOWN, group.targets.length) * target +
        (group.targets.length > OUTSIDE_TARGETS_SHOWN ? more : 0) +
        from,
      0,
    )
  );
}

/**
 * Rows of the box "from outside this folder" (the rows of the box outside: the same CSS): each group
 * has its kind, up to OUTSIDE_TARGETS_SHOWN files that write the references, a line with how many
 * more, and the items they reach (not for the folder itself).
 */
export function inboundBoxHeight(groups: InboundGroup[]) {
  const { pad, title, kind, target, more, from, gap } = OUTSIDE_BOX;
  return (
    pad * 2 +
    title +
    groups.reduce(
      (sum, group) =>
        sum +
        gap +
        kind +
        Math.min(OUTSIDE_TARGETS_SHOWN, group.sources.length) * target +
        (group.sources.length > OUTSIDE_TARGETS_SHOWN ? more : 0) +
        (group.targets.length ? from : 0),
      0,
    )
  );
}
/**
 * From the bottom of the box "from outside this folder" to the top of the first card: room for the
 * title of the first column (32 px above the cards) and a gap.
 */
const INBOUND_ABOVE = 48;
/** Cards in a column of the grid of a folder without arrows between its items. */
export const GRID_ROWS = 6;

/*
 * The room of the arrows, in px of the map. An arrow leaves a card at a port of its own, runs
 * straight to a lane of its own in the corridor, follows it up or down and runs straight to its port
 * on the other card: two arrows drawn at rest never share a line.
 */
/** From the top and the bottom of a card to its first and last ports. */
const PORT_PAD = 10;
/** Least distance between two ports of a side; with more ports than fit, the card grows. */
const PORT_PITCH = 6;
/** Distance between the ports of a side when they are few. */
const PORT_SPREAD = 20;
/** A number fits beside a port whose neighbours are this far; closer than that, it goes on the lane. */
const STUB_ROOM = 11;
/** From this distance on, the numbers beside neighbouring ports share one x; under it they alternate. */
const STUB_ALONE = 19;
/** Width of a lane without a number; one with a number is as wide as it. */
const TRACK = 8;
/** From a card to the first lane of a corridor. */
const EDGE = 12;
/** Length of the head of an arrow (the CSS marker has this size). */
export const ARROW_HEAD = 7;
/** Least distance between two parallel stretches of different arrows. */
const TOUCH = 5;
const RADIUS = 8;
/**
 * Two stretches that come from the two edges of a corridor this close in height have their rounded
 * corners near each other: the order of their lanes keeps the corners apart.
 */
const FACING = TOUCH + RADIUS;
/** Beyond the last lane of a corridor outside the columns. */
const OUTER = 6;
/**
 * The two lines of the arrows drawn only in focus meet a card this far from its top (the arrows that
 * reach it) and from its bottom (those that leave it): apart from its ports (PORT_PAD).
 */
const BUS_INSET = 4;
/** A corridor grows in steps of this width: one lane more seldom moves the columns at its right. */
const STEP = 16;
/** Height of the number of an arrow; its width follows its digits (the CSS takes both from here). */
export const NUMBER_HEIGHT = 16;
export const numberWidth = (count: number) => 10 + Math.ceil(6.5 * String(count).length);
/** Width of the line of an arrow: 1 reference 1.2 px, 10 about 2.4, 100 or more 3.5. */
export const arrowStroke = (count: number) =>
  Math.round(Math.min(3.5, 1.2 + 1.15 * Math.log10(Math.max(1, count))) * 10) / 10;

export type CardPlace = {
  id: string;
  column: number;
  x: number;
  y: number;
  height: number;
  /** `entry`: instructions of the folder; `source`: others in column 0; `cited`: the rest. */
  group: 'entry' | 'source' | 'cited';
};
/**
 * What the title of a column says: only what is true of every card in it (its ↙ and ↗ count the
 * references with every other item of the folder, those left out by the limit included).
 *
 * - Column 0 with instructions: `entries`. Without: `sources` (each references, none is referenced),
 *   `both` (each references and is referenced: items that cite each other in a cycle), `referencing`
 *   (each references), `referenced` (each is referenced, by items left out by the limit) or `none`
 *   (no title).
 * - Another column, by the fewest steps from a card of column 0 to each card (arrows of the map):
 *   `direct` (1 for every card), `steps` (`steps` for every card) or `range` (from `steps` to `upTo`).
 *   A cycle or a card pushed right by an arrow of its column mixes them.
 */
export type ColumnTitleKind =
  | 'entries'
  | 'sources'
  | 'both'
  | 'referencing'
  | 'referenced'
  | 'none'
  | 'direct'
  | 'steps'
  | 'range';
export type ColumnTitle = {
  column: number;
  x: number;
  kind: ColumnTitleKind;
  steps: number;
  upTo: number;
};
/** The box of the number of an arrow, by its centre. */
export type NumberBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** No place free of the lines of other arrows at rest: shown only while the arrow is in focus. */
  quiet: boolean;
};
export type Route = {
  arrow: FolderArrow;
  /** SVG path, in map coordinates; it ends where the head of the arrow starts. */
  d: string;
  /** The corners of the line before they are rounded, from the card it leaves to the head. */
  points: [number, number][];
  /** Where the number goes (null with one reference). */
  label: NumberBox | null;
  /** Width of the line, by the number of references. */
  stroke: number;
  shape: 'next' | 'skip' | 'same';
  sourceColumn: number;
  targetColumn: number;
  /** Not drawn at rest: drawn for one of its cards in focus, on the lines of that card it shares. */
  waits?: boolean;
};
export type FolderLayout = {
  geometry: Geometry;
  cards: CardPlace[];
  columns: ColumnTitle[];
  /**
   * The label above the items of column 0 that are not instructions: "Others that reference" when each
   * of them references (`referencing`), else only "Other items".
   */
  others: { x: number; y: number; referencing: boolean } | null;
  routes: Route[];
  outsideBox: { x: number; y: number; width: number; height: number } | null;
  /** The box of the references from outside: above the first column, over its title. */
  inboundBox: { x: number; y: number; width: number; height: number } | null;
  /**
   * The whole drawing, lanes outside the columns included: what a framing has to fit. The first column
   * starts at x 0, so the lanes at its left start at `left` (0 or less); the cards start at y 0, so the
   * box from outside above them starts at `top` (0 or less). `height` runs from `top`.
   */
  left: number;
  top: number;
  width: number;
  height: number;
  /** No arrow between the items: the cards in a grid, without titles, ports or arrows. */
  grid: boolean;
  /** Items with at least one arrow; those drawn; those left out by the limit; those without arrows. */
  linked: string[];
  shown: string[];
  omitted: string[];
  unlinked: string[];
  /** References of the arrows that touch an item left out by the limit (not drawn). */
  hidden: number;
  /**
   * Arrows between two cards of the map that are not drawn at rest: their corridor had no lane left
   * for them, or their line would have run along another one. `folderFocus` draws those of one card.
   */
  undrawn: FolderArrow[];
  /** Numbers of arrows drawn at rest without a place free of other arrows (shown in focus). */
  quiet: number;
  /** Pairs of arrows that cross between two neighbouring columns. */
  crossings: number;
};

type Slot = {
  id: string;
  kind: 'card' | 'pass' | 'label';
  column: number;
  height: number;
  y: number;
  /** Slots of the previous and of the next column it is joined to. */
  up: Slot[];
  down: Slot[];
  weight: number;
};
/** One end of a stretch of an arrow in a corridor: on its left edge (`L`) or on its right edge. */
type End = {
  slot: Slot;
  edge: 'L' | 'R';
  y: number;
  net: Net;
  hop: Hop;
  other: End;
  /** Position among the ports of its side of the card, and the distance to the nearest of them. */
  index: number;
  room: number;
};
/** The stretch of an arrow in one corridor: between two columns, or a loop on one side of a column. */
type Hop = { channel: number; from: End; to: End; loop: boolean; track: number; x: number };
type Net = {
  arrow: FolderArrow;
  /** Place among the arrows by references (0: the most). */
  rank: number;
  shape: Route['shape'];
  hops: Hop[];
  count: number;
  width: number;
  /** The number goes beside this port, or on the lane of this stretch, at this height. */
  stub: End | null;
  lane: Hop | null;
  laneY: number;
};
type Line = 'L:out' | 'L:into' | 'R:into' | 'R:out';
type Channel = {
  left: number;
  width: number;
  marginLeft: number;
  marginRight: number;
  tracks: number[];
  /** Widest number beside a port of each edge, and how many of them alternate there. */
  zone: { L: number; R: number };
  turns: { L: number; R: number };
  /**
   * x of the lines of the arrows drawn only in focus, by the edge they keep beside and by the card in
   * focus (`out`: they leave it; `into`: they reach it).
   */
  lines: Partial<Record<Line, number>>;
  busRoom: number;
};

const layoutCache: Cache<FolderLayout> = new WeakMap();
/** Positions and routes of a folder map; kept per model, folder, conventions and geometry. */
export function folderLayout(
  model: Model,
  folder: string,
  conventions: boolean,
  geometry: Geometry = WIDE,
  limit = FOLDER_MAP_LIMIT,
): FolderLayout {
  return cached(
    layoutCache,
    model,
    `${conventions}\n${geometry.cardWidth}\n${limit}\n${folder}`,
    () => layoutSums(folderSums(model, folder, conventions), geometry, limit),
  );
}

type Focus = { card: (id: string) => Route[]; arrow: (id: string) => Route | null };
const focusCache = new WeakMap<FolderLayout, Focus>();
/**
 * Every arrow of one card, for while it is in focus: those drawn at rest stay where they are, and
 * those that wait (`undrawn`) run on two lines of each corridor, one for the arrows that leave the card
 * and one for those that reach it, which they share. The number of each one goes on its own line where
 * no other line of the card, no number and no card is.
 */
export function folderFocus(layout: FolderLayout, id: string): Route[] {
  return focusCache.get(layout)?.card(id) ?? [];
}
/** One arrow drawn at rest, in focus (the pointer on it): its number shown, also one that waits. */
export function folderArrowFocus(layout: FolderLayout, id: string): Route | null {
  return focusCache.get(layout)?.arrow(id) ?? null;
}

/** Weighted isotonic regression with minimum separations: tops as close as possible to the wishes. */
function place(
  slots: Slot[],
  wish: (slot: Slot) => number,
  separation: (a: Slot, b: Slot) => number,
) {
  const offsets: number[] = [];
  let offset = 0;
  slots.forEach((slot, i) => {
    if (i) offset += slots[i - 1].height + separation(slots[i - 1], slot);
    offsets.push(offset);
  });
  const blocks: { value: number; weight: number; count: number }[] = [];
  slots.forEach((slot, i) => {
    blocks.push({ value: wish(slot) - offsets[i], weight: slot.weight, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1],
        before = blocks[blocks.length - 2];
      if (before.value <= last.value) break;
      const weight = before.weight + last.weight;
      before.value = (before.value * before.weight + last.value * last.weight) / weight;
      before.weight = weight;
      before.count += last.count;
      blocks.pop();
    }
  });
  let i = 0;
  for (const block of blocks)
    for (let k = 0; k < block.count; k++, i++) slots[i].y = block.value + offsets[i];
}

const round = (value: number) => Math.round(value * 100) / 100;
/** A line through the points, each corner rounded as far as its two stretches allow. */
function corners(points: [number, number][]) {
  const kept: [number, number][] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01)
      continue;
    const before = kept[kept.length - 2];
    // A point on the line of the two before it only extends that line.
    if (
      before &&
      ((Math.abs(before[0] - last[0]) < 0.01 && Math.abs(last[0] - point[0]) < 0.01) ||
        (Math.abs(before[1] - last[1]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01))
    )
      kept[kept.length - 1] = point;
    else kept.push([point[0], point[1]]);
  }
  return kept;
}
function roundedPath(points: [number, number][]) {
  const kept = corners(points);
  let d = `M ${round(kept[0][0])},${round(kept[0][1])}`;
  for (let i = 1; i < kept.length; i++) {
    const [x, y] = kept[i];
    if (i === kept.length - 1) {
      d += ` L ${round(x)},${round(y)}`;
      break;
    }
    const [px, py] = kept[i - 1],
      [nx, ny] = kept[i + 1];
    const before = Math.hypot(x - px, y - py),
      after = Math.hypot(nx - x, ny - y);
    const r = Math.min(RADIUS, before / 2, after / 2);
    const ax = x - ((x - px) / before) * r,
      ay = y - ((y - py) / before) * r;
    const bx = x + ((nx - x) / after) * r,
      by = y + ((ny - y) / after) * r;
    d += ` L ${round(ax)},${round(ay)} Q ${round(x)},${round(y)} ${round(bx)},${round(by)}`;
  }
  return d;
}

type Box = { left: number; top: number; right: number; bottom: number };
const meets = (a: Box, b: Box) =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;
/** A stretch of a line, `pad` thick on each side of its middle. */
type Segment = { x1: number; y1: number; x2: number; y2: number; pad: number };
/** Whether the stretch passes inside the box (clipped as Liang and Barsky do). */
function crosses(box: Box, s: Segment) {
  const left = box.left + 0.5 - s.pad,
    right = box.right - 0.5 + s.pad,
    top = box.top + 0.5 - s.pad,
    bottom = box.bottom - 0.5 + s.pad;
  const dx = s.x2 - s.x1,
    dy = s.y2 - s.y1;
  let t0 = 0,
    t1 = 1;
  for (const [p, q] of [
    [-dx, s.x1 - left],
    [dx, right - s.x1],
    [-dy, s.y1 - top],
    [dy, bottom - s.y1],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}
/** The stretches of a route as drawn: its straight parts, the chord of each rounded corner, its head. */
function segmentsOf(route: Route): Segment[] {
  const kept = corners(route.points);
  const pad = route.stroke / 2;
  const segments: Segment[] = [];
  for (let i = 1; i < kept.length; i++)
    segments.push({ x1: kept[i - 1][0], y1: kept[i - 1][1], x2: kept[i][0], y2: kept[i][1], pad });
  for (let i = 1; i + 1 < kept.length; i++) {
    const [px, py] = kept[i - 1],
      [x, y] = kept[i],
      [nx, ny] = kept[i + 1];
    const before = Math.hypot(x - px, y - py),
      after = Math.hypot(nx - x, ny - y);
    const r = Math.min(RADIUS, before / 2, after / 2);
    segments.push({
      x1: x - ((x - px) / before) * r,
      y1: y - ((y - py) / before) * r,
      x2: x + ((nx - x) / after) * r,
      y2: y + ((ny - y) / after) * r,
      pad,
    });
  }
  const [ax, ay] = kept[kept.length - 2] ?? kept[0],
    [bx, by] = kept[kept.length - 1];
  const length = Math.hypot(bx - ax, by - ay) || 1;
  segments.push({
    x1: bx,
    y1: by,
    x2: bx + ((bx - ax) / length) * ARROW_HEAD,
    y2: by + ((by - ay) / length) * ARROW_HEAD,
    pad: ARROW_HEAD / 2,
  });
  return segments;
}

/**
 * The title of each column, true of every card in it (see `ColumnTitle`), and whether every item of
 * column 0 that is not an instruction references. `sums` gives the ↙ and ↗ of a card; the steps run
 * on the arrows of the map, from the cards of column 0.
 */
export function columnTitles(
  shown: string[],
  arrows: { source: string; target: string }[],
  layers: Map<string, number>,
  entries: Set<string>,
  sums: Map<string, { incoming: number; outgoing: number }>,
) {
  const count = shown.length ? Math.max(...shown.map((id) => layers.get(id)!)) + 1 : 0;
  const steps = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const arrow of arrows) {
    const list = next.get(arrow.source);
    if (list) list.push(arrow.target);
    else next.set(arrow.source, [arrow.target]);
  }
  const queue = shown.filter((id) => layers.get(id) === 0);
  queue.forEach((id) => steps.set(id, 0));
  for (let i = 0; i < queue.length; i++)
    for (const target of next.get(queue[i]) ?? [])
      if (!steps.has(target)) {
        steps.set(target, steps.get(queue[i])! + 1);
        queue.push(target);
      }
  const every = (ids: string[], test: (item: { incoming: number; outgoing: number }) => boolean) =>
    ids.every((id) => test(sums.get(id)!));
  const titles = Array.from({ length: count }, (_, column) => {
    const ids = shown.filter((id) => layers.get(id) === column);
    if (column === 0) {
      const kind: ColumnTitleKind = entries.size
        ? 'entries'
        : every(ids, (item) => !item.incoming)
          ? 'sources'
          : every(ids, (item) => item.incoming > 0 && item.outgoing > 0)
            ? 'both'
            : every(ids, (item) => item.outgoing > 0)
              ? 'referencing'
              : every(ids, (item) => item.incoming > 0)
                ? 'referenced'
                : 'none';
      return { kind, steps: 0, upTo: 0 };
    }
    const found = ids.map((id) => steps.get(id) ?? Infinity);
    const least = Math.min(...found),
      most = Math.max(...found);
    // Every card of a later column is referenced by another card: a cycle shares a column, and a
    // component outside column 0 has an arrow into it. Unreachable would mean a broken layering.
    if (!Number.isFinite(most)) return { kind: 'referenced' as const, steps: 0, upTo: 0 };
    const kind: ColumnTitleKind = least !== most ? 'range' : least === 1 ? 'direct' : 'steps';
    return { kind, steps: least, upTo: most };
  });
  const others = shown.filter((id) => layers.get(id) === 0 && !entries.has(id));
  return { titles, othersReference: every(others, (item) => item.outgoing > 0) };
}

/** The box from outside above the first column (at x 0), or null without references from outside. */
function inboundPlace(sums: FolderSums, cardWidth: number) {
  if (!sums.inbound.length) return null;
  const height = inboundBoxHeight(sums.inbound);
  return { x: 0, y: -INBOUND_ABOVE - height, width: cardWidth, height };
}

/**
 * A folder without arrows between its items: its items as cards, in the order of the Structure, in
 * columns of up to GRID_ROWS (as many columns as that takes, each as full as the others), one
 * corridor apart. Over the limit, the items with the most references (inside them, to outside and
 * from outside) stay; the rest is counted. The box from outside above the first column, the box
 * outside at the end of the last one.
 */
function gridLayout(sums: FolderSums, geometry: Geometry, limit: number): FolderLayout {
  const { cardWidth, cardHeight, corridor, gap } = geometry;
  let chosen = sums.items;
  if (chosen.length > limit) {
    const weight = (item: FolderItem) => item.internal + item.outside + item.inbound;
    const position = new Map(sums.items.map((item, i) => [item.id, i]));
    const kept = new Set(
      [...sums.items]
        .sort((a, b) => weight(b) - weight(a) || position.get(a.id)! - position.get(b.id)!)
        .slice(0, limit)
        .map((item) => item.id),
    );
    chosen = sums.items.filter((item) => kept.has(item.id));
  }
  const shownSet = new Set(chosen.map((item) => item.id));
  const columnCount = Math.ceil(chosen.length / GRID_ROWS);
  // The first `n % columns` columns take one card more than the others (13 cards: 5, 4 and 4).
  const rows = columnCount ? Math.ceil(chosen.length / columnCount) : 0;
  const fuller = chosen.length % columnCount || columnCount;
  const lefts = Array.from({ length: columnCount }, (_, c) => c * (cardWidth + corridor));
  const cards: CardPlace[] = chosen.map((item, i) => {
    const column =
      i < fuller * rows
        ? Math.floor(i / rows)
        : fuller + Math.floor((i - fuller * rows) / (rows - 1));
    const row = i < fuller * rows ? i % rows : (i - fuller * rows) % (rows - 1);
    return {
      id: item.id,
      column,
      x: lefts[column],
      y: row * (cardHeight + gap),
      height: cardHeight,
      group: item.node.kind === 'entry' ? 'entry' : 'cited',
    };
  });
  let bottom = Math.max(0, ...cards.map((card) => card.y + card.height));
  let outsideBox: FolderLayout['outsideBox'] = null;
  if (sums.outside.length && columnCount) {
    const last = cards.filter((card) => card.column === columnCount - 1);
    const height = outsideBoxHeight(sums.outside);
    outsideBox = {
      x: lefts[columnCount - 1],
      y: Math.max(...last.map((card) => card.y + card.height)) + 28,
      width: cardWidth,
      height,
    };
    bottom = Math.max(bottom, outsideBox.y + height);
  }
  const inboundBox = columnCount ? inboundPlace(sums, cardWidth) : null;
  const top = inboundBox?.y ?? 0;
  return {
    geometry,
    cards,
    columns: lefts.map((x, column) => ({ column, x, kind: 'none', steps: 0, upTo: 0 })),
    others: null,
    routes: [],
    outsideBox,
    inboundBox,
    left: 0,
    top,
    width: columnCount ? columnCount * cardWidth + (columnCount - 1) * corridor : 0,
    height: bottom - top,
    grid: true,
    linked: [],
    shown: chosen.map((item) => item.id),
    omitted: sums.items.filter((item) => !shownSet.has(item.id)).map((item) => item.id),
    unlinked: [],
    hidden: 0,
    undrawn: [],
    quiet: 0,
    crossings: 0,
  };
}

function layoutSums(sums: FolderSums, geometry: Geometry, limit: number): FolderLayout {
  if (!sums.arrows.length && sums.items.length) return gridLayout(sums, geometry, limit);
  const { cardWidth, cardHeight, corridor, gap } = geometry;
  const byItem = new Map(sums.items.map((item) => [item.id, item]));
  const linkedSet = new Set(sums.arrows.flatMap((arrow) => [arrow.source, arrow.target]));
  const linked = sums.items.filter((item) => linkedSet.has(item.id)).map((item) => item.id);
  const unlinked = sums.items.filter((item) => !linkedSet.has(item.id)).map((item) => item.id);
  const entries = new Set(linked.filter((id) => byItem.get(id)!.node.kind === 'entry'));
  // Over the limit: the instructions first, then the items with the most references (so the cards
  // drawn keep their arrows), then the nearest columns.
  let shown = linked;
  if (linked.length > limit) {
    const layers = folderLayers(linked, sums.arrows, entries);
    const weight = (id: string) => byItem.get(id)!.incoming + byItem.get(id)!.outgoing;
    const position = new Map(linked.map((id, i) => [id, i]));
    const chosen = new Set(
      [...linked]
        .sort(
          (a, b) =>
            Number(entries.has(b)) - Number(entries.has(a)) ||
            weight(b) - weight(a) ||
            layers.get(a)! - layers.get(b)! ||
            position.get(a)! - position.get(b)!,
        )
        .slice(0, limit),
    );
    shown = linked.filter((id) => chosen.has(id));
  }
  const shownSet = new Set(shown);
  const omitted = linked.filter((id) => !shownSet.has(id));
  const arrows = sums.arrows.filter((a) => shownSet.has(a.source) && shownSet.has(a.target));
  const hidden = sums.arrows
    .filter((a) => !shownSet.has(a.source) || !shownSet.has(a.target))
    .reduce((sum, a) => sum + a.relations.length, 0);
  const layers = folderLayers(shown, arrows, entries);
  const columnCount = shown.length ? Math.max(...shown.map((id) => layers.get(id)!)) + 1 : 0;
  const group = (id: string): CardPlace['group'] =>
    entries.has(id) ? 'entry' : layers.get(id) === 0 ? 'source' : 'cited';
  const nameOf = (id: string) => byItem.get(id)?.node.name ?? id;
  const name = (s: Slot) => nameOf(s.id);
  const middle = (s: Slot) => s.y + s.height / 2;
  // Corridor `c + 1` lies at the right of column `c`; corridor 0, at the left of the first column.
  // The loops of a column run on its side with fewer arrows to other columns (on the right when
  // both have as many): at the left of the first column when there are others, at the right of the
  // last one, and never in the way of the arrows of a column in the middle when the other side is
  // freer.
  const crossing = Array.from({ length: columnCount + 1 }, () => 0);
  for (const arrow of arrows)
    for (let c = layers.get(arrow.source)! + 1; c <= layers.get(arrow.target)!; c++) crossing[c]++;
  const loopsLeft = (column: number) => crossing[column] < crossing[column + 1];
  const loopChannel = (column: number) => (loopsLeft(column) ? column : column + 1);
  const channelsOf = (arrow: FolderArrow) => {
    const from = layers.get(arrow.source)!,
      to = layers.get(arrow.target)!;
    return from === to
      ? [loopChannel(from)]
      : Array.from({ length: to - from }, (_, i) => from + 1 + i);
  };

  // 1. Order of each column, from every arrow between the cards (so the arrows drawn at rest never move
  //    a card). Slots: the cards, and a passage in each column an arrow crosses.
  const columns: Slot[][] = Array.from({ length: columnCount }, () => []);
  const slots = new Map<string, Slot>();
  const slot = (id: string, kind: Slot['kind'], column: number, height: number, weight: number) => {
    const made: Slot = { id, kind, column, height, y: 0, up: [], down: [], weight };
    columns[column].push(made);
    slots.set(id, made);
    return made;
  };
  for (const id of shown) slot(id, 'card', layers.get(id)!, cardHeight, 1);
  const chains = new Map<string, Slot[]>();
  for (const arrow of arrows) {
    const from = layers.get(arrow.source)!,
      to = layers.get(arrow.target)!;
    if (from === to) continue;
    const chain = [slots.get(arrow.source)!];
    for (let column = from + 1; column < to; column++)
      chain.push(slot(`pass:${arrow.id}:${column}`, 'pass', column, PASS, 0.5));
    chain.push(slots.get(arrow.target)!);
    for (let i = 1; i < chain.length; i++) {
      chain[i - 1].down.push(chain[i]);
      chain[i].up.push(chain[i - 1]);
    }
    chains.set(arrow.id, chain);
  }
  // Order inside each column: barycentres, sweeping right and left, keeping the fewest crossings.
  const rankInGroup = (s: Slot) =>
    s.kind === 'card' ? ['entry', 'source', 'cited'].indexOf(group(s.id)) : 2;
  columns.forEach((column) =>
    column.sort((a, b) => rankInGroup(a) - rankInGroup(b) || name(a).localeCompare(name(b))),
  );
  const position = new Map<Slot, number>();
  const index = () => columns.forEach((column) => column.forEach((s, i) => position.set(s, i)));
  index();
  const crossingsOf = () => {
    let total = 0;
    for (let c = 0; c + 1 < columns.length; c++) {
      const segments: [number, number][] = [];
      for (const s of columns[c])
        for (const d of s.down) segments.push([position.get(s)!, position.get(d)!]);
      for (let i = 0; i < segments.length; i++)
        for (let j = i + 1; j < segments.length; j++)
          if ((segments[i][0] - segments[j][0]) * (segments[i][1] - segments[j][1]) < 0) total++;
    }
    return total;
  };
  const sweep = (c: number, side: 'up' | 'down') => {
    const column = columns[c];
    const centre = new Map<Slot, number>();
    for (const s of column) {
      const near = s[side];
      centre.set(
        s,
        near.length
          ? near.reduce((sum, n) => sum + position.get(n)!, 0) / near.length
          : position.get(s)!,
      );
    }
    column.sort(
      (a, b) =>
        (c === 0 ? rankInGroup(a) - rankInGroup(b) : 0) ||
        centre.get(a)! - centre.get(b)! ||
        position.get(a)! - position.get(b)!,
    );
    column.forEach((s, i) => position.set(s, i));
  };
  let best = crossingsOf();
  let bestOrder = columns.map((column) => [...column]);
  for (let round = 0; round < 6 && best > 0; round++) {
    for (let c = 1; c < columns.length; c++) sweep(c, 'up');
    for (let c = columns.length - 2; c >= 0; c--) sweep(c, 'down');
    const found = crossingsOf();
    if (found < best) {
      best = found;
      bestOrder = columns.map((column) => [...column]);
    }
  }
  bestOrder.forEach((order, c) => (columns[c] = order));
  index();
  const pairCost = (u: Slot, v: Slot) => {
    let cost = 0;
    for (const side of ['up', 'down'] as const)
      for (const a of u[side])
        for (const b of v[side]) if (position.get(a)! > position.get(b)!) cost++;
    return cost;
  };
  for (let round = 0, changed = true; changed && round < 12; round++) {
    changed = false;
    columns.forEach((column, c) => {
      for (let i = 0; i + 1 < column.length; i++) {
        const u = column[i],
          v = column[i + 1];
        if (c === 0 && rankInGroup(u) !== rankInGroup(v)) continue;
        if (pairCost(v, u) < pairCost(u, v)) {
          column[i] = v;
          column[i + 1] = u;
          position.set(v, i);
          position.set(u, i + 1);
          changed = true;
        }
      }
    });
  }
  if (crossingsOf() > best) {
    bestOrder.forEach((order, c) => (columns[c] = order));
    index();
  }
  index();
  // "Others that reference": a label above the first item of column 0 that is not an instruction.
  let othersLabel: Slot | null = null;
  if (columns.length) {
    const first = columns[0].findIndex((s) => s.kind === 'card' && group(s.id) === 'source');
    if (first > 0 && entries.size) {
      othersLabel = {
        id: 'label:others',
        kind: 'label',
        column: 0,
        height: LABEL,
        y: 0,
        up: [],
        down: [],
        weight: 0.001,
      };
      columns[0].splice(first, 0, othersLabel);
    }
  }

  // Heights (step 4): the tallest column stacks from the top; the others follow their neighbours.
  const separation = (a: Slot, b: Slot) =>
    a.kind === 'card' && b.kind === 'card' ? gap : a.kind === 'label' || b.kind === 'label' ? 6 : 8;
  const stack = (column: Slot[]) =>
    column.forEach((s, i) => {
      s.y = i ? column[i - 1].y + column[i - 1].height + separation(column[i - 1], s) : 0;
    });
  const extent = (column: Slot[]) =>
    column.length ? column[column.length - 1].y + column[column.length - 1].height : 0;
  const heights = () => {
    columns.forEach(stack);
    const anchor = columns.reduce(
      (tallest, column, c) => (extent(column) > extent(columns[tallest]) ? c : tallest),
      0,
    );
    for (let round = 0; round < 4; round++) {
      const order = [
        ...Array.from({ length: columns.length }, (_, c) => c).filter((c) => c > anchor),
        ...Array.from({ length: columns.length }, (_, c) => c)
          .filter((c) => c < anchor)
          .reverse(),
      ];
      for (const c of order) {
        const column = columns[c];
        const wishes = new Map<Slot, number>();
        for (const s of column) {
          const near = [...s.up, ...s.down];
          wishes.set(
            s,
            near.length
              ? near.reduce((sum, n) => sum + middle(n), 0) / near.length - s.height / 2
              : s.y,
          );
          // The instructions, where reading starts, stay within the first rows: centred on twenty
          // targets they would open out of view.
          if (s.kind === 'card' && entries.has(s.id))
            wishes.set(s, Math.min(wishes.get(s)!, ENTRY_ROWS * (cardHeight + gap)));
        }
        column.forEach((s, i) => {
          if (s.kind === 'label' && column[i + 1])
            wishes.set(s, wishes.get(column[i + 1])! - s.height - separation(s, column[i + 1]));
        });
        place(column, (s) => wishes.get(s)!, separation);
      }
    }
    const top = Math.min(0, ...columns.map((column) => (column.length ? column[0].y : 0)));
    for (const column of columns) for (const s of column) s.y -= top;
  };

  // 2. The arrows at rest: from the most references to the fewest; as many, the shortest first, then
  //    by the names of the two items. Each comes in while every corridor it runs in has a lane left;
  //    the rest waits for the focus. The length of an arrow is the way between its two cards where
  //    they stand before any card grows for its ports: the height between their middles, plus the
  //    corridors and the columns between them.
  heights();
  const lengthOf = new Map(
    arrows.map((arrow) => {
      const a = slots.get(arrow.source)!,
        b = slots.get(arrow.target)!;
      const apart = Math.abs(b.column - a.column);
      const across = apart ? apart * corridor + (apart - 1) * cardWidth : 0;
      return [arrow, Math.round(Math.abs(middle(a) - middle(b)) + across)];
    }),
  );
  const ranked = [...arrows].sort(
    (a, b) =>
      b.relations.length - a.relations.length ||
      lengthOf.get(a)! - lengthOf.get(b)! ||
      nameOf(a.source).localeCompare(nameOf(b.source)) ||
      nameOf(a.target).localeCompare(nameOf(b.target)),
  );
  const rankOf = new Map(ranked.map((arrow, i) => [arrow, i]));
  const load = Array.from({ length: columnCount + 1 }, () => 0);
  const atRest = new Set<FolderArrow>();
  for (const arrow of ranked) {
    const through = channelsOf(arrow);
    if (through.some((c) => load[c] >= geometry.lanes)) continue;
    through.forEach((c) => load[c]++);
    atRest.add(arrow);
  }

  // 3. Each arrow at rest as stretches, one per corridor.
  const nets: Net[] = [];
  const sides = new Map<string, End[]>();
  const sideOf = (e: End) => sides.get(`${e.edge}\n${e.slot.id}`)!;
  const hop = (net: Net, channel: number, a: Slot, b: Slot, loop: boolean) => {
    const edges: ['L' | 'R', 'L' | 'R'] = loop
      ? loopsLeft(a.column)
        ? ['R', 'R']
        : ['L', 'L']
      : ['L', 'R'];
    const made = { channel, loop, track: -1, x: 0 } as Hop;
    const end = (s: Slot, edge: 'L' | 'R') => {
      const e = { slot: s, edge, y: 0, net, hop: made, index: 0, room: -1 } as End;
      if (s.kind === 'card') {
        const key = `${edge}\n${s.id}`;
        const list = sides.get(key);
        if (list) list.push(e);
        else sides.set(key, [e]);
      }
      return e;
    };
    made.from = end(a, edges[0]);
    made.to = end(b, edges[1]);
    made.from.other = made.to;
    made.to.other = made.from;
    net.hops.push(made);
  };
  for (const arrow of arrows) {
    if (!atRest.has(arrow)) continue;
    const chain = chains.get(arrow.id);
    const count = arrow.relations.length;
    const net: Net = {
      arrow,
      rank: rankOf.get(arrow)!,
      shape: !chain ? 'same' : chain.length > 2 ? 'skip' : 'next',
      hops: [],
      count,
      width: numberWidth(count),
      stub: null,
      lane: null,
      laneY: 0,
    };
    if (!chain) {
      const source = slots.get(arrow.source)!;
      hop(net, loopChannel(source.column), source, slots.get(arrow.target)!, true);
    } else
      for (let i = 1; i < chain.length; i++)
        hop(net, chain[i - 1].column + 1, chain[i - 1], chain[i], false);
    nets.push(net);
  }
  // A card with more arrows on a side than ports fit there grows.
  for (const list of sides.values()) {
    const s = list[0].slot;
    s.height = Math.max(s.height, 2 * PORT_PAD + (list.length - 1) * PORT_PITCH);
  }

  // 4. Heights again, with the cards that grew.
  heights();

  // 5. Ports. On a side, from the top: the loops to cards above (the nearest first), the arrows to
  //    the other column by the height of their other end, the loops to cards below (the nearest
  //    last): arrows of one card do not cross each other on their way out.
  for (const list of sides.values()) {
    const s = list[0].slot;
    const here = middle(s);
    const rank = (e: End): [number, number] => {
      const there = middle(e.other.slot);
      if (!e.hop.loop) return [1, there];
      return there < here ? [0, here - there] : [2, there - here];
    };
    list.sort((a, b) => {
      const [groupA, keyA] = rank(a),
        [groupB, keyB] = rank(b);
      if (groupA !== groupB) return groupA - groupB;
      const ids = a.net.arrow.id.localeCompare(b.net.arrow.id);
      return groupA === 2 ? keyB - keyA || -ids : keyA - keyB || ids;
    });
    const pitch =
      list.length > 1 ? Math.min(PORT_SPREAD, (s.height - 2 * PORT_PAD) / (list.length - 1)) : 0;
    list.forEach((e, i) => {
      e.index = i;
      e.y = here + (i - (list.length - 1) / 2) * pitch;
    });
  }
  const channelHops: Hop[][] = Array.from({ length: columnCount + 1 }, () => []);
  for (const net of nets)
    for (const h of net.hops) {
      channelHops[h.channel].push(h);
      for (const e of [h.from, h.to]) if (e.slot.kind !== 'card') e.y = middle(e.slot);
    }
  // An arrow alone on a side of a card leaves or arrives at the height of its other end, straight,
  // when no other arrow of the corridor comes near that height (a straight line crosses all of it).
  const within = (e: End, y: number) =>
    y >= e.slot.y + PORT_PAD && y <= e.slot.y + e.slot.height - PORT_PAD;
  const alone = (e: End) => e.slot.kind === 'card' && sideOf(e).length === 1;
  const clear = (h: Hop, y: number) =>
    channelHops[h.channel].every(
      (o) =>
        o.from.net === h.from.net ||
        (Math.abs(o.from.y - y) >= TOUCH && Math.abs(o.to.y - y) >= TOUCH),
    );
  for (const net of nets)
    for (const h of net.hops) {
      if (h.loop) continue;
      if (alone(h.to) && within(h.to, h.from.y) && clear(h, h.from.y)) h.to.y = h.from.y;
      else if (alone(h.from) && within(h.from, h.to.y) && clear(h, h.to.y)) h.from.y = h.to.y;
    }
  const straight = (h: Hop) => !h.loop && Math.abs(h.from.y - h.to.y) <= 0.5;
  // A port on the right edge of a corridor at the height of a port of another arrow on its left edge
  // moves to the nearest free height of its card, when it has one (else the order of the lanes keeps
  // the two lines apart, below).
  for (const hops of channelHops) {
    const ends = hops.flatMap((h) => [h.from, h.to]);
    const left = ends.filter((e) => e.edge === 'L');
    const right = ends
      .filter((e) => e.edge === 'R' && e.slot.kind === 'card' && !straight(e.hop))
      .sort((a, b) => a.y - b.y || a.net.arrow.id.localeCompare(b.net.arrow.id));
    for (const r of right) {
      const clash = (y: number) => left.some((l) => l.net !== r.net && Math.abs(l.y - y) < TOUCH);
      if (!clash(r.y)) continue;
      const list = sideOf(r);
      const above = list[r.index - 1],
        below = list[r.index + 1];
      const low = above ? above.y + TOUCH : r.slot.y + PORT_PAD,
        high = below ? below.y - TOUCH : r.slot.y + r.slot.height - PORT_PAD;
      const fits = (y: number) => y >= low && y <= high && !clash(y);
      for (let d = 1; d <= 14; d++) {
        if (fits(r.y + d)) {
          r.y += d;
          break;
        }
        if (fits(r.y - d)) {
          r.y -= d;
          break;
        }
      }
    }
  }
  for (const list of sides.values())
    list.forEach((e, i) => {
      e.room = Math.min(
        i ? e.y - list[i - 1].y : Infinity,
        i + 1 < list.length ? list[i + 1].y - e.y : Infinity,
      );
    });

  // 6. Lanes. In each corridor, the stretches that go up or down are put in order from its left edge
  //    so that the fewest of them cross, then packed: two that do not meet in height share a lane.
  //    Two ends of different arrows on the two edges nearer than FACING fix the order: the stretch
  //    from the left edge turns first, so the one to the right edge starts after it and the two never
  //    run along each other, nor their corners. When the order cannot hold, or two ends nearer than
  //    TOUCH would share a line anyway, the arrow with fewer references waits for the focus.
  const waiting = new Set<Net>();
  const lanes: number[] = Array.from({ length: columnCount + 1 }, () => 0);
  const worse = (a: Net, b: Net) => (a.rank > b.rank ? a : b);
  const assign = (channel: number): Net | null => {
    const hops = channelHops[channel].filter((h) => !waiting.has(h.from.net));
    for (const h of hops) h.track = -1;
    const ends = hops.flatMap((h) => [h.from, h.to]);
    const leftOf = new Map<Hop, Hop[]>();
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) {
        const p = ends[i],
          q = ends[j];
        if (p.net === q.net || Math.abs(p.y - q.y) >= FACING) continue;
        const shared = p.edge === q.edge || straight(p.hop) || straight(q.hop);
        if (shared && Math.abs(p.y - q.y) < TOUCH) return worse(p.net, q.net);
        if (shared) continue;
        const [l, r] = p.edge === 'L' ? [p, q] : [q, p];
        const list = leftOf.get(r.hop);
        if (!list) leftOf.set(r.hop, [l.hop]);
        else if (!list.includes(l.hop)) list.push(l.hop);
      }
    type Item = { hop: Hop; low: number; high: number; left: number[]; right: number[] };
    const items: Item[] = hops
      .filter((h) => !straight(h))
      .map((h) => ({
        hop: h,
        low: Math.min(h.from.y, h.to.y),
        high: Math.max(h.from.y, h.to.y),
        left: [h.from, h.to].filter((e) => e.edge === 'L').map((e) => e.y),
        right: [h.from, h.to].filter((e) => e.edge === 'R').map((e) => e.y),
      }));
    // Crossings when `a` runs on a lane at the left of the lane of `b`.
    const inside = (y: number, item: Item) => y > item.low + 0.5 && y < item.high - 0.5;
    const cost = (a: Item, b: Item) =>
      a.right.filter((y) => inside(y, b)).length + b.left.filter((y) => inside(y, a)).length;
    const wish = items.map((a) => items.map((b) => (a === b ? 0 : cost(a, b) - cost(b, a))));
    const score = wish.map((row) => row.reduce((sum, value) => sum + value, 0));
    const pending = new Set(items.map((_, i) => i));
    const placed = new Set<Hop>();
    const before: Item[] = [];
    const blocked = (h: Hop) => (leftOf.get(h) ?? []).find((l) => !placed.has(l));
    let count = 0;
    while (pending.size) {
      let next = -1;
      for (const i of pending)
        if (
          !blocked(items[i].hop) &&
          (next < 0 ||
            score[i] < score[next] ||
            (score[i] === score[next] &&
              (items[i].low - items[next].low ||
                items[i].hop.from.net.arrow.id.localeCompare(items[next].hop.from.net.arrow.id)) <
                0))
        )
          next = i;
      if (next < 0) {
        // Every stretch left waits for another: a cycle. Its arrow with the fewest references waits
        // for the focus.
        let at = items[pending.values().next().value!].hop;
        const seen = new Set<Hop>();
        while (!seen.has(at)) {
          seen.add(at);
          at = blocked(at)!;
        }
        let out = at.from.net;
        for (let k = blocked(at)!; k !== at; k = blocked(k)!) out = worse(out, k.from.net);
        return out;
      }
      pending.delete(next);
      for (const i of pending) score[i] -= wish[i][next];
      const item = items[next];
      let track = 0;
      for (const done of before)
        if (done.low - RADIUS < item.high && item.low - RADIUS < done.high)
          track = Math.max(track, done.hop.track + 1);
      item.hop.track = track;
      count = Math.max(count, track + 1);
      placed.add(item.hop);
      before.push(item);
    }
    lanes[channel] = count;
    return null;
  };
  for (;;) {
    let found: Net | null = null;
    for (let c = 0; c <= columnCount && !found; c++) found = assign(c);
    if (!found) break;
    waiting.add(found);
  }
  const live = nets.filter((net) => !waiting.has(net));
  const liveHops = channelHops.map((hops) => hops.filter((h) => !waiting.has(h.from.net)));

  // 7. Numbers, from the arrow with the most references: beside its port on the card it reaches, or on
  //    the one it leaves, when the ports there are apart enough (a place free by construction); else
  //    on its lane, at a height no other arrow crosses, the lane as wide as the number, while the lanes
  //    of the corridor keep within its room. The others wait for the focus.
  const widths = lanes.map((count) => Array.from({ length: count }, () => TRACK));
  for (const net of [...live].sort((a, b) => a.rank - b.rank)) {
    if (net.count < 2) continue;
    const first = net.hops[0].from,
      last = net.hops[net.hops.length - 1].to;
    net.stub = last.room >= STUB_ROOM ? last : first.room >= STUB_ROOM ? first : null;
    if (net.stub) continue;
    let lane: Hop | null = null;
    for (const h of net.hops) {
      const run = Math.abs(h.from.y - h.to.y);
      if (
        h.track >= 0 &&
        run >= NUMBER_HEIGHT + 6 &&
        (!lane || run > Math.abs(lane.from.y - lane.to.y))
      )
        lane = h;
    }
    if (!lane) continue;
    const crossed: number[] = [];
    for (const other of liveHops[lane.channel]) {
      if (other === lane) continue;
      for (const e of [other.from, other.to])
        if (
          other.track < 0 ||
          (e.edge === 'L' ? other.track > lane.track : other.track < lane.track)
        )
          crossed.push(e.y);
    }
    const low = Math.min(lane.from.y, lane.to.y) + NUMBER_HEIGHT / 2 + 2,
      high = Math.max(lane.from.y, lane.to.y) - NUMBER_HEIGHT / 2 - 2;
    const mid = (lane.from.y + lane.to.y) / 2;
    const free = (y: number) =>
      y >= low && y <= high && crossed.every((c) => Math.abs(c - y) >= NUMBER_HEIGHT / 2 + 3);
    let y: number | null = null;
    for (let d = 0; d <= high - low && y === null; d += 2)
      y = free(mid + d) ? mid + d : free(mid - d) ? mid - d : null;
    if (y === null) continue;
    const tracks = widths[lane.channel];
    const wide = Math.max(tracks[lane.track], net.width + 6);
    if (tracks.reduce((sum, w) => sum + w, 0) - tracks[lane.track] + wide > geometry.numbered)
      continue;
    tracks[lane.track] = wide;
    net.lane = lane;
    net.laneY = y;
  }
  /** A number that waits for the focus: neither beside a port nor on a lane at rest. */
  const waits = (net: Net) => net.count > 1 && !net.stub && !net.lane;

  // 8. The width of each corridor, and the columns from the left. The arrows that wait take lines in
  //    every corridor they run in, and their numbers a place beside the cards at their ends. A line
  //    keeps beside the cards at the far end from the card in focus: those of a loop beside its column;
  //    between two columns, the line of the arrows that leave the card in focus beside the right edge,
  //    and the line of those that reach it beside the left one. The stretch that crosses the corridor
  //    is then the one at the card in focus, which its arrows share.
  const drawn = new Set(live.map((net) => net.arrow));
  const undrawn = arrows.filter((arrow) => !drawn.has(arrow));
  const busOf = new Map<number, { edges: Set<'L' | 'R'>; lines: Set<Line>; width: number }>();
  /** The edge a line of `arrow` keeps beside in a corridor, by the role of the card in focus. */
  const lineOf = (arrow: FolderArrow, role: 'out' | 'into'): Line => {
    const column = layers.get(arrow.source)!;
    if (column === layers.get(arrow.target)) return `${loopsLeft(column) ? 'R' : 'L'}:${role}`;
    return role === 'out' ? 'R:out' : 'L:into';
  };
  for (const arrow of undrawn) {
    const through = channelsOf(arrow);
    const loop = layers.get(arrow.source) === layers.get(arrow.target);
    through.forEach((channel, i) => {
      let bus = busOf.get(channel);
      if (!bus) busOf.set(channel, (bus = { edges: new Set(), lines: new Set(), width: 0 }));
      if (loop) bus.edges.add(loopsLeft(layers.get(arrow.source)!) ? 'R' : 'L');
      else {
        if (i === 0) bus.edges.add('L');
        if (i === through.length - 1) bus.edges.add('R');
      }
      bus.lines.add(lineOf(arrow, 'out'));
      bus.lines.add(lineOf(arrow, 'into'));
      bus.width = Math.max(bus.width, numberWidth(arrow.relations.length));
    });
  }
  const channels: Channel[] = channelHops.map((_, channel) => {
    const hops = liveHops[channel];
    const tracks = widths[channel];
    // The margins: room for the head of an arrow and for the numbers beside the ports.
    const zone = { L: 0, R: 0 };
    const turns = { L: 0, R: 0 };
    const heads = { L: false, R: false };
    for (const h of hops) {
      const net = h.from.net;
      const first = net.hops[0].from,
        last = net.hops[net.hops.length - 1].to;
      if (last === h.to) heads[h.to.edge] = true;
      for (const e of [h.from, h.to])
        if (net.stub === e) {
          zone[e.edge] = Math.max(zone[e.edge], net.width);
          turns[e.edge] = Math.max(turns[e.edge], e.room >= STUB_ALONE ? 1 : 2);
        } else if (waits(net) && (e === first || e === last)) {
          // In focus, the numbers of a card line up beside the cards at the other end of its
          // arrows: room for them there, in two turns.
          zone[e.edge] = Math.max(zone[e.edge], net.width);
          turns[e.edge] = 2;
        }
    }
    const bus = busOf.get(channel);
    for (const edge of ['L', 'R'] as const)
      if (bus?.edges.has(edge)) {
        zone[edge] = Math.max(zone[edge], bus.width);
        turns[edge] = Math.max(turns[edge], 1);
        heads[edge] = true;
      }
    const margin = (edge: 'L' | 'R') =>
      turns[edge]
        ? ARROW_HEAD + 4 + turns[edge] * (zone[edge] + 4) + 4
        : heads[edge]
          ? ARROW_HEAD + 9
          : EDGE;
    const outside = channel === 0 || channel === columnCount;
    let marginLeft = channel === 0 ? OUTER : margin('L'),
      marginRight = channel === columnCount ? OUTER : margin('R');
    // The lines of the arrows drawn only in focus.
    const busRoom = (bus?.lines.size ?? 0) * (TRACK + 2);
    const inner = marginLeft + marginRight + busRoom + tracks.reduce((sum, w) => sum + w, 0);
    const stepped = Math.ceil(inner / STEP) * STEP;
    const width = outside ? (hops.length || bus ? stepped : 0) : Math.max(corridor, stepped);
    marginLeft += (width - inner) / 2;
    marginRight += (width - inner) / 2;
    return { left: 0, width, marginLeft, marginRight, tracks, zone, turns, lines: {}, busRoom };
  });
  const lefts: number[] = [];
  let x = 0;
  for (let c = 0; c < columnCount; c++) {
    lefts[c] = x;
    x += cardWidth + channels[c + 1].width;
  }
  channels.forEach((channel, c) => {
    channel.left = c ? lefts[c - 1] + cardWidth : -channel.width;
  });
  const drawingLeft = columnCount ? -channels[0].width : 0;
  const width = columnCount ? x - drawingLeft : 0;
  channels.forEach((channel, i) => {
    const lines = busOf.get(i)?.lines ?? new Set<Line>();
    // From the left edge: its lines in focus, the lanes, the lines in focus of the right edge.
    let at = channel.left + channel.marginLeft;
    for (const line of ['L:out', 'L:into'] as const)
      if (lines.has(line)) {
        channel.lines[line] = at + (TRACK + 2) / 2;
        at += TRACK + 2;
      }
    const centres = channel.tracks.map((w) => {
      at += w;
      return at - w / 2;
    });
    for (const h of liveHops[i]) if (h.track >= 0) h.x = centres[h.track];
    for (const line of ['R:into', 'R:out'] as const)
      if (lines.has(line)) {
        channel.lines[line] = at + (TRACK + 2) / 2;
        at += TRACK + 2;
      }
  });
  const edgeX = (e: End) => {
    const channel = channels[e.hop.channel];
    return e.edge === 'L' ? channel.left : channel.left + channel.width;
  };
  /** The centre of a number beside a port: after the head of the arrow, in the slot of the port. */
  const beside = (edge: 'L' | 'R', x: number, zone: number, slotIndex: number) => {
    const offset = ARROW_HEAD + 4 + slotIndex * (zone + 4) + zone / 2;
    return edge === 'L' ? x + offset : x - offset;
  };

  // 9. The routes drawn at rest.
  const routes: Route[] = live.map((net) => {
    const points: [number, number][] = [];
    for (const h of net.hops) {
      points.push([edgeX(h.from), h.from.y]);
      if (h.track >= 0) points.push([h.x, h.from.y], [h.x, h.to.y]);
      points.push([edgeX(h.to), h.to.y]);
    }
    const last = net.hops[net.hops.length - 1].to;
    points[points.length - 1][0] += last.edge === 'R' ? -(ARROW_HEAD - 1) : ARROW_HEAD - 1;
    let label: NumberBox | null = null;
    if (net.count > 1) {
      const box = (x: number, y: number, hush = false) => ({
        x: round(x),
        y: round(y),
        width: net.width,
        height: NUMBER_HEIGHT,
        quiet: hush,
      });
      const at = (e: End, turn: number) =>
        beside(e.edge, edgeX(e), channels[e.hop.channel].zone[e.edge], turn);
      if (net.stub) {
        const e = net.stub;
        label = box(at(e, e.room >= STUB_ALONE ? 0 : e.index % 2), e.y);
      } else if (net.lane) label = box(net.lane.x, net.laneY);
      else label = box(at(last, 0), last.y, true);
    }
    return {
      arrow: net.arrow,
      shape: net.shape,
      sourceColumn: net.hops[0].from.slot.column,
      targetColumn: last.slot.column,
      d: roundedPath(points),
      points,
      label,
      stroke: arrowStroke(net.count),
    };
  });
  let crossings = 0;
  for (let c = 1; c < columnCount; c++) {
    const stretches = liveHops[c].filter((h) => !h.loop).map((h) => [h.from.y, h.to.y]);
    for (let i = 0; i < stretches.length; i++)
      for (let j = i + 1; j < stretches.length; j++)
        if ((stretches[i][0] - stretches[j][0]) * (stretches[i][1] - stretches[j][1]) < 0)
          crossings++;
  }
  const cards: CardPlace[] = [];
  columns.forEach((column, c) =>
    column.forEach((s) => {
      if (s.kind === 'card')
        cards.push({
          id: s.id,
          column: c,
          x: lefts[c],
          y: s.y,
          height: s.height,
          group: group(s.id),
        });
    }),
  );
  let height = Math.max(0, ...columns.map(extent));
  let outsideBox: FolderLayout['outsideBox'] = null;
  if (sums.outside.length && columns.length) {
    const boxHeight = outsideBoxHeight(sums.outside);
    const last = columns[columns.length - 1];
    outsideBox = {
      x: lefts[columns.length - 1],
      y: last.length ? extent(last) + 28 : 0,
      width: cardWidth,
      height: boxHeight,
    };
    height = Math.max(height, outsideBox.y + boxHeight);
  }
  const inboundBox = columns.length ? inboundPlace(sums, cardWidth) : null;
  const top = inboundBox?.y ?? 0;

  // 10. Focus. The arrows of a card that wait run on two lines of each corridor: one leaves the card
  //     and branches to each card it references, through the passage of each column it crosses;
  //     another gathers, from each card that references it, into it. A line meets a card at its top
  //     or its bottom, apart from its ports, at the first of the two clear of the lines in focus.
  const placeOf = new Map(cards.map((card) => [card.id, card]));
  const atRestRoute = new Map(routes.map((route) => [route.arrow.id, route]));
  /** A straight stretch across a corridor, held at one of its edges (`L`, `R`) or at both. */
  type Flat = {
    channel: number;
    anchor: 'L' | 'R' | 'LR';
    a: number;
    b: number;
    y: number;
    /** The stretches the waiting arrows of the card in focus share on purpose. */
    shared?: string;
  };
  /**
   * Two stretches that would run along each other: nearer than TOUCH where they overlap, or, held at
   * the two edges, nearer than FACING with their rounded corners a short overlap apart.
   */
  const touches = (f: Flat, g: Flat) => {
    if (f.channel !== g.channel || (f.shared && f.shared === g.shared)) return false;
    const overlap = Math.min(f.b, g.b) - Math.max(f.a, g.a);
    const apart = Math.abs(f.y - g.y);
    return (
      overlap > 0.5 &&
      (apart < TOUCH ||
        (apart < FACING &&
          overlap < 2 * RADIUS + 3 &&
          f.anchor !== g.anchor &&
          f.anchor !== 'LR' &&
          g.anchor !== 'LR'))
    );
  };
  const flatsAtRest = new Map<FolderArrow, Flat[]>();
  for (const net of live)
    flatsAtRest.set(
      net.arrow,
      net.hops.flatMap((h): Flat[] => {
        const channel = channels[h.channel];
        if (h.track < 0)
          return [
            {
              channel: h.channel,
              anchor: 'LR',
              a: channel.left,
              b: channel.left + channel.width,
              y: h.from.y,
            },
          ];
        return [h.from, h.to].map((e) => ({
          channel: h.channel,
          anchor: e.edge,
          a: Math.min(edgeX(e), h.x),
          b: Math.max(edgeX(e), h.x),
          y: e.y,
        }));
      }),
    );
  /**
   * The line of an arrow that waits, with `focused` (one of its cards) in focus. `taken`: the stretches
   * in focus so far; `stubs`: where the lines of the card in focus already meet it; `homes`: the lines
   * (`channel:line`) the waiting arrows of the card in focus keep to.
   */
  const busRoute = (
    arrow: FolderArrow,
    focused: string,
    taken: Flat[],
    stubs: Map<string, number>,
    homes: Set<string>,
  ): Route => {
    const source = placeOf.get(arrow.source)!,
      target = placeOf.get(arrow.target)!;
    const role = arrow.source === focused ? 'out' : 'into';
    const flats: Flat[] = [];
    /** Every stretch placed so far keeps clear of the lines in focus. */
    let clean = true;
    /** Where the stretch from `line` to the edge `anchor` of `channel` meets `card`. */
    const meet = (
      channel: number,
      anchor: 'L' | 'R',
      line: number,
      card: CardPlace,
      bottomFirst: boolean,
      shared?: string,
    ) => {
      const corridor = channels[channel];
      const edge = anchor === 'L' ? corridor.left : corridor.left + corridor.width;
      const flat = (y: number): Flat => ({
        channel,
        anchor,
        a: Math.min(edge, line),
        b: Math.max(edge, line),
        y,
        shared,
      });
      const clear = (y: number) =>
        !taken.some((t) => touches(t, flat(y))) && !flats.some((f) => touches(f, flat(y)));
      const top = card.y + BUS_INSET,
        bottom = card.y + card.height - BUS_INSET;
      let y = shared ? stubs.get(shared) : undefined;
      if (y !== undefined && !clear(y)) clean = false;
      y ??= (bottomFirst ? [bottom, top] : [top, bottom]).find(clear);
      for (let k = top + 1; y === undefined && k < bottom; k++) if (clear(k)) y = k;
      if (y === undefined) {
        clean = false;
        y = bottomFirst ? bottom : top;
      }
      if (shared) stubs.set(shared, y);
      flats.push(flat(y));
      return y;
    };
    /** A stretch at a fixed height: the passage of a column. */
    const pass = (channel: number, anchor: 'L' | 'R', line: number, y: number) => {
      const corridor = channels[channel];
      const edge = anchor === 'L' ? corridor.left : corridor.left + corridor.width;
      const flat: Flat = { channel, anchor, a: Math.min(edge, line), b: Math.max(edge, line), y };
      if (taken.some((t) => touches(t, flat)) || flats.some((f) => touches(f, flat))) clean = false;
      flats.push(flat);
      return y;
    };
    const points: [number, number][] = [];
    if (source.column === target.column) {
      const c = loopChannel(source.column);
      const anchor = loopsLeft(source.column) ? 'R' : 'L';
      const corridor = channels[c];
      const edge = anchor === 'L' ? corridor.left : corridor.left + corridor.width;
      const line = corridor.lines[lineOf(arrow, role)]!;
      const shared = `${c}:${role}`;
      const from =
        role === 'out'
          ? meet(c, anchor, line, source, true, shared)
          : meet(c, anchor, line, source, true);
      const to =
        role === 'out'
          ? meet(c, anchor, line, target, false)
          : meet(c, anchor, line, target, false, shared);
      points.push(
        [edge, from],
        [line, from],
        [line, to],
        [edge + (anchor === 'L' ? ARROW_HEAD - 1 : -(ARROW_HEAD - 1)), to],
      );
    } else {
      // In each corridor, the line of its role; when a stretch at a fixed height (the passage of a
      // column) would run along a line in focus there, the line of the other edge, if the arrows of
      // the card in focus do not keep to it.
      const first = source.column + 1,
        last = target.column;
      const home = lineOf(arrow, role),
        other: Line = role === 'out' ? 'L:into' : 'R:out';
      let y = 0;
      for (let c = first; c <= last; c++) {
        const options = [home, other].filter(
          (option, i) =>
            channels[c].lines[option] !== undefined && (i === 0 || !homes.has(`${c}:${option}`)),
        );
        for (let k = 0; k < options.length; k++) {
          const line = channels[c].lines[options[k]]!;
          const mark = flats.length,
            known = new Set(stubs.keys());
          clean = true;
          const from =
            c === first
              ? meet(c, 'L', line, source, true, role === 'out' ? `${c}:out` : undefined)
              : pass(c, 'L', line, y);
          const to =
            c < last
              ? pass(c, 'R', line, middle(slots.get(`pass:${arrow.id}:${c}`)!))
              : meet(c, 'R', line, target, false, role === 'into' ? `${c}:into` : undefined);
          if (clean || k === options.length - 1) {
            if (c === first) points.push([source.x + cardWidth, from]);
            points.push([line, from], [line, to]);
            y = to;
            break;
          }
          flats.length = mark;
          for (const key of [...stubs.keys()]) if (!known.has(key)) stubs.delete(key);
        }
      }
      points.push([target.x - (ARROW_HEAD - 1), y]);
    }
    taken.push(...flats);
    return {
      arrow,
      shape:
        source.column === target.column
          ? 'same'
          : target.column - source.column > 1
            ? 'skip'
            : 'next',
      sourceColumn: source.column,
      targetColumn: target.column,
      d: roundedPath(points),
      points,
      label: null,
      stroke: arrowStroke(arrow.relations.length),
      waits: true,
    };
  };
  // Where a number may not go: cards, the box outside, the titles. (In focus the numbers of the other
  // arrows are not shown.)
  const solid: Box[] = [
    ...cards.map((card) => ({
      left: card.x,
      top: card.y,
      right: card.x + cardWidth,
      bottom: card.y + card.height,
    })),
    ...Array.from({ length: columnCount }, (_, c) => ({
      left: lefts[c],
      top: -32,
      right: lefts[c] + cardWidth,
      bottom: -12,
    })),
  ];
  for (const box of [outsideBox, inboundBox])
    if (box)
      solid.push({
        left: box.x,
        top: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
      });
  if (othersLabel)
    solid.push({
      left: lefts[0],
      top: othersLabel.y,
      right: lefts[0] + cardWidth,
      bottom: othersLabel.y + othersLabel.height,
    });
  const boxOf = (x: number, y: number, w: number): Box => ({
    left: x - w / 2,
    top: y - NUMBER_HEIGHT / 2,
    right: x + w / 2,
    bottom: y + NUMBER_HEIGHT / 2,
  });
  /**
   * The numbers of the arrows in focus, from the one with the most references: where it is at rest
   * when that place is still free, else on its own line from the card at its far end on, at the first
   * place clear of the other lines in focus, of the numbers placed and of every card.
   */
  const placeNumbers = (lit: Route[], far: (route: Route) => 'end' | 'start') => {
    const taken: Box[] = [];
    const lines = lit.map((route) => {
      const segments = segmentsOf(route);
      const xs = segments.flatMap((s) => [s.x1, s.x2]),
        ys = segments.flatMap((s) => [s.y1, s.y2]);
      return {
        id: route.arrow.id,
        segments,
        bounds: {
          left: Math.min(...xs) - 4,
          top: Math.min(...ys) - 4,
          right: Math.max(...xs) + 4,
          bottom: Math.max(...ys) + 4,
        },
      };
    });
    const clearOf = (box: Box, own: string, linesToo: boolean) =>
      !solid.some((s) => meets(box, s)) &&
      !taken.some((t) => meets(box, t)) &&
      (!linesToo ||
        lines.every(
          (line) =>
            line.id === own ||
            !meets(box, line.bounds) ||
            line.segments.every((s) => !crosses(box, s)),
        ));
    return [...lit]
      .sort((a, b) => rankOf.get(a.arrow)! - rankOf.get(b.arrow)!)
      .map((route): Route => {
        const count = route.arrow.relations.length;
        if (count < 2) return { ...route, label: null };
        const w = numberWidth(count);
        const id = route.arrow.id;
        const candidates: [number, number][] = [];
        if (route.label && !route.label.quiet) candidates.push([route.label.x, route.label.y]);
        const points = corners(route.points);
        if (far(route) === 'start') points.reverse();
        for (let i = points.length - 1; i > 0; i--) {
          const [bx, by] = points[i],
            [ax, ay] = points[i - 1];
          const length = Math.hypot(bx - ax, by - ay);
          const flat = Math.abs(by - ay) < 0.5;
          for (let t = 0; t <= length; t += 3) {
            const px = bx + ((ax - bx) * t) / (length || 1),
              py = by + ((ay - by) * t) / (length || 1);
            candidates.push([px, py]);
            if (flat) candidates.push([px, py - 6], [px, py + 6]);
          }
        }
        const found =
          candidates.find(([cx, cy]) => clearOf(boxOf(cx, cy, w), id, true)) ??
          candidates.find(([cx, cy]) => clearOf(boxOf(cx, cy, w), id, false)) ??
          candidates[0];
        taken.push(boxOf(found[0], found[1], w));
        return {
          ...route,
          label: {
            x: round(found[0]),
            y: round(found[1]),
            width: w,
            height: NUMBER_HEIGHT,
            quiet: false,
          },
        };
      });
  };
  const inFocus = new Map<string, Route[]>();
  const focus: Focus = {
    card: (id) => {
      if (!placeOf.has(id)) return [];
      let found = inFocus.get(id);
      if (!found) {
        const mine = arrows.filter((arrow) => arrow.source === id || arrow.target === id);
        const taken = mine.flatMap((arrow) => flatsAtRest.get(arrow) ?? []);
        const stubs = new Map<string, number>();
        const homes = new Set(
          mine
            .filter((arrow) => !atRestRoute.has(arrow.id))
            .flatMap((arrow) =>
              channelsOf(arrow).map(
                (c) => `${c}:${lineOf(arrow, arrow.source === id ? 'out' : 'into')}`,
              ),
            ),
        );
        const lit = [
          ...mine.flatMap((arrow) => atRestRoute.get(arrow.id) ?? []),
          ...mine
            .filter((arrow) => !atRestRoute.has(arrow.id))
            .sort((a, b) => rankOf.get(a)! - rankOf.get(b)!)
            .map((arrow) => busRoute(arrow, id, taken, stubs, homes)),
        ];
        found = placeNumbers(lit, (route) => (route.arrow.source === id ? 'end' : 'start'));
        inFocus.set(id, found);
      }
      return found;
    },
    arrow: (id) => {
      const route = atRestRoute.get(id);
      return route ? placeNumbers([route], () => 'end')[0] : null;
    },
  };
  const titled = columnTitles(shown, arrows, layers, entries, byItem);
  const layout: FolderLayout = {
    geometry,
    cards,
    columns: titled.titles.map((title, c) => ({ column: c, x: lefts[c], ...title })),
    others: othersLabel
      ? { x: lefts[0], y: othersLabel.y, referencing: titled.othersReference }
      : null,
    routes,
    outsideBox,
    inboundBox,
    left: drawingLeft,
    top,
    width,
    height: height - top,
    grid: false,
    linked,
    shown,
    omitted,
    unlinked,
    hidden,
    undrawn,
    quiet: live.filter(waits).length,
    crossings,
  };
  focusCache.set(layout, focus);
  return layout;
}

/**
 * The edges of each folder with the rest of the reading, for the columns of the Structure: distinct files
 * outside the folder that its files reference, and distinct files outside it that reference something in
 * it. One pass over the relations per reading, then a lookup per folder.
 */
const boundaryCache: Cache<Map<string, { out: Set<string>; into: Set<string> }>> = new WeakMap();
export function folderBoundary(model: Model, folder: string, conventions: boolean) {
  const index = cached(boundaryCache, model, String(conventions), () => {
    const result = new Map<string, { out: Set<string>; into: Set<string> }>();
    const entry = (path: string) => {
      let value = result.get(path);
      if (!value) result.set(path, (value = { out: new Set(), into: new Set() }));
      return value;
    };
    const holds = (folder: string, path: string) =>
      path === folder || path.startsWith(folder + '/');
    for (const edge of model.edges) {
      if (edge.source === edge.target || (!conventions && edge.kind === 'scope')) continue;
      for (
        let up = dirname(edge.source);
        up && up !== '/' && !holds(up, edge.target);
        up = dirname(up)
      )
        entry(up).out.add(edge.target);
      for (
        let up = dirname(edge.target);
        up && up !== '/' && !holds(up, edge.source);
        up = dirname(up)
      )
        entry(up).into.add(edge.source);
    }
    return result;
  });
  const found = index.get(folder);
  return { out: found?.out.size ?? 0, into: found?.into.size ?? 0 };
}
