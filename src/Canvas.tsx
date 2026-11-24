import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getViewportForBounds,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  ReactNode,
} from 'react';
import type { Edge, EdgeProps, Node, NodeProps, ReactFlowInstance, Viewport } from '@xyflow/react';
import { FileText, Folder, NotebookPen, PanelRight, X } from 'lucide-react';
import type { FileNode, Model, Trace } from './types';
import { kinds, relations } from './types';
import { contextualGraph, pathLayers, positionFiles, TILE_HEIGHT } from './graphLayout';
import type { RelationBundle } from './graphLayout';
import type { FilterResult } from './mapFilters';
import { folderArrowFocus, folderFocus, folderLayout, folderSums, NARROW, WIDE } from './folderMap';
import type { FolderArrow, FolderItem, FolderSums, InboundGroup, OutsideGroup } from './folderMap';
import {
  ArrowHead,
  arrowSentence,
  columnTitle,
  FolderEvidenceList,
  FolderStrip,
  InboundBox,
  InboundCard,
  inboundWord,
  ItemCard,
  LaneRoom,
  LaneTitle,
  OutsideBox,
  outsideWord,
  PartialNote,
  SummedEdge,
} from './FolderMap';
import type { FolderEvidence } from './FolderMap';
import { useI18n } from './i18n';
import type { Translator } from './i18n';
import { relationEvidence } from './serverText';
import { InspectorContext, ItemDecorationsContext } from './itemDecorations';
import { MapHeader, zoomStore } from './MapHeader';
import type { ZoomStore } from './MapHeader';
import { MAP_GLIDE_MS, reducedMotion } from './theme';
import '@xyflow/react/dist/style.css';
import './canvas.css';

