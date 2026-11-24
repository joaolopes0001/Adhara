import type { Model } from './types';

/**
 * How a view presents its selection: the folder structure (list/tree of the file system) or the map of
 * references. Undefined means the default for the selection: a folder shows its structure, a file its map
 * (only a view that never received a selection of the user has no mode of its own).
 */
export type ViewMode = 'structure' | 'map';
export type ScopeView = { path: string; selected: string; mode?: ViewMode };
export type Visit = { selected: string; views: ScopeView[] };
export const within = (path: string, directory: string) =>
  path === directory || path.startsWith(directory.endsWith('/') ? directory : directory + '/');
export const dirname = (path: string) =>
  path === '/' ? '' : path.slice(0, path.lastIndexOf('/')) || '/';
export function scopePaths(model: Model): string[] {
  return [
    ...new Set([
      ...model.roots.map((root) => root.path),
      ...model.nodes
        .filter((node) => node.kind === 'entry' && node.status === 'resolved')
        .map((node) => dirname(node.path)),
    ]),
  ].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
const scopeIndexes = new WeakMap<string[], Set<string>>();
export function scopeFor(path: string, paths: string[]) {
  let index = scopeIndexes.get(paths);
  if (!index) {
    index = new Set(paths);
    scopeIndexes.set(paths, index);
  }
  for (let candidate = path; candidate; candidate = dirname(candidate))
    if (index.has(candidate)) return candidate;
  return undefined;
}
/** Mode actually shown by a view: the explicit choice, or the default for what it has selected. */
export function viewMode(model: Model, view: ScopeView): ViewMode {
  return (
    view.mode ??
    (model.nodes.find((node) => node.id === view.selected)?.kind === 'directory'
      ? 'structure'
      : 'map')
  );
}
/**
 * Next history entry for a selection. Views of the enclosing scopes open together (a folder with its own
 * entry opens beside its parents), and every opened root has its view; a view opened this way, or whose
 * selection no longer exists, shows its folder, never a file chosen for the user. The view that receives
 * the selection keeps the mode it shows (Structure or Map): only its own switch changes it, never a new
 * selection or a re-reading. A view that opens with this selection takes `inherit`, the mode of the view
 * the user was in, when there is one; without it, the default for what it shows.
 */
export function visit(
  model: Model | undefined,
  previous: Visit,
  selected: string,
  inherit?: ViewMode,
): Visit {
  if (!selected || !model) return { selected, views: [] };
  const paths = scopePaths(model);
  const chain = paths.filter((path) => within(selected, path));
  if (!chain.length) return { selected, views: previous.views };
  const ids = new Set(model.nodes.map((node) => node.id));
  const views = previous.views
    .filter((view) => paths.includes(view.path))
    .map((view) =>
      ids.has(view.selected) && scopeFor(view.selected, paths) === view.path
        ? view
        : { path: view.path, selected: view.path, ...(view.mode && { mode: view.mode }) },
    );
  const known = new Set(views.map((view) => view.path));
  // Every opened project keeps a view of its root, also when the previous entry had none (the overview).
  for (const path of [...model.roots.map((root) => root.path), ...chain])
    if (!views.some((view) => view.path === path)) views.push({ path, selected: path });
  const active = chain.at(-1);
  return {
    selected,
    views: views.map((view) => {
      if (view.path !== active) return view;
      if (known.has(view.path) && view.selected === selected) return view;
      const mode = known.has(view.path) ? viewMode(model, view) : inherit;
      return mode ? { path: view.path, selected, mode } : { path: view.path, selected };
    }),
  };
}
/** Mode of the view that shows the selection of an entry, or undefined in the overview. */
export function activeMode(model: Model | undefined, entry: Visit): ViewMode | undefined {
  if (!model || !entry.selected) return undefined;
  const scope = scopeFor(entry.selected, scopePaths(model));
  const view = entry.views.find((item) => item.path === scope);
  return view && viewMode(model, view);
}
/** The same history entry with one view switched between structure and map (no new entry). */
export function withMode(entry: Visit, path: string, mode: ViewMode): Visit {
  return {
    ...entry,
    views: entry.views.map((view) => (view.path === path ? { ...view, mode } : view)),
  };
}
