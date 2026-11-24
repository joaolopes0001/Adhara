import type { EditLimits, EditSaved, EditText, Model, Stats } from './types';
import { t } from './i18n';
import { serverText } from './serverText';
import type { ServerPhrase } from './serverText';

/**
 * A request the server refused: its HTTP status and, when the server gives one, the stable `code`.
 * The client decides by the code, never by the status (409 means four things) nor by the text. The
 * message is the server's sentence in the interface language (`serverText`).
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let token = '';
let limits: EditLimits | undefined;
let reconnecting: Promise<unknown> | undefined;
const reconnected = new Set<() => void>();

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-AAE-Token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result: { error?: unknown; errorPhrase?: unknown; code?: unknown } | undefined;
  try {
    result = await response.json();
  } catch (error) {
    // An answer that is not JSON (a proxy, a server that died while answering): its status is all there is.
    if (response.ok) throw error;
  }
  if (!response.ok)
    throw new ApiError(
      typeof result?.error === 'string' && result.error
        ? serverText(result.error, result.errorPhrase as ServerPhrase | undefined)
        : t('The operation could not be completed.'),
      response.status,
      typeof result?.code === 'string' ? result.code : undefined,
    );
  return result as T;
}

/**
 * Every call to the server. A refused session (`code: 'session'`: the server restarted and issued a new
 * token) renews it and repeats the request once; then the `onReconnect` listeners are told the server
 * is another process.
 */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  try {
    return await request<T>(path, body);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'session' || path === 'session') throw error;
    reconnecting ??= connect().finally(() => (reconnecting = undefined));
    await reconnecting;
    try {
      return await request<T>(path, body);
    } finally {
      for (const listener of reconnected) listener();
    }
  }
}
export function onReconnect(listener: () => void) {
  reconnected.add(listener);
  return () => void reconnected.delete(listener);
}
export async function connect() {
  const session = await api<{
    token: string;
    home: string;
    defaultParent: string;
    edit?: EditLimits;
  }>('session');
  token = session.token;
  limits = session.edit;
  return session;
}
export const editLimits = () => limits;

export async function editEnable(root: string) {
  return (await api<{ editing: Model['editing'] }>('edit/enable', { root })).editing;
}
export async function editDisable(root: string) {
  return (await api<{ editing: Model['editing'] }>('edit/disable', { root })).editing;
}
export const editRead = (path: string) => api<EditText>('edit/read', { path });
/** Saves `text` if the bytes on disk still hash to `baseSha256`. */
export const editSave = (path: string, baseSha256: string, text: string) =>
  api<EditSaved>('edit/save', { path, baseSha256, text });

type ModelInput = Partial<Omit<Model, 'stats' | 'scope'>> & {
  stats?: Partial<Stats>;
  scope?: Partial<Model['scope']> | null;
};
/** Single entry point of the model into the UI: a partial model gets the neutral value of each missing block. */
function normalizeModel(raw: ModelInput): Model {
  const stats = raw.stats ?? {};
  const reachability = stats.reachability
    ? { ...stats.reachability, starts: stats.reachability.starts ?? [] }
    : null;
  return {
    ...raw,
    roots: raw.roots ?? [],
    savedCases: raw.savedCases ?? [],
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
    objects: raw.objects ?? [],
    issues: raw.issues ?? [],
    signals: raw.signals ?? [],
    notes: raw.notes ?? {},
    expected: raw.expected ?? {},
    editing: raw.editing ?? {},
    restoreErrors: raw.restoreErrors ?? [],
    delta: raw.delta
      ? {
          ...raw.delta,
          warnings: raw.delta.warnings ?? [],
          roots: (raw.delta.roots ?? []).map((root) => ({
            ...root,
            referenceSaved: root.referenceSaved ?? false,
          })),
        }
      : null,
    scope: { source: raw.scope?.source ?? null, patterns: raw.scope?.patterns ?? [] },
    stats: {
      files: stats.files ?? 0,
      unresolvedTargets: stats.unresolvedTargets,
      parsed: stats.parsed ?? 0,
      edges: stats.edges ?? 0,
      entries: stats.entries ?? 0,
      resolution: {
        file: 0,
        skill: 0,
        root: 0,
        basename: 0,
        suffix: 0,
        'skill-basename': 0,
        'skill-suffix': 0,
        'frontmatter-name': 0,
        'root-dot': 0,
        unresolved: 0,
        ...stats.resolution,
      },
      inventory: {
        complete: true,
        lookupComplete: true,
        omitted: 0,
        omittedFiles: 0,
        byTopLevel: [],
        ...stats.inventory,
      },
      ignored: stats.ignored ?? {},
      probe: stats.probe ?? null,
      relations: stats.relations ?? { complete: true, omitted: 0, max: 0 },
      headers: stats.headers,
      structure: {
        cycles: 0,
        selfReferences: 0,
        repeatedReferences: 0,
        highFanout: 0,
        fanoutThreshold: 0,
        maxFanout: null,
        ...stats.structure,
      },
      reachability,
    },
    policy: raw.policy ?? {
      excluded: [],
      maxNodes: 0,
      maxFileBytes: 0,
      maxTextBytes: 0,
      ai: false,
    },
  };
}
export async function loadModel(path: string, body?: unknown): Promise<Model> {
  return normalizeModel(await api<ModelInput>(path, body));
}
export async function setExpected(root: string, key: string, expected: boolean, reason = '') {
  return (await api<{ expected: Model['expected'] }>('expected', { root, key, expected, reason }))
    .expected;
}
