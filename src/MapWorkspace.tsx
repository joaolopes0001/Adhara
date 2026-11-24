import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  FileText,
  FolderOpen,
  LayoutGrid,
  ListFilter,
  Maximize2,
  Minus,
  MoreHorizontal,
  Route,
  Rows2,
  X,
} from 'lucide-react';
import Canvas from './Canvas';
import { ScopePane, ViewModeToggle } from './ScopeWorkspace';
import { FilterMap } from './MapFilters';
import { scopeFor, scopePaths, within } from './scopeNavigation';
import { useI18n } from './i18n';
import type { ScopeView, ViewMode } from './scopeNavigation';
import type { MapFilter } from './mapFilters';
import type { Model, Trace } from './types';
import type { Theme } from './theme';

export type PaneDirection = 'left' | 'right' | 'up' | 'down';
/** How the user arranged the grid, kept by the caller while the grid is away (Home). */
export type Arrangement = {
  order: string[];
  minimized: string[];
  orientation: 'columns' | 'rows';
};
function paneNeighbor(index: number, count: number, columns: number, direction: PaneDirection) {
  const target =
    direction === 'left'
      ? index - 1
      : direction === 'right'
        ? index + 1
        : direction === 'up'
          ? index - columns
          : index + columns;
  if (
    target < 0 ||
    target >= count ||
    ((direction === 'left' || direction === 'right') &&
      Math.floor(index / columns) !== Math.floor(target / columns))
  )
    return -1;
  return target;
}
type Pane = {
  id: string;
  title: string;
  path?: string;
  kind: 'scope' | 'filter' | 'overview' | 'trace';
  selected?: string;
  /** Closes the view only: the project stays open. */
  close?: () => void;
  /** The view of an opened root: it can be minimized, never closed (forgetting a project is on Home). */
  root?: boolean;
  render: (controls: ReactNode) => ReactNode;
};
/** Position of the project a view belongs to (its most specific opened root), for the grid order. */
function projectRank(model: Model, path: string) {
  let rank = model.roots.length,
    length = -1;
  model.roots.forEach((root, index) => {
    if (within(path, root.path) && root.path.length > length) {
      rank = index;
      length = root.path.length;
    }
  });
  return rank;
}

