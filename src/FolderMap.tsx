// The pieces of the map of a folder drawn by Canvas. The numbers come from src/folderMap.ts.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { BaseEdge, EdgeLabelRenderer, Handle, Position } from '@xyflow/react';
import type { Edge, EdgeProps, Node, NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight, FileSymlink, FileText, Folder, X } from 'lucide-react';
import type { FileNode, Relation } from './types';
import { relations as relationKinds } from './types';
import type {
  FolderArrow,
  FolderItem,
  FolderLayout,
  FolderSums,
  InboundGroup,
  InboundKind,
  OutsideGroup,
  OutsideKind,
  Route,
} from './folderMap';
import { ARROW_HEAD, OUTSIDE_TARGETS_SHOWN, relativeTo } from './folderMap';
import { useI18n } from './i18n';
import { relationEvidence } from './serverText';
import type { Translator } from './i18n';
import './folder-map.css';

type T = Translator['t'];
type Plural = Translator['plural'];

/** The class of a special file, the words of the Structure; a plain file has none. */
function classWord(t: T, kind: string) {
  return kind === 'entry'
    ? t('Instructions')
    : kind === 'memory'
      ? t('Memory')
      : kind === 'skill'
        ? t('Skill')
        : kind === 'manifest'
          ? t('Manifest')
          : '';
}

/** Why a file has no references of its own in this reading, or '' when its text was read. */
function readingWord(t: T, node: FileNode) {
  if (node.kind === 'symlink') return t('not followed');
  if (node.analysis === 'parsed') return '';
  if (node.analysis === 'partial') return t('partly read');
  return t('not read');
}

/** "N references from files of A to files of B", by what each end is. */
export function arrowSentence(plural: Plural, count: number, source: FileNode, target: FileNode) {
  const params = { source: source.name, target: target.name };
  const from = source.kind === 'directory',
    to = target.kind === 'directory';
  return from && to
    ? plural(
        count,
        '{count} written reference from files of {source} to files of {target}',
        '{count} written references from files of {source} to files of {target}',
        params,
      )
    : from
      ? plural(
          count,
          '{count} written reference from files of {source} to {target}',
          '{count} written references from files of {source} to {target}',
          params,
        )
      : to
        ? plural(
            count,
            '{count} written reference from {source} to files of {target}',
            '{count} written references from {source} to files of {target}',
            params,
          )
        : plural(
            count,
            '{count} written reference from {source} to {target}',
            '{count} written references from {source} to {target}',
            params,
          );
}

/** What each group of the box "outside this folder" is. */
export function outsideWord(t: T, kind: OutsideKind, projects: string[] = []) {
  switch (kind) {
    case 'self':
      return t('This folder (.)');
    case 'project':
      return t('Elsewhere in this project');
    case 'other-project':
      return projects.length === 1
        ? t('Another open project: {project}', { project: projects[0] })
        : t('Other open projects');
    case 'outside':
      return t('Outside open projects', { context: 'map' });
    case 'unread':
      return t('In unread folder');
    case 'missing':
      return t('Missing');
    case 'declared':
      return t('Declared outside the package');
    case 'unverified':
      return t('Unverified');
  }
}

/** What each group of the box "from outside this folder" is: where the files that write them are. */
export function inboundWord(t: T, kind: InboundKind, projects: string[] = []) {
  return kind === 'self' ? t('To this folder (.)') : outsideWord(t, kind, projects);
}

/**
 * The second line of a card: what the Structure does not say (sums, internal references), and states.
 * `between` false (a map without arrows between the items): no ↙ and ↗, which would say 0 and 0.
 */
