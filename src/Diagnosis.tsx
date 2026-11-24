import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
} from 'lucide-react';
import { api } from './api';
import type { ExpectedMark, Issue, ScopeKind } from './types';
import { scopeKinds } from './types';
import type { Diagnosis as DiagnosisData, Tone } from './observations';
import {
  countTone,
  describeMarker,
  groupMeaning,
  groupObservations,
  inconclusiveNote,
  inconclusive,
  issueInfo,
  scopeEdit,
  shortText,
  showsMarker,
  strongestTone,
  toneLabel,
} from './observations';
import { ExpectedButton, ExpectedForm, ExpectedNote } from './ExpectedMark';
import { observationKey } from './editing';
import { formatNumber, useI18n } from './i18n';
import { messageText } from './serverText';
import type { Translator } from './i18n';

function ToneChip({ tone }: { tone: Tone }) {
  useI18n();
  return <em className={`tone-chip tone-${tone}`}>{toneLabel(tone).toLowerCase()}</em>;
}

/**
 * The number of a marker, in the colour of its strongest tone: problems and warnings only. An item with
 * informative ones only has no marker (`showsMarker`).
 */
function markerCount(items: Issue[]) {
  return formatNumber(items.filter((item) => issueInfo(item).tone !== 'info').length);
}

/**
 * Marker of an item with a problem or a warning (explorer tree, Structure, Home): their count in the colour
 * of the strongest tone, and the same count in words in the tooltip and accessible name, the informative
 * ones apart (`describeMarker`); it opens the diagnosis of the item. Nothing for informative ones alone.
 */
export function ObservationMarker({
  items,
  onOpen,
  audit = false,
}: {
  items: Issue[];
  onOpen: () => void;
  /** The marker of a whole project (the list of Home): it opens the Audit, not one diagnosis. */
  audit?: boolean;
}) {
  const { t } = useI18n();
  if (!showsMarker(items)) return null;
  const tone = strongestTone(items);
  const words = describeMarker(items, audit);
  return (
    <button
      className={`observation-marker tone-${tone}`}
      title={words}
      aria-label={
        audit ? t('{words}. Open in the Audit', { words }) : t('{words}. View diagnosis', { words })
      }
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {markerCount(items)}
    </button>
  );
}

/**
 * Discreet badge of a map tile, at most one per file: like the marker of the tree, one click opens the
 * file with its observations in the inspector (a request for detail; the tile itself only selects), and
 * nothing for informative ones alone.
 */
export function ObservationBadge({ items, onOpen }: { items: Issue[]; onOpen: () => void }) {
  const { t } = useI18n();
  if (!showsMarker(items)) return null;
  const tone = strongestTone(items);
  const words = describeMarker(items);
  return (
    <button
      className={`tile-observations nodrag tone-${tone}`}
      title={words}
      aria-label={t('{words}. View diagnosis', { words })}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {markerCount(items)}
    </button>
  );
}

