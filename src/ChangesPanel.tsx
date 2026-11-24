import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, FileText, GitBranch, History, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Delta, DeltaFile, DeltaFinding, DeltaRelation, DeltaRoot, Model } from './types';
import { relations as relationKinds, statuses, unresolvedLabels } from './types';
import {
  codeInfo,
  codeTitle,
  inconclusive,
  inconclusiveNote,
  joinList,
  nodeIndex,
  shortText,
  toneLabel,
} from './observations';
import { findingMark, markedAt } from './expected';
import { formatDate, plural, t, useI18n } from './i18n';
import { messageText, serverText } from './serverText';

/** Label of a value read from the delta: own keys only, so "__proto__" or "constructor" never reach the page as objects. */
const labelOf = (labels: Record<string, string>, key: string | null | undefined) =>
  typeof key === 'string' && Object.hasOwn(labels, key) ? labels[key] : undefined;

/** The moment of a scan in the local time of this computer, in the interface language ("02/10 14:03"). */
const readingTime = (at: string) => formatDate(at, 'day-time');

/** Items listed by the tool: files, relations and findings that differ from the reference. */
export function deltaCount(delta: Delta | null | undefined) {
  if (!delta) return 0;
  const { files, relations, findings } = delta;
  return (
    files.totals.added +
    files.totals.removed +
    files.totals.changed +
    relations.totals.added +
    relations.totals.removed +
    findings.totals.new +
    findings.totals.resolved
  );
}

/**
 * Files, relations and findings in one reading only, whose file the other reading did not inventory: one sentence,
 * never a list, and outside the count of the dock.
 */
export function describeUncompared(delta: Delta) {
  const { files, relations, findings } = delta;
  const others = joinList(
    [
      relations.uncompared && plural(relations.uncompared, '{count} relation', '{count} relations'),
      findings.uncompared &&
        plural(findings.uncompared, '{count} observation', '{count} observations'),
    ].filter(Boolean) as string[],
  );
  const total = relations.uncompared + findings.uncompared;
  const what = files.uncompared
    ? others
      ? plural(
          files.uncompared,
          '{count} file not compared, with {others}',
          '{count} files not compared, with {others}',
          { others },
        )
      : plural(files.uncompared, '{count} file not compared', '{count} files not compared')
    : total
      ? plural(total, '{others} not compared', '{others} not compared', { others })
      : '';
  const one = files.uncompared ? files.uncompared === 1 : total === 1;
  // A reading with more findings than the server keeps (`findings-truncated`) leaves findings uncompared too.
  const cap = findings.context.some((item) => item.code === 'findings-truncated');
  return what
    ? cap
      ? plural(
          one ? 1 : 2,
          '{what}: was left out of the inventory or the observation cap of one of the scans.',
          '{what}: were left out of the inventory or the observation cap of one of the scans.',
          { what },
        )
      : plural(
          one ? 1 : 2,
          '{what}: was left out of the inventory of one of the scans.',
          '{what}: were left out of the inventory of one of the scans.',
          { what },
        )
    : '';
}

/** Codes of the warnings that say why relations and observations of a project were not compared. */
const CONTEXT_CODES = new Set(['reference-context-changed', 'reference-context-unknown']);

/** Projects whose relations and observations were not compared: the baseline was read in other conditions. */
export function notCompared(delta: Delta) {
  return delta.roots.filter((root) => root.context === 'changed' || root.context === 'unknown');
}

/**
 * Why relations and observations were not compared, one sentence per reason, naming the projects when several are
 * open. Empty when every project was compared.
 */
