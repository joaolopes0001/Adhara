import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileQuestion,
  FileText,
  Folder,
  FolderMinus,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  Search,
  X,
  Layers,
  NotebookPen,
} from 'lucide-react';
import type { FileNode, Issue, Model, Root } from './types';
import { isFile, isUnresolved, outsideInventory, statuses, unresolvedLabels } from './types';
import { ItemDecorationsContext } from './itemDecorations';
import {
  ClassIcon,
  classKeys,
  classLabel,
  classOf,
  filterActive,
  noClassFilter,
} from './fileClasses';
import type { ClassFilter } from './fileClasses';
import { nodeIndex } from './observations';
import { t as translate, useI18n } from './i18n';

const SEARCH_LIMIT = 150;
/**
 * What "Close" does, said the same way in the tree and in the project menu. It reads the active language
 * when it is called.
 */
export const removeProjectHintText = () =>
  translate('Close: closes the project; it stays saved, with its notes and the Changes baseline.');
/**
 * One row of the tree (file or folder, without its children). Memoized: a render of the workspace that
 * does not change the item skips it, so a large expanded tree (as a class filter leaves it) stays fast.
 */
const TreeRow = memo(function TreeRow({
  node,
  depth,
  open,
  current,
  ownEntry,
  note,
  marker,
  toggle,
  choose,
}: {
  node: FileNode;
  depth: number;
  open: boolean;
  current: boolean;
  ownEntry: boolean;
  note: boolean;
  marker?: (node: FileNode) => ReactNode;
  toggle: (path: string) => void;
  choose: (node: FileNode) => void;
}) {
  const { t } = useI18n();
  const isDir = node.kind === 'directory';
  const mark = marker?.(node);
  return (
    <div
      className={
        isDir
          ? `tree-directory-row${mark ? ' has-marker' : ''}`
          : `tree-file-row${mark ? ' has-marker' : ''}`
      }
    >
      {isDir && (
        <button
          className="tree-directory-toggle"
          style={{ marginLeft: 12 + depth * 14 }}
          aria-label={
            open
              ? t('Collapse folder {name}', { name: node.name })
              : t('Expand folder {name}', { name: node.name })
          }
          aria-expanded={open}
          onClick={() => toggle(node.path)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}
      <button
        title={node.path}
        aria-expanded={isDir ? open : undefined}
        aria-current={current ? 'true' : undefined}
        className={`tree-item ${current ? 'selected' : ''} ${node.kind === 'entry' ? 'entry' : ''}`}
        style={{ paddingLeft: isDir ? 3 : 12 + depth * 14 }}
        onClick={() => choose(node)}
      >
        {!isDir && <span className="tree-spacer" />}
        {isDir ? open ? <FolderOpen size={15} /> : <Folder size={15} /> : <ClassIcon node={node} />}
        <span>{node.name}</span>
        {ownEntry && (
          <small
            className="entry-directory-badge"
            title={t(
              'Folder with its own instructions (AGENTS.md or CLAUDE.md): opens a view next to the parent view',
            )}
          >
            {t('instructions')}
          </small>
        )}
        {note && <NotebookPen size={12} />}
      </button>
      {mark && <span className="tree-marker">{mark}</span>}
    </div>
  );
});
/** The new order with `path` placed at `index` (an index of the list without it). */
function placed(order: string[], path: string, index: number) {
  const others = order.filter((item) => item !== path);
  return [...others.slice(0, index), path, ...others.slice(index)];
}

export default function Explorer({
  model,
  selected,
  select,
  remove,
  reorder,
  search,
  setSearch,
  observations,
  classFilter,
  setClassFilter,
  overview,
  busy,
  hidden,
  leaving = false,
  onLeft,
}: {
  hidden: boolean;
  /** Sliding out (see --motion-panel in style.css): on the screen, without input, until `onLeft`. */
  leaving?: boolean;
  onLeft?: () => void;
  overview: (path: string) => void;
  busy: boolean;
  model: Model;
  selected: string;
  select: (id: string) => void;
  /** "Close": closes the project and keeps it saved (its notes and Changes baseline too). */
  remove: (path: string) => void;
  /** Persists a new order of the opened projects; rejects with the server message on failure. */
  reorder: (order: string[]) => Promise<void>;
  search: string;
  setSearch: (s: string) => void;
  /** Observations of each item, for the "With observations" button. */
  observations: Map<string, Issue[]>;
  classFilter: ClassFilter;
  setClassFilter: (filter: ClassFilter) => void;
}) {
  const { t, plural, formatNumber } = useI18n();
  const { marker, include } = useContext(ItemDecorationsContext);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem('aae-collapsed-roots') || '[]');
      return new Set(
        Array.isArray(value)
          ? value.filter((path): path is string => typeof path === 'string')
          : [],
      );
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('aae-collapsed-roots', JSON.stringify([...collapsedRoots]));
    } catch {
      /* Optional browser persistence. */
    }
  }, [collapsedRoots]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!selected) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      let path = selected;
      while (path.lastIndexOf('/') > 0) {
        path = path.slice(0, path.lastIndexOf('/'));
        next.add(path);
      }
      // Unchanged when the ancestors were already open: no second render of the whole tree.
      return next.size === previous.size ? previous : next;
    });
  }, [selected]);
  // Stable handlers for the memoized rows; they call the latest select and overview.
  const latest = useRef({ select, overview });
  useLayoutEffect(() => {
    latest.current = { select, overview };
  });
  const toggle = useCallback(
    (path: string) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [],
  );
  const choose = useCallback((node: FileNode) => {
    if (node.kind === 'directory') {
      setExpanded((previous) => new Set(previous).add(node.path));
      latest.current.overview(node.id);
    } else latest.current.select(node.id);
  }, []);
  const [tab, setTab] = useState('files');
  // Order of the opened projects. While a new order is being saved the list already shows it; a server
  // error brings the previous order back, with the message next to the list.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  // The server's message and the move, said in words when drawn (so in the language of the moment).
  const [orderError, setOrderError] = useState('');
  const [announcement, setAnnouncement] = useState<{
    name: string;
    position: number;
    count: number;
  }>();
  const roots = useMemo(() => {
    if (!pendingOrder) return model.roots;
    const byPath = new Map(model.roots.map((root) => [root.path, root]));
    const listed = pendingOrder.flatMap((path) => byPath.get(path) ?? []);
    return [...listed, ...model.roots.filter((root) => !pendingOrder.includes(root.path))];
  }, [model.roots, pendingOrder]);
  const order = roots.map((root) => root.path);
  const [drag, setDrag] = useState<{
    path: string;
    pointer: number;
    startY: number;
    /** Index of the dragged project in the list without it. */
    index: number;
    moved: boolean;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const refocus = useRef('');
  useLayoutEffect(() => {
    const path = refocus.current;
    if (!path) return;
    const handle = [
      ...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-root-handle]') ?? []),
    ].find((element) => element.dataset.rootHandle === path);
    if (handle) {
      handle.focus({ preventScroll: true });
      handle.scrollIntoView({ block: 'nearest' });
    }
  }, [order.join('\0')]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) =>
      scrollRef.current
        ?.querySelectorAll<HTMLDetailsElement>('.root-menu[open]')
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.removeAttribute('open');
        });
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  // Esc cancels a drag wherever the focus is (pressing the mouse on the handle may not focus it).
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrag(null);
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [dragging]);
  async function commitOrder(next: string[], moved: Root, keepFocus: boolean) {
    if (busy || next.join('\0') === order.join('\0')) return;
    setOrderError('');
    setAnnouncement(undefined);
    setPendingOrder(next);
    refocus.current = keepFocus ? moved.path : '';
    try {
      await reorder(next);
      setAnnouncement({
        name: moved.name,
        position: next.indexOf(moved.path) + 1,
        count: next.length,
      });
    } catch (error) {
      setOrderError((error as Error).message);
    } finally {
      setPendingOrder(null);
      // Focus follows the moved project only for this move (and its undoing on an error).
      requestAnimationFrame(() => {
        refocus.current = '';
      });
    }
  }
  function step(root: Root, delta: number) {
    const index = order.indexOf(root.path) + delta;
    if (index < 0 || index >= order.length) return;
    void commitOrder(placed(order, root.path, index), root, true);
  }
  /** Insertion index (in the list without the dragged project) for the pointer height. */
  function dropIndex(path: string, y: number) {
    const headers = [
      ...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-root-header]') ?? []),
    ].filter((element) => element.dataset.rootHeader !== path);
    return headers.filter((element) => {
      const box = element.getBoundingClientRect();
      return y > box.top + box.height / 2;
    }).length;
  }
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, root: Root) {
    if (busy || roots.length < 2 || event.button !== 0) return;
    event.preventDefault();
    // preventDefault also blocks the default focus: focus explicitly so ↑/↓ work right after a click.
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    setOrderError('');
    setDrag({
      path: root.path,
      pointer: event.pointerId,
      startY: event.clientY,
      index: order.indexOf(root.path),
      moved: false,
    });
  }
  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || event.pointerId !== drag.pointer) return;
    // Near the edges the list scrolls, so a project can be dropped beyond what is visible.
    const box = scrollRef.current?.getBoundingClientRect();
    if (box && event.clientY < box.top + 24) scrollRef.current!.scrollTop -= 12;
    if (box && event.clientY > box.bottom - 24) scrollRef.current!.scrollTop += 12;
    const index = dropIndex(drag.path, event.clientY);
    const moved = drag.moved || Math.abs(event.clientY - drag.startY) > 4;
    if (index !== drag.index || moved !== drag.moved) setDrag({ ...drag, index, moved });
  }
  function endDrag(event: ReactPointerEvent<HTMLButtonElement>, root: Root) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { index, moved } = drag;
    setDrag(null);
    if (moved) void commitOrder(placed(order, root.path, index), root, false);
  }
  function handleKey(event: ReactKeyboardEvent<HTMLButtonElement>, root: Root) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      step(root, event.key === 'ArrowUp' ? -1 : 1);
    }
  }
  const dragTarget = drag?.moved ? placed(order, drag.path, drag.index) : null;
  const dragChanges = !!dragTarget && dragTarget.join('\0') !== order.join('\0');
  const draggedName = drag ? roots.find((root) => root.path === drag.path)?.name : '';
  // The line that shows where the dragged project will land: before the project now at that position.
  const dropBefore = dragChanges
    ? (order.filter((path) => path !== drag!.path)[drag!.index] ?? '')
    : null;
  const children = useMemo(() => {
    const map = new Map<string, FileNode[]>();
    for (const node of model.nodes) {
      const parent = node.path.slice(0, node.path.lastIndexOf('/'));
      let siblings = map.get(parent);
      if (!siblings) {
        siblings = [];
        map.set(parent, siblings);
      }
      siblings.push(node);
    }
    for (const items of map.values())
      items.sort(
        (a, b) =>
          Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
          a.name.localeCompare(b.name),
      );
    return map;
  }, [model.nodes]);
  // Inventoried files only: reference placeholders are never listed or counted as files.
  const files = useMemo(
    () => model.nodes.filter((n) => isFile(n) && !outsideInventory.has(n.status)),
    [model.nodes],
  );
  // The class filter keeps the folders on the way to every kept file (as the Structure does).
  const keptFolders = useMemo(() => {
    if (!include) return null;
    const folders = new Set<string>();
    for (const node of files)
      if (include(node))
        for (
          let path = node.path.slice(0, node.path.lastIndexOf('/'));
          path && !folders.has(path);
          path = path.slice(0, path.lastIndexOf('/'))
        )
          folders.add(path);
    return folders;
  }, [files, include]);
  // Choosing a class reveals where its files are: the folders on the way open (they can be closed again).
  useEffect(() => {
    if (keptFolders) setExpanded((previous) => new Set([...previous, ...keptFolders]));
  }, [keptFolders]);
  const shown = (n: FileNode) =>
    !include || (n.kind === 'directory' ? !!keptFolders?.has(n.path) : include(n));
  const classCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of files) counts.set(classOf(node), (counts.get(classOf(node)) ?? 0) + 1);
    return counts;
  }, [files]);
  const observed = files.filter(
    (node) =>
      observations.has(node.id) && (!classFilter.only || classOf(node) === classFilter.only),
  ).length;
  function tree(path: string, root: string, depth = 0): React.ReactNode {
    return children
      .get(path)
      ?.filter((n) => n.roots.includes(root) && !outsideInventory.has(n.status) && shown(n))
      .map((n) => {
        const isDir = n.kind === 'directory',
          open = expanded.has(n.path);
        return (
          <div key={n.id}>
            <TreeRow
              node={n}
              depth={depth}
              open={open}
              current={selected === n.id}
              ownEntry={!!isDir && !!children.get(n.path)?.some((child) => child.kind === 'entry')}
              note={!!model.notes[n.id]}
              marker={marker}
              toggle={toggle}
              choose={choose}
            />
            {isDir && open && tree(n.path, root, depth + 1)}
          </div>
        );
      });
  }
  const nodes = nodeIndex(model);
  // Destinations that do not exist as inventoried files stay out of the main list, collapsed below it.
  const matches = search
    ? model.nodes.filter(
        (n) =>
          n.kind !== 'directory' &&
          (n.relative + n.path).toLowerCase().includes(search.toLowerCase()),
      )
    : [];
  const hits = matches.filter(isFile),
    unresolved = matches.filter(isUnresolved);
  return (
    // No title row nor footer: collapsing is in the top bar, the "More" menu and Ctrl+B; the files read
    // are counted in the bottom bar.
    <aside
      hidden={hidden}
      className={`explorer${leaving ? ' is-leaving' : ''}`}
      inert={leaving}
      aria-hidden={leaving || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && leaving) onLeft?.();
      }}
    >
      <div className="search-box">
        <Search size={14} />
        <input
          id="workspace-search"
          aria-label={t('Search files')}
          placeholder={t('Search files…')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setSearch('');
            }
          }}
        />
        <button
          className="icon-button"
          aria-label={t('Clear search')}
          title={t('Clear search')}
          disabled={!search}
          onClick={() => {
            setSearch('');
            document.getElementById('workspace-search')?.focus();
          }}
        >
          <X size={13} />
        </button>
      </div>
      <div className="small-tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          {t('Files')}
        </button>
        <button
          className={tab === 'objects' ? 'active' : ''}
          title={t(
            'Logical objects: skills (folders with SKILL.md) and objects declared in agent-architecture.json',
          )}
          onClick={() => setTab('objects')}
        >
          {t('Skills and objects')} <span>{formatNumber(model.objects.length)}</span>
        </button>
      </div>
      {tab === 'files' && !search && model.roots.length > 0 && (
        // One line: a selector of the class (each with its count) and "With observations".
        <div className="class-filter" role="group" aria-label={t('Filter files by class')}>
          <select
            aria-label={t('File class')}
            title={t('Filters the tree and the Structure by file class')}
            value={classFilter.only ?? ''}
            onChange={(event) =>
              setClassFilter({
                ...classFilter,
                only: (event.target.value || null) as ClassFilter['only'],
              })
            }
          >
            <option value="">
              {t('All', { context: 'files' })} · {formatNumber(files.length)}
            </option>
            {classKeys.map((key) => (
              <option
                key={key}
                value={key}
                disabled={!classCounts.get(key) && classFilter.only !== key}
              >
                {classLabel(key, t)} · {formatNumber(classCounts.get(key) ?? 0)}
              </option>
            ))}
          </select>
          <button
            className="class-observed"
            aria-pressed={classFilter.observed}
            disabled={!observed && !classFilter.observed}
            title={t('Only files with Audit observations (problems, warnings or info)')}
            onClick={() => setClassFilter({ ...classFilter, observed: !classFilter.observed })}
          >
            {t('With observations')} · <span>{formatNumber(observed)}</span>
          </button>
          {filterActive(classFilter) && (
            <button
              className="class-clear"
              aria-label={t('Clear class filter')}
              title={t('Clear class filter')}
              onClick={() => setClassFilter(noClassFilter)}
            >
              <X size={11} />
            </button>
          )}
        </div>
      )}
      <div className="explorer-scroll" ref={scrollRef}>
        {search ? (
          <>
            <div className="search-results">
              <p>
                {plural(hits.length, '{count} file', '{count} files')}
                {hits.length > SEARCH_LIMIT
                  ? ` · ${t('first {limit}', { limit: SEARCH_LIMIT })}`
                  : ''}
              </p>
              {!hits.length && <p className="empty-small">{t('No file matches the search.')}</p>}
              {hits.slice(0, SEARCH_LIMIT).map((n) => (
                <button
                  key={n.id}
                  className={selected === n.id ? 'selected' : ''}
                  onClick={() => select(n.id)}
                  title={n.path}
                >
                  <FileText size={14} />
                  <span>
                    {n.name}
                    <small>{n.relative}</small>
                  </span>
                </button>
              ))}
            </div>
            {unresolved.length > 0 && (
              <details className="unresolved-group search-unresolved">
                <summary>
                  {plural(
                    unresolved.length,
                    '{count} target not found',
                    '{count} targets not found',
                  )}
                </summary>
                {unresolved.slice(0, SEARCH_LIMIT).map((n) => (
                  <button
                    key={n.id}
                    className={`unresolved-item${selected === n.id ? ' selected' : ''}`}
                    onClick={() => select(n.id)}
                    title={n.path}
                  >
                    <FileQuestion size={14} />
                    <span>
                      {n.name}
                      <small>{n.relative}</small>
                    </span>
                    <em className={`unresolved-tag ${n.status}`}>
                      {unresolvedLabels[n.status] || statuses[n.status] || n.status}
                    </em>
                  </button>
                ))}
                {unresolved.length > SEARCH_LIMIT && (
                  <p>
                    {t('First {limit} of {count}. Narrow the search.', {
                      limit: SEARCH_LIMIT,
                      count: unresolved.length,
                    })}
                  </p>
                )}
              </details>
            )}
          </>
        ) : tab === 'objects' ? (
          <div className="object-list">
            {model.objects.map((o) => (
              <button key={o.id} onClick={() => select(o.node)}>
                <Layers size={16} />
                <span>
                  {o.name}
                  <small title={o.node}>
                    {o.type} · {nodes.get(o.node)?.relative ?? o.node}
                  </small>
                </span>
              </button>
            ))}
            {!model.objects.length && <p className="empty-small">{t('No logical objects.')}</p>}
          </div>
        ) : !model.roots.length ? (
          <p className="empty-small">{t('Open a folder to explore its files.')}</p>
        ) : (
          <div
            className={`project-list${drag ? ' is-dragging' : ''}`}
            role="list"
            aria-label={t('Open projects')}
          >
            {orderError && (
              <div className="project-order-error" role="alert">
                <span>
                  {t('Could not change the project order: {message} The previous order was kept.', {
                    message: orderError,
                  })}
                </span>
                <button
                  className="icon-button"
                  aria-label={t('Dismiss project order error')}
                  onClick={() => setOrderError('')}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {roots.map((root, index) => (
              <section
                className={`root-section${drag?.path === root.path ? ' is-dragged' : ''}`}
                key={root.path}
                role="listitem"
                aria-label={t('Project {name}', { name: root.name })}
              >
                {dropBefore === root.path && <div className="project-drop-line" aria-hidden />}
                <div className="tree-root" title={root.path} data-root-header={root.path}>
                  {roots.length > 1 && (
                    <button
                      className="icon-button root-handle"
                      data-root-handle={root.path}
                      aria-disabled={busy || undefined}
                      aria-label={t(
                        'Reorder {name} ({position} of {count}): drag, or use the up and down arrows',
                        {
                          name: root.name,
                          position: index + 1,
                          count: roots.length,
                        },
                      )}
                      title={t('Drag to reorder (or ↑ and ↓)')}
                      onPointerDown={(event) => startDrag(event, root)}
                      onPointerMove={moveDrag}
                      onPointerUp={(event) => endDrag(event, root)}
                      onPointerCancel={() => setDrag(null)}
                      onLostPointerCapture={() => setDrag(null)}
                      onKeyDown={(event) => handleKey(event, root)}
                    >
                      <GripVertical size={13} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    className="icon-button root-toggle"
                    aria-label={
                      collapsedRoots.has(root.path)
                        ? t('Expand project {name}', { name: root.name })
                        : t('Collapse project {name}', { name: root.name })
                    }
                    aria-expanded={!collapsedRoots.has(root.path)}
                    onClick={() =>
                      setCollapsedRoots((previous) => {
                        const next = new Set(previous);
                        if (next.has(root.path)) next.delete(root.path);
                        else next.add(root.path);
                        return next;
                      })
                    }
                  >
                    {collapsedRoots.has(root.path) ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </button>
                  <button
                    className="root-overview"
                    aria-label={t('Back to project {name}', { name: root.name })}
                    aria-current={selected === root.path ? 'true' : undefined}
                    onClick={() => overview(root.path)}
                  >
                    <FolderOpen size={15} />
                    <strong>{root.name}</strong>
                  </button>
                  <details
                    className="root-menu"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.currentTarget.removeAttribute('open');
                        event.currentTarget.querySelector('summary')?.focus();
                      }
                    }}
                  >
                    <summary
                      aria-label={t('Actions for project {name}', { name: root.name })}
                      title={t('Order and removal')}
                    >
                      <MoreHorizontal size={14} />
                    </summary>
                    <div>
                      {(
                        [
                          [-1, ArrowUp],
                          [1, ArrowDown],
                        ] as const
                      ).map(([delta, Icon]) => (
                        <button
                          key={delta}
                          disabled={busy || index + delta < 0 || index + delta >= roots.length}
                          aria-label={
                            delta < 0
                              ? t('Move {name} up', { name: root.name })
                              : t('Move {name} down', { name: root.name })
                          }
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            step(root, delta);
                          }}
                        >
                          <Icon size={13} aria-hidden="true" />
                          {delta < 0 ? t('Move up') : t('Move down')}
                        </button>
                      ))}
                      <button
                        disabled={busy}
                        title={removeProjectHintText()}
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          remove(root.path);
                        }}
                      >
                        <FolderMinus size={13} aria-hidden="true" />
                        {t('Close')}
                      </button>
                    </div>
                  </details>
                  <button
                    className="icon-button root-remove"
                    disabled={busy}
                    title={removeProjectHintText()}
                    aria-label={t('Close {name}', { name: root.name })}
                    onClick={() => remove(root.path)}
                  >
                    <FolderMinus size={13} aria-hidden="true" />
                  </button>
                </div>
                {!collapsedRoots.has(root.path) && (
                  <>
                    {root.parent && (
                      <div className="root-meta">
                        {plural(
                          root.level,
                          '↳ {parent} · +{count} level',
                          '↳ {parent} · +{count} levels',
                          { parent: root.parent.split('/').at(-1) ?? '' },
                        )}
                      </div>
                    )}
                    {tree(root.path, root.path)}
                    {include &&
                      !files.some((node) => node.roots.includes(root.path) && include(node)) && (
                        <p className="empty-small">
                          {t('No files from this filter in this project.')}
                        </p>
                      )}
                  </>
                )}
              </section>
            ))}
            {dropBefore === '' && <div className="project-drop-line" aria-hidden />}
            <p className="visually-hidden" role="status">
              {announcement && t('{name} is now project {position} of {count}.', announcement)}
            </p>
          </div>
        )}
      </div>
      {drag?.moved && (
        // At the foot of the explorer, never over a project where the dragged one could land.
        <p className="project-drag-hint" aria-hidden="true">
          {dragChanges
            ? t('Drop to place {name} at position {position} of {count} · Esc cancels', {
                name: draggedName ?? '',
                position: drag.index + 1,
                count: order.length,
              })
            : t('Drag {name} above or below another project · Esc cancels', {
                name: draggedName ?? '',
              })}
        </p>
      )}
    </aside>
  );
}