export function ItemCard({
  item,
  badge,
  between = true,
}: {
  item: FolderItem;
  badge?: ReactNode;
  between?: boolean;
}) {
  const { t, plural, formatNumber } = useI18n();
  const node = item.node;
  const facts: string[] = [];
  if (item.folder) {
    if (node.listing === 'unread')
      facts.push(
        plural(
          node.omitted ?? 0,
          'not read · {count} item on disk',
          'not read · {count} items on disk',
        ),
      );
    else if (node.listing === 'partial')
      facts.push(
        plural(
          node.omitted ?? 0,
          'partly read · {count} item left out',
          'partly read · {count} items left out',
        ),
      );
    facts.push(plural(item.files, '{count} file', '{count} files'));
  } else {
    const word = classWord(t, node.kind);
    if (word) facts.push(word);
    const reading = readingWord(t, node);
    if (reading) facts.push(reading);
  }
  if (item.internal)
    facts.push(
      item.folder || item.selfReferences < item.internal
        ? plural(item.internal, '{count} internal', '{count} internal')
        : plural(item.internal, '{count} to itself', '{count} to itself'),
    );
  if (item.ownEntries.length === 1) facts.push(t('own {name}', { name: item.ownEntries[0] }));
  else if (item.ownEntries.length > 1)
    facts.push(
      t('own {first} and {second}', { first: item.ownEntries[0], second: item.ownEntries[1] }),
    );
  const sums = t('{incoming} from other items · {outgoing} to other items', {
    incoming: item.incoming,
    outgoing: item.outgoing,
  });
  return (
    <div
      className={`file-tile item-tile ${node.kind} ${node.status}`}
      title={`${node.path}\n${facts.join(' · ')}${between ? `\n${sums}` : ''}`}
    >
      <Handle type="source" id="out" position={Position.Right} />
      <Handle type="target" id="in" position={Position.Left} />
      <div className="tile-name">
        {item.folder ? (
          <Folder size={16} />
        ) : node.kind === 'symlink' ? (
          <FileSymlink size={16} />
        ) : (
          <FileText size={16} />
        )}
        <strong title={node.path}>{node.name}</strong>
        {badge && <span className="tile-kind">{badge}</span>}
      </div>
      <div className="tile-foot">
        <span className="item-facts">{facts.join(' · ')}</span>
        {between && (
          <span title={sums} aria-label={sums}>
            ↙ {formatNumber(item.incoming)} <i /> ↗ {formatNumber(item.outgoing)}
          </span>
        )}
      </div>
    </div>
  );
}

export type LaneData = { text: string };
/** The title of a column (and of the group "others that reference" in the first one). */
export function LaneTitle({ data }: NodeProps<Node<LaneData>>) {
  return <span className="folder-lane">{data.text}</span>;
}

/** The titles of the columns, about references: only what is true of every card ('' says nothing). */
export function columnTitle(t: T, column: FolderLayout['columns'][number]) {
  switch (column.kind) {
    case 'entries':
      return t('Instructions of this folder');
    case 'sources':
      return t('Reference without being referenced');
    case 'both':
      return t('Reference and are referenced');
    case 'referencing':
      return t('Reference other items');
    case 'referenced':
      return t('Referenced by other items');
    case 'none':
      return '';
    case 'direct':
      return t('Referenced directly');
    case 'steps':
      return t('Referenced in {steps} steps', { steps: column.steps });
    case 'range':
      return t('Referenced in {from} to {to} steps', { from: column.steps, to: column.upTo });
  }
}