export function describeContext(delta: Delta) {
  const multi = delta.roots.length > 1;
  const names = (context: string) =>
    joinList(delta.roots.filter((root) => root.context === context).map((root) => root.name));
  const sentences: string[] = [];
  if (delta.roots.some((root) => root.context === 'changed'))
    sentences.push(
      multi
        ? t(
            'Relations and observations of {projects} not compared: the open projects, or their order, changed since the baseline.',
            { projects: names('changed') },
          )
        : t(
            'Relations and observations not compared: the open projects, or their order, changed since the baseline.',
          ),
    );
  if (delta.roots.some((root) => root.context === 'unknown'))
    sentences.push(
      multi
        ? t(
            'Relations and observations of {projects} not compared: the baseline does not record which projects were open.',
            { projects: names('unknown') },
          )
        : t(
            'Relations and observations not compared: the baseline does not record which projects were open.',
          ),
    );
  return sentences;
}

/** Relations and findings of a file analysed in one of the scans only: one sentence, outside the count of the dock. */
export function describeUnanalysed(delta: Delta) {
  const { relations, findings } = delta;
  const total = relations.unanalysed + findings.unanalysed;
  if (!total) return '';
  const others = joinList(
    [
      relations.unanalysed && plural(relations.unanalysed, '{count} relation', '{count} relations'),
      findings.unanalysed &&
        plural(findings.unanalysed, '{count} observation', '{count} observations'),
    ].filter(Boolean) as string[],
  );
  return plural(
    total,
    '{others} not compared: its file was analysed in only one of the scans.',
    '{others} not compared: their files were analysed in only one of the scans.',
    { others },
  );
}

