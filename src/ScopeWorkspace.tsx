import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ChevronRight, FolderOpen, Info, ListTree, Network } from 'lucide-react';
import Canvas from './Canvas';
import StructureView from './StructureView';
import type { Model } from './types';
import type { Theme } from './theme';
import { dirname, scopeFor, viewMode, within } from './scopeNavigation';
import { useI18n } from './i18n';
import type { ScopeView, ViewMode } from './scopeNavigation';
import './scope-workspace.css';

/**
 * Structure | Map of one view: in its header when there are two or more views, in the top bar when it
 * is the only one. Switching replaces the current history entry (see `withMode`).
 */
export function ViewModeToggle({
  model,
  view,
  onMode,
}: {
  model: Model;
  view: ScopeView;
  onMode: (mode: ViewMode) => void;
}) {
  const { t } = useI18n();
  const name = view.path.split('/').at(-1) || view.path;
  const mode = viewMode(model, view);
  const directory = model.nodes.find((n) => n.id === view.selected)?.kind === 'directory';
  return (
    <span className="view-mode" role="group" aria-label={t('View mode of {name}', { name })}>
      <button
        aria-label={t('Structure of {name}', { name })}
        aria-pressed={mode === 'structure'}
        title={t('Structure: folders and files as they are on disk')}
        onClick={() => onMode('structure')}
      >
        <ListTree size={13} aria-hidden="true" />
        <span>{t('Structure')}</span>
      </button>
      <button
        aria-label={t('Map of {name}', { name })}
        aria-pressed={mode === 'map'}
        title={
          directory
            ? t('Map: the references between the items of this folder, summed')
            : t('Map: references of the selected file')
        }
        onClick={() => onMode('map')}
      >
        <Network size={13} aria-hidden="true" />
        <span>{t('Map')}</span>
      </button>
    </span>
  );
}