// Line texts fetched for a diagnosis whose line has no relation in the model (an ambiguous reference
// alone on its line); keyed by path and content hash, so a new reading of a changed file reads it again.
const lines = new Map<string, Promise<string[]>>();
function useLineText(path: string | undefined, line: number | undefined, version = '') {
  const [text, setText] = useState<string>();
  useEffect(() => {
    setText(undefined);
    if (!path || !line) return;
    const key = `${path}\n${version}`;
    let request = lines.get(key);
    if (!request) {
      request = api<{ text: string }>(`content?path=${encodeURIComponent(path)}`).then((data) =>
        data.text.split('\n'),
      );
      request.catch(() => lines.delete(key));
      lines.set(key, request);
    }
    let cancelled = false;
    request
      .then((all) => {
        if (!cancelled) setText(all[line - 1]?.trim().slice(0, 500));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, line, version]);
  return text;
}

/**
 * The facts of one occurrence, from the model only (see `diagnose`): the line as written (and how the
 * reference was written when that changes the reading), where the reader looked, the candidates of an
 * ambiguity with the path to write for each, and the actions. What the type means is said once, by its group
 * (`meaning` shows it here when there is no group, as in the evidence of a relation). `scope`, when given,
 * keeps "Declare in project…" closed until clicked; without it the declaration is shown open. `source` and
 * `version` let it read the line text when the model has none for that line.
 */
export function Diagnosis({
  diagnosis,
  source,
  version,
  onSelect,
  meaning = false,
  actions,
  scope,
  children,
}: {
  diagnosis: DiagnosisData;
  source?: string;
  version?: string;
  onSelect: (id: string) => void;
  meaning?: boolean;
  actions?: ReactNode;
  scope?: { open: boolean; onToggle: () => void };
  children?: ReactNode;
}) {
  const { t, rich } = useI18n();
  const { info, written, citation, searched, candidates, candidatesTotal, ancestor, message } =
    diagnosis;
  const fetched = useLineText(
    written?.snippet ? undefined : source,
    written?.snippet ? undefined : written?.line,
    version,
  );
  const snippet = written?.snippet ?? fetched;
  const shown = snippet ?? written?.target;
  const listed = candidates?.length ?? 0;
  const scopeShown = diagnosis.scope && (!scope || scope.open);
  return (
    <div className={`diagnosis tone-${info.tone}`}>
      {meaning && <p className="diagnosis-meaning">{info.meaning}</p>}
      {shown && (
        <p className="diagnosis-written">
          <code>{shown}</code>
          {citation && <span className="diagnosis-citation"> · {citation}</span>}
        </p>
      )}
      {message && <p className="diagnosis-message">{message}</p>}
      {searched && <p className="diagnosis-searched">{searched}</p>}
      {diagnosis.inconclusive && (
        <p className="diagnosis-message diagnosis-inconclusive">{diagnosis.inconclusive}</p>
      )}
      {!!listed && (
        <div className="diagnosis-candidates-block">
          {(candidatesTotal ?? listed) > listed && (
            <p className="diagnosis-candidates-count">
              {t('{listed} of {total} candidates:', { listed, total: candidatesTotal ?? listed })}
            </p>
          )}
          <ul className="diagnosis-candidates">
            {candidates!.map((candidate) => (
              <li key={candidate.id}>
                <button title={candidate.id} onClick={() => onSelect(candidate.id)}>
                  <FileText size={12} aria-hidden="true" />
                  {candidate.label}
                </button>
                <span>
                  {rich('to reference this one, write <code>{suggestion}</code>', {
                    suggestion: candidate.suggestion,
                    code: (chunks) => <code>{chunks}</code>,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ancestor && (
        <p className="diagnosis-ancestor">
          <button
            className="diagnosis-link"
            title={ancestor.id}
            onClick={() => onSelect(ancestor.id)}
          >
            <FolderOpen size={12} aria-hidden="true" />
            {ancestor.label}
          </button>{' '}
          {t('is referenced by a reachable file; referencing the folder does not reach its files.')}
        </p>
      )}
      {(actions || (diagnosis.scope && scope)) && (
        <div className="diagnosis-actions">
          {actions}
          {diagnosis.scope && scope && (
            <button
              className="diagnosis-link scope-toggle"
              aria-expanded={scope.open}
              onClick={scope.onToggle}
            >
              {t('Declare in project…')}
            </button>
          )}
        </div>
      )}
      {children}
      {scopeShown && (
        <ScopeSuggestion scope={diagnosis.scope!} titled={!scope} onSelect={onSelect} />
      )}
    </div>
  );
}

type Place = NonNullable<DiagnosisData['scope']>['places'][number];

/** Where the snippet goes in agent-architecture.json, given what the file holds now. */
function editNote(place: Place, kind: ScopeKind, mode: string, rich: Translator['rich']) {
  const tags = {
    code: (chunks: ReactNode) => <code>{chunks}</code>,
    name: place.name,
    kind,
  };
  switch (mode) {
    case 'create':
      return rich(
        'Create <code>agent-architecture.json</code> in the root of {name} with this content:',
        tags,
      );
    case 'add-key':
      return rich(
        'The <code>agent-architecture.json</code> of {name} already exists, without the <code>scope</code> key: add this snippet to the top-level object, separated by a comma.',
        tags,
      );
    case 'replace-value':
      return place.manifest.state === 'invalid-scope'
        ? place.manifestIssue
          ? rich(
              'The <code>scope</code> key of the <code>agent-architecture.json</code> of {name} is invalid and is being ignored (see the manifest observation): replace its value with this object, or fix it and add the pattern, without creating another <code>scope</code> key.',
              tags,
            )
          : rich(
              'The <code>scope</code> key of the <code>agent-architecture.json</code> of {name} is invalid and is being ignored: replace its value with this object, or fix it and add the pattern, without creating another <code>scope</code> key.',
              tags,
            )
        : rich(
            'The <code>agent-architecture.json</code> of {name} already has the <code>scope</code> key, with no patterns: replace its value with this object, without creating another <code>scope</code> key.',
            tags,
          );
    case 'add-pattern':
      return rich(
        'Add this pattern to the <code>{kind}</code> list of the <code>scope</code> key of the <code>agent-architecture.json</code> of {name}.',
        tags,
      );
    case 'add-list':
      return rich(
        'The <code>scope</code> key of the <code>agent-architecture.json</code> of {name} exists, without the <code>{kind}</code> list: add this snippet inside it, separated by a comma.',
        tags,
      );
    default:
      return place.manifest.state === 'broken'
        ? rich(
            'The <code>agent-architecture.json</code> of {name} is not valid JSON and is being ignored: fix the file first and click Rescan; then the diagnosis shows the snippet to add.',
            tags,
          )
        : rich(
            'Could not read the <code>agent-architecture.json</code> of {name} (symlink, permission or size): check the file and click Rescan.',
            tags,
          );
  }
}

/** One root where the declaration can go: why this pattern, where it goes and the snippet to copy. */
function ScopePlaceEdit({
  place,
  kind,
  alternative,
  onSelect,
}: {
  place: Place;
  kind: ScopeKind | '';
  alternative: boolean;
  onSelect: (id: string) => void;
}) {
  const { t, rich } = useI18n();
  const [copy, setCopy] = useState<'' | 'copied' | 'failed'>('');
  useEffect(() => {
    if (!copy) return;
    const timer = setTimeout(() => setCopy(''), 2500);
    return () => clearTimeout(timer);
  }, [copy]);
  const edit = kind && place.pattern ? scopeEdit(kind, place.pattern, place.manifest) : undefined;
  // Until a kind is chosen there is no snippet: the options above are all there is.
  if (!edit) return null;
  return (
    <div className={`scope-place${alternative ? ' alternative' : ''}`}>
      <p>
        <strong>
          {alternative
            ? t('Alternative, in project {name}:', { name: place.name })
            : t('In project {name}:', { name: place.name })}
        </strong>{' '}
        {editNote(place, kind as ScopeKind, edit.mode, rich)}
      </p>
      {edit.snippet === null ? (
        <p className="scope-fix">
          {place.manifestIssue && <span>{messageText(place.manifestIssue)} </span>}
          <button
            className="diagnosis-link"
            onClick={() => onSelect(`${place.root}/agent-architecture.json`)}
          >
            <FileText size={12} aria-hidden="true" />
            {t('Open agent-architecture.json of {name}', { name: place.name })}
          </button>
        </p>
      ) : (
        <div className="scope-snippet">
          <pre>
            <code>{edit.snippet}</code>
          </pre>
          <button
            aria-label={t('Copy the scope declaration snippet for {name}', { name: place.name })}
            onClick={() =>
              navigator.clipboard
                .writeText(edit.snippet!)
                .then(() => setCopy('copied'))
                .catch(() => setCopy('failed'))
            }
          >
            {copy === 'copied' ? <Check size={12} /> : <Copy size={12} />}
            {copy === 'copied' ? t('Copied') : t('Copy')}
          </button>
          {copy && (
            <span role="status">
              {copy === 'copied' ? t('Snippet copied.') : t('Could not copy; select the snippet.')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The declared-scope snippet for agent-architecture.json, per root that can hold it (the owner project, then
 * enclosing open roots): the choice between the two readings of a missing destination in words, then, per root,
 * where the snippet goes (one sentence) and the snippet to copy. Without a fitting v1 pattern, one sentence says
 * why. What a declaration changes and proves is in the usage guide, not here.
 */
function ScopeSuggestion({
  scope,
  titled,
  onSelect,
}: {
  scope: NonNullable<DiagnosisData['scope']>;
  titled: boolean;
  onSelect: (id: string) => void;
}) {
  const places = scope.places.filter((place) => place.pattern !== null);
  const choices = places.find((place) => place.kinds.length > 1)?.kinds ?? [];
  const [chosen, setChosen] = useState<ScopeKind | ''>('');
  const name = useId();
  const { t, rich } = useI18n();
  const blocked = scope.places.find((place) => place.pattern === null);
  if (!places.length)
    return (
      <div className="diagnosis-scope">
        {titled && <p className="diagnosis-scope-title">{t('Declare in project')}</p>}
        <p>
          {blocked?.basis === 'wildcard'
            ? t(
                'The path has * or ?, which the v1 scope declaration treats as a wildcard; use Mark as expected.',
              )
            : t(
                'The v1 scope declaration cannot say that a file is not meant for the agent; use Mark as expected.',
              )}
        </p>
      </div>
    );
  return (
    <div className="diagnosis-scope">
      {titled && <p className="diagnosis-scope-title">{t('Declare in project')}</p>}
      {choices.length > 1 && (
        <fieldset className="scope-choice">
          <legend>{t('The target is:')}</legend>
          {choices.map((kind) => (
            <label key={kind} title={kind}>
              <input
                type="radio"
                name={name}
                value={kind}
                checked={chosen === kind}
                onChange={() => setChosen(kind)}
              />
              {scopeKinds[kind]}
            </label>
          ))}
        </fieldset>
      )}
      {places.map((place, index) => (
        <ScopePlaceEdit
          key={place.root}
          place={place}
          kind={place.kinds.length > 1 ? chosen : place.kinds[0]}
          alternative={index > 0}
          onSelect={onSelect}
        />
      ))}
      {scope.places
        .filter((place) => !place.owner && place.pattern === null && place.basis === 'wildcard')
        .map((place) => (
          <p key={place.root} className="scope-place alternative">
            {rich(
              '<strong>No alternative in project {name}:</strong> the path from it has * or ?.',
              { name: place.name, strong: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        ))}
    </div>
  );
}

/** Title line of one observation: title in words, the tone in its colour and the code as a secondary detail. */
export function ObservationTitle({ code, form }: { code: string; form?: string }) {
  const { t } = useI18n();
  const info = issueInfo({ code, form });
  return (
    <span className={`observation-title tone-${info.tone}`}>
      <strong title={t('Code in aae audit: {code}', { code })}>{info.title}</strong>
      <ToneChip tone={info.tone} />
    </span>
  );
}

/** What the inspector needs to mark an observation as expected, or undo it, from the app state. */
export type ExpectedActions = {
  /** The observation has a stable key inside an opened project. */
  can: (item: Issue) => boolean;
  /** Title, destination and place, for accessible names. */
  subject: (item: Issue) => string;
  /** Reason of a mark undone in this session. */
  initial: (item: Issue) => string;
  mark: (item: Issue, reason: string) => Promise<void>;
  unmark: (item: Issue) => Promise<void>;
  markOf: (item: Issue) => ExpectedMark | undefined;
};

/** Occurrences shown per group before "Show more". */
const PAGE = 8;
/** Key of the group of observations marked as expected (no code has a newline). */
const EXPECTED = '\nexpected';

/**
 * Observations of the selected item in the inspector: a summary by tone, then one group per type (problems,
 * warnings, informative ones), the type explained once by its meaning, and one line per occurrence in line
 * order (`L7  missing.md`): the line number goes to the line in the text, the rest opens the facts of that
 * occurrence, one at a time. Eight per group, then "Show more". Only the first group opens by itself, and
 * never an informative one; observations marked as expected come last, collapsed. `openId` is the open
 * occurrence (also set from outside, by "View detail"), and `focus` changes each time it should be brought into
 * view. Render it with `key` = the item, so a new selection starts from the defaults.
 */
export function FileObservations({
  items,
  marked,
  hidden,
  onHidden,
  openId,
  onOpen,
  focus,
  diagnoseItem,
  version,
  onSelect,
  onLine,
  expected,
  resolved,
  fresh = 0,
  onRefresh,
}: {
  items: Issue[];
  marked: Issue[];
  hidden: boolean;
  onHidden: (hidden: boolean) => void;
  openId: string;
  onOpen: (id: string) => void;
  focus: number;
  diagnoseItem: (item: Issue) => DiagnosisData;
  version?: string;
  onSelect: (id: string) => void;
  onLine: (item: Issue) => void;
  expected: ExpectedActions;
  /** While the file is edited the list keeps its lines: these ones a save resolved stay, so marked. */
  resolved?: Set<string>;
  /** Observations of a later reading not in the kept list, and the gesture that takes the list again. */
  fresh?: number;
  onRefresh?: () => void;
}) {
  const { t, plural, rich, formatNumber } = useI18n();
  const groups = groupObservations(items);
  if (marked.length) groups.push({ key: EXPECTED, info: issueInfo({ code: '' }), items: marked });
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () =>
      new Set(
        groups[0] && groups[0].info.tone !== 'info' && groups[0].key !== EXPECTED
          ? [groups[0].key]
          : [],
      ),
  );
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [marking, setMarking] = useState('');
  const [scopeFor, setScopeFor] = useState('');
  const root = useRef<HTMLElement>(null);
  /** Keeps the keyboard in the list: focus on a control of one occurrence once React has drawn it. */
  // A few frames: a group that opens for it (the first mark of a file) is drawn one render later.
  const focusIn = (id: string, selector: string, frames = 6) =>
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(
        `[data-observation="${CSS.escape(id)}"] ${selector}`,
      );
      if (target) target.focus();
      else if (frames > 1) focusIn(id, selector, frames - 1);
    });
  // Reasons typed in a form closed by the declaration, kept until it opens again.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // An occurrence opened from outside ("View detail") or just marked as expected: its group opens and shows it.
  useEffect(() => {
    if (!openId) return;
    const group = groups.find((each) => each.items.some((item) => item.id === openId));
    if (!group) return;
    const index = group.items.findIndex((item) => item.id === openId);
    setOpenGroups((previous) => new Set(previous).add(group.key));
    setLimits((previous) => ({
      ...previous,
      [group.key]: Math.max(previous[group.key] ?? PAGE, Math.ceil((index + 1) / PAGE) * PAGE),
    }));
  }, [openId, focus, items.length, marked.length]);
  useEffect(() => {
    if (!focus || !openId) return;
    const frame = requestAnimationFrame(() =>
      root.current
        ?.querySelector(`[data-observation="${CSS.escape(openId)}"]`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focus, openId]);
  if (!items.length && !marked.length) return null;
  const tones = (['problem', 'warning', 'info'] as Tone[])
    .map((tone) => [tone, items.filter((item) => issueInfo(item).tone === tone).length] as const)
    .filter(([, n]) => n);
  const toggleGroup = (key: string) =>
    setOpenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <section className="file-observations" aria-label={t('File observations')} ref={root}>
      <div className="observations-summary">
        {tones.map(([tone, n]) => (
          <span key={tone} className={`observations-count tone-${tone}`}>
            {countTone(tone, n)}
          </span>
        ))}
        {!!marked.length && (
          <span className="observations-count expected">
            {plural(marked.length, '{count} marked as expected', '{count} marked as expected')}
          </span>
        )}
        {fresh > 0 && onRefresh && (
          <button
            className="observations-refresh"
            title={plural(
              fresh,
              '{count} new observation since the editor opened',
              '{count} new observations since the editor opened',
            )}
            onClick={onRefresh}
          >
            {t('refresh list')}
          </button>
        )}
        <button
          className="observations-toggle"
          aria-expanded={!hidden}
          aria-label={hidden ? t('Show file observations') : t('Hide file observations')}
          onClick={() => onHidden(!hidden)}
        >
          {hidden ? t('show') : t('hide')}
        </button>
      </div>
      {!hidden &&
        groups.map((group) => {
          const isExpected = group.key === EXPECTED;
          const open = openGroups.has(group.key);
          const limit = limits[group.key] ?? PAGE;
          const tone = isExpected ? 'info' : group.info.tone;
          const title = isExpected ? t('Marked as expected') : group.info.title;
          return (
            <div
              key={group.key}
              className={`observation-group tone-${tone}${isExpected ? ' expected' : ''}`}
            >
              <button
                className="observation-group-head"
                aria-expanded={open}
                onClick={() => toggleGroup(group.key)}
              >
                {open ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
                {isExpected && <BadgeCheck size={14} aria-hidden="true" />}
                <strong
                  title={
                    isExpected
                      ? undefined
                      : t('Code in aae audit: {code}', { code: group.items[0].code })
                  }
                >
                  {title}
                </strong>
                <span className="observation-group-count">
                  · {formatNumber(group.items.length)}
                </span>
                {!isExpected && (
                  <span className="observation-group-tone">{toneLabel(tone).toLowerCase()}</span>
                )}
              </button>
              {open && (
                <>
                  {!isExpected && (
                    <p className="observation-group-meaning">
                      {groupMeaning(group.info, group.items)}
                    </p>
                  )}
                  <ol>
                    {group.items.slice(0, limit).map((item) => {
                      const detail = openId === item.id;
                      const mark = isExpected ? expected.markOf(item) : undefined;
                      const subject = expected.subject(item);
                      const what = shortText(item);
                      const unsure = inconclusive(item);
                      return (
                        <li
                          key={item.id}
                          className={`file-observation${detail ? ' open' : ''}${isExpected ? ' expected' : ''}`}
                          data-observation={item.id}
                          data-observation-key={observationKey(item)}
                        >
                          <div className="file-observation-row">
                            {item.line ? (
                              <button
                                className="file-observation-line"
                                title={t('Highlight the line in the file')}
                                aria-label={t('Go to line {line}', { line: String(item.line) })}
                                onClick={() => onLine(item)}
                              >
                                L{item.line}
                              </button>
                            ) : (
                              <span className="file-observation-line" aria-hidden="true">
                                —
                              </span>
                            )}
                            <button
                              className="file-observation-open"
                              aria-expanded={detail}
                              aria-label={
                                detail
                                  ? t('Close detail: {subject}', { subject })
                                  : t('View detail: {subject}', { subject })
                              }
                              title={
                                unsure
                                  ? t('{text} · {note}', { text: what, note: inconclusiveNote() })
                                  : what
                              }
                              onClick={() => onOpen(detail ? '' : item.id)}
                            >
                              <span
                                className={
                                  item.target !== undefined
                                    ? 'file-observation-target'
                                    : 'file-observation-text'
                                }
                              >
                                {what}
                              </span>
                              {unsure && (
                                <small className="file-observation-type inconclusive">
                                  {inconclusiveNote()}
                                </small>
                              )}
                              {isExpected && (
                                <small className="file-observation-type">
                                  {issueInfo(item).title}
                                </small>
                              )}
                              {resolved?.has(item.id) ? (
                                <small className="file-observation-resolved">{t('resolved')}</small>
                              ) : detail ? (
                                <ChevronDown size={13} aria-hidden="true" />
                              ) : (
                                <ChevronRight size={13} aria-hidden="true" />
                              )}
                            </button>
                          </div>
                          {detail && (
                            <div className="occurrence-detail">
                              {mark && (
                                <ExpectedNote
                                  mark={mark}
                                  subject={subject}
                                  onUndo={async () => {
                                    await expected.unmark(item);
                                    focusIn(item.id, '.file-observation-open');
                                  }}
                                />
                              )}
                              <Diagnosis
                                diagnosis={diagnoseItem(item)}
                                source={item.node ?? undefined}
                                version={version}
                                onSelect={onSelect}
                                scope={{
                                  open: scopeFor === item.id,
                                  // One form at a time: the declaration closes the mark, and back.
                                  onToggle: () => {
                                    setScopeFor(scopeFor === item.id ? '' : item.id);
                                    setMarking('');
                                  },
                                }}
                                actions={
                                  !isExpected &&
                                  expected.can(item) && (
                                    <ExpectedButton
                                      subject={subject}
                                      open={marking === item.id}
                                      onClick={() => {
                                        setMarking(marking === item.id ? '' : item.id);
                                        setScopeFor('');
                                      }}
                                    />
                                  )
                                }
                              >
                                {!isExpected && marking === item.id && (
                                  <ExpectedForm
                                    subject={subject}
                                    initial={drafts[item.id] ?? expected.initial(item)}
                                    onDraft={(reason) =>
                                      setDrafts({ ...drafts, [item.id]: reason })
                                    }
                                    onCancel={() => {
                                      // Cancelled, the reason is dropped; only the declaration keeps it.
                                      setDrafts(({ [item.id]: _dropped, ...rest }) => rest);
                                      setMarking('');
                                      focusIn(item.id, '.expected-button');
                                    }}
                                    onSubmit={async (reason) => {
                                      await expected.mark(item, reason);
                                      setMarking('');
                                      // The occurrence moves to "Marked as expected", still open.
                                      focusIn(item.id, '.file-observation-open');
                                    }}
                                  />
                                )}
                              </Diagnosis>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                  {group.items.length > limit && (
                    <button
                      className="observation-more"
                      onClick={() => {
                        setLimits({ ...limits, [group.key]: limit + PAGE });
                        // The last page removes the button: the focus goes to the first new line.
                        if (limit + PAGE >= group.items.length)
                          focusIn(group.items[limit].id, '.file-observation-open');
                      }}
                    >
                      {rich('Show {count} more<span> · {left} left</span>', {
                        count: Math.min(PAGE, group.items.length - limit),
                        left: group.items.length - limit,
                        span: (chunks) => <span>{chunks}</span>,
                      })}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
    </section>
  );
}