export default function MapWorkspace({
  model,
  views,
  selected,
  theme,
  trace,
  onSelect,
  onActivate,
  onEdge,
  onClose,
  solo,
  arrangement,
  onLeave,
  onColumns,
  maxColumns = 2,
  room = 0,
  paneMinHeight = 188,
  onRows,
  onMode,
  onClearTrace,
  showConventions,
  activeFilter,
  openFilters,
  onCloseHighlight,
  onCloseFilter,
}: {
  model: Model;
  views: ScopeView[];
  selected: string;
  theme: Theme;
  trace: Trace | null;
  /** Navigation, as in the tree; `inherit` is the mode of the place clicked, for a view it opens. */
  onSelect: (id: string, inherit?: ViewMode) => void;
  /** Selection that follows an activated tab: no navigation side effect, the path stays. */
  onActivate: (id: string) => void;
  onEdge: (id: string) => void;
  onClose: (path: string) => void;
  /** The root chosen on Home: the views of the other projects start minimized, once per value. */
  solo?: string;
  /** Read on mount only. */
  arrangement?: Arrangement;
  onLeave?: (arrangement: Arrangement) => void;
  /** The columns of views on the screen (1 or 2): the inspector leaves the centre room for them. */
  onColumns?: (columns: number) => void;
  /**
   * 1 when the window cannot hold two views at their least width beside the explorer and the inspector at
   * its least width: the views then go one above the other, and the grid never scrolls sideways.
   */
  maxColumns?: number;
  /** The height the grid can have (0 while unknown): with `paneMinHeight`, the rows of views that fit. */
  room?: number;
  paneMinHeight?: number;
  /** The rows of views on the screen: the bottom panel gives way so that each keeps its least height. */
  onRows?: (rows: number) => void;
  onMode: (path: string, mode: ViewMode) => void;
  onClearTrace: () => void;
  showConventions: boolean;
  activeFilter?: MapFilter;
  openFilters: MapFilter[];
  onCloseHighlight: () => void;
  onCloseFilter: (id: string) => void;
}) {
  const { t } = useI18n();
  const paths = useMemo(() => scopePaths(model), [model]);
  const scope = scopeFor(selected, paths);
  const [order, setOrder] = useState<string[]>(() => arrangement?.order ?? []);
  const [minimized, setMinimized] = useState<string[]>(() => arrangement?.minimized ?? []);
  // While a path is traced, the other views leave the grid without entering `minimized`, so clearing
  // the path restores the arrangement. A view restored during the trace is listed here, shown beside it.
  const [restoredDuringTrace, setRestoredDuringTrace] = useState<{
    trace: Trace | null;
    ids: string[];
  }>({ trace: null, ids: [] });
  const shownWithTrace =
    trace && restoredDuringTrace.trace === trace ? restoredDuringTrace.ids : [];
  const showWithTrace = (id: string) => {
    if (trace)
      setRestoredDuringTrace((previous) => ({
        trace,
        ids: previous.trace === trace ? [...previous.ids.filter((item) => item !== id), id] : [id],
      }));
  };
  const [orientation, setOrientation] = useState<'columns' | 'rows'>(
    () => arrangement?.orientation ?? 'columns',
  );
  // Read from a ref, so the unmount cleanup gives the caller the last arrangement drawn.
  const latest = useRef<Arrangement>({ order, minimized, orientation });
  latest.current = { order, minimized, orientation };
  useEffect(() => () => onLeave?.(latest.current), []);
  const [focused, setFocused] = useState('');
  const [tabsHost, setTabsHost] = useState<HTMLElement | null>(null);
  const [modeHost, setModeHost] = useState<HTMLElement | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const filterSelections = useRef(new Map<string, string>());
  const selectionPane = useRef('');
  useEffect(() => {
    setTabsHost(document.getElementById('workspace-view-tabs'));
    setModeHost(document.getElementById('top-view-mode'));
    const dismiss = (event: PointerEvent) =>
      container.current
        ?.querySelectorAll<HTMLDetailsElement>('.pane-arrange[open]')
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.removeAttribute('open');
        });
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  const filterSelection = (id: string, filter: MapFilter) => {
    const previous = filterSelections.current.get(id);
    return previous && model.nodes.some((node) => node.id === previous)
      ? previous
      : filter.files.find((id) => model.nodes.some((node) => node.id === id));
  };
  const overview = !views.length || !scope;
  const directory = model.nodes.find((node) => node.id === selected)?.kind === 'directory';
  // Directory views follow the order of the projects (the explorer list).
  const isRoot = (path: string) => model.roots.some((root) => root.path === path);
  const projectViews = views
    .map((view, index) => ({
      view,
      index,
      rank: projectRank(model, view.path),
      root: isRoot(view.path),
    }))
    .sort((a, b) => a.rank - b.rank || Number(b.root) - Number(a.root) || a.index - b.index)
    .map((item) => item.view);
  const allPanes: Pane[] = projectViews.map((view) => ({
    id: `scope:${view.path}`,
    title: view.path.split('/').at(-1) || view.path,
    path: view.path,
    selected: view.selected,
    kind: 'scope',
    ...(isRoot(view.path) ? { root: true } : { close: () => onClose(view.path) }),
    render: (controls) => (
      <ScopePane
        model={model}
        view={view}
        paths={paths}
        active={scope === view.path}
        theme={theme}
        onSelect={onSelect}
        onEdge={onEdge}
        onMode={(mode) => onMode(view.path, mode)}
        onClose={() => onClose(view.path)}
        showConventions={showConventions}
        parallel={views.length + openFilters.length > 1}
        header={multiple}
        controls={controls}
      />
    ),
  }));
  // A selection outside every open project (a destination in a folder that is not open) has no view of
  // its own: its map takes the grid. With nothing selected, Home is shown instead of this grid.
  const outside =
    overview && selected ? model.nodes.find((node) => node.id === selected) : undefined;
  if (overview && selected)
    allPanes.push({
      id: 'overview',
      title: outside?.name ?? (selected.split('/').at(-1) || selected),
      path: selected,
      kind: 'overview',
      render: (controls) => (
        <section className="overview-pane">
          {multiple && (
            <header>
              <FileText size={14} />
              <strong>{outside?.name ?? selected}</strong>
              {controls}
            </header>
          )}
          <Canvas
            overviewPath={directory ? selected : ''}
            theme={theme}
            model={model}
            selected={directory ? '' : selected}
            trace={null}
            onSelect={(id) => onSelect(id, 'map')}
            onEdge={onEdge}
            showConventions={showConventions}
          />
        </section>
      ),
    });
  if (trace)
    allPanes.push({
      id: 'trace',
      title: t('Trace'),
      kind: 'trace',
      close: onClearTrace,
      render: (controls) => (
        <section className="overview-pane trace-pane">
          <header>
            <Route size={14} />
            <strong>{t('Trace')}</strong>
            <span
              className="trace-pane-note"
              title={t(
                'Temporary view: the others stay in the Views strip and come back as they were when the trace is cleared',
              )}
            >
              {t('temporary')}
            </span>
            {controls}
          </header>
          <Canvas
            overviewPath=""
            theme={theme}
            model={model}
            selected={directory ? '' : selected}
            trace={trace}
            onSelect={(id) => {
              // Selecting a step keeps the path in front instead of revealing that file's view.
              selectionPane.current = id !== selected ? 'trace' : '';
              setFocused('trace');
              onSelect(id, 'map');
            }}
            onEdge={onEdge}
            showConventions={showConventions}
          />
        </section>
      ),
    });
  if (activeFilter)
    allPanes.push({
      id: `highlight:${activeFilter.id}`,
      title: activeFilter.name,
      selected: filterSelection(`highlight:${activeFilter.id}`, activeFilter),
      kind: 'filter',
      close: onCloseHighlight,
      render: (controls) => (
        <FilterMap
          model={model}
          filter={activeFilter}
          theme={theme}
          isolate={false}
          onSelect={(id) => {
            filterSelections.current.set(`highlight:${activeFilter.id}`, id);
            selectionPane.current = id !== selected ? `highlight:${activeFilter.id}` : '';
            setFocused(`highlight:${activeFilter.id}`);
            onSelect(id, 'map');
          }}
          onEdge={onEdge}
          onClose={onCloseHighlight}
          controls={controls}
        />
      ),
    });
  allPanes.push(
    ...openFilters.map((filter) => ({
      id: `filter:${filter.id}`,
      title: filter.name,
      selected: filterSelection(`filter:${filter.id}`, filter),
      kind: 'filter' as const,
      close: () => onCloseFilter(filter.id),
      render: (controls: ReactNode) => (
        <FilterMap
          model={model}
          filter={filter}
          theme={theme}
          isolate
          onSelect={(id) => {
            filterSelections.current.set(`filter:${filter.id}`, id);
            selectionPane.current = id !== selected ? `filter:${filter.id}` : '';
            setFocused(`filter:${filter.id}`);
            onSelect(id, 'map');
          }}
          onEdge={onEdge}
          onClose={() => onCloseFilter(filter.id)}
          controls={controls}
        />
      ),
    })),
  );
  const eligible = allPanes.filter((pane) =>
    pane.kind === 'trace'
      ? true
      : pane.kind === 'scope'
        ? !overview && !activeFilter
        : pane.id === 'overview'
          ? !activeFilter
          : true,
  );
  const ordered = [...eligible].sort((a, b) => {
    const aIndex = order.indexOf(a.id),
      bIndex = order.indexOf(b.id);
    return (
      (aIndex < 0 ? order.length + eligible.indexOf(a) : aIndex) -
      (bIndex < 0 ? order.length + eligible.indexOf(b) : bIndex)
    );
  });
  const heldByTrace = (pane: Pane) =>
    !!trace && pane.kind !== 'trace' && !shownWithTrace.includes(pane.id);
  // The views the user keeps in the grid; all of them on the screen when the room allows.
  const chosen = ordered.filter((pane) => !minimized.includes(pane.id) && !heldByTrace(pane));
  // Rows of views at their least height that the grid has room for (no limit while unknown).
  const fitRows = room > 0 ? Math.max(1, Math.floor((room + 1) / (paneMinHeight + 1))) : Infinity;
  const besideChosen =
    maxColumns > 1 && (chosen.length > 2 || (chosen.length === 2 && orientation === 'columns'));
  // Views one above the other that do not fit go side by side, when the window has room for two columns.
  const besideForRoom =
    !besideChosen && maxColumns > 1 && chosen.length >= 2 && chosen.length > fitRows;
  const gridColumns = besideChosen || besideForRoom ? 2 : 1;
  // Still more than fit: the active view and those already on the screen stay, so a click in a view
  // never sends another away; the others wait as minimized until the room returns.
  const capacity = fitRows * gridColumns;
  const onScreen = useRef<string[]>([]);
  let visible = chosen;
  if (chosen.length > capacity) {
    const keep = new Set<string>();
    const active = chosen.find((pane) => pane.id === focused);
    for (const pane of [
      ...(active ? [active] : []),
      ...chosen.filter((pane) => onScreen.current.includes(pane.id)),
      ...chosen,
    ]) {
      if (keep.size >= capacity) break;
      keep.add(pane.id);
    }
    visible = chosen.filter((pane) => keep.has(pane.id));
  }
  onScreen.current = visible.map((pane) => pane.id);
  const heldByRoom = (pane: Pane) => chosen.includes(pane) && !visible.includes(pane);
  const isMinimized = (pane: Pane) =>
    minimized.includes(pane.id) || heldByTrace(pane) || heldByRoom(pane);
  // One view has no header and no tabs: the top bar names it and holds its mode toggle.
  const multiple = ordered.length > 1;
  const single = !multiple && ordered[0]?.kind === 'scope' ? ordered[0] : undefined;
  const singleView = single && projectViews.find((view) => `scope:${view.path}` === single.id);
  // A view left alone cannot stay minimized: without a header, nothing on the screen would restore it.
  useEffect(() => {
    if (!multiple) setMinimized([]);
  }, [multiple]);
  const activeId = visible.some((pane) => pane.id === focused) ? focused : visible[0]?.id;
  const columns = gridColumns > 1 && visible.length > 1 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(visible.length / columns));
  // The other arrangement of two views: one above the other only when two rows fit.
  const rowsFit = fitRows >= 2;
  // Before the paint, so that a second column never shows beside an inspector as wide as one
  // column allowed.
  useLayoutEffect(() => {
    onColumns?.(columns);
  }, [columns]);
  useLayoutEffect(() => () => onColumns?.(1), []);
  useLayoutEffect(() => {
    onRows?.(rows);
  }, [rows]);
  const paneIds = allPanes.map((pane) => pane.id).join('\0');
  useEffect(() => {
    const ids = new Set(paneIds.split('\0'));
    setOrder((previous) => previous.filter((id) => ids.has(id)));
    setMinimized((previous) => previous.filter((id) => ids.has(id)));
  }, [paneIds]);
  // Before the paint, so the grid never shows the other views first; once per choice, so a later
  // navigation or restoration is the user's. A project opened from Home has its view only after the
  // reading: the choice waits for it.
  const appliedSolo = useRef('');
  useLayoutEffect(() => {
    if (!solo || appliedSolo.current === solo) return;
    const target = `scope:${solo}`;
    const ids = paneIds.split('\0');
    if (!ids.includes(target)) return;
    appliedSolo.current = solo;
    setMinimized(ids.filter((id) => id.startsWith('scope:') && id !== target));
    setFocused(target);
  }, [solo, paneIds]);
  // A move by the menu is temporary: a new order of the projects puts the directory views back in that
  // order, in the grid places they hold (filters and the path keep theirs).
  const projectOrder = model.roots.map((root) => root.path).join('\0');
  const previousProjectOrder = useRef(projectOrder);
  useEffect(() => {
    if (previousProjectOrder.current === projectOrder) return;
    previousProjectOrder.current = projectOrder;
    setOrder((previous) => {
      const rank = (id: string) => projectRank(model, id.slice('scope:'.length));
      const scopes = previous
        .filter((id) => id.startsWith('scope:'))
        .sort((a, b) => rank(a) - rank(b));
      let index = 0;
      return previous.map((id) => (id.startsWith('scope:') ? scopes[index++] : id));
    });
  }, [projectOrder]);
  useEffect(() => {
    // Explicit navigation reveals a minimized view, except while a path is shown: then only the tabs
    // bring views back. Minimizing never changes the selection.
    const target = selectionPane.current || (scope ? `scope:${scope}` : '');
    const fromPane = !!selectionPane.current;
    selectionPane.current = '';
    if (!target) return;
    setFocused(target);
    if (!fromPane && !trace) setMinimized((previous) => previous.filter((id) => id !== target));
    const frame = requestAnimationFrame(() =>
      [...(container.current?.querySelectorAll<HTMLElement>('[data-pane-id]') || [])]
        .find(
          (element) => element.dataset.paneId === target && element.dataset.minimized !== 'true',
        )
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [selected, scope]);
  function reveal(pane: Pane) {
    if (pane.selected) {
      selectionPane.current = pane.selected !== selected ? pane.id : '';
      onActivate(pane.selected);
    }
    setMinimized((previous) => previous.filter((id) => id !== pane.id));
    if (heldByTrace(pane)) showWithTrace(pane.id);
    setFocused(pane.id);
    requestAnimationFrame(() => {
      const element = [
        ...(container.current?.querySelectorAll<HTMLElement>('[data-pane-id]') || []),
      ].find((element) => element.dataset.paneId === pane.id);
      element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      element?.focus({ preventScroll: true });
    });
  }
  function arrange(next: string[]) {
    setOrder((previous) => {
      const existing = new Set(allPanes.map((pane) => pane.id));
      const baseline = [
        ...previous.filter((id) => existing.has(id)),
        ...allPanes.map((pane) => pane.id).filter((id) => !previous.includes(id)),
      ];
      const moved = new Set(next);
      let index = 0;
      return baseline.map((id) => (moved.has(id) ? next[index++] : id));
    });
  }
  function move(pane: Pane, direction: PaneDirection) {
    const next = visible.map((item) => item.id);
    const index = next.indexOf(pane.id);
    if (next.length === 2) {
      setOrientation(direction === 'left' || direction === 'right' ? 'columns' : 'rows');
      const first = direction === 'left' || direction === 'up';
      arrange(
        first
          ? [pane.id, ...next.filter((id) => id !== pane.id)]
          : [...next.filter((id) => id !== pane.id), pane.id],
      );
    } else {
      const target = paneNeighbor(index, next.length, columns, direction);
      if (target < 0) return;
      [next[index], next[target]] = [next[target], next[index]];
      arrange(next);
    }
    setFocused(pane.id);
  }
  function minimize(pane: Pane) {
    setMinimized((previous) => (previous.includes(pane.id) ? previous : [...previous, pane.id]));
    requestAnimationFrame(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-view-id]')]
        .find((button) => button.dataset.viewId === pane.id)
        ?.focus(),
    );
  }
  function controls(pane: Pane) {
    const index = visible.findIndex((item) => item.id === pane.id);
    return (
      <div className="pane-actions">
        <details
          className="pane-arrange"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.removeAttribute('open');
              event.currentTarget.querySelector('summary')?.focus();
            }
          }}
        >
          <summary
            aria-label={t('Arrange view {name}', { name: pane.title })}
            title={t('Move view')}
          >
            <MoreHorizontal size={15} />
          </summary>
          <div>
            {(
              [
                ['left', t('Move {name} left', { name: pane.title }), t('Move left'), ArrowLeft],
                [
                  'right',
                  t('Move {name} right', { name: pane.title }),
                  t('Move right'),
                  ArrowRight,
                ],
                ['up', t('Move {name} up', { name: pane.title }), t('Move up'), ArrowUp],
                ['down', t('Move {name} down', { name: pane.title }), t('Move down'), ArrowDown],
              ] as const
            ).map(([direction, name, label, Icon]) => (
              <button
                key={direction}
                disabled={
                  visible.length < 2 ||
                  (visible.length !== 2 &&
                    paneNeighbor(index, visible.length, columns, direction) < 0)
                }
                onClick={(event) => {
                  move(pane, direction);
                  const details = event.currentTarget.closest('details');
                  details?.removeAttribute('open');
                  details?.querySelector('summary')?.focus();
                }}
                aria-label={name}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        </details>
        <span className="pane-window">
          <button
            className="icon-button"
            aria-label={t('Minimize view {name}', { name: pane.title })}
            title={
              pane.root
                ? t(
                    'Minimize: the view goes to the Views strip; the project stays open and scanned',
                  )
                : t('Minimize: the view goes to the Views strip')
            }
            onClick={() => minimize(pane)}
          >
            <Minus size={14} />
          </button>
          {pane.close && (
            <button
              className="icon-button"
              aria-label={
                pane.kind === 'trace'
                  ? t('Clear trace')
                  : pane.id.startsWith('highlight:')
                    ? t('Close highlight {name}', { name: pane.title })
                    : t('Close view {name}', { name: pane.title })
              }
              title={pane.kind === 'trace' ? t('Clear trace') : t('Close view')}
              onClick={pane.close}
            >
              <X size={14} />
            </button>
          )}
        </span>
      </div>
    );
  }
  const tabs = (
    <div className="workspace-view-strip" aria-label={t('Views')}>
      <span className="view-strip-label">{t('Views')}</span>
      <div className="workspace-view-list">
        {ordered.map((pane) => (
          <button
            key={pane.id}
            data-view-id={pane.id}
            className={`workspace-view-tab ${isMinimized(pane) ? 'is-minimized' : ''}`}
            data-active={activeId === pane.id && !isMinimized(pane)}
            aria-pressed={activeId === pane.id && !isMinimized(pane)}
            aria-label={
              isMinimized(pane)
                ? t('Restore view {name}', { name: pane.title })
                : t('Activate view {name}', { name: pane.title })
            }
            title={`${pane.path || pane.title}${
              pane.kind === 'trace'
                ? ` · ${t('temporary view')}`
                : isMinimized(pane)
                  ? ` · ${t('Minimized')}`
                  : ''
            }`}
            onClick={() => reveal(pane)}
          >
            {pane.kind === 'scope' ? (
              <FolderOpen size={13} />
            ) : pane.kind === 'filter' ? (
              <ListFilter size={13} />
            ) : pane.kind === 'trace' ? (
              <Route size={13} />
            ) : (
              <FileText size={13} />
            )}
            <span>{pane.title}</span>
            {isMinimized(pane) && (
              <>
                <small>{t('Minimized')}</small>
                <Maximize2 size={11} />
              </>
            )}
          </button>
        ))}
      </div>
      {visible.length === 2 && maxColumns > 1 && (
        <button
          className="icon-button view-orientation"
          aria-label={columns === 2 ? t('Arrange views in rows') : t('Arrange views in columns')}
          title={columns === 2 ? t('One view above the other') : t('Views side by side')}
          disabled={columns === 2 && !rowsFit}
          onClick={() => setOrientation(columns === 2 ? 'rows' : 'columns')}
        >
          {columns === 2 ? <Rows2 size={14} /> : <Columns2 size={14} />}
        </button>
      )}
    </div>
  );
  return (
    <>
      <div
        ref={container}
        className="map-workspace"
        aria-label={t('Parallel maps')}
        data-columns={columns}
        data-visible-panes={visible.length}
        style={
          {
            '--pane-columns': columns,
            '--pane-rows': rows,
            '--pane-min-height': `${paneMinHeight}px`,
          } as CSSProperties
        }
      >
        {allPanes.map((pane) => (
          <PaneFrame
            key={pane.id}
            id={pane.id}
            title={pane.title}
            hidden={!visible.some((item) => item.id === pane.id)}
            index={visible.findIndex((item) => item.id === pane.id)}
            active={activeId === pane.id}
            onFocus={() => setFocused(pane.id)}
          >
            {pane.render(multiple ? controls(pane) : null)}
          </PaneFrame>
        ))}
        {!visible.length && (
          <div className="workspace-minimized-empty">
            <LayoutGrid size={28} />
            <strong>{t('All views are minimized')}</strong>
            <button onClick={() => setMinimized([])}>{t('Restore views')}</button>
          </div>
        )}
      </div>
      {multiple && (tabsHost ? createPortal(tabs, tabsHost) : tabs)}
      {singleView &&
        modeHost &&
        createPortal(
          <ViewModeToggle
            model={model}
            view={singleView}
            onMode={(mode) => onMode(singleView.path, mode)}
          />,
          modeHost,
        )}
    </>
  );
}

