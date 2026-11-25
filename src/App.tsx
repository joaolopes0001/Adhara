import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Filter,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  History,
  Languages,
  Home,
  PanelLeft,
  PanelRight,
  RotateCcw,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  FileText,
  FolderOpen,
  FolderPlus,
  Info,
  GitBranch,
  Layers,
  MessageSquare,
  Plus,
  RefreshCw,
  Route,
  ScanSearch,
  ShieldCheck,
  X,
  Moon,
  Sun,
  PencilLine,
  PencilOff,
  TextCursor,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  bounds,
  defaultBottomHeight,
  defaultBottomHeightCss,
  explorerRoom,
  inspectorMax,
  paneMinHeight,
  ResizeHandle,
  toolPanelMinHeight,
  useHeight,
  useLayout,
  usePresence,
  useWindowHeight,
  useWindowWidth,
  twoColumnsMinWidth,
} from './layout';
import { api, connect, loadModel, onReconnect, setExpected } from './api';
import { applyTheme, readTheme } from './theme';
import type { Theme } from './theme';
import { LANGUAGES, useI18n } from './i18n';
import type { Translator } from './i18n';
import { messageText, relationEvidence, serverText } from './serverText';
import MapWorkspace from './MapWorkspace';
import type { Arrangement } from './MapWorkspace';
import AuditPanel, {
  allProjects,
  defaultAuditView,
  observationEdge,
  unresolvedFilter,
} from './AuditPanel';
import type { AuditView } from './AuditPanel';
import ChangesPanel, {
  deltaCount,
  describeContext,
  describeDelta,
  notCompared,
} from './ChangesPanel';
import { FilterDialog } from './MapFilters';
import { readFilters } from './mapFilters';
import type { MapFilter } from './mapFilters';
import {
  activeMode,
  dirname,
  scopeFor,
  scopePaths,
  viewMode,
  visit,
  within,
  withMode,
} from './scopeNavigation';
import type { ViewMode, Visit } from './scopeNavigation';
import Explorer from './Explorer';
import { MenuButton } from './MenuButton';
import type { MenuAction } from './MenuButton';
import { CasesDialog, CreateDialog, ForgetDialog, OpenDialog } from './Dialogs';
import HomeList from './HomeList';
import { HelpDialog } from './Help';
import { observationKey, targetRanges } from './editing';
import {
  EditButton,
  EditingDialogs,
  EditorSlot,
  StaleNotice,
  cursorText,
  editingStatus,
  heldEditorLine,
  holdReadOnlyPlace,
  restoreReadOnlyPlace,
  useEditing,
  useNewborn,
} from './FileEditor';
import type { Delta, FileNode, Issue, Model, Relation, Trace } from './types';
import {
  analyzedExtensions,
  isFile,
  isUnresolved,
  kinds,
  outsideInventory,
  relations,
  relationTally,
  resolutionLabel,
  resolutionNote,
  scopeKinds,
  statuses,
} from './types';
import { fieldText, resolveTracePath, rootRelative } from './tracePath';
import type { TraceTarget } from './tracePath';
import { InspectorContext, ItemDecorationsContext } from './itemDecorations';
import type { InspectorAccess } from './itemDecorations';
import type { ItemDecorations } from './itemDecorations';
import {
  codeInfo,
  issueInfo,
  diagnose,
  nodeIndex,
  observationsByNode,
  projectOf,
  projectPath,
  showsMarker,
} from './observations';
import {
  Diagnosis,
  FileObservations,
  ObservationBadge,
  ObservationMarker,
  ObservationTitle,
} from './Diagnosis';
import { classOf, filterActive, noClassFilter } from './fileClasses';
import {
  describeInventoryCut,
  describePartial,
  listingCauses,
  omittedAtLeast,
  partialLabel,
  partialReading,
} from './partialReading';
import type { ClassFilter } from './fileClasses';
import {
  markOf,
  rememberReason,
  rememberedReason,
  settledDestinations,
  splitExpected,
} from './expected';

type Tool = 'trace' | 'audit' | 'changes';
/** A Trace field that does not designate one file: candidates to choose or suggestions, next to the field. */
type FieldProblem = Exclude<TraceTarget, { kind: 'found' }>;
function toolName(tool: Tool, t: Translator['t']) {
  return tool === 'trace' ? t('Trace') : tool === 'audit' ? t('Audit') : t('Changes');
}
function toolTitles(tool: Tool, t: Translator['t']): [string, string] {
  if (tool === 'trace') return [t('Trace between files'), t('Trace between files')];
  if (tool === 'audit') return [t('Audit of references'), t('Audit of references')];
  return [t('Changes between scans'), t('Changes since the baseline')];
}
/** Lines of the file preview mounted at first and added by each "Show"; lines kept around a far line. */
const PREVIEW_LINES = 400;
const NO_ISSUES: Issue[] = [];
const PREVIEW_CONTEXT = 200;
/** The text of a line with the ranges marked, as text nodes and `mark` elements made here, never parsed. */
function markedText(text: string, ranges: [number, number][]) {
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark className="line-target" key={index}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
/**
 * Read-only text of the inspector with numbered lines. Mounts the first 400 lines of a long text (up to
 * 1 MiB) and 400 more per request; a highlighted line beyond them is shown with the lines around it. The
 * destination written by the reference (`target`, in its `syntax`) is marked on that line. Memoized.
 */
const SourcePreview = memo(function SourcePreview({
  path,
  text,
  line,
  target = '',
  syntax = '',
}: {
  path: string;
  text: string;
  line: number;
  target?: string;
  syntax?: string;
}) {
  const { t } = useI18n();
  const partialPreview = t(
    'Only the lines shown are on the page: the browser search (Ctrl+F) and copying do not reach the others.',
  );
  const lines = useMemo(() => text.split('\n'), [text]);
  // The editor takes this text's place and gives it back with the line in view at the same top.
  const code = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const element = code.current;
    restoreReadOnlyPlace(path, element);
    return () => holdReadOnlyPlace(path, element);
  }, [path]);
  // Lines from the top; and, around a highlighted line beyond them, the lines added above and below.
  const [shown, setShown] = useState({ top: PREVIEW_LINES, above: 0, below: 0 });
  // Coming back from the editor: around the line it had in view, as around a highlighted line, until
  // another line is highlighted.
  const [around, setAround] = useState(() => heldEditorLine(path) ?? 0);
  const firstLine = useRef(line);
  useEffect(() => {
    if (line !== firstLine.current) setAround(0);
  }, [line]);
  const focus = around || line;
  // A line beyond the end: the file changed on disk after the reading that gave the evidence.
  const missing = line > lines.length;
  const far = focus > shown.top && focus <= lines.length;
  const start = far ? Math.max(0, focus - 1 - PREVIEW_CONTEXT - shown.above) : 0;
  const end = Math.min(lines.length, far ? focus + PREVIEW_CONTEXT + shown.below : shown.top);
  return (
    <>
      {missing && (
        <div className="source-context" role="status">
          {t(
            'Line {line} does not exist in the version of the file on disk, which ends at line {last}: it changed after the scan. Rescan the projects.',
            { line, last: lines.length },
          )}
        </div>
      )}
      {start > 0 && (
        <button
          className="load-more"
          title={partialPreview}
          onClick={() => setShown({ ...shown, above: shown.above + PREVIEW_LINES })}
        >
          {t('Show {count} earlier · {left} left', {
            count: Math.min(PREVIEW_LINES, start),
            left: start,
          })}
        </button>
      )}
      {/* The column of the numbers is as wide as the largest number of the file (editor.css). */}
      <pre
        className="source-code"
        ref={code}
        style={{ '--line-digits': String(lines.length).length } as CSSProperties}
      >
        {lines.slice(start, end).map((text, index) => {
          const highlighted = line === start + index + 1;
          const ranges = highlighted ? targetRanges(text, target, syntax) : [];
          return (
            <div
              data-line={start + index + 1}
              className={highlighted ? 'highlight-line' : ''}
              key={start + index}
            >
              <span>{start + index + 1}</span>
              <code>{ranges.length ? markedText(text, ranges) : text || ' '}</code>
            </div>
          );
        })}
      </pre>
      {end < lines.length && (
        <button
          className="load-more"
          title={partialPreview}
          onClick={() =>
            setShown(
              far
                ? { ...shown, below: shown.below + PREVIEW_LINES }
                : { ...shown, top: shown.top + PREVIEW_LINES },
            )
          }
        >
          {t('Show {count} more · {left} left', {
            count: Math.min(PREVIEW_LINES, lines.length - end),
            left: lines.length - end,
          })}
        </button>
      )}
    </>
  );
});
/** Suggestions of a Path field: up to 100 items other than folders whose path contains the typed text. */
function FileOptions({ id, nodes, text }: { id: string; nodes: FileNode[]; text: string }) {
  const matches = useMemo(
    () =>
      nodes
        .filter((n) => n.kind !== 'directory' && n.path.toLowerCase().includes(text.toLowerCase()))
        .slice(0, 100),
    [nodes, text],
  );
  return (
    <datalist id={id}>
      {matches.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name}
        </option>
      ))}
    </datalist>
  );
}
type StripNotice = {
  key: string;
  text: string;
  tone: 'problem' | 'warning';
  action?: { label: string; run: () => void };
  dismiss?: () => void;
  dismissLabel?: string;
};
/**
 * The strip below the header: one message, or "N notices" that opens the list. It speaks as an alert when
 * a failure is among its messages.
 */