export type OutsideData = {
  groups: OutsideGroup[];
  names: Map<string, string>;
  open: (group: OutsideGroup) => void;
};
export function OutsideBox({ data }: NodeProps<Node<OutsideData>>) {
  return <OutsideCard {...data} />;
}
/** The references that leave the folder, by what they reach: a card of the map, without arrows to it. */
export function OutsideCard(data: OutsideData) {
  const { t, plural, formatNumber } = useI18n();
  const total = data.groups.reduce((sum, group) => sum + group.relations.length, 0);
  return (
    <section className="file-tile outside-box" aria-label={t('This folder points to')}>
      <div className="tile-name">
        <strong>{t('This folder points to')}</strong>
        <span className="outside-total">{formatNumber(total)}</span>
      </div>
      {data.groups.map((group) => {
        const sources = group.sources.map((id) => data.names.get(id) ?? id);
        const label = outsideWord(t, group.kind, group.projects);
        return (
          <button
            key={group.kind}
            className="outside-group nodrag"
            data-kind={group.kind}
            title={`${label}: ${plural(group.relations.length, '{count} reference', '{count} references')}\n${group.targets.map((target) => target.label).join('\n')}`}
            onClick={() => data.open(group)}
          >
            <span className="outside-kind">
              {label} · {formatNumber(group.relations.length)}
            </span>
            {group.targets.slice(0, OUTSIDE_TARGETS_SHOWN).map((target) => (
              <span key={target.id} className="tile-path" title={target.id}>
                {target.label}
              </span>
            ))}
            {group.targets.length > OUTSIDE_TARGETS_SHOWN && (
              <span className="outside-more">
                {plural(
                  group.targets.length - OUTSIDE_TARGETS_SHOWN,
                  '+{count} other destination',
                  '+{count} other destinations',
                )}
              </span>
            )}
            <span className="outside-from">
              {sources.length > 2
                ? t('from {first}, {second} and {count} more', {
                    first: sources[0],
                    second: sources[1],
                    count: sources.length - 2,
                  })
                : t('from {names}', { names: sources.join(', ') })}
            </span>
          </button>
        );
      })}
    </section>
  );
}

export type InboundData = {
  groups: InboundGroup[];
  names: Map<string, string>;
  open: (group: InboundGroup) => void;
};
export function InboundBox({ data }: NodeProps<Node<InboundData>>) {
  return <InboundCard {...data} />;
}
/**
 * The references written in files outside the folder that reach it, by where those files are: a card
 * of the map, without arrows from it (the mirror of the box outside, with the rows it has).
 */