function PaneFrame({
  id,
  title,
  hidden,
  index,
  active,
  onFocus,
  children,
}: {
  id: string;
  title: string;
  hidden: boolean;
  index: number;
  active: boolean;
  onFocus: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const size = useRef({ width: 400, height: 300 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || hidden) return;
    const capture = () => {
      if (element.clientWidth && element.clientHeight)
        size.current = { width: element.clientWidth, height: element.clientHeight };
    };
    capture();
    const observer = new ResizeObserver(capture);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hidden]);
  // Keeping the canvas mounted at its previous dimensions preserves pan, zoom,
  // node positions and filter selection. Fixed positioning also keeps its old
  // dimensions out of the grid scroll area after the window shrinks. Opacity
  // hides the whole subtree: React Flow nodes explicitly set visibility:visible
  // and can otherwise paint through the frame's inherited visibility:hidden.
  return (
    <div
      ref={ref}
      className="workspace-pane"
      data-pane-id={id}
      data-active={active}
      data-minimized={hidden}
      inert={hidden}
      aria-hidden={hidden || undefined}
      aria-label={t('View {name}', { name: title })}
      tabIndex={hidden ? -1 : 0}
      onFocus={onFocus}
      onPointerDown={onFocus}
      style={
        hidden
          ? {
              position: 'fixed',
              visibility: 'hidden',
              opacity: 0,
              pointerEvents: 'none',
              width: size.current.width,
              height: size.current.height,
              left: 0,
              top: 0,
            }
          : { order: index }
      }
    >
      {children}
    </div>
  );
}