/** Short wording shared by the dock and the notice shown right after a reading. */
export function describeDelta(delta: Delta) {
  const { files, relations, findings } = delta;
  return [
    relations.totals.added &&
      plural(relations.totals.added, '{count} relation added', '{count} relations added'),
    relations.totals.removed &&
      plural(relations.totals.removed, '{count} relation removed', '{count} relations removed'),
    files.totals.changed &&
      plural(files.totals.changed, '{count} file changed', '{count} files changed'),
    files.totals.added && plural(files.totals.added, '{count} file added', '{count} files added'),
    files.totals.removed &&
      plural(files.totals.removed, '{count} file removed', '{count} files removed'),
    findings.totals.new &&
      plural(findings.totals.new, '{count} new observation', '{count} new observations'),
    findings.totals.resolved &&
      plural(
        findings.totals.resolved,
        '{count} resolved observation',
        '{count} resolved observations',
      ),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Where the reference of one root came from: loaded from the app state, or set in this server session. */
function originLabel(root: DeltaRoot) {
  const origin =
    root.referenceOrigin === 'persisted'
      ? t('saved on disk')
      : root.referenceOrigin === 'user'
        ? t('set by you in this session')
        : t('first scan of this session');
  return root.referenceSaved || root.referenceOrigin === 'persisted'
    ? origin
    : t('{origin}, not saved', { origin });
}

/** The name of the scope source a compare-audit note speaks of; undefined for a source this tool does not know. */
function sourceName(source: string) {
  return source === 'manifest'
    ? 'agent-architecture.json'
    : source === 'flag'
      ? t('--scope option')
      : undefined;
}
/** compare-audit notes about the comparison itself, worded for the two readings of this tool. */
function contextMessage(item: Delta['findings']['context'][number]) {
  if (item.code === 'audit-context-differs' && item.scopeSource) {
    const name = (source: string | null) => (source ? (sourceName(source) ?? source) : t('none'));
    return t(
      'The declared scope changed between scans (source in the baseline: {before}; in the current scan: {after}): some of the new or resolved observations may come from the scope declaration, not from changes in the documents.',
      { before: name(item.scopeSource.before), after: name(item.scopeSource.after) },
    );
  }
  return messageText(item);
}

function Tag({
  kind,
  finding,
  expected,
  children,
}: {
  kind: 'added' | 'removed' | 'changed';
  finding?: boolean;
  /** A new observation marked as expected: neutral, never the warm tone of a new one. */
  expected?: boolean;
  children: string;
}) {
  return (
    <span
      className={`change-tag ${kind}${finding ? ' finding' : ''}${expected ? ' expected' : ''}`}
    >
      {children}
    </span>
  );
}

function Row({
  available,
  kind,
  title,
  onOpen,
  children,
}: {
  available: boolean;
  kind: string;
  title?: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return available ? (
    <button className={`change-row ${kind}`} title={title} onClick={onOpen}>
      {children}
      <ChevronRight size={13} />
    </button>
  ) : (
    <div className={`change-row ${kind}`} title={title}>
      {children}
    </div>
  );
}

function More({ shown, total, limit }: { shown: number; total: number; limit: number }) {
  const { t } = useI18n();
  return total > shown ? (
    <p className="changes-more">
      {t(
        'Showing {shown} of {total}. Each list keeps up to {limit} items; the totals count all of them.',
        { shown, total, limit },
      )}
    </p>
  ) : null;
}

/**
 * "Changes" tool: what differs between the reference scan of each opened root and the current one.
 * A scan is what the server read from disk; the tool never says who changed a file or why.
 * The app never rescans by itself: "Rescan now" does what the Rescan button at the top does.
 */
export default function ChangesPanel({
  model,
  busy,
  onAdopt,
  onReread,
  onOpenFile,
  onOpenEdge,
}: {
  model: Model;
  busy: boolean;
  onAdopt: () => Promise<boolean>;
  onReread: () => void;
  /** Opens a file, at a line when there is one; `target`: the destination written there, to mark. */
  onOpenFile: (path: string, line?: number, target?: string) => void;
  onOpenEdge: (edge: string) => void;
}) {
  const { t, plural, rich } = useI18n();
  const delta = model.delta;
  // The time of the baseline just adopted; the sentence is written when drawn.
  const [confirmation, setConfirmation] = useState('');
  const nodes = nodeIndex(model);
  if (!delta)
    return (
      <div className="panel-empty">
        <History size={22} />
        <span>{t('No open project.')}</span>
      </div>
    );
  const multi = delta.roots.length > 1;
  const rootOf = (path: string) =>
    [...delta.roots]
      .sort((a, b) => b.path.length - a.path.length)
      .find((root) => path === root.path || path.startsWith(root.path + '/'));
  // Relative to its opened root, prefixed with the root name when several roots are compared.
  const display = (path: string) => {
    const root = rootOf(path);
    if (!root) return path;
    const relative = path === root.path ? '.' : path.slice(root.path.length + 1);
    return multi ? `${root.name}/${relative}` : relative;
  };
  const exists = (path: string) => nodes.get(path)?.status === 'resolved';
  const total = deltaCount(delta);
  // Reading times have one-second resolution: a reading with differences is never the reference itself.
  // A project not compared is never "the baseline is the current scan": updating it is the way out.
  const fresh =
    total === 0 &&
    !notCompared(delta).length &&
    !delta.relations.unanalysed &&
    !delta.findings.unanalysed &&
    delta.roots.every((root) => root.referenceAt === delta.current.at);
  const { files, relations, findings } = delta;
  // New observations marked as expected are counted apart from the new ones that ask for attention.
  const expectedNew = findings.new.filter((item) => findingMark(model, item)).length;
  // "saved on disk": loaded from the app state; "of this session": set by this server, saved unless a warning says otherwise.
  const persisted = delta.roots.filter((root) => root.referenceOrigin === 'persisted').length;
  const unsaved = delta.roots.filter((root) => !root.referenceSaved).length;
  const source =
    persisted === delta.roots.length
      ? t('saved on disk')
      : persisted
        ? t('saved on disk and of this session')
        : t('of this session');
  const sourceTitle =
    persisted === delta.roots.length
      ? t('Loaded from the app state: set before the server restarted.')
      : persisted
        ? t(
            'Some projects have a baseline loaded from the app state and others one set in this session; the origin of each is below.',
          )
        : unsaved
          ? t('Set in this server session.')
          : t(
              'Set in this server session and saved in the app state: it stays valid after a restart.',
            );
  const nameOf = (path: string) => delta.roots.find((root) => root.path === path)?.name ?? path;
  const partialRoots = [
    ...new Set(
      findings.context
        .filter((item) => item.code === 'comparison-incomplete')
        .map((item) => nameOf(item.root)),
    ),
  ];
  const otherContext = findings.context.filter((item) => item.code !== 'comparison-incomplete');
  const uncompared = describeUncompared(delta);
  const unanalysed = describeUnanalysed(delta);
  // Projects whose relations and observations were not compared (baseline read with other open projects).
  const skipped = notCompared(delta);
  const allSkipped = skipped.length === delta.roots.length;
  const skippedNote = skipped.length
    ? multi && !allSkipped
      ? t('not compared in {projects}', { projects: joinList(skipped.map((root) => root.name)) })
      : t('not compared')
    : '';
  async function adopt() {
    const at = delta!.current.at;
    if (await onAdopt()) setConfirmation(at);
  }
  function fileRow(item: DeltaFile, kind: 'added' | 'removed' | 'changed') {
    const sizes = { before: String(item.before ?? '?'), after: String(item.after ?? '?') };
    const detail =
      kind === 'changed'
        ? item.basis === 'sha256'
          ? t('content (SHA-256) · {before} → {after} bytes', sizes)
          : t('size · {before} → {after} bytes', sizes)
        : item.bytes != null
          ? t('{bytes} bytes', { bytes: String(item.bytes) })
          : '';
    const available = kind !== 'removed' && exists(item.path);
    return (
      <Row
        key={`${kind}${item.path}`}
        kind={kind}
        title={item.path}
        available={available}
        onOpen={() => onOpenFile(item.path)}
      >
        <Tag kind={kind}>
          {kind === 'added'
            ? t('added', { context: 'file' })
            : kind === 'removed'
              ? t('removed', { context: 'file' })
              : t('changed')}
        </Tag>
        <span>
          <b>{display(item.path)}</b>
          {detail && (
            <small>
              {kind === 'removed' ? t('{detail} in the baseline scan', { detail }) : detail}
            </small>
          )}
        </span>
      </Row>
    );
  }
  function target(item: DeltaRelation) {
    const status =
      item.targetStatus && item.targetStatus !== 'resolved'
        ? ` (${labelOf(unresolvedLabels, item.targetStatus) || labelOf(statuses, item.targetStatus) || item.targetStatus})`
        : '';
    return (
      <>
        {display(item.target)}
        {status}
      </>
    );
  }
  function relationRow(item: DeltaRelation, kind: 'added' | 'removed') {
    const available =
      kind === 'added'
        ? !!item.edge && model.edges.some((edge) => edge.id === item.edge)
        : exists(item.origin);
    return (
      <Row
        key={`${kind}${item.origin}:${item.line}:${item.target}:${item.raw}`}
        kind={kind}
        title={`${item.origin}:${item.line}`}
        available={available}
        onOpen={() =>
          kind === 'added' && item.edge ? onOpenEdge(item.edge) : onOpenFile(item.origin)
        }
      >
        <Tag kind={kind}>
          {kind === 'added'
            ? t('added', { context: 'relation' })
            : t('removed', { context: 'relation' })}
        </Tag>
        <span>
          <b>
            {display(item.origin)}:{item.line}
          </b>{' '}
          → {target(item)}
          <small>
            {kind === 'removed'
              ? `${t('was at line {line} in the baseline scan', { line: String(item.line) })} · `
              : ''}
            {labelOf(relationKinds, item.kind) || item.kind}
            {/* The written destination only when the evidence does not show it and it differs from the one shown. */}
            {!(kind === 'added' && item.evidence) && item.raw !== display(item.target) && (
              <>
                {' '}
                {rich('· written target <code>{raw}</code>', {
                  raw: item.raw,
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </>
            )}
            {kind === 'added' && item.evidence ? (
              <>
                {' '}
                · <code className="change-evidence">{item.evidence}</code>
              </>
            ) : (
              ''
            )}
          </small>
        </span>
      </Row>
    );
  }
  /**
   * The short line of the Audit for a finding (the destination as written, or the fact of the case), from
   * the observation of the current reading when there is one; a resolved one keeps only what it carries.
   */
  function findingText(item: DeltaFinding) {
    const issue = model.issues.find((each) => each.id === item.id);
    // A finding carries the facts of its observation (class and inbound of an `unreachable`, the phrase of its message).
    return shortText(issue ?? item, model);
  }
  function findingRow(item: DeltaFinding, kind: 'added' | 'removed') {
    // Resolved observations stay as they are; a new one may be marked as expected (by its stable key).
    const mark = kind === 'added' ? findingMark(model, item) : undefined;
    const available =
      !!item.node &&
      nodes.has(item.node) &&
      (kind === 'added' ||
        nodes.get(item.node)?.status === 'resolved' ||
        nodes.get(item.node)?.kind === 'directory');
    const where = item.node
      ? `${display(item.node)}${item.line ? `:${item.line}` : ''}`
      : t('no file');
    return (
      <Row
        key={`${kind}${item.id}`}
        kind={kind}
        title={item.node || undefined}
        available={available}
        onOpen={() =>
          item.node &&
          (kind === 'added' ? onOpenFile(item.node, item.line, item.target) : onOpenFile(item.node))
        }
      >
        <Tag kind={kind} finding expected={!!mark}>
          {mark ? t('expected') : kind === 'added' ? t('new') : t('resolved')}
        </Tag>
        <span>
          {findingText(item)}
          {/* The reader's caveat, as in the Audit: from the observation, or its message once resolved. */}
          {(() => {
            const issue = model.issues.find((each) => each.id === item.id);
            // A resolved observation keeps the `conclusive` its scan gave it.
            return inconclusive(issue ?? item) ? (
              <em className="change-inconclusive"> · {inconclusiveNote()}</em>
            ) : null;
          })()}
          <small>
            {kind === 'removed' ? t('was at {where} in the baseline scan', { where }) : where} ·{' '}
            {mark && (
              <>
                {mark.reason
                  ? t('new since the baseline, marked as expected on {date}: {reason}', {
                      date: markedAt(mark.at),
                      reason: mark.reason,
                    })
                  : t('new since the baseline, marked as expected on {date}', {
                      date: markedAt(mark.at),
                    })}{' '}
                ·{' '}
              </>
            )}
            <span
              className="change-code"
              title={t('{tone} · code in aae audit: {code}', {
                tone: toneLabel(codeInfo(item.code).tone),
                code: item.code,
              })}
            >
              {codeTitle(item.code) || t('Observation')}
            </span>
          </small>
        </span>
      </Row>
    );
  }
  // Nothing listed, and nothing left out of the comparison for another reason than the inventory: "No changes."
  const empty = total === 0 && !skipped.length && !relations.unanalysed && !findings.unanalysed;
  return (
    <div className="changes-content">
      <div className="changes-summary">
        <span className="changes-times">
          <History size={13} />
          <span>
            {rich(
              delta.reference.uniform
                ? '<strong>Baseline:</strong> scan from {time}'
                : '<strong>Baseline:</strong> scan from {time} (the oldest)',
              {
                time: readingTime(delta.reference.at),
                strong: (chunks) => <strong>{chunks}</strong>,
              },
            )}
            <span className="changes-origin" title={sourceTitle}>
              {source}
            </span>
            {unsaved > 0 && (
              <span
                className="changes-origin unsaved"
                title={t(
                  'It was not saved in the app state: valid only until the server restarts.',
                )}
              >
                {t('not saved')}
              </span>
            )}
          </span>
          <span>
            {rich('<strong>Current scan:</strong> {time}', {
              time: readingTime(delta.current.at),
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </span>
        </span>
        <span className="changes-actions">
          <button className="changes-reread" disabled={busy} onClick={onReread}>
            <RefreshCw className={busy ? 'spin' : ''} size={12} />
            {t('Rescan now')}
          </button>
          <button
            className="changes-adopt"
            disabled={busy || (fresh && !unsaved)}
            title={
              fresh && unsaved
                ? t('Try saving the baseline again, which is the current scan')
                : fresh
                  ? t('The baseline is already the current scan')
                  : t(
                      'Future rescans will be compared with the current scan, which is saved in the app state',
                    )
            }
            onClick={() => void adopt()}
          >
            {t('Update baseline')}
          </button>
        </span>
      </div>
      {confirmation && (
        <p className="changes-confirmation" role="status">
          {t('Baseline updated: scan from {time}.', { time: readingTime(confirmation) })}
        </p>
      )}
      {(multi || !delta.reference.uniform) && (
        <p className="audit-note changes-roots">
          {delta.roots
            .map((root) =>
              t('{name}: baseline from {time} ({origin})', {
                name: root.name,
                time: readingTime(root.referenceAt),
                origin: originLabel(root),
              }),
            )
            .join(' · ')}
        </p>
      )}
      {describeContext(delta).map((sentence) => (
        <p key={sentence} className="audit-note changes-warning changes-context" role="alert">
          <span>{sentence}</span>
        </p>
      ))}
      {delta.warnings
        .filter((item) => !CONTEXT_CODES.has(item.code))
        .map((item) => (
          <p
            key={`${item.root}${item.code}${item.message}`}
            className="audit-note changes-warning"
            role="alert"
          >
            <span>
              {/* A warning about several projects says how many; one about one project is named after it. */}
              {multi && (item.roots?.length ?? 1) === 1
                ? t('{name}: {message}', { name: nameOf(item.root), message: messageText(item) })
                : messageText(item)}
            </span>
          </p>
        ))}
      <details className="changes-about">
        <summary>{t('About the baseline')}</summary>
        <p>
          {t(
            'Compares the baseline scan with the latest scan of the disk; it does not say who changed anything or why.',
          )}
        </p>
        <p>
          {t(
            'The first scan of each project is the baseline, which only advances through “Update baseline”. It is saved in the app state, outside the open folders and without the document text (it keeps paths, hashes, targets as written and observations), and stays valid after the server restarts; forgetting the project deletes it.',
          )}
        </p>
        <p>
          {rich(
            'An observation is the same in both scans when the code, the file and the written target match, without the line number: the same identity as <code>aae compare-audit</code>.',
            { code: (chunks) => <code>{chunks}</code> },
          )}
        </p>
      </details>
      {findings.error && (
        <p className="audit-note changes-warning" role="alert">
          <span>{serverText(findings.error, findings.errorPhrase)}</span>
        </p>
      )}
      {/* A partial comparison is said once, naming the projects it applies to. */}
      {partialRoots.length > 0 && (
        <p className="audit-note changes-warning changes-partial">
          <span>
            {multi
              ? t('Partial scan in {projects}: a missing observation does not prove resolution.', {
                  projects: joinList(partialRoots),
                })
              : t('Partial scan: a missing observation does not prove resolution.')}
          </span>
        </p>
      )}
      {uncompared && (
        <p className="audit-note changes-warning changes-uncompared">
          <span>{uncompared}</span>
        </p>
      )}
      {unanalysed && (
        <p className="audit-note changes-warning changes-unanalysed">
          <span>{unanalysed}</span>
        </p>
      )}
      {otherContext.map((item) => (
        <p key={`${item.root}${item.code}`} className="audit-note changes-warning">
          <span>
            {multi
              ? t('{name}: {message}', { name: nameOf(item.root), message: contextMessage(item) })
              : contextMessage(item)}
          </span>
        </p>
      ))}
      {empty ? (
        <div className="panel-empty changes-empty">
          <span>{t('No changes.')}</span>
        </div>
      ) : (
        <>
          <section className="changes-section" aria-label={t('Files')}>
            <h3>
              <FileText size={13} />
              {t('Files')}
              <span>
                {[
                  files.totals.changed &&
                    plural(files.totals.changed, '{count} changed', '{count} changed'),
                  files.totals.added &&
                    plural(files.totals.added, '{count} added', '{count} added', {
                      context: 'file',
                    }),
                  files.totals.removed &&
                    plural(files.totals.removed, '{count} removed', '{count} removed', {
                      context: 'file',
                    }),
                ]
                  .filter(Boolean)
                  .join(' · ') || t('no changes')}
              </span>
            </h3>
            {files.changed.map((item) => fileRow(item, 'changed'))}
            <More shown={files.changed.length} total={files.totals.changed} limit={delta.limit} />
            {files.added.map((item) => fileRow(item, 'added'))}
            <More shown={files.added.length} total={files.totals.added} limit={delta.limit} />
            {files.removed.map((item) => fileRow(item, 'removed'))}
            <More shown={files.removed.length} total={files.totals.removed} limit={delta.limit} />
            {files.unverified > 0 && (
              <p className="changes-more">
                {plural(
                  files.unverified,
                  '{count} file without a comparable hash or size.',
                  '{count} files without a comparable hash or size.',
                )}
              </p>
            )}
          </section>
          <section className="changes-section" aria-label={t('Relations')}>
            <h3>
              <GitBranch size={13} />
              {t('Relations')}
              <span>
                {allSkipped ? (
                  skippedNote
                ) : (
                  <>
                    {plural(relations.totals.added, '{count} added', '{count} added', {
                      context: 'relation',
                    })}{' '}
                    ·{' '}
                    {plural(relations.totals.removed, '{count} removed', '{count} removed', {
                      context: 'relation',
                    })}
                    {skippedNote && ` · ${skippedNote}`}
                  </>
                )}
              </span>
            </h3>
            {relations.added.map((item) => relationRow(item, 'added'))}
            <More
              shown={relations.added.length}
              total={relations.totals.added}
              limit={delta.limit}
            />
            {relations.removed.map((item) => relationRow(item, 'removed'))}
            <More
              shown={relations.removed.length}
              total={relations.totals.removed}
              limit={delta.limit}
            />
            {!relations.totals.added &&
              !relations.totals.removed &&
              !skipped.length &&
              !relations.unanalysed &&
              !relations.uncompared && (
                <p className="changes-more">
                  {t(
                    'No explicit relation added or removed. Changing only the line of a reference does not count as a change.',
                  )}
                </p>
              )}
          </section>
          <section className="changes-section" aria-label={t('Observations')}>
            <h3>
              <ShieldCheck size={13} />
              {t('Observations')}
              <span>
                {allSkipped ? (
                  skippedNote
                ) : (
                  <>
                    {plural(findings.totals.new - expectedNew, '{count} new', '{count} new')}
                    {expectedNew
                      ? ` · ${plural(expectedNew, '{count} expected', '{count} expected')}`
                      : ''}{' '}
                    · {plural(findings.totals.resolved, '{count} resolved', '{count} resolved')} ·{' '}
                    {t('{count} unchanged', { count: findings.persisting })}
                    {skippedNote && ` · ${skippedNote}`}
                  </>
                )}
              </span>
            </h3>
            {findings.new.map((item) => findingRow(item, 'added'))}
            <More shown={findings.new.length} total={findings.totals.new} limit={delta.limit} />
            {findings.resolved.map((item) => findingRow(item, 'removed'))}
            <More
              shown={findings.resolved.length}
              total={findings.totals.resolved}
              limit={delta.limit}
            />
          </section>
        </>
      )}
    </div>
  );
}