function WindowStrip({ notices }: { notices: StripNotice[] }) {
  const { t, plural } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!notices.length) return null;
  const tone = notices.some((notice) => notice.tone === 'problem') ? 'problem' : 'warning';
  const body = (notice: StripNotice) => (
    <>
      <span className={`strip-text tone-${notice.tone}`}>{notice.text}</span>
      {notice.action && (
        <button className="strip-action" onClick={notice.action.run}>
          {notice.action.label}
        </button>
      )}
      {notice.dismiss && (
        <button
          className="icon-button"
          aria-label={notice.dismissLabel ?? t('Dismiss notice')}
          onClick={notice.dismiss}
        >
          <X size={15} />
        </button>
      )}
    </>
  );
  return (
    <div className={`error-banner strip-${tone}`} role={tone === 'problem' ? 'alert' : 'status'}>
      {notices.length === 1 ? (
        body(notices[0])
      ) : (
        <div className="strip-list">
          <button
            className={`strip-action tone-${tone}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {plural(notices.length, '{count} notice', '{count} notices')}
          </button>
          {expanded && (
            <ul>
              {notices.map((notice) => (
                <li key={notice.key}>{body(notice)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
type StatusItem = {
  key: string;
  /** Higher stays longer: the link of partial reading goes last, then the one of unresolved destinations. */
  priority: number;
  node: ReactNode;
  menu: Omit<MenuAction, 'onSelect'> & { onSelect?: () => void };
};
/**
 * The state of the reading, right of the tools. Items never end in an ellipsis: when the line has no room,
 * the least important ones leave whole (lowest priority first) and the "Status" menu lists them.
 */
function StatusLine({ items }: { items: StatusItem[] }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const fit = useCallback(() => {
    const element = box.current;
    if (!element) return;
    const width = (selector: string) =>
      [...element.querySelectorAll<HTMLElement>(selector)].map((slot) => ({
        key: slot.dataset.key!,
        width: slot.getBoundingClientRect().width,
      }));
    const slots = width(':scope > .status-slot');
    const more = width(':scope > .status-more')[0]?.width ?? 0;
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    const room = element.clientWidth;
    const order = [...items].sort((a, b) => a.priority - b.priority).map((item) => item.key);
    const out: string[] = [];
    const used = () =>
      slots
        .filter((slot) => !out.includes(slot.key))
        .reduce((sum, slot) => sum + slot.width + gap, 0) -
      gap +
      (out.length ? more + gap : 0);
    for (const key of order) {
      if (used() <= room) break;
      out.push(key);
    }
    const next = out.sort().join('\0');
    setHidden((previous) => (previous.slice().sort().join('\0') === next ? previous : out));
  }, [items]);
  useLayoutEffect(fit);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  const left = items.filter((item) => hidden.includes(item.key));
  return (
    <div className="status-bar" ref={box}>
      {items.map((item) => (
        <span
          key={item.key}
          className="status-slot"
          data-key={item.key}
          data-hidden={hidden.includes(item.key) || undefined}
          aria-hidden={hidden.includes(item.key) || undefined}
        >
          {item.node}
        </span>
      ))}
      <span className="status-more" data-hidden={!left.length || undefined}>
        <MenuButton
          id="status-menu"
          label={t('Status')}
          title={t('Scan status that does not fit in the bar')}
          icon={Info}
          above
          actions={left.map((item) => ({ onSelect: () => {}, ...item.menu }))}
        />
      </span>
    </div>
  );
}
/**
 * "34 of 36 files read": the texts read for references, of every file listed (`stats.files`, without folders
 * or symbolic links). Past the inventory limit the total also counts the files left out of it ("of at least"
 * when the existence index also overflowed), so the share read is never larger than it is.
 */
function readCount(model: Model, listed: number, plural: Translator['plural']) {
  const inventory = model.stats.inventory;
  const cut = inventory && !inventory.complete;
  const total = listed + (cut ? inventory.omittedFiles : 0);
  const numbers = { parsed: model.stats.parsed, total };
  return cut && !inventory.lookupComplete
    ? plural(
        total,
        '{parsed} of at least {total} file read',
        '{parsed} of at least {total} files read',
        numbers,
      )
    : plural(total, '{parsed} of {total} file read', '{parsed} of {total} files read', numbers);
}
/** The contexts of the window: the inspector as the maps see it. */
function WindowContexts({
  inspector,
  children,
}: {
  inspector: InspectorAccess;
  children: ReactNode;
}) {
  return <InspectorContext.Provider value={inspector}>{children}</InspectorContext.Provider>;
}
export default function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const { t, plural: i18nPlural, rich, language, setLanguage } = useI18n();
  const otherLanguage = language === 'en' ? 'pt' : 'en';
  const [model, setModel] = useState<Model>();
  // The projects of the model on the screen: a new reading compares with them to know which ones left.
  const shownRoots = useRef<string[]>([]);
  useEffect(() => {
    shownRoots.current = model?.roots.map((root) => root.path) ?? [];
  }, [model]);
  const [home, setHome] = useState('');
  const [parent, setParent] = useState('');
  const [error, setError] = useState('');
  // A failed copy of a path, said in the strip in the language of the moment.
  const [copyFailed, setCopyFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [navigation, setNavigation] = useState<{ entries: Visit[]; index: number }>({
    entries: [{ selected: '', views: [] }],
    index: 0,
  });
  const { entries: history, index: historyIndex } = navigation;
  const { selected, views } = history[historyIndex];
  const { layout, setLayout, compact, isOpen, show, reset: resetLayout } = useLayout();
  const inspectorOpen = isOpen('inspector');
  const inspectorAccess = useMemo(
    () => ({ open: inspectorOpen, show: () => show('inspector', true) }),
    [inspectorOpen, show],
  );
  const bottomOpen = layout.bottom;
  const setBottomOpen = (bottom: boolean) => setLayout((previous) => ({ ...previous, bottom }));
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'open' | 'add' | 'create' | 'help' | 'filters' | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const [filters, setFilters] = useState<MapFilter[]>(readFilters);
  const [highlight, setHighlight] = useState('');
  const [filterViews, setFilterViews] = useState<string[]>([]);
  useEffect(() => {
    try {
      localStorage.setItem('aae-map-filters', JSON.stringify(filters));
    } catch {
      /* Optional browser persistence. */
    }
  }, [filters]);
  const activeFilter = filters.find((filter) => filter.id === highlight);
  const openFilters = filters.filter((filter) => filterViews.includes(filter.id));
  const saveFilter = (filter: MapFilter) =>
    setFilters((previous) => [...previous.filter((item) => item.id !== filter.id), filter]);
  const openFilter = (id: string) => {
    setFilterViews((previous) => (previous.includes(id) ? previous : [...previous, id]));
    setBottomOpen(false);
  };
  const highlightFilter = (id: string) => {
    setHighlight(id);
    setBottomOpen(false);
  };
  // "Hide panels" remembers which panels were open; "Show panels" brings those back (the explorer when none was).
  const panelsBeforeHiding = useRef<
    { explorer: boolean; inspector: boolean; bottom: boolean } | undefined
  >(undefined);
  const hidePanels = () => {
    panelsBeforeHiding.current = {
      explorer: shown('explorer'),
      inspector: shown('inspector'),
      bottom: layout.bottom,
    };
    showPanel('explorer', false);
    showPanel('inspector', false);
    setBottomOpen(false);
  };
  const showPanels = () => {
    const before = panelsBeforeHiding.current ?? {
      explorer: true,
      inspector: false,
      bottom: false,
    };
    panelsBeforeHiding.current = undefined;
    if (before.inspector) showPanel('inspector', true);
    if (before.explorer || !before.inspector) showPanel('explorer', true);
    if (before.bottom) setBottomOpen(true);
  };
  const [bottom, setBottom] = useState<Tool>('trace');
  // The changes a reading found, said in words when drawn (so in the language of the moment).
  const [changeNotice, setChangeNotice] = useState<Delta>();
  const [edgeId, setEdgeId] = useState('');
  const [sourceLine, setSourceLine] = useState(0);
  // Observation opened from the audit: named above the highlighted line while that line is still shown,
  // with the destination as written (and its syntax) to mark on the line when no relation holds it.
  const [observation, setObservation] = useState<{
    id: string;
    node: string;
    line: number;
    target?: string;
    syntax?: string;
  }>();
  const [inspectorTab, setInspectorTab] = useState('source');
  const [note, setNote] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [selected]);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  const [noteSaves, setNoteSaves] = useState<Record<string, { pending: boolean; error?: string }>>(
    {},
  );
  const savingNotes = useRef(new Set<string>());
  const savedNoteVersion = useRef(0);
  const confirmedNotes = useRef(new Map<string, { version: number; value: string }>());
  const [content, setContent] = useState<{ path: string; text: string; truncated: boolean }>();
  const [contentError, setContentError] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [direction, setDirection] = useState('directed');
  const [trace, setTrace] = useState<Trace | null>(null);
  /**
   * Home: the list of projects, shown when nothing is selected and no traced path or filter box asks for the
   * grid (or when no project is open). The explorer and the inspector stay out so the list takes the width.
   */
  const atHome =
    !!model &&
    (!model.roots.length ||
      (!selected &&
        !(bottomOpen && bottom === 'trace' && trace) &&
        !activeFilter &&
        !openFilters.length));
  // On Home the panels come in only when asked for (their button, the More menu, Ctrl+B, Ctrl+K), without
  // changing the saved layout, which comes back on leaving Home (Ctrl+K opens the explorer for good).
  const [homePanels, setHomePanels] = useState<ReadonlySet<'explorer' | 'inspector'>>(new Set());
  // The project chosen on a row of Home: its view takes the grid alone and the others wait minimized in the
  // strip of views (MapWorkspace). Cleared on returning to Home and by any selection outside that project,
  // so the user's later choice wins over the pending one while a closed project is still being read.
  const [soloProject, setSoloProject] = useState('');
  useEffect(() => {
    setSoloProject((chosen) => (chosen && (atHome || !within(selected, chosen)) ? '' : chosen));
  }, [atHome, selected]);
  // The arrangement of the grid of views (minimized views, order, orientation) while Home is on the
  // screen: coming back by Back, Forward or a file shows it as it was left. Only the last one.
  const arrangement = useRef<Arrangement | undefined>(undefined);
  // Columns of views on the screen: the inspector leaves the centre room for each of them.
  const [gridColumns, setGridColumns] = useState(1);
  // While the reading is still on its way the app opens on Home: a panel asked for then stays asked for.
  const onHome = atHome || !model;
  useEffect(() => {
    if (!onHome) setHomePanels(new Set());
  }, [onHome]);
  const shown = (panel: 'explorer' | 'inspector') =>
    onHome ? homePanels.has(panel) : isOpen(panel);
  const showPanel = (panel: 'explorer' | 'inspector', open: boolean) => {
    if (!onHome) return show(panel, open);
    setHomePanels((previous) => {
      const next = new Set(previous);
      if (open) next.add(panel);
      else next.delete(panel);
      return next;
    });
  };
  const explorerShown = shown('explorer');
  const inspectorPanel = usePresence(!!model?.roots.length && shown('inspector'));
  // The explorer stays mounted (search, scroll and open folders kept) and slides out before it hides.
  const explorerPanel = usePresence(!!model?.roots.length && explorerShown);
  // Capped when drawing so the centre keeps 320 px per column of views; the saved width is not written
  // down to it, so it comes back in a wider window or with one column again.
  const windowWidth = useWindowWidth();
  const inspectorLimit = inspectorMax(
    windowWidth,
    model?.roots.length && explorerShown
      ? explorerRoom(windowWidth, layout.explorerWidth, compact)
      : 0,
    compact,
    gridColumns,
  );
  const inspectorWidth = Math.min(layout.inspectorWidth, inspectorLimit);
  // Two columns need both views at their least width beside the explorer and the inspector (in a compact
  // window the inspector keeps the width it has); otherwise the views stack.
  const twoColumnsFit =
    windowWidth -
      (model?.roots.length && explorerShown
        ? explorerRoom(windowWidth, layout.explorerWidth, compact)
        : 0) -
      (model?.roots.length && shown('inspector')
        ? (compact ? inspectorWidth : bounds.inspectorWidth[0]) + 1
        : 0) >=
    twoColumnsMinWidth(compact);
  // Each view on the screen keeps its least height (paneMinHeight); the bottom panel gets what the rows
  // of views leave it, never more than it asked for (--bottom-room).
  const mainRef = useRef<HTMLElement>(null);
  const mainHeight = useHeight(mainRef);
  const windowHeight = useWindowHeight();
  const leastPane = paneMinHeight(windowHeight <= 550);
  const panelShown = !!model && bottomOpen && model.roots.length > 0;
  const gridRoom = mainHeight
    ? mainHeight - (panelShown ? toolPanelMinHeight(windowHeight <= 600) : 0)
    : 0;
  const [gridRows, setGridRows] = useState(1);
  const bottomRoom =
    mainHeight && !atHome ? mainHeight - (gridRows * leastPane + gridRows - 1) : null;
  const [forgetting, setForgetting] = useState('');
  const closeForget = useCallback(() => setForgetting(''), []);
  const [startProblem, setStartProblem] = useState<FieldProblem>();
  const [endProblem, setEndProblem] = useState<FieldProblem>();
  const showPathEnd = useCallback((input: HTMLInputElement | null) => {
    if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
  }, []);
  useEffect(() => {
    for (const id of ['trace-start', 'trace-end'])
      showPathEnd(document.getElementById(id) as HTMLInputElement | null);
  }, [start, end, showPathEnd]);
  // A file chosen for a field ("Set as A/B" or a candidate) keeps its id beside the text shown:
  // the text, relative to its project, is never read again while the user has not edited it.
  const chosen = useRef<Partial<Record<'start' | 'end', { text: string; id: string }>>>({});
  const fieldTarget = (which: 'start' | 'end', text: string): TraceTarget | null => {
    const choice = chosen.current[which];
    if (choice && choice.text === text) return { kind: 'found', id: choice.id };
    return model && text.trim() ? resolveTracePath(model, text, home) : null;
  };
  function fillField(which: 'start' | 'end', id: string) {
    const text = model ? fieldText(model, id) : id;
    chosen.current[which] = { text, id };
    (which === 'start' ? setStart : setEnd)(text);
  }
  const fieldTargets = useMemo(
    () => ({ start: fieldTarget('start', start), end: fieldTarget('end', end) }),
    // `chosen` changes only together with the text of its field.
    [model, home, start, end],
  );
  // Errors of the Trace tool stay in the tool, never in the global banner.
  const [traceError, setTraceError] = useState('');
  const [showConventions, setShowConventions] = useState(false);
  const [auditView, setAuditView] = useState<AuditView>(defaultAuditView);
  // The reading in which the audit view was chosen: when the reading changed while the Audit was off the
  // screen, the panel applies the opening rule again as it mounts.
  const auditViewModel = useRef<Model | undefined>(undefined);
  const [auditProject, setAuditProject] = useState(allProjects);
  // Class filter above the tree: it filters the tree and the Structure, never the map or the model.
  const [classFilter, setClassFilter] = useState<ClassFilter>(noClassFilter);
  // Observations of the inspector: the whole list hidden under its summary (until shown again or opened
  // by a marker), the occurrence whose facts are open, and a count bumped to bring it into view.
  const [observationsHidden, setObservationsHidden] = useState(false);
  const [occurrence, setOccurrence] = useState('');
  const [occurrenceFocus, setOccurrenceFocus] = useState(0);
  const [directoryLimit, setDirectoryLimit] = useState(100);
  const [relationLimit, setRelationLimit] = useState(100);
  const [evidenceScope, setEvidenceScope] = useState('');
  const [evidenceLimit, setEvidenceLimit] = useState(100);
  useEffect(() => {
    setRelationLimit(100);
    setEvidenceLimit(100);
    setDirectoryLimit(100);
    setOccurrence('');
  }, [selected]);
  const contentRef = useRef<HTMLDivElement>(null);
  // How long the last reading of the disk asked by this window took, from the request to the screen
  // drawn: a save is followed by a reading only when it was fast (editing.ts).
  const lastReading = useRef<number | undefined>(undefined);
  // The readings of the disk this window asked for, numbered when asked, and the model each one gave: the
  // report of a save waits for a reading asked after it, never a snapshot (after a restart, the new
  // server's snapshot is a reading made before the save).
  const readingsAsked = useRef(0);
  const readingOf = useRef(new WeakMap<Model, number>());
  const [contentVersion, setContentVersion] = useState(0);
  // Each click on the line of an observation, also on the line already highlighted: the editor goes there.
  const [lineJump, setLineJump] = useState(0);
  const [editorFoot, setEditorFoot] = useState<HTMLElement | null>(null);
  const editing = useEditing({
    model,
    setEditing: (next) => setModel((previous) => previous && { ...previous, editing: next }),
    reread: () => updateModel('refresh', {}, { quiet: true, keepView: true }),
    lastReading: () => lastReading.current,
    readingsAsked: () => readingsAsked.current,
    readingOf: (of) => readingOf.current.get(of),
    // Another file is read when it is selected; reading it now would reload the one shown, at the top.
    changed: (path) => {
      if (path === sourcePath) setContentVersion((version) => version + 1);
    },
    reveal: (path) => {
      select(path);
      setInspectorTab('source');
      show('inspector', true);
    },
    error: setError,
  });
  // After the session was renewed the server is another process: its snapshot, without reading the disk.
  const reconnected = useRef(() => {});
  reconnected.current = () =>
    void updateModel('workspace', undefined, { quiet: true, keepView: true }).catch(() => {});

  useEffect(() => {
    const stop = onReconnect(() => reconnected.current());
    connect()
      .then((session) => {
        setHome(session.home);
        setParent(session.defaultParent);
        return loadModel('workspace');
      })
      .then(setModel)
      .catch((e) => setError(e.message));
    return stop;
  }, []);
  /**
   * Selects an item: a new history entry, the inspector on its File tab. It never opens the inspector by
   * itself (see `pick`). `inherit`: the mode of a view that opens with this selection.
   */
  const select = useCallback(
    (id: string, currentModel = model, inherit?: ViewMode) => {
      setEdgeId('');
      setSourceLine(0);
      setInspectorTab('source');
      setNavigation((previous) => {
        if (previous.entries[previous.index].selected === id) return previous;
        const entries = [
          ...previous.entries.slice(0, previous.index + 1),
          visit(currentModel, previous.entries[previous.index], id, inherit),
        ];
        return { entries, index: entries.length - 1 };
      });
    },
    [model],
  );
  const currentMode = activeMode(model, history[historyIndex]);
  /**
   * A click on an item changes one thing at a time. When what the centre shows changes (a map moves to
   * the clicked file), the inspector stays as it was; when it does not (the Structure keeps its list, or
   * the file was already selected), the click opens the inspector on the file. A folder only opens.
   * `inherit`: the mode of the place clicked, for a view that opens with this selection.
   */
  function pick(id: string, inherit = currentMode) {
    const item = model?.nodes.find((node) => node.id === id);
    if (item?.kind === 'directory') return overview(id, inherit);
    const scope = model ? scopeFor(id, scopePaths(model)) : undefined;
    const view = visit(model, history[historyIndex], id, inherit).views.find(
      (entry) => entry.path === scope,
    );
    const structure = !!model && !!view && viewMode(model, view) === 'structure';
    const again = id === selected;
    select(id, model, inherit);
    if (item && (again || structure)) show('inspector', true);
  }
  function closeView(path: string) {
    setNavigation((previous) => {
      const current = previous.entries[previous.index];
      const remaining = current.views.filter((view) => view.path !== path);
      const selected = remaining.some((view) => view.selected === current.selected)
        ? current.selected
        : remaining.at(-1)?.selected || '';
      const entries = [
        ...previous.entries.slice(0, previous.index + 1),
        { selected, views: remaining },
      ];
      return { entries, index: entries.length - 1 };
    });
    setEdgeId('');
    setSourceLine(0);
    setSearch('');
  }
  // Structure × map is how a view shows its selection, not navigation: it replaces the current history
  // entry, so going back and forward returns each entry with the mode it had when it was left.
  function setViewMode(path: string, mode: ViewMode) {
    setNavigation((previous) => ({
      ...previous,
      entries: previous.entries.map((entry, index) =>
        index === previous.index ? withMode(entry, path, mode) : entry,
      ),
    }));
  }
  function overview(path = '', inherit = currentMode) {
    setHighlight('');
    select(path, model, inherit);
    if (path) setBottomOpen(false);
    setTrace(null);
    setSearch('');
  }
  function goHome() {
    overview();
    setFilterViews([]);
    setHomePanels(new Set());
  }
  function travel(delta: number) {
    setHighlight('');
    setNavigation((previous) => ({
      ...previous,
      index: Math.max(0, Math.min(previous.entries.length - 1, previous.index + delta)),
    }));
    setEdgeId('');
    setSourceLine(0);
    setTrace(null);
    setSearch('');
  }
  const node = useMemo(() => model?.nodes.find((n) => n.id === selected), [model, selected]);
  // A map is on the screen: the overview, the path, a filter box or a view in the Map mode (as MapWorkspace
  // composes the grid). The Conventions box only changes what a map draws.
  const mapShown = useMemo(() => {
    if (!model?.roots.length || atHome) return false;
    if (!views.length || !scopeFor(selected, scopePaths(model))) return true;
    if ((bottomOpen && bottom === 'trace' && trace) || activeFilter || openFilters.length)
      return true;
    return views.some((view) => viewMode(model, view) === 'map');
  }, [model, atHome, views, selected, bottomOpen, bottom, trace, activeFilter, openFilters.length]);
  const changes = deltaCount(model?.delta);
  // Relations and observations of some project not compared: the count is a lower bound, never "no change".
  const skipped = model?.delta ? notCompared(model.delta).length > 0 : false;
  // Real inventoried files only, as stats.files and `aae audit` metrics.files (no symlink); reference
  // placeholders are counted apart. Destinations whose references are all marked as expected leave the count.
  const settled = useMemo(() => (model ? settledDestinations(model) : new Set<string>()), [model]);
  const fileCount = useMemo(
    () => model?.nodes.filter((n) => isFile(n) && n.kind !== 'symlink').length ?? 0,
    [model],
  );
  const unresolvedCount = useMemo(
    () => (model?.nodes.filter(isUnresolved).length ?? 0) - settled.size,
    [model, settled],
  );
  const partial = useMemo(() => partialReading(model), [model]);
  const isDirectory = node?.kind === 'directory';
  const directoryChildren = useMemo(
    () =>
      model?.nodes
        .filter(
          (n) =>
            n.path.slice(0, n.path.lastIndexOf('/')) === selected &&
            !outsideInventory.has(n.status),
        )
        .sort(
          (a, b) =>
            Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
            a.name.localeCompare(b.name),
        ) || [],
    [model, selected],
  );
  const nodeMap = model ? nodeIndex(model) : new Map<string, FileNode>();
  // Markers, the class filter, badges and the inspector count only active observations; marked ones are listed apart.
  const split = model ? splitExpected(model) : undefined;
  const observations = useMemo(
    () => (model && split ? observationsByNode(model, split.issues) : new Map<string, Issue[]>()),
    [model, split],
  );
  const settledObservations = useMemo(
    () =>
      model && split ? observationsByNode(model, split.expectedIssues) : new Map<string, Issue[]>(),
    [model, split],
  );
  async function markExpected(root: string, key: string, expected: boolean, reason = '') {
    // Undoing keeps the reason for this session: marking again fills the form with it.
    const previous = model?.expected[root]?.[key];
    if (!expected && previous) rememberReason(root, key, previous.reason);
    const marks = await setExpected(root, key, expected, reason);
    setModel((previous) => (previous ? { ...previous, expected: marks } : previous));
  }
  const referenceIssues = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const item of model?.issues ?? [])
      if (
        (item.code === 'broken' ||
          item.code === 'unresolved-name' ||
          item.code === 'unverified' ||
          item.code === 'outside-root') &&
        item.node
      )
        map.set(`${item.node}\n${item.line}\n${item.target}`, item);
    return map;
  }, [model?.issues]);
  const referenceIssue = (edge: Relation) =>
    referenceIssues.get(`${edge.origin}\n${edge.line}\n${edge.raw}`);
  const openDiagnosisRef = useRef<(id: string) => void>(() => {});
  const decorations = useMemo<ItemDecorations>(
    () => ({
      marker: (item) => {
        const items = observations.get(item.id);
        return items && showsMarker(items) ? (
          <ObservationMarker items={items} onOpen={() => openDiagnosisRef.current(item.id)} />
        ) : null;
      },
      badge: (item) => {
        const items = observations.get(item.id);
        return items && showsMarker(items) ? (
          <ObservationBadge items={items} onOpen={() => openDiagnosisRef.current(item.id)} />
        ) : null;
      },
      filterName:
        classFilter.only && classFilter.observed
          ? t('Class filter and with observations')
          : classFilter.observed
            ? t('Filter with observations')
            : t('Class filter'),
      include: filterActive(classFilter)
        ? (item) =>
            (!classFilter.only || classOf(item) === classFilter.only) &&
            (!classFilter.observed || observations.has(item.id))
        : undefined,
    }),
    [observations, classFilter, t],
  );
  const relevantEdges = useMemo(
    () => model?.edges.filter((e) => e.source === selected || e.target === selected) || [],
    [model, selected],
  );
  const selfLast = (items: Relation[]) => [
    ...items.filter((e) => e.source !== e.target),
    ...items.filter((e) => e.source === e.target),
  ];
  const outgoing = selfLast(
    relevantEdges.filter((e) => e.source === selected && (showConventions || e.kind !== 'scope')),
  );
  const incoming = selfLast(
    relevantEdges.filter((e) => e.target === selected && (showConventions || e.kind !== 'scope')),
  );
  const extension = node?.name.includes('.')
    ? node.name.slice(node.name.lastIndexOf('.')).toLowerCase()
    : '';
  // Inventoried, but its text is never read for references (a script, an image, a file without extension).
  const unanalyzed = !!node && isFile(node) && node.kind !== 'symlink' && !node.analysis;
  const activeEdge = useMemo(() => model?.edges.find((e) => e.id === edgeId), [model, edgeId]);
  const openedObservation = useMemo(
    () =>
      observation &&
      !activeEdge &&
      observation.node === selected &&
      observation.line === sourceLine &&
      sourceLine > 0
        ? [...(model?.issues || []), ...(model?.signals || [])].find(
            (item) => item.id === observation.id,
          )
        : undefined,
    [model, observation, activeEdge, selected, sourceLine],
  );
  const evidence = activeEdge
    ? [activeEdge]
    : relevantEdges.filter((e) => showConventions || e.kind !== 'scope');
  const highlightedLine = activeEdge?.line || sourceLine;
  // The destination marked on the highlighted line: the one the evidence wrote, or the one of the
  // observation opened at that line when no relation holds it.
  const lineTarget = activeEdge
    ? { text: activeEdge.raw, syntax: activeEdge.kind }
    : observation &&
        observation.node === selected &&
        observation.line === sourceLine &&
        sourceLine > 0
      ? { text: observation.target ?? '', syntax: observation.syntax }
      : undefined;
  const sourcePath = activeEdge ? activeEdge.origin : isDirectory ? '' : selected;
  const editingFile = !!node && !isDirectory && editing.isOpen(sourcePath);
  // Switching the action row (Edit ↔ Save, Close editor): A and B ignore the rest of a double click.
  const repeatedClick = useNewborn(editingFile);
  // The buttons that appeared under the pointer do not look hovered until the pointer moves.
  const [freshRow, setFreshRow] = useState(false);
  const rowSwitched = useRef(false);
  useLayoutEffect(() => {
    if (!rowSwitched.current) {
      rowSwitched.current = true;
      return;
    }
    setFreshRow(true);
    const moved = () => setFreshRow(false);
    window.addEventListener('pointermove', moved, { once: true });
    return () => window.removeEventListener('pointermove', moved);
  }, [editingFile]);
  const openedIssue =
    observation && observation.node === sourcePath && observation.line === highlightedLine
      ? observations.get(sourcePath)?.find((item) => item.id === observation.id)
      : undefined;
  /*
   * While a file is edited, and after, until another file is selected, its observations above the text keep
   * their place and height: the list taken when the editor opened, each one with what the reading says of
   * it now; one a save resolved stays, marked "resolved", and new ones wait for "refresh list". The band of
   * the evidence or observation at the highlighted line likewise keeps its height when a save takes away
   * what it named. Only a gesture in them (a group, Hide, "refresh list", Clear highlight, a mark) or
   * another file changes their height.
   */
  const [frozen, setFrozen] = useState<{ id: string; items: Issue[]; marked: Issue[] }>();
  useLayoutEffect(() => {
    if (frozen && frozen.id !== selected) setFrozen(undefined);
    else if (editingFile && !frozen)
      setFrozen({
        id: selected,
        items: observations.get(selected) ?? NO_ISSUES,
        marked: settledObservations.get(selected) ?? NO_ISSUES,
      });
  }, [editingFile, selected, frozen]);
  type Band =
    | { kind: 'evidence'; source: string; target: string; line: number }
    | { kind: 'observation'; target?: string; title: string; line: number };
  const bandMemory = useRef<Band & { id: string; height: number }>(undefined);
  const bandRef = (band: Band) => (element: HTMLElement | null) => {
    if (element)
      bandMemory.current = {
        ...band,
        id: selected,
        height: element.getBoundingClientRect().height,
      };
  };
  // A band that left without the file being frozen (another highlight, the same file chosen again) is
  // not kept.
  const liveBand = !!activeEdge || !!openedObservation;
  useLayoutEffect(() => {
    if (!liveBand && frozen?.id !== selected) bandMemory.current = undefined;
  });
  const frozenBand =
    frozen?.id === selected && bandMemory.current?.id === selected ? bandMemory.current : undefined;
  const heldBand =
    frozenBand && !activeEdge && !openedObservation && inspectorTab === 'source'
      ? {
          ...frozenBand,
          resolved: (() => {
            const opened =
              observation?.node === selected && observation.line === frozenBand.line
                ? frozen?.items.find((item) => item.id === observation.id)
                : undefined;
            return (
              !!opened &&
              !(observations.get(selected) ?? []).some(
                (item) => observationKey(item) === observationKey(opened),
              )
            );
          })(),
        }
      : undefined;
  // The kept band says what happened to its line ("· resolved") only where that fits in the height it
  // had; else it keeps its words as they were.
  const heldBox = useRef<HTMLDivElement>(null);
  const [heldShort, setHeldShort] = useState<object>();
  useLayoutEffect(() => {
    const box = heldBox.current;
    const kept = bandMemory.current;
    if (box && kept && heldShort !== kept && box.getBoundingClientRect().height > kept.height + 0.5)
      setHeldShort(kept);
  });
  const evidenceText = (source: string, target: string, line: number) =>
    line > 0
      ? t('Evidence of {source} → {target} · line {line}', { source, target, line: String(line) })
      : t('Evidence of {source} → {target}', { source, target });

  useEffect(() => {
    setNote(drafts[selected] ?? model?.notes[selected] ?? '');
  }, [selected, model?.notes]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.entries(drafts).some(([id, value]) => value !== (model?.notes[id] || ''))) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [drafts, model?.notes]);
  useEffect(() => {
    setContent(undefined);
    setContentError('');
    setContentLoading(false);
    if (!sourcePath || !model) return;
    let cancelled = false;
    setContentLoading(true);
    api<{ text: string; truncated: boolean }>(`content?path=${encodeURIComponent(sourcePath)}`)
      .then((data) => {
        if (!cancelled) setContent({ ...data, path: sourcePath });
      })
      .catch((e) => {
        if (!cancelled) setContentError(e.message);
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourcePath, model, contentVersion]);
  // Another file or tab starts at the top; with the editor open, a reading (the one after a save) and a
  // highlight cleared never scroll the inspector.
  const scrolledFor = useRef('');
  useEffect(() => {
    const shown = `${sourcePath}\n${inspectorTab}`;
    const switched = scrolledFor.current !== shown;
    scrolledFor.current = shown;
    if (!highlightedLine && contentRef.current && (switched || !editingFile))
      contentRef.current.scrollTop = 0;
  }, [sourcePath, inspectorTab, highlightedLine]);
  // A highlighted line comes to the middle once: when it is chosen (also again) or its text arrives,
  // not when a reading loads the same text again, and not when the editor opens or closes over it.
  const lineShown = useRef('');
  useEffect(() => {
    if (!highlightedLine || inspectorTab !== 'source') {
      lineShown.current = '';
      return;
    }
    const shown = `${content?.path}\n${highlightedLine}\n${lineJump}\n${isOpen('inspector')}`;
    if (shown === lineShown.current) return;
    if (editingFile) {
      lineShown.current = shown;
      return;
    }
    const row = contentRef.current?.querySelector(`[data-line="${highlightedLine}"]`);
    if (!row) return;
    lineShown.current = shown;
    row.scrollIntoView({ block: 'center' });
  }, [highlightedLine, content, inspectorTab, isOpen('inspector'), lineJump, editingFile]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (dialog) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setDialog('open');
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        show('explorer', true);
        // On Home, asking for the search brings the explorer in there too.
        showPanel('explorer', true);
        requestAnimationFrame(() => document.getElementById('workspace-search')?.focus());
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        showPanel('explorer', !shown('explorer'));
      }
      if (
        e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !(
          e.target instanceof HTMLElement &&
          e.target.closest('input,textarea,select,[contenteditable]')
        )
      ) {
        e.preventDefault();
        travel(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  /**
   * `quiet`: the caller shows the error next to its own control, never in the global banner. `keepView`: the
   * reading after a save (or the snapshot after the session was renewed): no "Since the baseline…"
   * notice, and the traced path is traced again instead of cleared.
   */
  async function updateModel(
    operation: string,
    body: unknown,
    { quiet = false, keepView = false } = {},
  ) {
    setBusy(true);
    if (!quiet) setError('');
    const noteVersionAtRequest = savedNoteVersion.current;
    const started = performance.now();
    const traced = keepView && trace ? { start: trace.nodes[0], end: trace.nodes.at(-1)! } : null;
    const reading = ['open', 'close', 'refresh', 'reorder'].includes(operation)
      ? ++readingsAsked.current
      : undefined;
    try {
      const next = await loadModel(operation, body);
      if (reading) readingOf.current.set(next, reading);
      // A reading of the disk is measured until the screen is drawn (two frames after the state).
      if (['open', 'close', 'refresh', 'reorder'].includes(operation))
        requestAnimationFrame(() =>
          requestAnimationFrame(() => (lastReading.current = performance.now() - started)),
        );
      // A delayed workspace snapshot must not erase a save acknowledged since
      // this request began. Later refreshes still accept the backend's notes.
      for (const [id, saved] of confirmedNotes.current)
        if (saved.version > noteVersionAtRequest) next.notes[id] = saved.value;
      setModel(next);
      // Reorder rereads the disk like Rescan, so it can reveal changes too.
      if (!keepView)
        setChangeNotice(
          (operation === 'refresh' || operation === 'reorder') &&
            !(bottomOpen && bottom === 'changes') &&
            deltaCount(next.delta) > 0
            ? next.delta!
            : undefined,
        );
      if (!traced) setTrace(null);
      else if (
        next.nodes.some((n) => n.id === traced.start) &&
        next.nodes.some((n) => n.id === traced.end)
      )
        void api<Trace>('trace', {
          start: traced.start,
          end: traced.end,
          direction,
          conventions: showConventions,
        }).then(setTrace, (e) => {
          setTrace(null);
          setTraceError((e as Error).message);
        });
      else setTrace(null);
      setEdgeId('');
      setSourceLine(0);
      // A chosen file is written again from its id (relative only while that names it alone) and leaves
      // the field when it left the reading; typed text stays while it still designates something.
      const rewritten = (which: 'start' | 'end') => {
        const choice = chosen.current[which];
        if (!choice) return undefined;
        const text = next.nodes.some((n) => n.id === choice.id && isFile(n))
          ? fieldText(next, choice.id)
          : '';
        chosen.current[which] = text ? { text, id: choice.id } : undefined;
        return { from: choice.text, text };
      };
      const keep = (change?: { from: string; text: string }) => (previous: string) =>
        change && previous === change.from
          ? change.text
          : previous && resolveTracePath(next, previous, home).kind !== 'missing'
            ? previous
            : '';
      setStart(keep(rewritten('start')));
      setEnd(keep(rewritten('end')));
      setStartProblem(undefined);
      setEndProblem(undefined);
      if (!traced) setTraceError('');
      // A project that left the screen takes its views and its places in the history along, also when
      // its folder is still read as part of another open project (a project inside another one).
      const before = shownRoots.current;
      const left = new Set(before.filter((path) => !next.roots.some((root) => root.path === path)));
      const ownerLeft = (path: string) => {
        const owner = before
          .filter((root) => within(path, root))
          .reduce((found, root) => (root.length > found.length ? root : found), '');
        return left.has(owner);
      };
      setNavigation((previous) => {
        const exists = (id: string) => next.nodes.some((n) => n.id === id);
        const valid = (entry: Visit) =>
          !entry.selected || (exists(entry.selected) && !ownerLeft(entry.selected));
        const remaining = (entry: Visit) => ({
          ...entry,
          views: entry.views.filter(
            (view) =>
              next.roots.some((root) => within(view.path, root.path)) && !ownerLeft(view.path),
          ),
        });
        // A current selection that left the reading gives way to its nearest folder still in an opened
        // project (the file was deleted) or, when its project was removed from the screen, to what the
        // first remaining view shows. Either way the views of the other projects stay as they were.
        const current = previous.entries[previous.index];
        const opened = (path: string) => next.roots.some((root) => within(path, root.path));
        let replacement = '';
        if (current.selected && ownerLeft(current.selected))
          replacement =
            remaining(current).views.find((view) => exists(view.selected))?.selected ?? '';
        else if (!valid(current)) {
          let folder = dirname(current.selected);
          while (folder && opened(folder) && !exists(folder)) folder = dirname(folder);
          replacement =
            folder && opened(folder) && exists(folder)
              ? folder
              : (remaining(current).views.find((view) => exists(view.selected))?.selected ?? '');
        }
        const source = replacement
          ? previous.entries.map((entry) =>
              entry === current ? { ...remaining(entry), selected: replacement } : entry,
            )
          : previous.entries;
        const entries = source
          .filter(valid)
          .map((entry) => visit(next, remaining(entry), entry.selected));
        const index = valid(source[previous.index])
          ? source.slice(0, previous.index).filter(valid).length
          : 0;
        // Without the entries that left (or the replaced one), an entry may repeat the one before it:
        // it goes, so that every "Back" and "Forward" changes what is shown.
        const distinct: Visit[] = [];
        let at = 0;
        entries.forEach((entry, position) => {
          if (!distinct.length || JSON.stringify(entry) !== JSON.stringify(distinct.at(-1)))
            distinct.push(entry);
          if (position === index) at = distinct.length - 1;
        });
        return {
          entries: distinct.length ? distinct : [{ selected: '', views: [] }],
          index: at,
        };
      });
      return next;
    } catch (e) {
      if (!quiet) setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const [removedNotice, setRemovedNotice] = useState<{ path: string; name: string }>();
  function removeProject(path: string) {
    const name = model?.roots.find((root) => root.path === path)?.name ?? path.split('/').at(-1)!;
    void editing
      .confirmLeaving([path], 'remove')
      .then(async (yes) => {
        if (!yes) return;
        await updateModel('close', { path });
        setRemovedNotice({ path, name });
      })
      .catch(() => {});
  }
  /**
   * The unsaved note drafts of project `path` alone: on its files, but not on a file that also lies inside
   * another saved project (the same rule as the notes the server counts and erases).
   */
  function ownDrafts(path: string) {
    if (!model) return [];
    return Object.entries(drafts)
      .filter(
        ([id, value]) =>
          value !== (model.notes[id] || '') &&
          within(id, path) &&
          !model.savedCases.some((item) => item.path !== path && within(id, item.path)),
      )
      .map(([id]) => id);
  }
  /**
   * Forget: the project leaves the app, closed first when it is open (one request), with its notes when
   * the user chose so; its unsaved note drafts are discarded and its unsaved documents stay in their list,
   * only to copy. A failure stays in the dialog, which stays open.
   */
  async function forgetProject(path: string, notes: boolean) {
    const discarded = ownDrafts(path);
    await updateModel('forget', { path, close: true, notes }, { quiet: true });
    if (discarded.length)
      setDrafts((previous) => {
        const next = { ...previous };
        for (const id of discarded) delete next[id];
        return next;
      });
    if (removedNotice?.path === path) setRemovedNotice(undefined);
    setForgetting('');
  }
  async function reorderProjects(order: string[]) {
    setRemovedNotice(undefined);
    await updateModel('reorder', { order }, { quiet: true });
  }
  async function openCase(path: string, replace = false) {
    const leaving = replace
      ? (model?.roots ?? []).map((root) => root.path).filter((root) => root !== path)
      : [];
    if (leaving.length && !(await editing.confirmLeaving(leaving, 'switch'))) return;
    const next = await updateModel('open', { path, replace });
    setRemovedNotice(undefined);
    setSearch('');
    setEdgeId('');
    setSourceLine(0);
    if (replace) {
      setFilterViews([]);
      setHighlight('');
      setBottomOpen(false);
    }
    setDialog(null);
    const root = next.roots.find((item) => item.path === path) || next.roots.at(-1);
    if (root) select(root.path, next);
  }
  // The app never watches the disk: the top button and "Rescan now" in Changes read it again.
  function reread() {
    void updateModel('refresh', {}).catch(() => {});
  }
  async function runTrace() {
    if (!model || !start.trim() || !end.trim() || busy) return;
    const a = fieldTarget('start', start)!,
      b = fieldTarget('end', end)!;
    setStartProblem(a.kind === 'found' ? undefined : a);
    setEndProblem(b.kind === 'found' ? undefined : b);
    setTraceError('');
    if (a.kind !== 'found' || b.kind !== 'found') {
      setTrace(null);
      return;
    }
    setBusy(true);
    try {
      setTrace(
        await api<Trace>('trace', {
          start: a.id,
          end: b.id,
          direction,
          conventions: showConventions,
        }),
      );
      setBottom('trace');
      setBottomOpen(true);
    } catch (e) {
      setTraceError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function traceField(which: 'start' | 'end') {
    const isStart = which === 'start';
    const value = isStart ? start : end;
    const problem = isStart ? startProblem : endProblem;
    const setValue = isStart ? setStart : setEnd;
    const setProblem = isStart ? setStartProblem : setEndProblem;
    const message = `trace-${which}-message`;
    const target = fieldTargets[which];
    const choose = (id: string) => {
      fillField(which, id);
      setProblem(undefined);
      setTrace(null);
      requestAnimationFrame(() =>
        document.getElementById(`trace-${which}`)?.focus({ preventScroll: true }),
      );
    };
    const options = (nodes: FileNode[]) =>
      nodes.map((node) => (
        <button key={node.id} title={node.path} onClick={() => choose(node.id)}>
          {model ? rootRelative(model, node) : node.path}
        </button>
      ));
    return (
      <div className="trace-field">
        <label>
          <b>{isStart ? 'A' : 'B'}</b>
          <input
            id={`trace-${which}`}
            aria-label={isStart ? t('Source file A') : t('Target file B')}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? message : undefined}
            list={isStart ? 'start-files' : 'end-files'}
            placeholder={isStart ? t('Source: path of the file') : t('Target: path of the file')}
            title={`${target?.kind === 'found' ? `${target.id}\n` : ''}${t('Absolute path or relative to an open project, with or without its name at the start')}`}
            value={value}
            ref={showPathEnd}
            onBlur={(e) => showPathEnd(e.currentTarget)}
            onChange={(e) => {
              chosen.current[which] = undefined;
              setValue(e.target.value);
              setProblem(undefined);
              setTraceError('');
              setTrace(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runTrace();
              }
            }}
          />
        </label>
        {problem && (
          <div className="trace-field-message" id={message} role="alert">
            {problem.kind === 'ambiguous' ? (
              <>
                <span>
                  {t('{count} files match this path. Choose one:', {
                    count: problem.candidates.length,
                  })}
                </span>
                {options(problem.candidates)}
              </>
            ) : (
              <>
                <span>
                  {t('No file at this path.')}
                  {problem.suggestions.length > 0 && ` ${t('With that ending:')}`}
                </span>
                {options(problem.suggestions)}
              </>
            )}
          </div>
        )}
      </div>
    );
  }
  function openDiagnosis(id: string) {
    if (nodeMap.get(id)?.kind === 'directory') overview(id);
    else select(id);
    setObservationsHidden(false);
    setInspectorTab('source');
    show('inspector', true);
  }
  openDiagnosisRef.current = openDiagnosis;
  function openObservation(issue: Issue) {
    if (!model || !issue.node) return;
    select(issue.node);
    const e = observationEdge(model, issue);
    setEdgeId(e ? e.id : '');
    setSourceLine(issue.line || 0);
    setLineJump((count) => count + 1);
    setObservation({
      id: issue.id,
      node: issue.node,
      line: issue.line || 0,
      target: issue.target,
      syntax: issue.syntax,
    });
    setInspectorTab('source');
    show('inspector', true);
  }
  const selectAny = (id: string) =>
    nodeMap.get(id)?.kind === 'directory' ? overview(id) : select(id);
  function listingCause(folder: FileNode, fix: string, unreadableWords: string) {
    const { limit, unreadable } = listingCauses(folder);
    if (!unreadable) return t('(item limit: {fix}).', { fix });
    if (!limit) return t('({cause}: see the observation below).', { cause: unreadableWords });
    return t('({cause} and item limit: {fix}; see the observation below).', {
      cause: unreadableWords,
      fix,
    });
  }
  function observationBlock(id: string) {
    const live = observations.get(id) ?? NO_ISSUES;
    const liveMarked = settledObservations.get(id) ?? NO_ISSUES;
    // Frozen while the file is edited (see `frozen`): each one as the reading says it now, in its place.
    const view =
      frozen?.id === id
        ? (() => {
            const now = new Map(
              [...live, ...liveMarked].map((item) => [observationKey(item), item]),
            );
            const keep = (item: Issue) => now.get(observationKey(item)) ?? item;
            const known = new Set([...frozen.items, ...frozen.marked].map(observationKey));
            return {
              items: frozen.items.map(keep),
              marked: frozen.marked.map(keep),
              resolved: new Set(
                frozen.items
                  .filter((item) => !now.has(observationKey(item)))
                  .map((item) => item.id),
              ),
              fresh: live.filter((item) => !known.has(observationKey(item))).length,
            };
          })()
        : undefined;
    const items = view?.items ?? live;
    const marked = view?.marked ?? liveMarked;
    if (!model || (!items.length && !marked.length)) return null;
    // Same wording as the audit ("… in folder/file.md:7"), so names never collide with "line N".
    const subject = (item: Issue) => {
      const what = `${issueInfo(item).title}${item.target ? ` (${item.target})` : ''}`;
      return item.node
        ? t('{what} in {where}', {
            what,
            where: `${projectPath(model.roots, item.node)}${item.line ? `:${item.line}` : ''}`,
          })
        : what;
    };
    const rootOf = (item: Issue) => projectOf(model.roots, item.node);
    return (
      <FileObservations
        // Not the bare path: the text preview next to it is keyed by the path of the file.
        key={`observations\n${id}`}
        items={items}
        marked={marked}
        hidden={observationsHidden}
        onHidden={setObservationsHidden}
        openId={occurrence}
        onOpen={setOccurrence}
        focus={occurrenceFocus}
        diagnoseItem={(item) => diagnose(model, item, observationEdge(model, item))}
        version={nodeMap.get(id)?.sha256}
        onSelect={selectAny}
        onLine={openObservation}
        resolved={view?.resolved}
        fresh={view?.fresh ?? 0}
        onRefresh={() => setFrozen(undefined)}
        expected={{
          can: (item) => !!item.key && !!rootOf(item),
          subject,
          initial: (item) => rememberedReason(rootOf(item)!.path, item.key!),
          // A mark is a gesture in the list: a frozen list is taken again with it.
          mark: (item, reason) =>
            markExpected(rootOf(item)!.path, item.key!, true, reason).then(() =>
              setFrozen(undefined),
            ),
          unmark: (item) =>
            markExpected(rootOf(item)!.path, item.key!, false).then(() => setFrozen(undefined)),
          markOf: (item) => markOf(model, item),
        }}
      />
    );
  }
  function missingMark(edge: Relation) {
    const issue = referenceIssue(edge);
    const info = codeInfo(issue?.code ?? 'broken');
    if (issue?.code === 'unverified' || issue?.code === 'outside-root')
      return (
        <span className="name-dot" title={`${info.title}: ${info.meaning}`}>
          {' '}
          · {issue.code === 'unverified' ? t('unverified') : t('above the open project')}
        </span>
      );
    return issue?.code === 'unresolved-name' ? (
      <span className="name-dot" title={`${info.title}: ${info.meaning}`}>
        {' '}
        · {t('name without a file')}
      </span>
    ) : (
      <span className="missing-dot" title={`${info.title}: ${info.meaning}`}>
        {' '}
        · <span className="missing-dot-text">{t('does not exist')}</span>
      </span>
    );
  }
  function evidenceDiagnosis(edge: Relation, full: boolean) {
    const issue = referenceIssue(edge);
    if (!model || !issue) return null;
    const info = issueInfo(issue);
    return full ? (
      <div className="evidence-diagnosis">
        <ObservationTitle code={issue.code} form={issue.form} />
        <Diagnosis
          diagnosis={diagnose(model, issue, edge)}
          meaning
          onSelect={selectAny}
          scope={{
            open: evidenceScope === edge.id,
            onToggle: () => setEvidenceScope(evidenceScope === edge.id ? '' : edge.id),
          }}
        />
      </div>
    ) : (
      <small className="diagnosis-note">
        <strong>{info.title}.</strong> {info.meaning}
      </small>
    );
  }
  const unresolvedText = `${i18nPlural(unresolvedCount, '{total} target not found', '{total} targets not found', { total: unresolvedCount })}${settled.size > 0 ? ` ${i18nPlural(settled.size, '(+{count} expected)', '(+{count} expected)')}` : ''}`;
  function openUnresolved() {
    chooseAuditView({ level: 'all', type: unresolvedFilter });
    setAuditProject(allProjects);
    openTool('audit');
  }
  function chooseAuditView(value: AuditView) {
    auditViewModel.current = model;
    setAuditView(value);
  }
  function openLimits() {
    // Unreadable files are listed apart from the limits; with only them, that list opens.
    const label = partialLabel(model);
    chooseAuditView({
      level: 'warning',
      type: label?.cause === 'unreadable' ? 'unreadable' : 'limit',
    });
    setAuditProject(allProjects);
    openTool('audit');
  }
  function openTool(value: Tool) {
    if (value === 'changes') setChangeNotice(undefined);
    setBottom(value);
    setBottomOpen(true);
  }
  // Adopting the current reading changes only the delta: selection, trace and views stay as they are.
  async function adoptReference() {
    setBusy(true);
    setError('');
    try {
      const next = await loadModel('reference', {});
      setModel((previous) => (previous ? { ...previous, delta: next.delta } : next));
      setChangeNotice(undefined);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function openChange(path: string, line = 0, target?: string) {
    if (!model?.nodes.some((item) => item.id === path)) return;
    select(path);
    setSourceLine(line);
    // The syntax of the reference, from the observation of the current reading at that line.
    const syntax = target
      ? model.issues.find(
          (item) => item.node === path && item.line === line && item.target === target,
        )?.syntax
      : undefined;
    setObservation(target && line ? { id: '', node: path, line, target, syntax } : undefined);
    setInspectorTab('source');
    show('inspector', true);
  }
  function openChangedEdge(id: string) {
    const edge = model?.edges.find((item) => item.id === id);
    if (!edge) return;
    select(edge.source);
    setEdgeId(id);
    setInspectorTab('source');
    show('inspector', true);
  }
  function inspectEdge(id: string) {
    const edge = model?.edges.find((item) => item.id === id);
    if (edge) select(edge.source);
    setEdgeId(id);
    setInspectorTab('evidence');
    show('inspector', true);
  }
  function readEvidence(edge: Relation) {
    setEdgeId(edge.id);
    setInspectorTab('source');
    show('inspector', true);
  }
  function relationHeading(items: Relation[], isOutgoing: boolean) {
    const tally = relationTally(items, isOutgoing);
    return (
      <div className="relation-heading">
        {isOutgoing ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}
        <h3>{isOutgoing ? t('Where it points') : t('What points to it')}</h3>
        <span
          className="count"
          title={
            isOutgoing
              ? t(
                  'Distinct targets (files or targets not found) and relations: each reference counts, with its line, including repeats in the same file.',
                )
              : t(
                  'Distinct files that reference this file and relations: each reference counts, with its line, including repeats in the same file.',
                )
          }
        >
          {isOutgoing
            ? i18nPlural(tally.ends, '{count} target', '{count} targets')
            : i18nPlural(tally.ends, '{count} file', '{count} files')}{' '}
          · {i18nPlural(tally.relations, '{count} relation', '{count} relations')}
        </span>
        {tally.self > 0 && (
          <span
            className="self-count"
            title={t(
              'References of this file to itself: they appear in both lists, after the others.',
            )}
          >
            + {i18nPlural(tally.self, '{count} self-reference', '{count} self-references')}
          </span>
        )}
      </div>
    );
  }
  function relationList(items: Relation[], isOutgoing: boolean) {
    // Citations of the same file are one line, in the order of their first citation; each line number opens
    // its own evidence. The page counts lines (files), so every line shown has all of its citations.
    const byEnd = new Map<string, Relation[]>();
    for (const e of items) {
      const end = isOutgoing ? e.target : e.source;
      const list = byEnd.get(end);
      if (list) list.push(e);
      else byEnd.set(end, [e]);
    }
    const lines = [...byEnd];
    const rest = lines.length - relationLimit;
    return (
      <div className="relation-list">
        {lines.slice(0, relationLimit).map(([end, edges]) => {
          const target = nodeMap.get(end);
          const first = edges[0];
          const self = edges.some((e) => e.source === e.target);
          const declared = edges.find((e) => e.declared)?.declared;
          const path = target?.relative && target.relative !== target.name ? target.relative : '';
          const missing =
            !declared &&
            (target?.status === 'missing' ||
              target?.status === 'unverified' ||
              (target?.status === 'external' && referenceIssue(first)?.code === 'outside-root'));
          return (
            <div className="relation-row" key={end}>
              <div className="relation-head">
                <button
                  className="relation-target"
                  onClick={() => select(target!.id)}
                  title={target?.path}
                >
                  <FileText size={14} />
                  <span>{target?.name}</span>
                  {missing && missingMark(first)}
                </button>
                <span className="relation-lines">
                  {edges.map((e, index) => {
                    const resolved = resolutionLabel(e.resolvedBy);
                    return (
                      <span key={e.id}>
                        {index > 0 && ', '}
                        <button
                          className="relation-evidence"
                          title={t('{relation}: view the evidence', {
                            relation: relations[e.kind],
                          })}
                          aria-label={(() => {
                            const evidence = e.line
                              ? t('Evidence: {relation} at line {line}', {
                                  relation: relations[e.kind],
                                  line: String(e.line),
                                })
                              : t('Evidence: {relation}', { relation: relations[e.kind] });
                            return resolved
                              ? t('{evidence}, resolved {how}', { evidence, how: resolved })
                              : evidence;
                          })()}
                          onClick={() => inspectEdge(e.id)}
                        >
                          {e.line ? `L${e.line}` : relations[e.kind]}
                        </button>
                        {resolved && ' '}
                        {resolved && (
                          <small className="resolution-mark" title={resolutionNote(e.resolvedBy!)}>
                            {t('(resolved {how})', { how: resolved })}
                          </small>
                        )}
                      </span>
                    );
                  })}
                </span>
              </div>
              {(path || self || declared) && (
                <small className="relation-path">
                  {[
                    path && <span key="path">{path}</span>,
                    self && (
                      <span key="self" className="self-mark">
                        {t('self-reference')}
                      </span>
                    ),
                    declared && (
                      <span
                        key="declared"
                        className="declared-mark"
                        title={`${scopeKinds[declared.kind]} (${declared.kind})`}
                      >
                        {t('declared scope: {pattern}', { pattern: declared.pattern })}
                      </span>
                    ),
                  ]
                    .filter(Boolean)
                    .flatMap((part, index) => (index ? [' · ', part] : [part]))}
                </small>
              )}
            </div>
          );
        })}
        {rest > 0 && (
          <button
            className="load-more"
            onClick={(event) => {
              const list = event.currentTarget.parentElement;
              setRelationLimit(relationLimit + 100);
              // The last page removes the button: the focus goes to the first new line.
              if (rest <= 100)
                requestAnimationFrame(() =>
                  list
                    ?.querySelectorAll<HTMLElement>('.relation-row')
                    [relationLimit]?.querySelector<HTMLElement>('.relation-target')
                    ?.focus(),
                );
            }}
          >
            {isOutgoing
              ? i18nPlural(
                  Math.min(100, rest),
                  'Show {count} more target · {left} left',
                  'Show {count} more targets · {left} left',
                  { left: rest },
                )
              : i18nPlural(
                  Math.min(100, rest),
                  'Show {count} more file · {left} left',
                  'Show {count} more files · {left} left',
                  { left: rest },
                )}
          </button>
        )}
        {!items.length && isOutgoing && unanalyzed && (
          <p className="empty-small">
            {t(
              'Type not read ({extension}): the content of this file is not read for references.',
              { extension: extension || t('no extension') },
            )}
          </p>
        )}
      </div>
    );
  }
  async function saveNote() {
    const id = selected,
      value = note;
    // Serialize saves of a single file, including when the user navigates away.
    // Editing remains available; a newer draft must be saved after this request.
    if (savingNotes.current.has(id)) return;
    savingNotes.current.add(id);
    setNoteSaves((previous) => ({ ...previous, [id]: { pending: true } }));
    try {
      await api('note', { node: id, body: value });
      confirmedNotes.current.set(id, { version: ++savedNoteVersion.current, value });
      setModel((m) => (m ? { ...m, notes: { ...m.notes, [id]: value } } : m));
      setDrafts((previous) => {
        if (previous[id] !== value) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      });
      setNoteSaves((previous) => ({ ...previous, [id]: { pending: false } }));
    } catch (e) {
      setNoteSaves((previous) => ({
        ...previous,
        [id]: { pending: false, error: (e as Error).message },
      }));
    } finally {
      savingNotes.current.delete(id);
    }
  }
  /** The end of the bottom bar: "Read-only", or "Editing on: project" in its place, the last item to leave the bar. */
  function footerEditing(): StatusItem[] {
    const { on, pending } = editingStatus(editing, model);
    const at = editing.cursor ? cursorText(editing.cursor, t) : '';
    const cursor = at
      ? [
          {
            key: 'cursor',
            priority: 4.5,
            menu: { label: at, icon: TextCursor, info: true },
            node: <span className="status-cursor">{at}</span>,
          },
        ]
      : [];
    const unsaved = pending ? i18nPlural(pending, '{count} unsaved', '{count} unsaved') : '';
    const list = {
      label: i18nPlural(pending, '{count} unsaved document', '{count} unsaved documents'),
      icon: FileText,
      onSelect: editing.showList,
    };
    if (!on.length)
      return [
        ...cursor,
        {
          key: 'readonly',
          priority: 1,
          menu: { label: t('Read-only'), icon: ShieldCheck, info: true },
          node: (
            <span className="status-readonly">
              <ShieldCheck size={12} aria-hidden="true" /> {t('Read-only')}
            </span>
          ),
        },
        ...(pending
          ? [
              {
                key: 'unsaved',
                priority: 8,
                menu: list,
                node: (
                  <button className="status-link status-unsaved" onClick={editing.showList}>
                    {unsaved}
                  </button>
                ),
              },
            ]
          : []),
      ];
    const label = [
      on.length === 1
        ? t('Editing on: {project}', { project: on[0].name })
        : // Several: the count, so the bar never grows with the names (each one is in the menu).
          i18nPlural(on.length, 'Editing on: {count} project', 'Editing on: {count} projects'),
      unsaved,
    ]
      .filter(Boolean)
      .join(' · ');
    const actions = [
      ...on.map((root) => ({
        label: t('Turn off editing in {project}', { project: root.name }),
        icon: PencilOff,
        onSelect: () => void editing.disable(root.path),
      })),
      ...(pending ? [list] : []),
    ];
    return [
      ...cursor,
      {
        key: 'editing',
        priority: 8,
        menu: { label, icon: PencilLine, onSelect: editing.showList },
        node: (
          <MenuButton
            id="editing-menu"
            label={label}
            title={t('Editing is on: the editor saves to the files of these projects')}
            icon={PencilLine}
            above
            className="status-editing"
            actions={actions}
          />
        ),
      },
    ];
  }
  const crumbParts = useMemo(
    () =>
      node
        ? (model?.nodes ?? [])
            .filter(
              (part) =>
                (part.kind === 'directory' && within(node.path, part.path)) || part.id === node.id,
            )
            .sort((a, b) => a.path.length - b.path.length)
        : [],
    [model, node],
  );
  const headerRef = useRef<HTMLElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const [crumbLevel, setCrumbLevel] = useState<0 | 1 | 2>(0);
  // The width the current item keeps while the project still has room to give (CSS variable).
  const [crumbCurrent, setCrumbCurrent] = useState(0);
  /**
   * Decides from the natural width of each name (measured on a canvas, with the font of the bar) and the
   * room the other controls leave: 0 shows every part; 1 puts the folders between the project and the
   * parent into "…" (the project may still shrink to 5em); 2 puts the parent there too. Never by trial
   * on the screen, so it does not flicker.
   */
  const fitCrumbs = useCallback(() => {
    const header = headerRef.current,
      nav = crumbsRef.current;
    if (!header || !nav || crumbParts.length < 2) return setCrumbLevel(0);
    const style = getComputedStyle(header);
    const gap = parseFloat(style.columnGap) || 0;
    let others = 0;
    for (const child of [...header.children]) {
      if (child === nav || child.classList.contains('bar-space')) continue;
      const width = child.getBoundingClientRect().width;
      if (width > 0) others += width + gap;
    }
    const home = (nav.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width ?? 28;
    const room =
      header.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      others -
      gap -
      8 -
      home;
    const font = getComputedStyle(nav);
    const size = parseFloat(font.fontSize) || 12;
    const context = document.createElement('canvas').getContext('2d');
    const text = (name: string, bold: boolean) => {
      if (!context) return name.length * size * 0.6;
      context.font = `${bold ? 600 : 400} ${getComputedStyle(nav.querySelector('button.breadcrumb-root') ?? nav).fontSize} ${font.fontFamily}`;
      return context.measureText(name).width;
    };
    // Chevron 13, gap 2, button padding 12, then the name.
    const segment = (part: FileNode, bold = false) => 13 + 2 + 12 + text(part.name, bold);
    const project = segment(crumbParts[0]);
    const current = segment(crumbParts.at(-1)!, true);
    const parent = segment(crumbParts.at(-2)!);
    const more = 13 + 2 + 30;
    const all = crumbParts.reduce(
      (sum, part, index) => sum + segment(part, index === crumbParts.length - 1),
      0,
    );
    const projectMin = Math.min(project, 13 + 2 + 5 * size);
    const level: 0 | 1 | 2 =
      all <= room
        ? 0
        : crumbParts.length > 3 && projectMin + more + parent + current <= room
          ? 1
          : crumbParts.length > 3 || projectMin + parent + current > room
            ? 2
            : 0;
    setCrumbLevel((previous) => (previous === level ? previous : level));
    const before =
      level === 0
        ? all - current
        : level === 1
          ? projectMin + more + parent
          : projectMin + (crumbParts.length > 2 ? more : 0);
    const keep = Math.max(0, Math.floor(Math.min(current, room - before)));
    setCrumbCurrent((previous) => (previous === keep ? previous : keep));
  }, [crumbParts]);
  // Measured again after each render of App (the path), when the bar or a control beside the location changes
  // size (also the Structure | Map that MapWorkspace puts in the bar by a portal, without rendering App),
  // and when the fonts load. A size change commits before the next paint (flushSync), so no frame shows
  // the location at the previous width. The count does not depend on the location's own width, so one pass
  // settles it.
  useLayoutEffect(fitCrumbs);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const sized = new ResizeObserver(() => flushSync(fitCrumbs));
    const watch = () => {
      sized.disconnect();
      sized.observe(header);
      for (const child of [...header.children])
        if (child !== crumbsRef.current) sized.observe(child);
      const mode = header.querySelector('#top-view-mode');
      if (mode) for (const child of [...mode.children]) sized.observe(child);
    };
    watch();
    const changed = new MutationObserver(() => {
      watch();
      fitCrumbs();
    });
    changed.observe(header, { childList: true });
    const mode = header.querySelector('#top-view-mode');
    if (mode) changed.observe(mode, { childList: true });
    let live = true;
    const fonts = () => live && fitCrumbs();
    document.fonts?.ready.then(fonts);
    document.fonts?.addEventListener('loadingdone', fonts);
    return () => {
      live = false;
      sized.disconnect();
      changed.disconnect();
      document.fonts?.removeEventListener('loadingdone', fonts);
    };
  }, [fitCrumbs]);
  return (
    <WindowContexts inspector={inspectorAccess}>
      <div
        className="app-shell"
        style={
          {
            '--explorer-width': `${layout.explorerWidth}px`,
            '--inspector-width': `${inspectorWidth}px`,
            '--bottom-height':
              layout.bottomHeight === null ? defaultBottomHeightCss : `${layout.bottomHeight}px`,
          } as CSSProperties
        }
      >
        <header className="app-header" ref={headerRef}>
          <div className="brand" title="Agent Architecture Explorer">
            <img src="/icon.svg" alt="Agent Architecture Explorer" />
          </div>
          <div className="history-controls">
            {!!model?.roots.length && (
              <button
                className={`icon-button explorer-toggle${explorerShown ? ' active' : ''}`}
                aria-label={t('Explorer')}
                aria-pressed={explorerShown}
                aria-keyshortcuts="Control+B"
                title={
                  explorerShown
                    ? t('Explorer shown · Ctrl+B hides it')
                    : t('Explorer hidden · Ctrl+B shows it')
                }
                onClick={() => showPanel('explorer', !explorerShown)}
              >
                <PanelLeft size={16} aria-hidden="true" />
              </button>
            )}
            <button
              className="icon-button"
              aria-label={t('Back', { context: 'selection' })}
              title={t('Back (Alt+←)')}
              disabled={historyIndex <= 0}
              onClick={() => travel(-1)}
            >
              <ArrowLeft size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={t('Forward', { context: 'selection' })}
              title={t('Forward (Alt+→)')}
              disabled={historyIndex >= history.length - 1}
              onClick={() => travel(1)}
            >
              <ArrowRight size={16} />
            </button>
          </div>
          <nav
            className="breadcrumbs"
            aria-label={t('Location')}
            ref={crumbsRef}
            style={{ '--crumb-current-min': `${crumbCurrent}px` } as CSSProperties}
          >
            <button
              className="icon-button"
              aria-label={t('Home')}
              title={t('Home: the list of projects')}
              aria-current={atHome ? 'page' : undefined}
              onClick={goHome}
            >
              <Home size={16} />
            </button>
            {node && (
              <div className="breadcrumb-segments">
                {(() => {
                  const parts = crumbParts;
                  const segment = (part: FileNode) => (
                    <span className="breadcrumb-segments" key={part.id}>
                      <ChevronRight size={13} />
                      <button
                        className={part.path === node.root ? 'breadcrumb-root' : undefined}
                        title={part.path}
                        aria-current={part.id === selected ? 'location' : undefined}
                        onClick={() => pick(part.id)}
                      >
                        {part.name}
                      </button>
                    </span>
                  );
                  // What has no room goes into one "…" (with a menu), never a segment of zero width: first the folders
                  // between the project and the parent, then the parent. The project and the current item stay.
                  const hidden = crumbLevel === 0 ? [] : parts.slice(1, crumbLevel === 1 ? -2 : -1);
                  if (!hidden.length) return parts.map(segment);
                  return [
                    segment(parts[0]),
                    <span className="breadcrumb-segments breadcrumb-middle" key="middle">
                      <ChevronRight size={13} />
                      <MenuButton
                        id="breadcrumb-middle"
                        label={i18nPlural(
                          hidden.length,
                          '{count} folder in between',
                          '{count} folders in between',
                        )}
                        title={hidden.at(-1)!.path}
                        icon={MoreHorizontal}
                        hideLabel
                        align="left"
                        className="breadcrumb-more"
                        actions={hidden.map((part) => ({
                          label: part.name,
                          icon: FolderOpen,
                          title: part.path,
                          onSelect: () => overview(part.id),
                        }))}
                      />
                    </span>,
                    ...parts.slice(1 + hidden.length).map(segment),
                  ];
                })()}
              </div>
            )}
            {!node && <strong>{t('Home')}</strong>}
          </nav>
          <div id="top-view-mode" className="top-view-mode" />
          <span className="bar-space" />
          <button
            className="icon-button reread-button"
            aria-label={t('Rescan projects')}
            title={t(
              'Reads the files on disk again; the app does not rescan by itself, except after saving a document in the editor.',
            )}
            disabled={busy || !model?.roots.length}
            onClick={reread}
          >
            <RefreshCw className={busy ? 'spin' : ''} size={16} />
            <span>{t('Rescan')}</span>
          </button>
          <MenuButton
            id="projects-menu"
            label={t('Projects')}
            title={t('Open, add or create a project')}
            icon={FolderOpen}
            arrow
            actions={[
              {
                label: t('Open project'),
                icon: FolderOpen,
                shortcut: 'Ctrl+O',
                // Without saved projects the list would be empty: the first step is "Add folder".
                disabled: !home || busy || !model?.savedCases.length,
                title:
                  model && !model.savedCases.length
                    ? t('No saved project yet: start with Add folder')
                    : undefined,
                onSelect: () => setDialog('open'),
              },
              {
                label: t('Add folder'),
                icon: FolderPlus,
                disabled: !home || busy,
                onSelect: () => setDialog('add'),
              },
              {
                label: t('New architecture'),
                icon: Plus,
                disabled: !home || busy,
                onSelect: () => setDialog('create'),
              },
            ]}
          />
          <MenuButton
            id="more-menu"
            label={t('More')}
            title={t('Panels, theme, language and help')}
            icon={MoreHorizontal}
            actions={[
              ...(model?.roots.length
                ? [
                    {
                      label: shown('inspector') ? t('Hide inspector') : t('Show inspector'),
                      icon: PanelRight,
                      onSelect: () => showPanel('inspector', !shown('inspector')),
                    },
                    {
                      label: explorerShown ? t('Hide explorer') : t('Show explorer'),
                      icon: PanelLeft,
                      shortcut: 'Ctrl+B',
                      onSelect: () => showPanel('explorer', !explorerShown),
                    },
                    !explorerShown && !shown('inspector') && !bottomOpen
                      ? { label: t('Show panels'), icon: Minimize2, onSelect: showPanels }
                      : {
                          label: t('Hide panels'),
                          icon: Maximize2,
                          onSelect: hidePanels,
                        },
                    { label: t('Reset layout'), icon: RotateCcw, onSelect: resetLayout },
                  ]
                : []),
              {
                label: theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme'),
                icon: theme === 'dark' ? Sun : Moon,
                onSelect: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
              },
              {
                label: LANGUAGES[otherLanguage].name,
                lang: LANGUAGES[otherLanguage].tag,
                title:
                  otherLanguage === 'pt'
                    ? t('Show the interface in Portuguese')
                    : t('Show the interface in English'),
                icon: Languages,
                onSelect: () => setLanguage(otherLanguage),
              },
              { label: t('Help'), icon: CircleHelp, onSelect: () => setDialog('help') },
            ]}
          />
        </header>
        <WindowStrip
          notices={[
            ...(copyFailed
              ? [
                  {
                    key: 'copy',
                    text: t('Could not copy the path.'),
                    tone: 'problem' as const,
                    dismiss: () => setCopyFailed(false),
                    dismissLabel: t('Dismiss error'),
                  },
                ]
              : []),
            ...(error
              ? [
                  {
                    key: 'error',
                    text: error,
                    tone: 'problem' as const,
                    dismiss: () => setError(''),
                    dismissLabel: t('Dismiss error'),
                  },
                ]
              : []),
            ...(model?.restoreErrors ?? []).map((text, index) => ({
              key: `restore:${text}`,
              text: serverText(text, model?.restoreErrorsPhrase?.[index]),
              tone: 'problem' as const,
            })),
            ...(partial.inventoryCut && model?.roots.length
              ? [
                  {
                    key: 'inventory',
                    text: describeInventoryCut(partial.inventoryCut),
                    tone: 'warning' as const,
                    action: { label: t('View limits'), run: openLimits },
                  },
                ]
              : []),
          ]}
        />
        {/* A line of their own under the bar and the strip, so they never cover a control. */}
        {(changeNotice || removedNotice || editing.stale.length > 0) && (
          <div className="bar-notices">
            <StaleNotice editing={editing} onRescan={reread} />
            {changeNotice && (
              <div className="change-notice" role="status">
                <button
                  title={t('Since the baseline: {changes}. Open Changes', {
                    changes: describeDelta(changeNotice),
                  })}
                  onClick={() => openTool('changes')}
                >
                  <History size={13} />
                  <span>
                    {t('Since the baseline: {changes}', { changes: describeDelta(changeNotice) })}
                  </span>
                </button>
                <button
                  className="icon-button"
                  aria-label={t('Dismiss the changes notice')}
                  onClick={() => setChangeNotice(undefined)}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {removedNotice && (
              <div className="change-notice removed-notice" role="status">
                <span>{t('{name} closed', { name: removedNotice.name })}</span>
                <button
                  disabled={busy}
                  onClick={() => void openCase(removedNotice.path).catch(() => {})}
                >
                  {t('Reopen')}
                </button>
                <button
                  className="icon-button"
                  aria-label={t('Dismiss the closed-project notice')}
                  onClick={() => setRemovedNotice(undefined)}
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </div>
        )}
        <ItemDecorationsContext.Provider value={decorations}>
          <div className="main-layout">
            {model?.roots.length ? (
              <Explorer
                hidden={!explorerPanel.mounted}
                leaving={explorerPanel.leaving}
                onLeft={explorerPanel.done}
                model={model}
                selected={selected}
                select={pick}
                overview={overview}
                busy={busy}
                remove={removeProject}
                reorder={reorderProjects}
                search={search}
                setSearch={setSearch}
                observations={observations}
                classFilter={classFilter}
                setClassFilter={setClassFilter}
              />
            ) : !model ? (
              <aside hidden={!shown('explorer')} className="explorer loading">
                {t('Connecting…')}
              </aside>
            ) : null}
            {!!model?.roots.length && explorerShown && (
              <ResizeHandle
                label={t('Explorer width')}
                value={layout.explorerWidth}
                min={180}
                max={420}
                reset={246}
                onChange={(explorerWidth) =>
                  setLayout((previous) => ({ ...previous, explorerWidth }))
                }
              />
            )}
            <main className="main-pane" ref={mainRef}>
              {model && !atHome ? (
                <MapWorkspace
                  model={model}
                  views={views}
                  selected={selected}
                  theme={theme}
                  trace={bottomOpen && bottom === 'trace' ? trace : null}
                  onSelect={(id, inherit) => pick(id, inherit)}
                  onActivate={(id) => select(id)}
                  onEdge={inspectEdge}
                  onClose={closeView}
                  solo={soloProject}
                  arrangement={arrangement.current}
                  onLeave={(left) => (arrangement.current = left)}
                  onColumns={setGridColumns}
                  maxColumns={twoColumnsFit ? 2 : 1}
                  room={gridRoom}
                  paneMinHeight={leastPane}
                  onRows={setGridRows}
                  onMode={setViewMode}
                  onClearTrace={() => setTrace(null)}
                  showConventions={showConventions}
                  activeFilter={activeFilter}
                  openFilters={openFilters}
                  onCloseHighlight={() => setHighlight('')}
                  onCloseFilter={(id) =>
                    setFilterViews((previous) => previous.filter((item) => item !== id))
                  }
                />
              ) : model?.roots.length || model?.savedCases.length ? (
                <HomeList
                  model={model}
                  observations={split?.issues ?? []}
                  home={home}
                  busy={busy}
                  dialogOpen={!!dialog}
                  onShow={(path) => {
                    setSoloProject(path);
                    select(path, model, 'structure');
                  }}
                  onOpen={(path) => {
                    setSoloProject(path);
                    void openCase(path).catch(() => setSoloProject(''));
                  }}
                  onForget={setForgetting}
                  onAudit={(path) => {
                    setAuditProject(path);
                    openTool('audit');
                  }}
                  onAdd={() => setDialog('add')}
                  onCreate={() => setDialog('create')}
                />
              ) : (
                <div className="welcome">
                  <div className="welcome-content">
                    {model && (
                      <p>
                        {t(
                          'Add the folder of an agent (AGENTS.md, CLAUDE.md, skills, memory) to see the structure, the references and the observations.',
                        )}
                      </p>
                    )}
                    <div className="welcome-actions">
                      <button
                        className="primary"
                        onClick={() => setDialog('add')}
                        disabled={!home || !model}
                      >
                        <FolderOpen size={16} /> {t('Add folder')}
                      </button>
                      <button onClick={() => setDialog('create')} disabled={!home}>
                        <Plus size={16} /> {t('New architecture')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {model && bottomOpen && model.roots.length > 0 && (
                <section
                  className={`bottom-panel tool-panel tool-${bottom}`}
                  aria-label={toolTitles(bottom, t)[0]}
                  style={
                    bottomRoom === null
                      ? undefined
                      : ({ '--bottom-room': `${bottomRoom}px` } as CSSProperties)
                  }
                >
                  <ResizeHandle
                    label={t('Bottom panel height')}
                    horizontal
                    reverse
                    value={layout.bottomHeight ?? defaultBottomHeight()}
                    min={bounds.bottomHeight[0]}
                    max={bounds.bottomHeight[1]}
                    reset={defaultBottomHeight()}
                    onChange={(bottomHeight) =>
                      setLayout((previous) => ({ ...previous, bottomHeight }))
                    }
                  />
                  <div className="tool-panel-title">
                    <strong>{toolTitles(bottom, t)[1]}</strong>
                    <button
                      className="icon-button"
                      aria-label={t('Hide bottom panel')}
                      title={t('Hide bottom panel')}
                      onClick={() => {
                        setBottomOpen(false);
                        // The × leaves with the panel: the focus goes back to the tool that opened it.
                        document
                          .querySelector<HTMLButtonElement>(
                            `.dock-tools button[aria-label="${toolName(bottom, t)}"]`,
                          )
                          ?.focus();
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {bottom === 'trace' && (
                    <div className="trace-bar">
                      {traceField('start')}
                      <ArrowRight className="trace-arrow" size={15} />
                      {traceField('end')}
                      <select
                        aria-label={t('Trace direction')}
                        value={direction}
                        onChange={(e) => {
                          setDirection(e.target.value);
                          setTrace(null);
                        }}
                      >
                        <option value="directed">{t('Follow arrows')}</option>
                        <option value="undirected">{t('Both directions')}</option>
                      </select>
                      <button
                        className="primary"
                        disabled={!start.trim() || !end.trim() || busy}
                        onClick={() => void runTrace()}
                      >
                        {t('Trace', { context: 'action' })}
                      </button>
                      {traceError && (
                        <p className="trace-error" role="alert">
                          {traceError}
                        </p>
                      )}
                      <FileOptions id="start-files" nodes={model.nodes} text={start} />
                      <FileOptions id="end-files" nodes={model.nodes} text={end} />
                    </div>
                  )}
                  <div className="bottom-content">
                    {bottom === 'trace' &&
                      (trace ? (
                        trace.found ? (
                          <div className="trace-result">
                            <div className="trace-summary">
                              {i18nPlural(
                                trace.steps.length,
                                'Trace found · {count} step',
                                'Trace found · {count} steps',
                              )}
                              {direction !== 'directed' && (
                                <span>{t('Structural relation in both directions')}</span>
                              )}
                              <button
                                className="trace-clear"
                                title={t(
                                  'Closes the view of the trace; the other views come back as they were',
                                )}
                                onClick={() => setTrace(null)}
                              >
                                {t('Clear trace')}
                              </button>
                            </div>
                            {trace.nodes.map((id, i) => {
                              const step = trace.steps[i],
                                e = step ? model.edges.find((e) => e.id === step.edge) : null;
                              return (
                                <div className="trace-step" key={id}>
                                  <b>{i + 1}</b>
                                  <button title={id} onClick={() => pick(id, 'map')}>
                                    {nodeMap.get(id)?.name}
                                    <small>{nodeMap.get(id)?.relative}</small>
                                  </button>
                                  {e && (
                                    <button
                                      className="step-evidence"
                                      onClick={() => inspectEdge(e.id)}
                                    >
                                      {step.reverse ? `← ${t('reverse direction')} · ` : '→ '}
                                      {relations[e.kind]}
                                      {e.line ? ` · L${e.line}` : ''}
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="panel-empty">
                            <Route size={22} />
                            <span>
                              {direction === 'directed'
                                ? t('No trace following the arrows.')
                                : t('No trace found between these files in the open projects.')}
                            </span>
                          </div>
                        )
                      ) : null)}
                    {bottom === 'audit' && (
                      <AuditPanel
                        model={model}
                        view={auditView}
                        setView={chooseAuditView}
                        chosenIn={auditViewModel.current}
                        project={auditProject}
                        setProject={setAuditProject}
                        onSelect={(id) => {
                          select(id);
                          show('inspector', true);
                        }}
                        onOpen={(issue) => openObservation(issue as Issue)}
                        onExpected={markExpected}
                      />
                    )}
                    {bottom === 'changes' && (
                      <ChangesPanel
                        model={model}
                        busy={busy}
                        onAdopt={adoptReference}
                        onReread={reread}
                        onOpenFile={openChange}
                        onOpenEdge={openChangedEdge}
                      />
                    )}
                  </div>
                </section>
              )}
            </main>
            {inspectorPanel.mounted && (
              <>
                {/* The editor has the width of the read-only text it replaces: this divider sets both. */}
                {!inspectorPanel.leaving && (
                  <ResizeHandle
                    label={t('Inspector width')}
                    reverse
                    value={inspectorWidth}
                    min={bounds.inspectorWidth[0]}
                    max={inspectorLimit}
                    reset={Math.min(380, inspectorLimit)}
                    onChange={(inspectorWidth) =>
                      setLayout((previous) => ({ ...previous, inspectorWidth }))
                    }
                  />
                )}
                <aside
                  className={`inspector${inspectorPanel.leaving ? ' is-leaving' : ''}`}
                  inert={inspectorPanel.leaving}
                  aria-hidden={inspectorPanel.leaving || undefined}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget && inspectorPanel.leaving)
                      inspectorPanel.done();
                  }}
                >
                  <button
                    className="icon-button inspector-close"
                    aria-label={t('Hide inspector', { context: 'close' })}
                    title={t('Hide inspector')}
                    onClick={() => showPanel('inspector', false)}
                  >
                    <X size={15} />
                  </button>
                  {isDirectory ? (
                    <div className="directory-overview">
                      <FolderOpen size={24} />
                      <h2>{node.name}</h2>
                      <p title={node.path}>{node.path}</p>
                      <p>{i18nPlural(directoryChildren.length, '{count} item', '{count} items')}</p>
                      {node.listing === 'unread' && (
                        <p className="directory-listing">
                          {node.omitted
                            ? i18nPlural(
                                node.omitted,
                                'Not read · {atLeast}{count} item on disk',
                                'Not read · {atLeast}{count} items on disk',
                                { atLeast: omittedAtLeast(node) },
                              )
                            : t('Not read', { context: 'folder' })}{' '}
                          {listingCause(
                            node,
                            t('open this folder as a project to read it'),
                            t('the reader could not read the folder or the names in it'),
                          )}
                        </p>
                      )}
                      {node.listing === 'partial' && (
                        <p className="directory-listing">
                          {i18nPlural(
                            node.omitted ?? 0,
                            'Partly read · {atLeast}{count} item left out',
                            'Partly read · {atLeast}{count} items left out',
                            { atLeast: omittedAtLeast(node) },
                          )}{' '}
                          {listingCause(
                            node,
                            t('open this folder as a project to read all of it'),
                            t('name that is not valid UTF-8'),
                          )}
                        </p>
                      )}
                      {observationBlock(node.id)}
                      {node.path !== node.root && (
                        <button
                          onClick={() => overview(node.path.slice(0, node.path.lastIndexOf('/')))}
                        >
                          <ArrowLeft size={14} /> {t('Parent folder')}
                        </button>
                      )}
                      {directoryChildren.slice(0, directoryLimit).map((child) => (
                        <button
                          className="directory-child"
                          key={child.id}
                          title={child.path}
                          onClick={() =>
                            child.kind === 'directory' ? overview(child.id) : select(child.id)
                          }
                        >
                          {child.kind === 'directory' ? (
                            <FolderOpen size={15} />
                          ) : (
                            <FileText size={15} />
                          )}
                          <span>{child.name}</span>
                          <ChevronRight size={13} />
                        </button>
                      ))}
                      {directoryChildren.length > directoryLimit && (
                        <button
                          className="load-more"
                          onClick={() => setDirectoryLimit(directoryLimit + 100)}
                        >
                          {t('Show more ({count})', {
                            count: directoryChildren.length - directoryLimit,
                          })}
                        </button>
                      )}
                      {!directoryChildren.length && (
                        <p>{t('No item available. See the Audit for the scan limits.')}</p>
                      )}
                    </div>
                  ) : node ? (
                    <>
                      <div className="inspector-identity">
                        <div className="inspector-name">
                          <h2>
                            <FileText size={19} />
                            {node.name}
                          </h2>
                          <span className={`type-label ${node.kind}`}>{kinds[node.kind]}</span>
                          {node.lines ? (
                            <span className="file-lines">
                              {i18nPlural(node.lines, '{count} line', '{count} lines')}
                            </span>
                          ) : null}
                          {node.status !== 'resolved' && (
                            <span className="file-status">{statuses[node.status]}</span>
                          )}
                        </div>
                        {node.declaredName &&
                          node.declaredName !== node.name &&
                          node.declaredName !== node.name.replace(/\.[^.]+$/, '') && (
                            <p
                              className="declared-name"
                              title={t(
                                'Identity the file itself declares in the frontmatter; wikilinks [[name]] without a folder resolve by it',
                              )}
                            >
                              {t('Declared name:')} <code>{node.declaredName}</code>
                            </p>
                          )}
                        <button
                          className="copy-path"
                          title={`${node.path}\n${t('Copy absolute path')}`}
                          aria-label={t('Copy absolute path: {path}', { path: node.path })}
                          onClick={() =>
                            navigator.clipboard
                              .writeText(node.path)
                              .then(() => setCopied(true))
                              .catch(() => setCopyFailed(true))
                          }
                        >
                          {/* Cut at the start, so the end of the path (the file) stays visible. */}
                          <span className="copy-path-text">
                            <code>{node.path}</code>
                          </span>
                          {copied ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                        {copied && <p role="status">{t('Path copied')}</p>}
                        {(node.analysis === 'partial' || node.analysis === 'skipped') && (
                          <p className="analysis-note">
                            {node.analysis === 'partial'
                              ? t('partly read: JSON depth limit')
                              : node.skippedBy === 'size'
                                ? t('not read: size limit (1 MiB)')
                                : node.skippedBy === 'unreadable'
                                  ? t('not read: read failure')
                                  : t('not read: text limit of the scan')}
                          </p>
                        )}
                        {content?.path === sourcePath && content.truncated && (
                          <p className="preview-note">{t('preview limited to 1 MiB')}</p>
                        )}
                        <div className="endpoint-actions" data-fresh={freshRow || undefined}>
                          {!editingFile && (
                            <>
                              <button
                                title={t('Use this file as source A of the Trace')}
                                onClick={(event) => {
                                  if (repeatedClick(event)) return;
                                  fillField('start', selected);
                                  setStartProblem(undefined);
                                  setTrace(null);
                                  openTool('trace');
                                }}
                              >
                                {rich('Set as <b>A</b>', { b: (chunks) => <b>{chunks}</b> })}
                              </button>
                              <button
                                title={t('Use this file as target B of the Trace')}
                                onClick={(event) => {
                                  if (repeatedClick(event)) return;
                                  fillField('end', selected);
                                  setEndProblem(undefined);
                                  setTrace(null);
                                  openTool('trace');
                                }}
                              >
                                {rich('Set as <b>B</b>', { b: (chunks) => <b>{chunks}</b> })}
                              </button>
                            </>
                          )}
                          <EditButton
                            editing={editing}
                            node={node}
                            shown={sourcePath}
                            onTab={() => setInspectorTab('source')}
                            onShow={() => {
                              setInspectorTab('source');
                              if (sourcePath !== node.path) {
                                setEdgeId('');
                                setSourceLine(0);
                              }
                            }}
                          />
                        </div>
                      </div>
                      <div className="small-tabs inspector-tabs" aria-label={t('File details')}>
                        <button
                          className={inspectorTab === 'source' ? 'active' : ''}
                          onClick={() => setInspectorTab('source')}
                        >
                          {t('File')}
                        </button>
                        <button
                          className={inspectorTab === 'relations' ? 'active' : ''}
                          onClick={() => setInspectorTab('relations')}
                        >
                          {t('Relations')}
                        </button>
                        <button
                          className={inspectorTab === 'evidence' ? 'active' : ''}
                          onClick={() => setInspectorTab('evidence')}
                        >
                          {t('Evidence')}
                        </button>
                        <button
                          className={inspectorTab === 'notes' ? 'active' : ''}
                          onClick={() => setInspectorTab('notes')}
                        >
                          <MessageSquare size={13} /> {t('Notes')}
                          {model?.notes[selected] && <span className="status-dot" />}
                        </button>
                      </div>
                      <div className="inspector-scroll" ref={contentRef}>
                        {inspectorTab === 'source' ? (
                          <>
                            {/* The text of another file (the origin of an evidence): say which. What is above the text stays
                                while the file is edited (see `frozen`). */}
                            {sourcePath !== node.path && (
                              <div className="source-path">{sourcePath}</div>
                            )}
                            {observationBlock(selected)}
                            {openedObservation &&
                              (() => {
                                const own = [
                                  ...(observations.get(selected) ?? []),
                                  ...(settledObservations.get(selected) ?? []),
                                ].find((item) => item.id === openedObservation.id);
                                const info = own ? issueInfo(own) : undefined;
                                return (
                                  <div
                                    className="source-context observation-context"
                                    ref={bandRef({
                                      kind: 'observation',
                                      target: own?.target,
                                      title: info?.title ?? messageText(openedObservation),
                                      line: sourceLine,
                                    })}
                                  >
                                    <span
                                      className={info ? `tone-${info.tone}` : undefined}
                                      title={info?.title}
                                    >
                                      {t('Line {line}:', { line: String(sourceLine) })}{' '}
                                      {own?.target !== undefined ? (
                                        <code>{own.target}</code>
                                      ) : (
                                        (info?.title ?? messageText(openedObservation))
                                      )}
                                    </span>
                                    {own && occurrence !== own.id && (
                                      <button
                                        onClick={() => {
                                          setObservationsHidden(false);
                                          setOccurrence(own.id);
                                          setOccurrenceFocus((n) => n + 1);
                                        }}
                                      >
                                        {t('View detail')}
                                      </button>
                                    )}
                                    <button
                                      onClick={() => {
                                        bandMemory.current = undefined;
                                        setSourceLine(0);
                                      }}
                                    >
                                      {t('Clear highlight')}
                                    </button>
                                  </div>
                                );
                              })()}
                            {activeEdge && (
                              <div
                                className="source-context"
                                ref={bandRef({
                                  kind: 'evidence',
                                  source: nodeMap.get(activeEdge.source)?.name || activeEdge.source,
                                  target: nodeMap.get(activeEdge.target)?.name || activeEdge.target,
                                  line: activeEdge.line > 0 ? highlightedLine : 0,
                                })}
                              >
                                {evidenceText(
                                  nodeMap.get(activeEdge.source)?.name || activeEdge.source,
                                  nodeMap.get(activeEdge.target)?.name || activeEdge.target,
                                  activeEdge.line > 0 ? highlightedLine : 0,
                                )}
                                <button
                                  onClick={() => {
                                    bandMemory.current = undefined;
                                    setEdgeId('');
                                    setSourceLine(0);
                                  }}
                                >
                                  {activeEdge.origin === selected
                                    ? t('Clear highlight')
                                    : t('Back to the file')}
                                </button>
                              </div>
                            )}
                            {heldBand && (
                              // The band of an evidence or observation a save took away, in its form and
                              // at the height it had: what is above the text does not move while the file
                              // is selected.
                              <div
                                ref={heldBox}
                                className={`source-context held-band${heldBand.kind === 'observation' ? ' observation-context' : ''}`}
                                style={{ minHeight: heldBand.height }}
                              >
                                {heldBand.kind === 'evidence' ? (
                                  evidenceText(heldBand.source, heldBand.target, heldBand.line)
                                ) : (
                                  <span title={heldBand.title}>
                                    {t('Line {line}:', { line: String(heldBand.line) })}{' '}
                                    {heldBand.target !== undefined ? (
                                      <code>{heldBand.target}</code>
                                    ) : (
                                      heldBand.title
                                    )}
                                  </span>
                                )}
                                {heldShort !== bandMemory.current &&
                                  ` · ${heldBand.resolved ? t('resolved') : t('changed', { context: 'observation' })}`}
                                <button
                                  onClick={() => {
                                    bandMemory.current = undefined;
                                    setEdgeId('');
                                    setSourceLine(0);
                                  }}
                                >
                                  {t('Clear highlight')}
                                </button>
                              </div>
                            )}
                            <EditorSlot
                              editing={editing}
                              path={sourcePath}
                              line={highlightedLine}
                              target={lineTarget?.text}
                              syntax={lineTarget?.syntax}
                              jump={lineJump}
                              foot={editorFoot}
                              observations={observations.get(sourcePath) ?? NO_ISSUES}
                              opened={openedIssue}
                              menu={(items) => (
                                <MenuButton
                                  id="editor-status-menu"
                                  label={t('More')}
                                  title={t('What does not fit in the state line')}
                                  icon={MoreHorizontal}
                                  hideLabel
                                  above
                                  className="editor-status-more"
                                  actions={items}
                                />
                              )}
                            >
                              {content?.path === sourcePath ? (
                                <SourcePreview
                                  key={content.path}
                                  path={content.path}
                                  text={content.text}
                                  line={highlightedLine}
                                  target={lineTarget?.text}
                                  syntax={lineTarget?.syntax}
                                />
                              ) : (
                                <div
                                  className="panel-empty"
                                  role={contentError ? 'alert' : 'status'}
                                >
                                  <Code2 size={22} />
                                  <span>
                                    {contentError ||
                                      (contentLoading
                                        ? t('Reading file…')
                                        : t('Select a file to read its content.'))}
                                  </span>
                                </div>
                              )}
                            </EditorSlot>
                          </>
                        ) : inspectorTab === 'evidence' ? (
                          <div className="inspector-evidence">
                            {evidence.length ? (
                              <>
                                {evidence.slice(0, evidenceLimit).map((edge) => (
                                  <article className="evidence-item" key={edge.id}>
                                    <span className="relation-chip">{relations[edge.kind]}</span>
                                    <p>
                                      <button
                                        title={edge.source}
                                        onClick={() => select(edge.source)}
                                      >
                                        {nodeMap.get(edge.source)?.name || edge.source}
                                      </button>
                                      <ArrowRight size={12} />
                                      <button
                                        title={edge.target}
                                        onClick={() => select(edge.target)}
                                      >
                                        {nodeMap.get(edge.target)?.name || edge.target}
                                      </button>
                                    </p>
                                    <code>{relationEvidence(edge)}</code>
                                    <button
                                      className="evidence-origin"
                                      aria-label={t('Read the evidence in {name}', {
                                        name: edge.origin.split('/').at(-1)!,
                                      })}
                                      onClick={() => readEvidence(edge)}
                                    >
                                      <FileText size={13} />
                                      <span>
                                        {edge.origin}
                                        {edge.line > 0 ? `:${edge.line}` : ''}
                                      </span>
                                      <ChevronRight size={13} />
                                    </button>
                                    {edge.kind === 'declared' && (
                                      <small>{t('Relation declared in the manifest above.')}</small>
                                    )}
                                    {edge.resolvedBy && resolutionLabel(edge.resolvedBy) && (
                                      <small className="resolution-note">
                                        <strong>
                                          {t('Resolved {how}.', {
                                            how: resolutionLabel(edge.resolvedBy) ?? '',
                                          })}
                                        </strong>{' '}
                                        {resolutionNote(edge.resolvedBy)}
                                      </small>
                                    )}
                                    {nodeMap.get(edge.target)?.status === 'missing' &&
                                      evidenceDiagnosis(edge, evidence.length === 1)}
                                    {edge.declared && (
                                      <small className="declared-note">
                                        {rich(
                                          '<b>Declared scope:</b> {kindName} (<code>{kindCode}</code>), pattern <code>{pattern}</code>. The target does not exist in the package; the reference was absorbed and is counted in the summary of the audit, with no proof that the file will exist at run time.',
                                          {
                                            kindName: scopeKinds[edge.declared.kind],
                                            kindCode: edge.declared.kind,
                                            pattern: edge.declared.pattern,
                                            b: (chunks) => <strong>{chunks}</strong>,
                                            code: (chunks) => <code>{chunks}</code>,
                                          },
                                        )}
                                      </small>
                                    )}
                                  </article>
                                ))}
                                {evidence.length > evidenceLimit && (
                                  <button
                                    className="load-more"
                                    onClick={() => setEvidenceLimit(evidenceLimit + 100)}
                                  >
                                    {i18nPlural(
                                      evidence.length - evidenceLimit,
                                      'Show {count} more evidence item',
                                      'Show {count} more evidence items',
                                    )}
                                  </button>
                                )}
                              </>
                            ) : (
                              <div className="panel-empty">
                                <GitBranch size={22} />
                                <span>{t('No relation found for this file.')}</span>
                              </div>
                            )}
                          </div>
                        ) : inspectorTab === 'relations' ? (
                          <>
                            {relationHeading(outgoing, true)}
                            {relationList(outgoing, true)}
                            {relationHeading(incoming, false)}
                            {relationList(incoming, false)}
                            {model?.objects
                              .filter((o) => o.node === selected)
                              .map((o) => (
                                <div className="logical-object" key={o.id}>
                                  <Layers size={16} />
                                  <div>
                                    <strong>{o.name}</strong>
                                    <small>{t('Logical object · {type}', { type: o.type })}</small>
                                  </div>
                                </div>
                              ))}
                            <p className="relation-scope-note">
                              {t(
                                'Relations come only from {extensions}; references in scripts (.py, .sh…) are not counted.',
                                { extensions: analyzedExtensions.join(', ') },
                              )}
                            </p>
                          </>
                        ) : (
                          <div className="note-editor">
                            <p>{t('Saved in the app, outside the file.')}</p>
                            <textarea
                              aria-label={t('File note')}
                              placeholder={t('Responsibility, question, decision…')}
                              value={note}
                              onChange={(e) => {
                                setNote(e.target.value);
                                setDrafts((d) => ({ ...d, [selected]: e.target.value }));
                                setNoteSaves((previous) => ({
                                  ...previous,
                                  [selected]: { pending: previous[selected]?.pending || false },
                                }));
                              }}
                              maxLength={20000}
                            />
                            <button
                              className="primary"
                              disabled={noteSaves[selected]?.pending}
                              onClick={() => void saveNote()}
                            >
                              <Check size={15} /> {t('Save note')}
                            </button>
                            <p className="save-status" role="status">
                              {noteSaves[selected]?.pending
                                ? t('Saving…', { context: 'note' })
                                : noteSaves[selected]?.error !== undefined
                                  ? t('Error: {message}', { message: noteSaves[selected].error! })
                                  : note !== (model?.notes[selected] || '')
                                    ? t('Unsaved changes')
                                    : model?.notes[selected] !== undefined
                                      ? t('Saved on this computer')
                                      : ''}
                            </p>
                          </div>
                        )}
                      </div>
                      {/* The editor's state line, at the foot of the inspector and out of the area that
                          scrolls (FileEditor.tsx draws into it). */}
                      {inspectorTab === 'source' && editingFile && (
                        <div className="editor-foot" ref={setEditorFoot} />
                      )}
                    </>
                  ) : (
                    <div className="inspector-empty">
                      <ScanSearch size={31} />
                      <p>{t('Select a file in the tree, the Structure or the map.')}</p>
                    </div>
                  )}
                </aside>
              </>
            )}
          </div>
        </ItemDecorationsContext.Provider>
        <div id="workspace-view-tabs" hidden={!model?.roots.length} />
        <footer className="app-footer">
          {!!model?.roots.length && (
            <nav className="dock-tools" aria-label={t('Tools')}>
              {(
                [
                  { key: 'trace', icon: Route },
                  { key: 'audit', icon: ShieldCheck },
                  { key: 'changes', icon: History },
                ] as const
              ).map(({ key, icon: Icon }) => (
                <button
                  key={key}
                  aria-label={toolName(key, t)}
                  title={
                    key === 'changes' && model?.delta
                      ? [
                          changes || !skipped
                            ? changes
                              ? t('{changes} since the baseline scan', {
                                  changes: describeDelta(model.delta),
                                })
                              : t('No change since the baseline scan')
                            : '',
                          ...describeContext(model.delta),
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : undefined
                  }
                  className={bottomOpen && bottom === key ? 'active' : ''}
                  aria-expanded={bottomOpen && bottom === key}
                  onClick={() =>
                    bottomOpen && bottom === key ? setBottomOpen(false) : openTool(key)
                  }
                >
                  <Icon size={15} />
                  <span>{toolName(key, t)}</span>
                  {key === 'changes' && (changes > 0 || skipped) && (
                    <span className="dock-count" aria-hidden="true">
                      {skipped ? (changes ? `${changes}+` : '?') : changes}
                    </span>
                  )}
                </button>
              ))}
              <button
                className="map-filter-button"
                aria-label={t('Map filters')}
                title={t('Create and manage filters')}
                onClick={() => setDialog('filters')}
              >
                <Filter size={15} />
                <span>
                  {t('Filters')}
                  {filters.length > 0 ? ` · ${filters.length}` : ''}
                </span>
              </button>
              {(mapShown || showConventions) && (
                <label
                  className="convention-toggle"
                  title={
                    activeFilter
                      ? t('Conventions are set when editing the filter')
                      : t('Include scope conventions in the folder map')
                  }
                >
                  <input
                    type="checkbox"
                    disabled={!!activeFilter}
                    checked={showConventions}
                    onChange={(e) => {
                      setShowConventions(e.target.checked);
                      setTrace(null);
                    }}
                  />{' '}
                  {t('Conventions')}
                </label>
              )}
            </nav>
          )}
          <StatusLine
            items={[
              {
                key: 'state',
                priority: 4,
                menu: {
                  label: busy ? t('Scanning…') : t('Ready'),
                  info: true,
                },
                node: (
                  <span className="status-state">
                    <span className="status-dot" />
                    {busy ? t('Scanning…') : t('Ready')}
                  </span>
                ),
              },
              ...(model?.roots.length
                ? [
                    {
                      key: 'roots',
                      priority: 2,
                      menu: {
                        label: i18nPlural(
                          model.roots.length,
                          '{count} project',
                          '{count} projects',
                        ),
                        icon: FolderOpen,
                        info: true,
                      },
                      node: (
                        <span className="status-roots">
                          {i18nPlural(model.roots.length, '{count} project', '{count} projects')}
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(partial.partial && !partial.inventoryCut
                ? [
                    {
                      key: 'partial',
                      priority: 7,
                      menu: {
                        label: t('Partial scan: {cause}', {
                          cause: partialLabel(model)?.text ?? '',
                        }),
                        tone: 'warning' as const,
                        title: describePartial(partial),
                        onSelect: openLimits,
                      },
                      node: (
                        <button
                          className="status-link status-partial"
                          title={describePartial(partial)}
                          aria-label={t('Partial scan: {cause}', {
                            cause: partialLabel(model)?.text ?? '',
                          })}
                          onClick={openLimits}
                        >
                          {partialLabel(model)?.text ?? t('Partial scan')}
                        </button>
                      ),
                    },
                  ]
                : []),
              ...(model?.roots.length
                ? [
                    {
                      key: 'files',
                      priority: 5,
                      menu: {
                        label: readCount(model, fileCount, i18nPlural),
                        icon: FileText,
                        info: true,
                      },
                      node: (
                        <span
                          className="status-files"
                          title={t(
                            'Files read for references, out of all those listed (without folders or symbolic links). In a scan cut by the item limit, the total adds the files left out',
                          )}
                        >
                          {readCount(model, fileCount, i18nPlural)}
                        </span>
                      ),
                    },
                    {
                      key: 'unresolved',
                      priority: 6,
                      menu: { label: unresolvedText, icon: ScanSearch, onSelect: openUnresolved },
                      node: (
                        <button
                          className="status-link status-unresolved"
                          title={
                            settled.size
                              ? i18nPlural(
                                  settled.size,
                                  'Not in this count: {count} target whose references were all marked as expected. Opens in the Audit the references without a target found (missing, names without a file and ambiguous), with file and line.',
                                  'Not in this count: {count} targets whose references were all marked as expected. Opens in the Audit the references without a target found (missing, names without a file and ambiguous), with file and line.',
                                )
                              : t(
                                  'Opens in the Audit the references without a target found (missing, names without a file and ambiguous), with file and line.',
                                )
                          }
                          onClick={openUnresolved}
                        >
                          {unresolvedText}
                        </button>
                      ),
                    },
                    {
                      key: 'relations',
                      priority: 3,
                      menu: {
                        label: i18nPlural(
                          model.stats.edges,
                          '{total} relation',
                          '{total} relations',
                          {
                            total: model.stats.edges,
                          },
                        ),
                        icon: GitBranch,
                        info: true,
                      },
                      node: (
                        <span
                          className="status-relations"
                          title={t(
                            'All the relations of the scan: each reference counts, with its line, including repeats and self-references; relations declared in a manifest and scope conventions count here even with Conventions off',
                          )}
                        >
                          {i18nPlural(model.stats.edges, '{total} relation', '{total} relations', {
                            total: model.stats.edges,
                          })}
                        </span>
                      ),
                    },
                  ]
                : []),
              ...footerEditing(),
            ]}
          />
        </footer>
        {dialog === 'filters' && model && (
          <FilterDialog
            model={model}
            filters={filters}
            initial={selected}
            onSave={saveFilter}
            onDelete={(id) => {
              setFilters((previous) => previous.filter((filter) => filter.id !== id));
              setFilterViews((previous) => previous.filter((item) => item !== id));
              if (highlight === id) setHighlight('');
            }}
            onHighlight={highlightFilter}
            onOpen={openFilter}
            onClose={closeDialog}
          />
        )}
        {dialog === 'open' && model && (
          <CasesDialog
            model={model}
            onClose={closeDialog}
            onAdd={() => setDialog('add')}
            onOpen={openCase}
            onForget={setForgetting}
          />
        )}
        {forgetting && model && (
          <ForgetDialog
            key={forgetting}
            name={
              model.savedCases.find((item) => item.path === forgetting)?.name ??
              model.roots.find((root) => root.path === forgetting)?.name ??
              forgetting.split('/').at(-1) ??
              forgetting
            }
            notes={model.savedCases.find((item) => item.path === forgetting)?.notes ?? 0}
            drafts={ownDrafts(forgetting).length}
            edits={editing.pending.filter((draft) => draft.root === forgetting).length}
            onForget={(notes) => forgetProject(forgetting, notes)}
            onClose={closeForget}
          />
        )}
        {dialog === 'add' && <OpenDialog home={home} onClose={closeDialog} onOpen={openCase} />}
        {dialog === 'create' && (
          <CreateDialog
            parent={parent}
            onClose={closeDialog}
            onCreated={(next) => {
              setModel(next);
              setTrace(null);
              setDialog(null);
              const root = next.roots.at(-1)?.path;
              if (root) select(root, next);
            }}
          />
        )}
        {dialog === 'help' && <HelpDialog policy={model?.policy} onClose={closeDialog} />}
        <EditingDialogs editing={editing} />
      </div>
    </WindowContexts>
  );
}
