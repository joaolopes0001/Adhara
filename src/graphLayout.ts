import type { FileNode, Model, Relation, Trace } from './types';
import { nodeIndex } from './observations';
import type { FilterResult } from './mapFilters';

export const TILE_WIDTH = 274;
export const TILE_HEIGHT = 125;
const COLUMN_GAP = 440;
const ROW_GAP = 176;
export type RelationBundle = {
  id: string;
  source: string;
  target: string;
  relations: Relation[];
  steps: { index: number; reverse: boolean }[];
};

/** One selectable bundle per directed pair; every evidence remains available. */
export function bundleRelations(edges: Relation[], trace: Trace | null): RelationBundle[] {
  const bundles = new Map<string, RelationBundle>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.source, edge.target]);
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = {
        id: `bundle:${edge.id}`,
        source: edge.source,
        target: edge.target,
        relations: [],
        steps: [],
      };
      bundles.set(key, bundle);
    }
    bundle.relations.push(edge);
    trace?.steps.forEach((step, index) => {
      if (step.edge === edge.id) bundle.steps.push({ index: index + 1, reverse: step.reverse });
    });
  }
  return [...bundles.values()];
}

/**
 * The map of a file (or of a trace, a filter, the overview): the selection, its neighbours and entries.
 * `_folder` is not read: the map of a folder is laid out by src/folderMap.ts.
 */
export function contextualGraph(
  model: Model,
  selected: string,
  trace: Trace | null,
  showConventions: boolean,
  _folder: string,
  filter?: FilterResult,
  isolate = false,
) {
  const byId = nodeIndex(model);
  const steps = new Set(trace?.found ? trace.steps.map((step) => step.edge) : []);
  const allowed = model.edges.filter(
    (edge) => showConventions || edge.kind !== 'scope' || steps.has(edge.id),
  );
  const visible = new Set<string>(trace?.found ? trace.nodes : []);
  if (selected) visible.add(selected);
  const neighbors = allowed.filter((edge) => edge.source === selected || edge.target === selected);
  for (const edge of neighbors) {
    if (visible.size >= 24) break;
    visible.add(edge.source);
    visible.add(edge.target);
  }
  for (const root of model.roots) {
    const candidates = root.entries.length
      ? root.entries
      : model.nodes
          .filter((node) => node.root === root.path && node.kind !== 'directory')
          .map((node) => node.id);
    for (const id of candidates.slice(0, selected ? 1 : 6)) if (visible.size < 72) visible.add(id);
  }
  const context = new Set(visible);
  if (filter) {
    if (isolate) visible.clear();
    filter.nodes.forEach((id) => visible.add(id));
  }
  const files = [...visible].map((id) => byId.get(id)).filter((node): node is FileNode => !!node);
  const existing = new Set(files.map((node) => node.id));
  const edges = allowed.filter(
    (edge) =>
      existing.has(edge.source) &&
      existing.has(edge.target) &&
      (!filter ||
        filter.edges.has(edge.id) ||
        (!isolate && context.has(edge.source) && context.has(edge.target))),
  );
  const hidden =
    filter && isolate
      ? 0
      : neighbors.filter((edge) => !existing.has(edge.source) || !existing.has(edge.target)).length;
  return { files, allowed, bundles: bundleRelations(edges, trace), hidden };
}

/** Layers by structural distance for the union of filtered paths, including inverse traversal. */
export function pathLayers(files: FileNode[], edges: Relation[], anchor: string) {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const [a, b] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      const neighbors = adjacency.get(a) || new Set<string>();
      neighbors.add(b);
      adjacency.set(a, neighbors);
    }
  }
  const levels = new Map<string, number>([[anchor, 0]]);
  const queue = [anchor];
  for (let i = 0; i < queue.length; i++)
    for (const next of adjacency.get(queue[i]) || [])
      if (!levels.has(next)) {
        levels.set(next, levels.get(queue[i])! + 1);
        queue.push(next);
      }
  const last = Math.max(0, ...levels.values()) + 1;
  for (const file of files) if (!levels.has(file.id)) levels.set(file.id, last);
  return levels;
}

/** Three roomy columns, centered on the selected file; long traces get their own ordered columns. */
export function positionFiles(
  files: FileNode[],
  selected: string,
  edges: Relation[],
  trace: Trace | null,
  compact = false,
  layers?: Map<string, number>,
) {
  const positions = new Map<string, { x: number; y: number }>();
  const incoming = new Set(
    edges.filter((edge) => edge.target === selected).map((edge) => edge.source),
  );
  const outgoing = new Set(
    edges.filter((edge) => edge.source === selected).map((edge) => edge.target),
  );
  const traceOrder =
    layers || new Map(trace?.found ? trace.nodes.map((id, index) => [id, index]) : []);
  if (compact) {
    const rank = (file: FileNode) =>
      traceOrder.get(file.id) ?? (file.id === selected ? 1 : incoming.has(file.id) ? 0 : 2);
    [...files]
      .sort((a, b) => rank(a) - rank(b))
      .forEach((file, row) => positions.set(file.id, { x: 110, y: 100 + row * 164 }));
    return { positions, width: 420, height: 130 + Math.max(1, files.length) * 164 };
  }
  const lanes: FileNode[][] = Array.from(
    {
      length: traceOrder.size
        ? Math.max(3, ...[...traceOrder.values()].map((level) => level + 1))
        : 3,
    },
    () => [],
  );
  for (const file of files) {
    const lane =
      traceOrder.get(file.id) ??
      (file.id === selected
        ? 1
        : incoming.has(file.id)
          ? 0
          : outgoing.has(file.id)
            ? 2
            : lanes.indexOf(lanes.reduce((a, b) => (a.length <= b.length ? a : b))));
    lanes[lane].push(file);
  }
  const rows = Math.max(1, ...lanes.map((lane) => lane.length));
  lanes.forEach((lane, column) =>
    lane.forEach((file, row) =>
      positions.set(file.id, {
        x: 40 + column * COLUMN_GAP,
        y: 112 + (row + (rows - lane.length) / 2) * ROW_GAP,
      }),
    ),
  );
  return {
    positions,
    width: 80 + TILE_WIDTH + (lanes.length - 1) * COLUMN_GAP,
    height: 160 + rows * ROW_GAP,
  };
}