type Port = { id: string; type: 'source' | 'target'; side: Position; offset: number };
type FileData = {
  file: FileNode;
  note: boolean;
  incoming: number;
  outgoing: number;
  focused: boolean;
  inTrace: boolean;
  ports: Port[];
  currentDirectory: boolean;
  rootReference: boolean;
  filtered: boolean;
  outside: boolean;
  dimmed: boolean;
  matched: boolean;
  /** In the map of a folder: the item this card stands for (its sums), drawn by ItemCard. */
  item?: FolderItem;
  /** In the map of a folder without arrows between its items: the card has no ↙ and ↗. */
  grid?: boolean;
};
type BundleData = { bundle: RelationBundle; inspect: () => void };
function FileTile({ data }: NodeProps<Node<FileData>>) {
  const n = data.file;
  const badge = useContext(ItemDecorationsContext).badge?.(n);
  // The selected tile offers the inspector while it is closed; clicking the tile does the same.
  const inspector = useContext(InspectorContext);
  const offer = data.focused && !!inspector && !inspector.open && n.kind !== 'directory';
  const { t, formatNumber } = useI18n();
  if (data.item) return <ItemCard item={data.item} badge={badge} between={!data.grid} />;
  return (
    <div
      className={`file-tile ${n.kind} ${n.status} ${data.focused ? 'focused' : ''} ${data.inTrace ? 'traced' : ''} ${data.dimmed ? 'filter-dimmed' : ''} ${data.matched ? 'filter-matched' : ''}`}
    >
      {data.ports.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.type}
          position={port.side}
          style={
            port.side === Position.Top ? { left: `${port.offset}%` } : { top: `${port.offset}%` }
          }
        />
      ))}
      <div className="tile-kind">
        <span className="kind-dot" />
        {data.currentDirectory
          ? t('Reference to the current folder')
          : data.rootReference
            ? t('Reference to the open project')
            : data.outside
              ? t('Reference outside this folder')
              : kinds[n.kind] || n.kind}
        {data.note && <NotebookPen size={12} />}
        {badge}
      </div>
      <div className="tile-name">
        {n.kind === 'directory' ? <Folder size={17} /> : <FileText size={17} />}
        <strong title={n.path}>
          {data.currentDirectory
            ? t('This folder (.)')
            : data.rootReference
              ? t('{name} (project)', { name: n.name })
              : n.name}
        </strong>
      </div>
      {(data.currentDirectory || data.outside || n.relative !== n.name) && (
        <div className="tile-path" title={n.path}>
          {data.currentDirectory || data.outside || n.relative === '.' ? n.path : n.relative}
        </div>
      )}
      <div className="tile-foot">
        {/* Inside the card, left of the counts: nothing hangs from its edge nor covers its footer. */}
        {offer && (
          <button
            className="tile-inspect nodrag"
            title={t(
              'Text, relations and evidence of this file in the inspector (Enter on the card)',
            )}
          >
            <PanelRight size={12} aria-hidden="true" />
            {t('Open inspector')}
          </button>
        )}
        {n.status === 'missing' ||
        n.status === 'declared' ||
        n.status === 'external' ||
        n.status === 'unscanned' ||
        (n.kind === 'directory' && data.filtered) ? (
          <span>
            {n.status === 'missing'
              ? t('Missing target')
              : n.status === 'declared'
                ? t('Declared outside the package')
                : n.status === 'external'
                  ? t('Outside open projects')
                  : n.status === 'unscanned'
                    ? t('Not read')
                    : t('Referenced folder')}
          </span>
        ) : null}
        <span
          title={
            data.outside
              ? t(
                  '↙ {incoming} incoming · ↗ {outgoing} outgoing · only the relations with this folder',
                  {
                    incoming: data.incoming,
                    outgoing: data.outgoing,
                  },
                )
              : t('↙ {incoming} incoming · ↗ {outgoing} outgoing', {
                  incoming: data.incoming,
                  outgoing: data.outgoing,
                })
          }
        >
          ↙ {formatNumber(data.incoming)} <i /> ↗ {formatNumber(data.outgoing)}
        </span>
      </div>
    </div>
  );
}
function RootTile({ data }: NodeProps) {
  return (
    <div className="root-tile">
      <Handle type="target" position={Position.Top} />
      <div className="root-title">
        <Folder size={15} />
        <strong>{String(data.name)}</strong>
        {data.meta ? <span>{String(data.meta)}</span> : null}
      </div>
      <div className="root-path">{String(data.path)}</div>
      {(data.lanes as string[]).length > 0 && (
        <div className="canvas-lanes">
          {(data.lanes as string[]).map((label, i) => (
            <span key={i}>{label}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
function RelationEdge(props: EdgeProps<Edge<BundleData>>) {
  const { t, plural } = useI18n();
  const { sourceX, sourceY, targetX, targetY, data } = props;
  const sameSide = props.sourcePosition === props.targetPosition;
  const [normalPath, labelX, labelY] = getBezierPath(props);
  const detour = props.sourcePosition === Position.Left ? -100 : 100;
  const path = sameSide
    ? `M ${sourceX},${sourceY} C ${sourceX + detour},${sourceY} ${targetX + detour},${targetY} ${targetX},${targetY}`
    : normalPath;
  if (!data) return <BaseEdge {...props} path={path} />;
  const { bundle } = data;
  const label = bundle.steps.length
    ? bundle.steps
        .map((step) =>
          step.reverse ? t('{step} · reverse', { step: String(step.index) }) : String(step.index),
        )
        .join(', ')
    : '';
  const count = bundle.relations.length;
  const sourceName = bundle.source.split('/').at(-1)!;
  const targetName = bundle.target.split('/').at(-1)!;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={24}
      />
      {(count > 1 || label) && (
        <EdgeLabelRenderer>
          <button
            className={`relation-bundle nodrag nopan ${label ? 'trace-bundle' : ''}`}
            style={{
              opacity: props.style?.opacity,
              transform: `translate(-50%, -50%) translate(${sameSide ? sourceX + detour * 0.75 : labelX}px,${sameSide ? (sourceY + targetY) / 2 : labelY}px)`,
            }}
            aria-label={
              label
                ? plural(
                    count,
                    'Step {steps}. {count} relation from {source} to {target}. View the evidence',
                    'Step {steps}. {count} relations from {source} to {target}. View the evidence',
                    { steps: label, source: sourceName, target: targetName },
                  )
                : plural(
                    count,
                    '{count} relation from {source} to {target}. View the evidence',
                    '{count} relations from {source} to {target}. View the evidence',
                    { source: sourceName, target: targetName },
                  )
            }
            onClick={(event) => {
              event.stopPropagation();
              data.inspect();
            }}
          >
            {label && <span>{t('Step {steps}', { steps: label })}</span>}
            {count > 1 && <span>{plural(count, '{count} relation', '{count} relations')}</span>}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const nodeTypes = {
  file: FileTile,
  root: RootTile,
  lane: LaneTitle,
  room: LaneRoom,
  outside: OutsideBox,
  inbound: InboundBox,
};
const edgeTypes = { relation: RelationEdge, summed: SummedEdge };
const NO_GRAPH: ReturnType<typeof contextualGraph> = {
  files: [],
  allowed: [],
  bundles: [],
  hidden: 0,
};

const HIDE_CREDIT = { hideAttribution: true };
/** Below this zoom the text of a tile stops being readable. */
const READABLE_ZOOM = 0.45;
/**
 * A double click on a tile is the second click of a pair the system counts as one (`detail` 2, its own
 * time and distance), at most this long (ms) after the click that selected the tile.
 */
const DOUBLE_CLICK_MS = 800;
const FIT_PADDING = 0.2;
/**
 * The sentence of a folder map without arrows between its items: over its grid of cards, or alone in the
 * area when the folder has no items.
 */
function noArrowsSentence(t: Translator['t'], sums: FolderSums) {
  if (!sums.items.length) return t('This folder has no items in this scan.');
  const isRead = (node: FileNode) => node.analysis === 'parsed' || node.analysis === 'partial';
  const files = sums.items.reduce((sum, item) => sum + (item.folder ? item.files : 1), 0);
  const read = sums.items.reduce(
    (sum, item) => sum + (item.folder ? item.read : Number(isRead(item.node))),
    0,
  );
  const sentence = t('No references between the items of this folder.');
  return files > 0 && !read
    ? `${sentence} ${t('None of its files was read for references.')}`
    : sentence;
}

/** The map of a folder is framed closer to the edges: its lanes ask for width, not its margins. */
const FOLDER_FIT_PADDING = 0.08;
/**
 * The least zoom of the first framing of a folder map: the smallest card text (11 px) stays at 11 px of
 * the screen (principle 3 of docs/posicionamento-visual.md), never above 100%. Read when the map
 * frames, so a page zoom (which resizes the pane) frames with the new ratio. What does not fit is
 * reached by dragging; the zoom buttons and "Enquadrar" may go below it.
 */
const CARD_SMALLEST_TEXT = 11;
const LEAST_TEXT = 11;
const folderReadableZoom = () =>
  Math.min(1, LEAST_TEXT / (CARD_SMALLEST_TEXT * (window.devicePixelRatio || 1)));
const fileReadableZoom = () => READABLE_ZOOM;
/**
 * Frames the given nodes, the first one always included, without cutting columns on the right: the zoom
 * first fits every column (down to a readable minimum; a graph wider than that keeps its leftmost
 * columns, the start of a path), then only the rows that fit at that zoom are framed.
 */
function fitReadable(
  flow: Pick<ReactFlowInstance, 'getInternalNode' | 'fitView' | 'setViewport'>,
  ids: string[],
  width: number,
  height: number,
  duration = 0,
  padding = FIT_PADDING,
  everyColumn = false,
  least = READABLE_ZOOM,
) {
  const boxes = ids
    .map((id) => flow.getInternalNode(id))
    .filter((node) => !!node)
    .map((node) => ({
      id: node.id,
      x: node.internals.positionAbsolute.x,
      y: node.internals.positionAbsolute.y,
      width: node.measured.width || 274,
      height: node.measured.height || 125,
    }));
  if (!boxes.length) {
    void flow.fitView({ padding, minZoom: least, maxZoom: Math.max(1, least), duration });
    return;
  }
  // Same usable area as React Flow's numeric padding.
  const usableWidth = width / (1 + padding),
    usableHeight = height / (1 + padding);
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const zoom = Math.max(least, Math.min(1, usableWidth / (right - left)));
  const lastRight = left + usableWidth / zoom,
    viewHeight = usableHeight / zoom;
  const [first, ...others] = boxes;
  const framed = [first];
  let top = first.y,
    bottom = first.y + first.height;
  for (const box of others) {
    if (box.x + box.width > lastRight + 1) continue;
    const nextTop = Math.min(top, box.y),
      nextBottom = Math.max(bottom, box.y + box.height);
    if (nextBottom - nextTop > viewHeight) continue;
    framed.push(box);
    top = nextTop;
    bottom = nextBottom;
  }
  // Set at once: fitView waits for the next render, when the user may already have panned or zoomed.
  // `everyColumn`: the framing keeps the width of all the columns that fit, also when the rows framed
  // lie in the first ones only (a second column whose first card is far down); else that of the rows.
  const x = everyColumn ? left : Math.min(...framed.map((box) => box.x));
  const bounds = {
    x,
    y: top,
    width:
      (everyColumn
        ? Math.min(right, lastRight)
        : Math.max(...framed.map((box) => box.x + box.width))) - x,
    height: bottom - top,
  };
  void flow.setViewport(
    getViewportForBounds(bounds, width, height, least, Math.max(1, least), padding),
    { duration },
  );
}
const glideDuration = () => (reducedMotion() ? 0 : MAP_GLIDE_MS);

/**
 * Frames the map when it mounts and when its size or focus changes, until the person pans or zooms it.
 * `glide`: the map mounted on the viewport of the previous selection, so the first framing moves there
 * instead of jumping. A framing asked again while it moves ends at the same moment. When the glide ends
 * the framing of the latest state is set again, so a glide interrupted or asked with stale sizes never
 * leaves the map off its selection.
 */
function AutoFocus({
  ids,
  compact,
  manualViewport,
  glide,
  padding,
  everyColumn,
  least,
  shape,
}: {
  ids: string[];
  compact: boolean;
  manualViewport: MutableRefObject<boolean>;
  glide: boolean;
  padding: number;
  everyColumn: boolean;
  /** The least zoom of the framing, read each time the map frames. */
  least: () => number;
  /** Changes when the same nodes take other places (the map of a folder in a narrower pane). */
  shape: string;
}) {
  const ready = useNodesInitialized();
  const flow = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const key = ids.join('\0');
  const first = useRef(true);
  const glideEnd = useRef(0);
  const latest = useRef({ ids, width, height });
  latest.current = { ids, width, height };
  const settle = useRef(0);
  useEffect(() => () => clearTimeout(settle.current), []);
  useLayoutEffect(() => {
    // Nodes measured by the previous map count as ready before this one knows its own size.
    if (!ready || !width || !height || manualViewport.current) return;
    const now = performance.now();
    if (first.current && glide) glideEnd.current = now + glideDuration();
    first.current = false;
    const duration = Math.max(0, Math.round(glideEnd.current - now));
    fitReadable(flow, ids, width, height, duration, padding, everyColumn, least());
    clearTimeout(settle.current);
    if (duration)
      settle.current = window.setTimeout(() => {
        if (manualViewport.current) return;
        const { ids, width, height } = latest.current;
        fitReadable(flow, ids, width, height, 0, padding, everyColumn, least());
      }, duration + 34);
  }, [ready, key, flow, width, height, compact, padding, everyColumn, least, shape]);
  return null;
}

/**
 * Tells whether some file of the map lies (even partly) outside the visible area: framing by width keeps
 * every column but can leave the last rows below a small pane.
 */
function OffscreenWatch({ onChange }: { onChange: (outside: boolean) => void }) {
  const outside = useStore((state) => {
    const [x, y, zoom] = state.transform;
    if (!state.width || !state.height || !zoom) return false;
    const left = -x / zoom,
      top = -y / zoom,
      right = left + state.width / zoom,
      bottom = top + state.height / zoom;
    for (const node of state.nodeLookup.values()) {
      // In the map of a folder, the lanes outside its columns count too (their `room` nodes).
      if (!['file', 'outside', 'inbound', 'room'].includes(node.type ?? '') || node.hidden)
        continue;
      const width = node.measured.width ?? 0,
        height = node.measured.height ?? 0;
      if (!width || !height) continue;
      const { x: nodeX, y: nodeY } = node.internals.positionAbsolute;
      if (
        nodeX < left - 2 ||
        nodeY < top - 2 ||
        nodeX + width > right + 2 ||
        nodeY + height > bottom + 2
      )
        return true;
    }
    return false;
  });
  useEffect(() => onChange(outside), [outside, onChange]);
  return null;
}

/** Hands the zoom of the map to its header line, which shows it beside "−" and "+". */
function ZoomWatch({ zoom }: { zoom: ZoomStore }) {
  const value = useStore((state) => state.transform[2]);
  useEffect(() => zoom.set(value), [value, zoom]);
  return null;
}
const MIN_ZOOM = 0.02,
  MAX_ZOOM = 1.6;

export default function Canvas({
  model,
  fullModel,
  selected,
  trace,
  onSelect,
  onEdge,
  showConventions,
  theme,
  overviewPath,
  contextPath = '',
  filter,
  isolate = false,
  pathsOnly = false,
}: {
  contextPath?: string;
  /** The whole reading, when `model` is cut to a view: the map of a folder sums over all of it. */
  fullModel?: Model;
  filter?: FilterResult;
  isolate?: boolean;
  pathsOnly?: boolean;
  overviewPath: string;
  theme: 'dark' | 'light';
  model: Model;
  selected: string;
  trace: Trace | null;
  onSelect: (id: string) => void;
  onEdge: (id: string) => void;
  showConventions: boolean;
}) {
  const instanceRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const inspector = useContext(InspectorContext);
  const manualViewport = useRef(false);
  const lastViewport = useRef<Viewport | null>(null);
  // The tile selected by the last click: it moves on that click, so a double click counts wherever it lands.
  const lastSelection = useRef<{ id: string; at: number } | null>(null);
  const secondClick = (event: { detail: number; timeStamp: number }) => {
    const last = lastSelection.current;
    return last && event.detail >= 2 && event.timeStamp - last.at <= DOUBLE_CLICK_MS ? last : null;
  };
  // A tile selected by the keyboard keeps the focus on the new map, so Enter again opens the inspector.
  const refocus = useRef(false);
  /** The selected tile asked for detail: it stays the selection and the inspector opens on it. */
  const inspectTile = (id: string) => {
    onSelect(id);
    inspector?.show();
  };
  const viewportContext = `${model.roots.map((root) => root.path).join('|')}|${selected}|${overviewPath}|${trace?.nodes.join('|')}`;
  const lastViewportContext = useRef(viewportContext);
  if (lastViewportContext.current !== viewportContext) {
    manualViewport.current = false;
    lastViewportContext.current = viewportContext;
    if (instanceRef.current) lastViewport.current = instanceRef.current.getViewport();
  }
  const [bundleId, setBundleId] = useState('');
  // Part of the map outside the view after the automatic framing (not after the user's pan or zoom).
  const [offscreen, setOffscreen] = useState(false);
  const [zoom] = useState(zoomStore);
  const containerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  // The map of a folder narrows its cards and corridors below this width (the columns stay).
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      setCompact(entries[0].contentRect.width < 650);
      setNarrow(entries[0].contentRect.width < 1000);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { t, plural: pluralOf } = useI18n();
  // A folder with nothing selected in it: its items and the references between them, summed.
  const sumsModel = fullModel ?? model;
  const folder = useMemo(() => {
    if (!overviewPath || selected || trace || filter) return null;
    const inside = overviewPath + '/';
    return {
      sums: folderSums(sumsModel, overviewPath, showConventions),
      layout: folderLayout(sumsModel, overviewPath, showConventions, narrow ? NARROW : WIDE),
      // What the inventory limit or the relation cap left out may hold references of this folder.
      partial:
        sumsModel.stats?.relations?.complete === false ||
        sumsModel.nodes.some(
          (node) =>
            node.kind === 'directory' &&
            (node.path === overviewPath || node.path.startsWith(inside)) &&
            !!node.listing &&
            node.listing !== 'complete',
        ),
    };
  }, [sumsModel, overviewPath, selected, trace, filter, showConventions, narrow]);
  const [evidence, setEvidence] = useState<FolderEvidence | null>(null);
  // The card or the arrow of a folder map under the pointer, and the card with the keyboard focus. The
  // pointer wins while it is on one; out of it, the card with the keyboard focus is the focus again. The
  // arrows of the focus stay and the others fade.
  const [lit, setLit] = useState({ card: '', arrow: '' });
  const [keyed, setKeyed] = useState('');
  const active = lit.card || lit.arrow ? lit : { card: keyed, arrow: '' };
  const head = `folder-arrow-head-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const graphFocus = filter ? [...filter.nodes][0] || '' : selected;
  const graph = useMemo(
    () =>
      folder
        ? NO_GRAPH
        : contextualGraph(model, graphFocus, trace, showConventions, overviewPath, filter, isolate),
    [folder, model, graphFocus, trace, showConventions, overviewPath, filter, isolate],
  );
  const activeBundle = graph.bundles.find((bundle) => bundle.id === bundleId);
  useEffect(() => {
    setBundleId('');
    setEvidence(null);
    setLit({ card: '', arrow: '' });
    setKeyed('');
  }, [selected, overviewPath, trace]);
  const onEdgeRef = useRef(onEdge);
  onEdgeRef.current = onEdge;
  const inspect = useCallback((bundle: RelationBundle) => {
    if (bundle.relations.length === 1) onEdgeRef.current(bundle.relations[0].id);
    else setBundleId(bundle.id);
  }, []);
  // An arrow of a folder map: one reference opens its evidence; more open their list.
  const openArrow = useCallback(
    (arrow: FolderArrow) => {
      if (arrow.relations.length === 1) return onEdgeRef.current(arrow.relations[0].id);
      const items = new Map(folder?.sums.items.map((item) => [item.id, item.node]));
      const source = items.get(arrow.source),
        target = items.get(arrow.target);
      if (!source || !target) return;
      setEvidence({
        title: arrowSentence(pluralOf, arrow.relations.length, source, target),
        from: arrow.source,
        to: arrow.target,
        relations: arrow.relations,
      });
    },
    [folder, pluralOf],
  );
  const openInbound = useCallback(
    (group: InboundGroup) => {
      if (group.relations.length === 1) return onEdgeRef.current(group.relations[0].id);
      const names = new Map(folder?.sums.items.map((item) => [item.id, item.node.name]));
      setEvidence({
        title: `${inboundWord(t, group.kind, group.projects)} · ${pluralOf(group.relations.length, '{count} reference', '{count} references')}`,
        from: group.sources.map((source) => source.label).join(', '),
        to: group.targets.length
          ? group.targets.map((id) => names.get(id) ?? id).join(', ')
          : overviewPath,
        relations: group.relations,
      });
    },
    [folder, t, pluralOf, overviewPath],
  );
  const openGroup = useCallback(
    (group: OutsideGroup) => {
      if (group.relations.length === 1) return onEdgeRef.current(group.relations[0].id);
      setEvidence({
        title: `${outsideWord(t, group.kind, group.projects)} · ${pluralOf(group.relations.length, '{count} reference', '{count} references')}`,
        from: overviewPath,
        to: group.targets.map((target) => target.label).join(', '),
        relations: group.relations,
      });
    },
    [t, pluralOf, overviewPath],
  );
  const folderNodes = useMemo(() => {
    if (!folder) return null;
    const { sums, layout: placed } = folder;
    const items = new Map(sums.items.map((item) => [item.id, item]));
    const { cardWidth } = placed.geometry;
    const fixed = { draggable: false, selectable: false, focusable: false };
    const nodes: Node[] = placed.columns
      .map((column) => ({ column, text: columnTitle(t, column) }))
      .filter(({ text }) => text)
      .map(({ column, text }) => ({
        id: `lane:${column.column}`,
        type: 'lane',
        position: { x: column.x, y: -32 },
        data: { text },
        ...fixed,
      }));
    // The lanes that run outside the columns count for the framing: a node without content each.
    const first = placed.columns[0]?.x ?? 0,
      last = (placed.columns.at(-1)?.x ?? 0) + cardWidth;
    for (const [id, x, width] of [
      ['room:left', placed.left, first - placed.left],
      ['room:right', last, placed.left + placed.width - last],
    ] as const)
      if (width > 0)
        nodes.push({
          id,
          type: 'room',
          position: { x, y: 0 },
          style: { width, height: 1 },
          data: {},
          ...fixed,
        });
    // Without arrows between the items, the sentence that says so is the title of the grid.
    if (placed.grid)
      nodes.push({
        id: 'lane:0',
        type: 'lane',
        position: { x: 0, y: -32 },
        data: { text: noArrowsSentence(t, sums) },
        ...fixed,
      });
    if (placed.others)
      nodes.push({
        id: 'lane:others',
        type: 'lane',
        position: { x: placed.others.x, y: placed.others.y + 6 },
        data: { text: placed.others.referencing ? t('Others that reference') : t('Other items') },
        ...fixed,
      });
    for (const card of placed.cards) {
      const item = items.get(card.id)!;
      nodes.push({
        id: card.id,
        type: 'file',
        position: { x: card.x, y: card.y },
        style: { width: cardWidth, height: card.height },
        draggable: false,
        data: {
          file: item.node,
          item,
          note: false,
          incoming: item.incoming,
          outgoing: item.outgoing,
          focused: false,
          inTrace: false,
          ports: [],
          currentDirectory: false,
          rootReference: false,
          filtered: false,
          outside: false,
          dimmed: false,
          matched: false,
          grid: placed.grid,
        },
      });
    }
    if (placed.inboundBox)
      nodes.push({
        id: 'inbound',
        type: 'inbound',
        position: { x: placed.inboundBox.x, y: placed.inboundBox.y },
        style: { width: placed.inboundBox.width, height: placed.inboundBox.height },
        ...fixed,
        data: {
          groups: sums.inbound,
          names: new Map(sums.items.map((item) => [item.id, item.node.name])),
          open: openInbound,
        },
      });
    if (placed.outsideBox)
      nodes.push({
        id: 'outside',
        type: 'outside',
        position: { x: placed.outsideBox.x, y: placed.outsideBox.y },
        style: { width: placed.outsideBox.width, height: placed.outsideBox.height },
        ...fixed,
        data: {
          groups: sums.outside,
          names: new Map(sums.items.map((item) => [item.id, item.node.name])),
          open: openGroup,
        },
      });
    return nodes;
  }, [folder, t, openGroup, openInbound]);
  const folderEdges = useMemo(() => {
    if (!folder) return null;
    const { sums, layout: placed } = folder;
    const items = new Map(sums.items.map((item) => [item.id, item]));
    const color = 'var(--edge-color, #648ca7)';
    // In focus, every arrow of the card (those not drawn at rest included) or the arrow under the
    // pointer, each with its number in a free place; the others stay where they are, faded.
    const inFocus = active.card
      ? folderFocus(placed, active.card)
      : active.arrow
        ? [folderArrowFocus(placed, active.arrow)].filter((route) => !!route)
        : [];
    const ids = new Set(inFocus.map((route) => route.arrow.id));
    const routes = [...placed.routes.filter((route) => !ids.has(route.arrow.id)), ...inFocus];
    return routes.map((route): Edge => {
      const source = items.get(route.arrow.source)!.node,
        target = items.get(route.arrow.target)!.node;
      const count = route.arrow.relations.length;
      const state = active.card || active.arrow ? (ids.has(route.arrow.id) ? 'lit' : 'faded') : '';
      return {
        id: route.arrow.id,
        source: route.arrow.source,
        target: route.arrow.target,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'summed',
        className: state,
        data: {
          route,
          source,
          target,
          open: openArrow,
          state,
          head: `url(#${head})`,
        },
        style: {
          stroke: color,
          strokeWidth: route.stroke,
          strokeDasharray: route.arrow.conventions ? '5 5' : undefined,
        },
        ariaLabel: arrowSentence(pluralOf, count, source, target),
        animated: false,
      };
    });
  }, [folder, pluralOf, openArrow, active.card, active.arrow, head]);
  const fileLayout = useMemo(() => {
    const incoming = new Map<string, number>(),
      outgoing = new Map<string, number>();
    for (const e of graph.allowed) {
      outgoing.set(e.source, (outgoing.get(e.source) || 0) + 1);
      incoming.set(e.target, (incoming.get(e.target) || 0) + 1);
    }
    const flowNodes: Node[] = [];
    const absolute = new Map<string, { x: number; y: number }>();
    let y = 0;
    const layers = pathsOnly
      ? pathLayers(
          graph.files,
          graph.bundles.flatMap((bundle) => bundle.relations),
          graphFocus,
        )
      : undefined;
    const rootGroupIds = new Map<string, string>();
    const groups = [
      ...model.roots.map((r) => ({
        key: r.path,
        name: r.name,
        meta: r.parent
          ? pluralOf(
              r.level,
              'Child of {parent} · +{count} level',
              'Child of {parent} · +{count} levels',
              {
                parent: r.parent.split('/').at(-1)!,
              },
            )
          : '',
      })),
      {
        key: '',
        name: t('References outside this context'),
        meta: t('Paths of other scopes or not opened'),
      },
    ];
    for (const group of groups) {
      const files = graph.files.filter((n) => (n.root || '') === group.key);
      if (!files.length) continue;
      const groupId = `root:${group.key}`;
      rootGroupIds.set(group.key, groupId);
      const placed = positionFiles(files, graphFocus, graph.allowed, trace, compact, layers);
      // Path filters already describe their purpose in the pane header/summary.
      // Repeating that label on every root overlaps the fixed caption when focused.
      // The overview of the entry points needs no column labels: the caption above already names it.
      const lanes =
        pathsOnly || (!trace?.found && !selected)
          ? []
          : compact
            ? [trace?.found ? t('Files of the trace ↓') : t('Sources ↑ · selection · targets ↓')]
            : trace?.found
              ? Array.from({ length: Math.max(3, trace.nodes.length) }, (_, i) =>
                  i < trace.nodes.length ? t('File {step}', { step: String(i + 1) }) : t('Context'),
                )
              : [
                  t('What points to the selection'),
                  t('File being inspected'),
                  t('Where the selection points'),
                ];
      const flat = group.key === contextPath;
      if (!flat)
        flowNodes.push({
          id: groupId,
          type: 'root',
          position: { x: 0, y },
          data: { name: group.name, path: group.key, meta: group.meta, lanes },
          style: { width: placed.width, height: placed.height },
          draggable: false,
          selectable: false,
          zIndex: -1,
        });
      for (const file of files) {
        const position = placed.positions.get(file.id)!;
        absolute.set(file.id, { x: position.x, y: position.y + y });
        flowNodes.push({
          id: file.id,
          type: 'file',
          parentId: flat ? undefined : groupId,
          extent: flat ? undefined : 'parent',
          position: flat ? { x: position.x, y: position.y + y } : position,
          data: {
            file,
            note: !!model.notes[file.id],
            incoming: incoming.get(file.id) || 0,
            outgoing: outgoing.get(file.id) || 0,
            focused: file.id === selected,
            inTrace: !!trace?.found && trace.nodes.includes(file.id),
            ports: [],
            filtered: !!filter,
            rootReference:
              file.kind === 'directory' && model.roots.some((root) => root.path === file.path),
            currentDirectory:
              file.kind === 'directory' && file.path === (overviewPath || contextPath),
            outside: !!contextPath && file.root === null,
            dimmed: !!filter && !filter.nodes.has(file.id),
            matched: !!filter && filter.nodes.has(file.id),
          },
        });
      }
      y += placed.height + 100;
    }
    const ports = new Map<
      string,
      { id: string; type: 'source' | 'target'; side: Position; order: number }[]
    >();
    const addPort = (
      id: string,
      port: { id: string; type: 'source' | 'target'; side: Position; order: number },
    ) => ports.set(id, [...(ports.get(id) || []), port]);
    const flowEdges: Edge<BundleData>[] = graph.bundles.map((bundle) => {
      const source = absolute.get(bundle.source)!,
        target = absolute.get(bundle.target)!;
      const sameColumn = source.x === target.x;
      const commonSide = source.x < 440 ? Position.Left : Position.Right;
      const forward = target.x > source.x || (target.x === source.x && target.y >= source.y);
      addPort(bundle.source, {
        id: `${bundle.id}:source`,
        type: 'source',
        side: sameColumn ? commonSide : forward ? Position.Right : Position.Left,
        order: target.y + (forward ? 0 : -TILE_HEIGHT / 3),
      });
      addPort(bundle.target, {
        id: `${bundle.id}:target`,
        type: 'target',
        side: sameColumn ? commonSide : forward ? Position.Left : Position.Right,
        order: source.y + (forward ? 0 : TILE_HEIGHT / 3),
      });
      const traced = bundle.steps.length > 0;
      const matched = !!filter && bundle.relations.some((edge) => filter.edges.has(edge.id));
      const dimmed = !!filter && !matched;
      const color = matched
        ? 'var(--accent, #014a94)'
        : traced
          ? 'var(--purple, #8988f5)'
          : 'var(--edge-color, #648ca7)';
      return {
        className: dimmed ? 'filter-dimmed' : matched ? 'filter-matched' : '',
        id: bundle.id,
        source: bundle.source,
        target: bundle.target,
        sourceHandle: `${bundle.id}:source`,
        targetHandle: `${bundle.id}:target`,
        type: 'relation',
        data: { bundle, inspect: () => inspect(bundle) },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        style: {
          opacity: dimmed ? 0.14 : 1,
          stroke: color,
          strokeWidth: matched ? 3 : traced ? 2.8 : bundle.relations.length > 1 ? 2 : 1.4,
          strokeDasharray: bundle.relations.every((e) => e.kind === 'scope') ? '5 5' : undefined,
        },
        ariaLabel: pluralOf(
          bundle.relations.length,
          '{count} relation: {source} → {target}',
          '{count} relations: {source} → {target}',
          { source: bundle.source, target: bundle.target },
        ),
        animated: false,
      };
    });
    for (const node of flowNodes)
      if (node.type === 'file') {
        const nodePorts = ports.get(node.id) || [];
        node.data.ports = nodePorts.map((port) => {
          const sidePorts = nodePorts
            .filter((p) => p.side === port.side)
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
          return {
            ...port,
            offset: 18 + ((sidePorts.indexOf(port) + 1) * 64) / (sidePorts.length + 1),
          };
        });
      }
    for (const root of model.roots)
      if (
        root.parent &&
        rootGroupIds.has(root.parent) &&
        rootGroupIds.has(root.path) &&
        !contextPath &&
        !filter
      )
        flowEdges.push({
          id: `hierarchy:${root.path}`,
          source: rootGroupIds.get(root.parent)!,
          target: rootGroupIds.get(root.path)!,
          type: 'default',
          label: pluralOf(root.level, 'contains · +{count} level', 'contains · +{count} levels'),
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-color, #648ca7)' },
          style: { stroke: 'var(--edge-color, #648ca7)', strokeWidth: 1.4, strokeDasharray: '5 5' },
          animated: false,
        });
    return { nodes: flowNodes, edges: flowEdges as Edge[] };
  }, [
    model,
    graph,
    selected,
    graphFocus,
    trace,
    inspect,
    compact,
    contextPath,
    overviewPath,
    filter,
    pathsOnly,
    t,
    pluralOf,
  ]);
  const layout = useMemo(
    () => (folderNodes && folderEdges ? { nodes: folderNodes, edges: folderEdges } : fileLayout),
    [folderNodes, folderEdges, fileLayout],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  useEffect(
    () =>
      setNodes((previous) => {
        if (!manualViewport.current) return layout.nodes;
        const positions = new Map(previous.map((node) => [node.id, node]));
        return layout.nodes.map((node) => {
          const existing = positions.get(node.id);
          return existing && node.type === 'file' && existing.parentId === node.parentId
            ? { ...node, position: existing.position }
            : node;
        });
      }),
    [layout.nodes, setNodes],
  );
  const focusIds = trace?.found
    ? trace.nodes.filter((id) => graph.files.some((file) => file.id === id))
    : selected
      ? [
          selected,
          ...graph.bundles
            .filter((bundle) => bundle.source === selected || bundle.target === selected)
            .slice(0, 4)
            .flatMap((bundle) => [bundle.source, bundle.target]),
        ].filter((id, i, ids) => ids.indexOf(id) === i)
      : [];
  // A minimum readable zoom cannot frame distant groups in a small pane: anchor
  // on an actual file, so the initial viewport never centers on empty space.
  const compactAnchor =
    selected ||
    (trace?.found ? trace.nodes[0] : '') ||
    graph.files.find((file) => file.kind === 'entry')?.id ||
    graph.files[0]?.id;
  // From the top of the folder map: the titles of the columns and the first row of cards; then the box
  // from outside above them, which joins only when the view has room for it with that row (a short
  // view keeps the cards, and Fit says part of the map is out of view); then the other rows.
  const rows = folder ? [...folder.layout.cards].sort((a, b) => a.y - b.y || a.x - b.x) : [];
  const firstRow = rows.filter((card) => card.y < (rows[0]?.y ?? 0) + (rows[0]?.height ?? 0));
  const framedIds = folder
    ? [
        'lane:0',
        'room:left',
        'room:right',
        ...firstRow.map((card) => card.id),
        ...(folder.layout.inboundBox ? ['inbound'] : []),
        ...rows.slice(firstRow.length).map((card) => card.id),
        ...(folder.layout.outsideBox ? ['outside'] : []),
      ]
    : compact
      ? compactAnchor
        ? [compactAnchor]
        : []
      : focusIds.length
        ? focusIds
        : graph.files.map((file) => file.id);
  const fitPadding = folder ? FOLDER_FIT_PADDING : FIT_PADDING;
  function focus(instance: ReactFlowInstance<Node, Edge> | null) {
    if (!instance) return;
    fitReadable(
      instance,
      framedIds,
      areaRef.current?.clientWidth || 800,
      areaRef.current?.clientHeight || 400,
      glideDuration(),
      fitPadding,
      !!folder,
    );
  }
  useEffect(() => {
    if (!refocus.current) return;
    // The tiles of the new map are hidden until measured: try again on each change of the nodes.
    const tile = [
      ...(containerRef.current?.querySelectorAll<HTMLElement>('.react-flow__node-file') ?? []),
    ].find((element) => element.dataset.id === selected);
    if (tile && getComputedStyle(tile).visibility !== 'hidden') {
      refocus.current = false;
      tile.focus({ preventScroll: true });
    }
  }, [selected, nodes]);
  // On the whole map: double click and Enter on a tile (see the comments inside).
  /** The card of a folder map an event happened on, by its node element. */
  const cardOf = (target: EventTarget) => {
    const tile = (target as HTMLElement).closest?.<HTMLElement>('.react-flow__node-file');
    return (folder && tile?.dataset.id) || '';
  };
  const tileEvents = {
    // The keyboard focus on a card of a folder map shows its arrows, as the pointer over it does, and
    // stays the focus of the map while the pointer is elsewhere.
    onFocus: (event: FocusEvent) => {
      const card = cardOf(event.target);
      if (card) setKeyed(card);
    },
    onBlur: (event: FocusEvent) => {
      if (cardOf(event.target)) setKeyed('');
    },
    // The second click of a double click on a tile just selected opens the inspector on it, wherever
    // the tile went; it never reaches what is now under the pointer. Its press does not either: on
    // the canvas, it would start a pan and stop the map gliding to the tile.
    onMouseDownCapture: (event: ReactMouseEvent) => {
      if (secondClick(event)) event.stopPropagation();
    },
    onClickCapture: (event: ReactMouseEvent) => {
      const last = secondClick(event);
      lastSelection.current = null;
      if (!last) return;
      event.stopPropagation();
      event.preventDefault();
      inspectTile(last.id);
    },
    // Enter on a tile does what a click does: selects it, or opens the inspector when it is selected.
    onKeyDown: (event: KeyboardEvent) => {
      const tile = event.target as HTMLElement;
      if (event.key !== 'Enter' || !tile.classList.contains('react-flow__node-file')) return;
      const id = tile.dataset.id;
      if (!id) return;
      event.preventDefault();
      if (id === selected) inspectTile(id);
      else {
        refocus.current = true;
        onSelect(id);
      }
    },
  };
  const flow = (
    <ReactFlow
      defaultViewport={lastViewport.current ?? { x: 0, y: 0, zoom: 0.75 }}
      key={`${model.roots.map((r) => r.path).join('|')}|${selected}|${overviewPath}|${trace?.nodes.join('|')}`}
      nodes={nodes}
      edges={layout.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      // Only a move made by the person (a pan, a zoom) keeps the map where they left it. A press on the
      // canvas starts a pan without moving anything: it does not count.
      onMove={(event) => {
        if (event) manualViewport.current = true;
      }}
      nodesDraggable={!folder}
      onNodeDragStart={() => {
        manualViewport.current = true;
      }}
      // A click on a tile changes one thing: another tile becomes the selection (the map moves to it);
      // the selected one opens the inspector.
      onNodeClick={(event, n) => {
        if (n.type !== 'file') return;
        if (n.id === selected) return inspectTile(n.id);
        lastSelection.current = { id: n.id, at: event.timeStamp };
        onSelect(n.id);
      }}
      // A double click belongs to the tiles (see onClickCapture), never to the zoom.
      zoomOnDoubleClick={false}
      onEdgeClick={(_, e) => {
        if (e.type === 'summed')
          openArrow((e.data as { route: { arrow: FolderArrow } }).route.arrow);
        else if (e.data) inspect((e.data as BundleData).bundle);
      }}
      onNodeMouseEnter={(_, n) => {
        if (folder && n.type === 'file') setLit({ card: n.id, arrow: '' });
      }}
      onNodeMouseLeave={() => {
        if (folder) setLit((now) => (now.card ? { card: '', arrow: '' } : now));
      }}
      onEdgeMouseEnter={(_, e) => {
        if (e.type === 'summed') setLit({ card: '', arrow: e.id });
      }}
      onEdgeMouseLeave={() => {
        if (folder) setLit((now) => (now.arrow ? { card: '', arrow: '' } : now));
      }}
      nodesConnectable={false}
      edgesReconnectable={false}
      deleteKeyCode={null}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      // The credit of the library is a line of the legend (MapHeader): nothing with text over the map.
      proOptions={HIDE_CREDIT}
      onInit={(instance) => {
        instanceRef.current = instance;
      }}
      aria-label={t('Architecture map')}
      colorMode={theme}
    >
      <Background color={theme === 'dark' ? '#25394f' : '#d7e2ed'} gap={22} size={1} />
      <AutoFocus
        ids={framedIds}
        compact={compact}
        manualViewport={manualViewport}
        glide={lastViewport.current !== null}
        padding={fitPadding}
        everyColumn={!!folder}
        least={folder ? folderReadableZoom : fileReadableZoom}
        shape={
          folder
            ? `${folder.layout.geometry.cardWidth}:${folder.layout.left}:${folder.layout.width}`
            : ''
        }
      />
      <OffscreenWatch onChange={setOffscreen} />
      <ZoomWatch zoom={zoom} />
    </ReactFlow>
  );
  // A zoom or a framing chosen by the person keeps the map where they left it, as a pan does.
  const zoomBy = (closer: boolean) => {
    manualViewport.current = true;
    void (closer ? instanceRef.current?.zoomIn() : instanceRef.current?.zoomOut());
  };
  /** "Fit": the whole map in the view, smaller. */
  const fitAll = () => {
    manualViewport.current = true;
    setOffscreen(false);
    void instanceRef.current?.fitView({ padding: 0.1, maxZoom: 1, duration: glideDuration() });
  };
  const header = (
    label: string,
    count: string,
    countTitle: string,
    { note, drawn = true }: { note?: ReactNode; drawn?: boolean } = {},
  ) => (
    <MapHeader
      label={label}
      note={note}
      count={count}
      countTitle={countTitle}
      drawn={drawn}
      conventions={showConventions}
      summed={!!folder}
      zoom={zoom}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      onZoomIn={() => zoomBy(true)}
      onZoomOut={() => zoomBy(false)}
      outside={offscreen}
      onFit={fitAll}
      onFocus={selected ? () => focus(instanceRef.current) : undefined}
    />
  );
  if (folder) {
    const { sums, layout: placed } = folder;
    const drawn = sums.totals.between - placed.hidden;
    // A file that references itself is inside an item too, not inside a folder.
    const insideWords = sums.totals.selfReferences
      ? pluralOf(sums.totals.internal, '{count} inside items', '{count} inside items')
      : pluralOf(sums.totals.internal, '{count} inside folders', '{count} inside folders');
    const name = overviewPath.split('/').at(-1) || overviewPath;
    const itemsWords = pluralOf(sums.items.length, '{count} item', '{count} items');
    const writtenWords = pluralOf(sums.totals.written, '{count} reference', '{count} references');
    const outsideWords = pluralOf(sums.totals.outside, '{count} outside', '{count} outside');
    // Without arrows between the items, the sentence of the map says so: the count does not say it
    // again ("0 between items"), and without any reference written here it is the items alone. The
    // references from outside are not written in the folder: a figure of their own, after.
    const written = sums.arrows.length
      ? `${itemsWords} · ${writtenWords} (${pluralOf(drawn, '{count} between items', '{count} between items')} · ${outsideWords} · ${insideWords}${placed.hidden > 0 ? ` · ${pluralOf(placed.hidden, '{count} with items not drawn', '{count} with items not drawn')}` : ''})`
      : sums.totals.written
        ? `${itemsWords} · ${writtenWords} (${outsideWords} · ${insideWords})`
        : itemsWords;
    const count = sums.totals.inbound
      ? `${written} · ${pluralOf(sums.totals.inbound, '{count} from outside', '{count} from outside')}`
      : written;
    return (
      <div
        ref={containerRef}
        className={`canvas-wrap contextual-canvas folder-map ${compact ? 'compact-context' : ''}`}
        data-crossings={placed.crossings}
        {...tileEvents}
      >
        {header(
          t('Summed references between the items of {folder}', { folder: name }),
          count,
          t(
            'References written in files of this folder: between its items (the arrows), to outside it (the box at the end) and inside one item (on its card); from outside: references written in other files to this folder or its items (the box at the start)',
          ),
          { note: folder.partial ? <PartialNote /> : undefined, drawn: placed.cards.length > 0 },
        )}
        <div className="map-area folder-map-area" ref={areaRef}>
          {placed.cards.length ? (
            <>
              <ArrowHead id={head} />
              {flow}
            </>
          ) : (
            // A folder without items: the sentence alone, and what reaches the folder itself.
            <div className="folder-map-empty">
              <p>{noArrowsSentence(t, sums)}</p>
              {sums.inbound.length > 0 && (
                <InboundCard groups={sums.inbound} names={new Map()} open={openInbound} />
              )}
            </div>
          )}
          {evidence && (
            <FolderEvidenceList
              key={`${evidence.from}>${evidence.to}`}
              evidence={evidence}
              folder={overviewPath}
              onEdge={(id) => {
                onEdge(id);
                setEvidence(null);
              }}
              onClose={() => setEvidence(null)}
            />
          )}
        </div>
        <FolderStrip
          key={overviewPath}
          sums={sums}
          layout={placed.cards.length ? placed : null}
          onSelect={(id) => onSelect(id)}
        />
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      className={`canvas-wrap contextual-canvas ${compact ? 'compact-context' : ''}`}
      {...tileEvents}
    >
      {header(
        filter
          ? isolate
            ? t('Only the filter')
            : t('Filter highlighted · other relations dimmed')
          : trace?.found
            ? t('Trace + context')
            : selected
              ? t('Context of the file')
              : overviewPath
                ? t('Items of this folder')
                : t('Entry points'),
        `${pluralOf(graph.files.length, '{count} element', '{count} elements')} · ${pluralOf(
          graph.bundles.reduce((total, bundle) => total + bundle.relations.length, 0),
          '{count} relation',
          '{count} relations',
        )}${graph.hidden > 0 ? ` · ${t('+{count} in the inspector', { count: graph.hidden })}` : ''}`,
        graph.hidden === 0
          ? t('Elements and relations drawn in this view')
          : overviewPath && !selected && !trace
            ? t(
                'Elements and relations drawn in this view; +{count}: items of this folder outside the map, listed in the inspector',
                { count: graph.hidden },
              )
            : t(
                'Elements and relations drawn in this view; +{count}: relations of the file in focus with elements outside the map, listed in the inspector',
                { count: graph.hidden },
              ),
      )}
      <div className="map-area" ref={areaRef}>
        {flow}
        {activeBundle && (
          <section className="canvas-evidence-picker" aria-label={t('Evidence of the arrow')}>
            <header>
              <strong>
                {pluralOf(
                  activeBundle.relations.length,
                  '{count} relation between these files',
                  '{count} relations between these files',
                )}
              </strong>
              <button
                aria-label={t('Close the evidence of the arrow')}
                onClick={() => setBundleId('')}
              >
                <X size={15} />
              </button>
            </header>
            <p title={activeBundle.source}>{activeBundle.source}</p>
            <p title={activeBundle.target}>→ {activeBundle.target}</p>
            <div>
              {activeBundle.relations.map((edge) => (
                <button
                  key={edge.id}
                  onClick={() => {
                    onEdge(edge.id);
                    setBundleId('');
                  }}
                >
                  <strong>
                    {t('{relation} · line {line}', {
                      relation: relations[edge.kind] || edge.kind,
                      line: String(edge.line),
                    })}
                  </strong>
                  <small>{edge.origin}</small>
                  <span>{relationEvidence(edge)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
