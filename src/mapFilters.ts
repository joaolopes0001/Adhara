import type { Model, Relation } from './types';
import { nodeIndex } from './observations';

export type MapFilter = {
  id: string;
  name: string;
  files: string[];
  kind: 'connections' | 'paths';
  direction: 'outgoing' | 'incoming' | 'both';
  conventions: boolean;
};
export type FilterResult = {
  nodes: Set<string>;
  edges: Set<string>;
  missing: string[];
  disconnected: [string, string][];
  omitted: number;
  limited: boolean;
  reversed: Set<string>;
};
export const FILTER_NODE_LIMIT = 240;
const PAIR_LIMIT = 600;
const SEARCH_BUDGET = 2_000_000;

// Definitions contain paths only. They never change the scanned model or its evidence.
export function readFilters(): MapFilter[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('aae-map-filters') || '[]');
    if (!Array.isArray(saved)) return [];
    const ids = new Set<string>();
    return saved
      .filter((f): f is MapFilter => {
        if (
          !f ||
          typeof f.id !== 'string' ||
          ids.has(f.id) ||
          typeof f.name !== 'string' ||
          !f.name.trim() ||
          !Array.isArray(f.files) ||
          !f.files.length ||
          !f.files.every((p: unknown) => typeof p === 'string' && p.startsWith('/')) ||
          !['connections', 'paths'].includes(f.kind) ||
          !['outgoing', 'incoming', 'both'].includes(f.direction) ||
          typeof f.conventions !== 'boolean'
        )
          return false;
        ids.add(f.id);
        return true;
      })
      .map((f) => ({ ...f, files: [...new Set(f.files)] }));
  } catch {
    return [];
  }
}

/** Incident references, or a deterministic shortest path per pair (both ordered pairs when directed).
 * Bounds are explicit; a path is accepted whole or omitted whole, never severed for rendering.
 */
export function evaluateFilter(
  model: Model,
  filter: MapFilter,
  searchBudget = SEARCH_BUDGET,
): FilterResult {
  const byId = nodeIndex(model);
  const requested = [...new Set(filter.files)].filter((id) => byId.has(id));
  const files = requested.slice(0, FILTER_NODE_LIMIT);
  const result: FilterResult = {
    nodes: new Set(files),
    edges: new Set(),
    missing: filter.files.filter((id) => !byId.has(id)),
    disconnected: [],
    omitted: 0,
    limited: requested.length > files.length,
    reversed: new Set(),
  };
  const allowed = model.edges.filter(
    (edge) =>
      (filter.conventions || edge.kind !== 'scope') &&
      byId.has(edge.source) &&
      byId.has(edge.target),
  );
  const pairs = new Set<string>();
  const finish = () => {
    // Every evidence for an accepted directed pair stays available, including duplicates.
    for (const edge of allowed)
      if (pairs.has(JSON.stringify([edge.source, edge.target]))) result.edges.add(edge.id);
    return result;
  };
  const add = (edges: Relation[], reverse: string[] = []) => {
    const nodes = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    const newPairs = new Set(
      edges
        .map((edge) => JSON.stringify([edge.source, edge.target]))
        .filter((pair) => !pairs.has(pair)),
    );
    if (
      result.nodes.size + [...nodes].filter((id) => !result.nodes.has(id)).length >
        FILTER_NODE_LIMIT ||
      pairs.size + newPairs.size > PAIR_LIMIT
    ) {
      result.omitted++;
      result.limited = true;
      return;
    }
    nodes.forEach((id) => result.nodes.add(id));
    newPairs.forEach((pair) => pairs.add(pair));
    edges.forEach((edge) => result.edges.add(edge.id));
    reverse.forEach((id) => result.reversed.add(id));
  };
  if (filter.kind === 'connections') {
    const selected = new Set(files);
    for (const edge of allowed)
      if (
        (filter.direction !== 'incoming' && selected.has(edge.source)) ||
        (filter.direction !== 'outgoing' && selected.has(edge.target))
      )
        add([edge]);
    return finish();
  }
  const adjacency = new Map<string, { target: string; edge: Relation; reverse: boolean }[]>();
  const link = (source: string, target: string, edge: Relation, reverse: boolean) => {
    const list = adjacency.get(source) || [];
    list.push({ target, edge, reverse });
    adjacency.set(source, list);
  };
  for (const edge of allowed) {
    link(edge.source, edge.target, edge, false);
    if (filter.direction === 'both') link(edge.target, edge.source, edge, true);
  }
  let work = 0;
  for (let i = 0; i < files.length; i++) {
    const start = files[i];
    const targets =
      filter.direction === 'both' ? files.slice(i + 1) : files.filter((id) => id !== start);
    if (!targets.length) continue;
    const pending = new Set(targets);
    const queue = [start];
    const previous = new Map<string, { source: string; edge: Relation; reverse: boolean }>();
    const seen = new Set([start]);
    for (let head = 0; head < queue.length && pending.size; head++) {
      for (const step of adjacency.get(queue[head]) || []) {
        if (++work > searchBudget) {
          result.limited = true;
          return finish();
        }
        if (seen.has(step.target)) continue;
        seen.add(step.target);
        previous.set(step.target, { source: queue[head], edge: step.edge, reverse: step.reverse });
        queue.push(step.target);
        pending.delete(step.target);
      }
    }
    for (const end of targets) {
      if (++work > searchBudget) {
        result.limited = true;
        return finish();
      }
      if (!seen.has(end)) {
        result.disconnected.push([start, end]);
        continue;
      }
      const edges: Relation[] = [],
        reverse: string[] = [];
      for (let id = end; id !== start; ) {
        if (++work > searchBudget) {
          result.limited = true;
          return finish();
        }
        const step = previous.get(id)!;
        edges.push(step.edge);
        if (step.reverse) reverse.push(step.edge.id);
        id = step.source;
      }
      add(edges, reverse);
    }
  }
  return finish();
}
