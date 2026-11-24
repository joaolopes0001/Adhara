import type { FileNode, Model } from './types';

/** What a path typed in a Trace field (A or B) designates among the opened directories. */
export type TraceTarget =
  | { kind: 'found'; id: string }
  | { kind: 'ambiguous'; candidates: FileNode[] }
  | { kind: 'missing'; suggestions: FileNode[] };

const SUGGESTIONS = 8;

/** `name/relative` of a node inside the opened root that holds it, as typed with the root name prefix. */
export function rootRelative(model: Model, node: FileNode) {
  const root = model.roots.find((item) => item.path === node.root);
  return root && node.path !== root.path ? `${root.name}/${node.relative}` : node.path;
}

/**
 * Text a Trace field shows for a chosen file: `name/relative` inside its opened root when that
 * designates only this file (a long absolute path would hide the file name), else the absolute path.
 */
export function fieldText(model: Model, id: string) {
  const node = model.nodes.find((item) => item.id === id);
  if (!node) return id;
  const relative = rootRelative(model, node);
  const target = resolveTracePath(model, relative);
  return target.kind === 'found' && target.id === id ? relative : id;
}

/**
 * Exact matches only, never a guess: the absolute path (id of a node), `~/…` expanded with the home
 * directory, or a path relative to an opened root, with or without the root name as prefix
 * (`loja/CLAUDE.md` and `CLAUDE.md`). Several files are returned to choose from; with none, files whose
 * path ends with the typed text are only suggested.
 */
export function resolveTracePath(model: Model, text: string, home = ''): TraceTarget {
  const typed = text.trim();
  const files = model.nodes.filter((node) => node.kind !== 'directory');
  const byId = new Map(files.map((node) => [node.id, node]));
  const clean = (value: string) =>
    value
      .replace(/^(\.\/)+/, '')
      .replace(/\/+$/, '')
      .replace(/\/{2,}/g, '/');
  if (byId.has(typed)) return { kind: 'found', id: typed };
  const expanded = home && /^~(\/|$)/.test(typed) ? home + typed.slice(1) : '';
  if (expanded && byId.has(clean(expanded))) return { kind: 'found', id: clean(expanded) };
  const relative = clean(typed);
  const found = new Map<string, FileNode>();
  if (relative && !relative.startsWith('/'))
    for (const root of model.roots) {
      const direct = byId.get(`${root.path}/${relative}`);
      if (direct) found.set(direct.id, direct);
      if (relative.startsWith(`${root.name}/`)) {
        const prefixed = byId.get(`${root.path}/${relative.slice(root.name.length + 1)}`);
        if (prefixed) found.set(prefixed.id, prefixed);
      }
    }
  const candidates = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (candidates.length === 1) return { kind: 'found', id: candidates[0].id };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  const tail = relative.split('/').filter(Boolean).join('/').toLowerCase();
  const suggestions = tail
    ? files
        .filter((node) => {
          const path = node.path.toLowerCase();
          return path.endsWith(`/${tail}`) && node.kind !== 'unresolved';
        })
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, SUGGESTIONS)
    : [];
  return { kind: 'missing', suggestions };
}