export function ScopePane({
  model,
  view,
  paths,
  active,
  theme,
  onSelect,
  onEdge,
  onMode,
  onClose,
  showConventions,
  parallel,
  header,
  controls,
}: {
  model: Model;
  view: ScopeView;
  paths: string[];
  active: boolean;
  theme: Theme;
  /** `inherit`: the mode of the place clicked, for a view that opens with this selection. */
  onSelect: (id: string, inherit?: ViewMode) => void;
  onEdge: (id: string) => void;
  /** Switches this view between the folder structure and the map, without a new history entry. */
  onMode: (mode: ViewMode) => void;
  /** Closes only this view; its directory stays open. */
  onClose: () => void;
  showConventions: boolean;
  parallel: boolean;
  /**
   * The header of the view (name, location, containment, mode, details, arrangement): only with two or
   * more views. A single view is named by the top bar, which also holds its Structure | Map.
   */
  header: boolean;
  controls: ReactNode;
}) {
  const { t, plural, rich } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const inspect = (id: string) => {
    onSelect(view.selected);
    onEdge(id);
  };
  const [limit, setLimit] = useState(30);
  const node = model.nodes.find((n) => n.id === view.selected);
  const name = view.path.split('/').at(-1) || view.path;
  const mode = viewMode(model, view);
  const parent = paths.filter((path) => path !== view.path && within(view.path, path)).at(-1);
  const levels = parent ? view.path.slice(parent.length).split('/').filter(Boolean).length : 0;
  const containment = parent
    ? plural(levels, 'Child of {parent} · +{count} level', 'Child of {parent} · +{count} levels', {
        parent: parent.split('/').at(-1)!,
      })
    : '';
  // A folder with its own entry that is not an opened root: its view opened by the scope rule.
  const ownEntries = model.roots.some((root) => root.path === view.path)
    ? []
    : model.nodes
        .filter((item) => item.kind === 'entry' && dirname(item.path) === view.path)
        .map((item) => item.name);
  const reason = ownEntries.length
    ? ownEntries.length > 1
      ? t('{name} has its own {first} and {second}', {
          name,
          first: ownEntries.slice(0, -1).join(', '),
          second: ownEntries.at(-1)!,
        })
      : t('{name} has its own {entry}', { name, entry: ownEntries[0] })
    : '';
  // Structure of a file: its folder (the nearest inventoried one in this view), with the file marked.
  const folder = useMemo(() => {
    if (node?.kind === 'directory') return view.selected;
    const folders = new Set(
      model.nodes.filter((item) => item.kind === 'directory').map((item) => item.id),
    );
    let path = dirname(view.selected);
    while (path && path !== view.path && within(path, view.path) && !folders.has(path))
      path = dirname(path);
    return path && within(path, view.path) ? path : view.path;
  }, [model.nodes, node?.kind, view.selected, view.path]);
  const { scoped, crossing } = useMemo(() => {
    const nodes = model.nodes.filter(
      (item) =>
        scopeFor(item.path, paths) === view.path ||
        (node?.kind === 'directory' && dirname(item.path) === view.selected),
    );
    const ids = new Set(nodes.map((node) => node.id));
    const edges = model.edges.filter((edge) => ids.has(edge.source) || ids.has(edge.target));
    const boundaryIds = new Set(
      edges.flatMap((edge) => [edge.source, edge.target]).filter((id) => !ids.has(id)),
    );
    const boundary = model.nodes
      .filter((node) => boundaryIds.has(node.id))
      .map((node) => ({ ...node, root: null, relative: node.path }));
    const crossing = model.edges.filter(
      (edge) =>
        ids.has(edge.source) !== ids.has(edge.target) && (showConventions || edge.kind !== 'scope'),
    );
    const scoped: Model = {
      ...model,
      nodes: [
        ...nodes.map((node) => ({
          ...node,
          root: view.path,
          relative: node.path === view.path ? '.' : node.path.slice(view.path.length + 1),
        })),
        ...boundary,
      ],
      edges,
      roots: [
        {
          path: view.path,
          name: view.path.split('/').at(-1) || view.path,
          parent: null,
          level: 0,
          entries: nodes.filter((node) => node.kind === 'entry').map((node) => node.id),
        },
      ],
    };
    return { scoped, crossing };
  }, [model, paths, view.path, view.selected, node?.kind, showConventions]);
  const children = paths.filter(
    (path) =>
      path !== view.path &&
      paths.filter((ancestor) => ancestor !== path && within(path, ancestor)).at(-1) === view.path,
  );
  return (
    <section
      className={`scope-pane ${parallel ? 'parallel' : ''}`}
      data-scope={view.path}
      data-active={active}
      aria-label={t('Folder panel: {path}', { path: view.path })}
    >
      {header && (
        <header className="scope-header">
          <button className="scope-name" title={view.path} onClick={() => onSelect(view.path)}>
            <FolderOpen size={14} />
            <strong>{view.path.split('/').at(-1)}</strong>
          </button>
          <div className="scope-location" title={view.selected}>
            <ChevronRight size={12} />
            <button onClick={() => onSelect(view.selected)}>
              {view.selected === view.path ? '.' : view.selected.slice(view.path.length + 1)}
            </button>
          </div>
          {parent && (
            <span className="scope-parent" title={t('Folder containment · {parent}', { parent })}>
              {containment}
            </span>
          )}
          <ViewModeToggle model={model} view={view} onMode={onMode} />
          <details className="scope-details">
            <summary
              aria-label={t('Folder details: {name}', { name: view.path.split('/').at(-1)! })}
              title={t('Path and subfolders')}
            >
              <Info size={14} />
            </summary>
            <div>
              <code>{view.path}</code>
              {parent && (
                <p>
                  {t(
                    'Folder containment · {parent} ({containment}). It does not state a run-time dependency.',
                    { parent, containment },
                  )}
                </p>
              )}
              {children.length > 0 && (
                <div className="scope-children">
                  <span>{t('Subfolders with their own entry point:')}</span>
                  {children.map((path) => (
                    <button
                      key={path}
                      title={path}
                      onClick={(event) => {
                        onSelect(path);
                        event.currentTarget.closest('details')?.removeAttribute('open');
                      }}
                    >
                      {path.slice(view.path.length + 1)} <ChevronRight size={12} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </details>
          {controls}
        </header>
      )}
      {reason && (
        <div
          className="scope-reason"
          role="note"
          title={
            parent
              ? t(
                  'Opened automatically: {reason} · Folder containment · {parent} ({containment})',
                  {
                    reason,
                    parent,
                    containment,
                  },
                )
              : t('Opened automatically: {reason}', { reason })
          }
        >
          <span>
            {rich('Opened automatically: <b>{reason}</b>', {
              reason,
              b: (chunks) => <strong>{chunks}</strong>,
            })}
          </span>
          <button onClick={onClose}>{t('Close view')}</button>
        </div>
      )}
      {mode === 'structure' ? (
        <StructureView
          model={model}
          directory={folder}
          highlight={node?.kind === 'directory' ? undefined : view.selected}
          showConventions={showConventions}
          onSelect={(id) => onSelect(id, 'structure')}
        />
      ) : (
        <Canvas
          contextPath={view.path}
          fullModel={model}
          overviewPath={node?.kind === 'directory' ? view.selected : view.path}
          theme={theme}
          model={scoped}
          selected={node?.kind === 'directory' ? '' : view.selected}
          trace={null}
          onSelect={(id) => onSelect(id, 'map')}
          onEdge={inspect}
          showConventions={showConventions}
        />
      )}
      {/* The map of a folder shows its own references that leave it (and the line under it). */}
      {crossing.length > 0 && !(mode === 'map' && node?.kind === 'directory') && (
        <div className="scope-crossing">
          <button
            className="scope-crossing-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ArrowRight size={13} />
            {plural(
              crossing.length,
              '{count} reference between this folder and another',
              '{count} references between this folder and others',
            )}{' '}
            <ChevronRight size={12} />
          </button>
          {expanded && (
            <div className="scope-crossing-list">
              {crossing.slice(0, limit).map((edge) => (
                <div key={edge.id}>
                  <button title={edge.source} onClick={() => onSelect(edge.source)}>
                    {edge.source.slice(dirname(edge.source).lastIndexOf('/') + 1)}
                  </button>
                  <button
                    aria-label={t('View the evidence of the reference {id}', { id: edge.id })}
                    onClick={() => inspect(edge.id)}
                  >
                    →
                  </button>
                  <button title={edge.target} onClick={() => onSelect(edge.target)}>
                    {edge.target.slice(dirname(edge.target).lastIndexOf('/') + 1)}
                  </button>
                </div>
              ))}
              {crossing.length > limit && (
                <button onClick={() => setLimit((value) => value + 30)}>
                  {t('Show more ({count})', { count: crossing.length - limit })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
