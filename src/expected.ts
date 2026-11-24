import type { DeltaFinding, ExpectedMark, Issue, Model, Root, Signal } from './types';
import { nodeIndex, projectOf } from './observations';
import { formatDate } from './i18n';

/**
 * Observations marked as expected (a false positive or something intentional). The mark lives in the app
 * state, per project, under the stable `key` the API gives each observation; the reading, the audit and
 * the CLI keep reporting everything. Here a marked item only leaves what the interface counts as active.
 */
export type Orphan = { root: Root; key: string; mark: ExpectedMark };
export type ExpectedSplit = {
  /** What the interface counts and marks: observations and signals not marked as expected. */
  issues: Issue[];
  signals: Signal[];
  expectedIssues: Issue[];
  expectedSignals: Signal[];
  /** Marks whose observation is not in this reading: kept until removed. */
  orphans: Orphan[];
  /** Number of marks of the opened projects, orphans included. */
  total: number;
};
/** Codes of structural signals: their orphan marks are listed with the signals. */
export const signalCodes = new Set(['cycle', 'repeated-reference', 'high-fanout']);

/** The mark of an observation or signal, if its project keeps one under its key. */
export function markOf(model: Model, item: Issue | Signal): ExpectedMark | undefined {
  if (!item.key) return undefined;
  const root = projectOf(model.roots, item.node);
  return root ? model.expected[root.path]?.[item.key] : undefined;
}

// One split per reading and set of marks: many components ask for it on every render.
const splits = new WeakMap<
  Model['expected'],
  { issues: Issue[]; signals: Signal[]; split: ExpectedSplit }
>();
export function splitExpected(model: Model): ExpectedSplit {
  const cached = splits.get(model.expected);
  if (cached && cached.issues === model.issues && cached.signals === model.signals)
    return cached.split;
  const split: ExpectedSplit = {
    issues: [],
    signals: [],
    expectedIssues: [],
    expectedSignals: [],
    orphans: [],
    total: 0,
  };
  const current = new Map<string, Set<string>>();
  for (const [list, active, expected] of [
    [model.issues, split.issues, split.expectedIssues],
    [model.signals, split.signals, split.expectedSignals],
  ] as [(Issue | Signal)[], (Issue | Signal)[], (Issue | Signal)[]][])
    for (const item of list) {
      const root = item.key ? projectOf(model.roots, item.node) : undefined;
      if (root && item.key) {
        const keys = current.get(root.path) ?? new Set<string>();
        keys.add(item.key);
        current.set(root.path, keys);
      }
      (root && model.expected[root.path]?.[item.key!] ? expected : active).push(item);
    }
  for (const root of model.roots)
    for (const [key, mark] of Object.entries(model.expected[root.path] ?? {})) {
      split.total++;
      if (!current.get(root.path)?.has(key)) split.orphans.push({ root, key, mark });
    }
  splits.set(model.expected, { issues: model.issues, signals: model.signals, split });
  return split;
}

/**
 * Missing destinations whose every reference observation is marked as expected: the footer keeps them out
 * of the unresolved destinations it counts (a destination cited by one active reference stays counted).
 */
export function settledDestinations(model: Model) {
  const nodes = nodeIndex(model);
  const references = new Map<string, Issue>();
  for (const item of model.issues)
    if ((item.code === 'broken' || item.code === 'unresolved-name') && item.node)
      references.set(`${item.node}\n${item.line}\n${item.target}`, item);
  const settled = new Map<string, boolean>();
  for (const edge of model.edges) {
    const target = nodes.get(edge.target);
    if (target?.kind !== 'unresolved' || target.status !== 'missing') continue;
    const issue = references.get(`${edge.origin}\n${edge.line}\n${edge.raw}`);
    settled.set(
      edge.target,
      (settled.get(edge.target) ?? true) && !!issue && !!markOf(model, issue),
    );
  }
  return new Set([...settled].filter(([, all]) => all).map(([id]) => id));
}

// Current observations by code, file, line and destination: the fields a finding of "Changes" keeps.
const findingIndexes = new WeakMap<Issue[], Map<string, Issue>>();
const findingKey = (
  code: string,
  node: string | null,
  line?: number | null,
  target?: string | null,
) => `${code}\n${node}\n${line ?? ''}\n${target ?? ''}`;
/** The mark of a new observation of "Changes": the current observation with the same code, file, line and destination. */
export function findingMark(model: Model, finding: DeltaFinding) {
  if (!finding.node) return undefined;
  let index = findingIndexes.get(model.issues);
  if (!index) {
    index = new Map();
    for (const item of model.issues) {
      const key = findingKey(item.code, item.node, item.line, item.target);
      if (!index.has(key)) index.set(key, item);
    }
    findingIndexes.set(model.issues, index);
  }
  const issue = index.get(findingKey(finding.code, finding.node, finding.line, finding.target));
  return issue ? markOf(model, issue) : undefined;
}

// Reasons of the marks undone in this session, to fill the form if the person marks again.
const undone = new Map<string, string>();
export const rememberReason = (root: string, key: string, reason: string) =>
  undone.set(`${root}\n${key}`, reason);
export const rememberedReason = (root: string, key: string) => undone.get(`${root}\n${key}`) ?? '';

/** The day of a mark in the local time of this computer, in the interface language ("07/11/2026"). */
export const markedAt = (at: string) => formatDate(at, 'date');