export function InboundCard(data: InboundData) {
  const { t, plural, formatNumber } = useI18n();
  const total = data.groups.reduce((sum, group) => sum + group.relations.length, 0);
  return (
    <section className="file-tile outside-box inbound-box" aria-label={t('Point to this folder')}>
      <div className="tile-name">
        <strong>{t('Point to this folder')}</strong>
        <span className="outside-total">{formatNumber(total)}</span>
      </div>
      {data.groups.map((group) => {
        const targets = group.targets.map((id) => data.names.get(id) ?? id);
        const label = inboundWord(t, group.kind, group.projects);
        return (
          <button
            key={group.kind}
            className="inbound-group nodrag"
            data-kind={group.kind}
            title={`${label}: ${plural(group.relations.length, '{count} reference', '{count} references')}\n${group.sources.map((source) => source.label).join('\n')}`}
            onClick={() => data.open(group)}
          >
            <span className="outside-kind">
              {label} · {formatNumber(group.relations.length)}
            </span>
            {group.sources.slice(0, OUTSIDE_TARGETS_SHOWN).map((source) => (
              <span key={source.id} className="tile-path" title={source.id}>
                {source.label}
              </span>
            ))}
            {group.sources.length > OUTSIDE_TARGETS_SHOWN && (
              <span className="outside-more">
                {plural(
                  group.sources.length - OUTSIDE_TARGETS_SHOWN,
                  '+{count} other source',
                  '+{count} other sources',
                )}
              </span>
            )}
            {targets.length > 0 && (
              <span className="outside-from">
                {targets.length > 2
                  ? t('to {first}, {second} and {count} more', {
                      first: targets[0],
                      second: targets[1],
                      count: targets.length - 2,
                    })
                  : t('to {names}', { names: targets.join(', ') })}
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}

export type SummedData = {
  route: Route;
  source: FileNode;
  target: FileNode;
  open: (arrow: FolderArrow) => void;
  /** With a card or an arrow in focus: this arrow is one of them (`lit`) or not (`faded`). */
  state: '' | 'lit' | 'faded';
  /** The head of the arrow: `url(#…)` of the marker of this map. */
  head: string;
};
/** An arrow of the folder map: the route and the place of its number are computed beforehand. */
export function SummedEdge(props: EdgeProps<Edge<SummedData>>) {
  const { plural, formatNumber } = useI18n();
  if (!props.data) return null;
  const { route, source, target, open, state, head } = props.data;
  const count = route.arrow.relations.length;
  const sentence = arrowSentence(plural, count, source, target);
  const box = route.label;
  return (
    <>
      <g
        className="folder-arrow"
        data-source={route.arrow.source}
        data-target={route.arrow.target}
        data-shape={route.shape}
        data-count={count}
        data-waits={route.waits ? '' : undefined}
      >
        <title>{sentence}</title>
        <BaseEdge
          id={props.id}
          path={route.d}
          markerEnd={head}
          style={props.style}
          interactionWidth={10}
        />
      </g>
      {box && (
        <EdgeLabelRenderer>
          <button
            className={`relation-bundle folder-arrow-count nodrag nopan ${state}${box.quiet ? ' quiet' : ''}`}
            data-arrow={`${route.arrow.source}>${route.arrow.target}`}
            style={{
              width: box.width,
              height: box.height,
              transform: `translate(-50%, -50%) translate(${box.x}px,${box.y}px)`,
            }}
            title={sentence}
            aria-label={sentence}
            onClick={(event) => {
              event.stopPropagation();
              open(route.arrow);
            }}
          >
            {formatNumber(count)}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** The head of the arrows of a folder map: one size for every width of line, in the colour of the lines. */
export function ArrowHead({ id }: { id: string }) {
  const half = ARROW_HEAD / 2;
  return (
    <svg className="folder-arrow-head" aria-hidden="true" width="0" height="0">
      <defs>
        <marker
          id={id}
          viewBox={`0 ${-half} ${ARROW_HEAD} ${ARROW_HEAD}`}
          markerWidth={ARROW_HEAD}
          markerHeight={ARROW_HEAD}
          refX={1}
          refY={0}
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d={`M 0,${-half} L ${ARROW_HEAD},0 L 0,${half} Z`} />
        </marker>
      </defs>
    </svg>
  );
}

/** A node without content: the room the lanes take outside the columns, for the framing of the map. */
export function LaneRoom() {
  return <span className="folder-lane-room" aria-hidden="true" />;
}

/** The references listed by the evidence picker of the folder map: an arrow or a group of the box. */
export type FolderEvidence = { title: string; from: string; to: string; relations: Relation[] };
const PAGE = 50;
/** The references of an arrow (or of a group outside), each with file, line and excerpt, page by page. */
export function FolderEvidenceList({
  evidence,
  folder,
  onEdge,
  onClose,
}: {
  evidence: FolderEvidence;
  folder: string;
  onEdge: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(PAGE);
  const left = evidence.relations.length - shown;
  // What had the focus when the list opened (the number of the arrow, clicked or by Enter): closing the
  // list, by Esc or by its ×, gives the focus back to it, or to the number of the same arrow if the map
  // drew it again.
  const opener = useRef<{ element: HTMLElement | null; arrow: string | null }>({
    element: null,
    arrow: null,
  });
  useEffect(() => {
    const element = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    opener.current = { element, arrow: element?.dataset.arrow ?? null };
  }, []);
  const close = useCallback(() => {
    const { element, arrow } = opener.current;
    onClose();
    requestAnimationFrame(() => {
      const target = element?.isConnected
        ? element
        : arrow
          ? document.querySelector<HTMLElement>(`[data-arrow="${CSS.escape(arrow)}"]`)
          : null;
      target?.focus();
    });
  }, [onClose]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      // A dialog over the map answers its own Esc.
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [close]);
  return (
    <section className="canvas-evidence-picker" aria-label={t('References of the arrow')}>
      <header>
        <strong>{evidence.title}</strong>
        <button aria-label={t('Close the references of the arrow')} onClick={close}>
          <X size={15} />
        </button>
      </header>
      <p title={evidence.from}>{evidence.from}</p>
      <p title={evidence.to}>→ {evidence.to}</p>
      <div>
        {evidence.relations.slice(0, shown).map((edge) => {
          const excerpt = relationEvidence(edge);
          return (
            <button key={edge.id} onClick={() => onEdge(edge.id)}>
              <strong>
                {t('{file} · line {line}', {
                  file: relativeTo(folder, edge.origin),
                  line: String(edge.line),
                })}
              </strong>
              <small>{relationKinds[edge.kind] || edge.kind}</small>
              {/* From its first character, cut only at its end; the whole excerpt in the tooltip. */}
              <span className="evidence-excerpt" title={excerpt}>
                {excerpt}
              </span>
            </button>
          );
        })}
        {left > 0 && (
          <button className="load-more" onClick={() => setShown((value) => value + PAGE)}>
            {t('Show {count} more · {left} left', { count: Math.min(PAGE, left), left })}
          </button>
        )}
      </div>
    </section>
  );
}

const STRIP_PAGE = 30;

// Whether the line under the map is folded to one line: a preference of the person, the same in every
// view, kept in `localStorage['aae-folder-strip']`. It starts folded: only `open` opens it.
const STRIP_KEY = 'aae-folder-strip';
function readFolded() {
  try {
    return localStorage.getItem(STRIP_KEY) !== 'open';
  } catch {
    return true;
  }
}
let folded = readFolded();
const foldListeners = new Set<() => void>();
function setFolded(value: boolean) {
  folded = value;
  for (const listener of foldListeners) listener();
  try {
    localStorage.setItem(STRIP_KEY, value ? 'folded' : 'open');
  } catch {
    /* Still usable without storage, for this session. */
  }
}
function useFolded() {
  return useSyncExternalStore(
    (listener) => {
      foldListeners.add(listener);
      return () => void foldListeners.delete(listener);
    },
    () => folded,
    () => folded,
  );
}
/**
 * Under the map: the items that have no arrow with another item of the folder (references to or from
 * outside it do not count: they leave the grid, and the line says so), the items left out by the
 * limit, and what an arrow without a number means. A map without arrows between the items has every
 * item as a card (up to the limit): only those left out are here.
 */
export function FolderStrip({
  sums,
  layout,
  onSelect,
}: {
  sums: FolderSums;
  layout: FolderLayout | null;
  onSelect: (id: string) => void;
}) {
  const { t, plural } = useI18n();
  const [all, setAll] = useState(false);
  const [showOmitted, setShowOmitted] = useState(false);
  const isFolded = useFolded();
  const byId = new Map(sums.items.map((item) => [item.id, item]));
  const unlinked = (layout?.unlinked ?? sums.items.map((item) => item.id)).map(
    (id) => byId.get(id)!,
  );
  const omitted = (layout?.omitted ?? []).map((id) => byId.get(id)!);
  const describe = (item: FolderItem) => {
    const parts = [
      item.folder
        ? plural(item.files, '{count} file', '{count} files')
        : item.node.kind === 'symlink'
          ? t('symbolic link')
          : classWord(t, item.node.kind) || readingWord(t, item.node),
    ];
    if (item.internal) parts.push(plural(item.internal, '{count} internal', '{count} internal'));
    return parts.filter(Boolean).join(' · ');
  };
  const button = (item: FolderItem) => (
    <button
      key={item.id}
      className="folder-strip-item"
      title={item.node.path}
      onClick={() => onSelect(item.id)}
    >
      {item.folder ? (
        <Folder size={13} aria-hidden="true" />
      ) : item.node.kind === 'symlink' ? (
        <FileSymlink size={13} aria-hidden="true" />
      ) : (
        <FileText size={13} aria-hidden="true" />
      )}
      <span>{item.node.name}</span>
      {describe(item) && <small>{describe(item)}</small>}
    </button>
  );
  const shown = all ? unlinked : unlinked.slice(0, STRIP_PAGE);
  // What waits for the focus: the arrows without room for a lane, the numbers without a free place.
  const undrawn = layout?.undrawn.length ?? 0,
    quiet = layout?.quiet ?? 0;
  const inFocus = t('Drawn while the pointer or the keyboard focus is on one of their items');
  if (!unlinked.length && !omitted.length && !layout?.routes.length && !undrawn) return null;
  const toggle = (
    <button
      className="folder-strip-fold"
      aria-expanded={!isFolded}
      aria-label={isFolded ? t('Show the line') : t('Fold the line')}
      title={isFolded ? t('Show the line') : t('Fold the line')}
      onClick={() => setFolded(!isFolded)}
    >
      {isFolded ? (
        <ChevronRight size={14} aria-hidden="true" />
      ) : (
        <ChevronDown size={14} aria-hidden="true" />
      )}
    </button>
  );
  if (isFolded) {
    const parts = [
      omitted.length > 0 &&
        (layout?.grid
          ? plural(omitted.length, '+{count} item', '+{count} items')
          : `${plural(omitted.length, '+{count} item', '+{count} items')} · ${plural(
              layout?.hidden ?? 0,
              '{count} reference not drawn',
              '{count} references not drawn',
            )}`),
      unlinked.length > 0 && t('Not linked · {count}', { count: unlinked.length }),
      undrawn > 0 && plural(undrawn, '{count} arrow not drawn', '{count} arrows not drawn'),
      quiet > 0 && plural(quiet, '{count} number not drawn', '{count} numbers not drawn'),
      !!layout?.routes.length && !quiet && t('Arrow without a number: 1 reference'),
    ].filter(Boolean);
    const summary = parts.join(' · ');
    return (
      <div
        className="scope-crossing folder-strip folder-strip-folded"
        aria-label={t('Items without a card')}
      >
        {toggle}
        <span className="folder-strip-summary" title={summary}>
          {summary}
        </span>
      </div>
    );
  }
  return (
    <div className="scope-crossing folder-strip" aria-label={t('Items without a card')}>
      {toggle}
      <div className="folder-strip-body">
        {omitted.length > 0 && (
          <div className="folder-strip-line">
            <button
              className="folder-strip-toggle"
              aria-expanded={showOmitted}
              title={
                layout?.grid
                  ? t('Items left out of the map by its limit of {limit} cards', {
                      limit: layout.shown.length,
                    })
                  : t('Linked items left out of the map by its limit of {limit} cards', {
                      limit: layout?.shown.length ?? 0,
                    })
              }
              onClick={() => setShowOmitted((value) => !value)}
            >
              {plural(omitted.length, '+{count} item', '+{count} items')}
              {/* Without arrows between the items, no reference is left undrawn by the limit. */}
              {!layout?.grid &&
                ` · ${plural(
                  layout?.hidden ?? 0,
                  '{count} reference not drawn',
                  '{count} references not drawn',
                )}`}
            </button>
            {showOmitted && omitted.map(button)}
          </div>
        )}
        {unlinked.length > 0 && (
          <div className="folder-strip-line">
            <span className="folder-strip-label">
              {t('Not linked to other items of this folder')}
            </span>
            {shown.map(button)}
            {unlinked.length > shown.length && (
              <button className="folder-strip-toggle" onClick={() => setAll(true)}>
                {plural(unlinked.length - shown.length, '+{count} more', '+{count} more')}
              </button>
            )}
          </div>
        )}
        {undrawn > 0 && (
          <span className="folder-strip-undrawn" title={inFocus}>
            {plural(undrawn, '{count} arrow not drawn', '{count} arrows not drawn')}
          </span>
        )}
        {quiet > 0 && (
          <span className="folder-strip-undrawn folder-strip-quiet" title={inFocus}>
            {plural(quiet, '{count} number not drawn', '{count} numbers not drawn')}
          </span>
        )}
        {!!layout?.routes.length && !quiet && (
          <span className="folder-strip-legend">{t('Arrow without a number: 1 reference')}</span>
        )}
      </div>
    </div>
  );
}

/** The note of a partial scan: text in the warning tone, no box. */
export function PartialNote() {
  const { t } = useI18n();
  return (
    <span className="structure-listing folder-partial">
      {t('Partial scan: the sums may be incomplete')}
    </span>
  );
}
