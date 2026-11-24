/**
 * Editing documents from the inspector. `App.tsx` only places these pieces; the pure rules are in
 * `editing.ts`; the behavior is in `docs/guia-de-uso.md`, section "Editar documentos".
 *
 * Everything shown from a file is text: no HTML of a document is ever parsed.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { Copy, FileText, RefreshCw, Save, Scale, Undo2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { editDisable, editEnable, editLimits, editRead, editSave, loadModel } from './api';
import {
  compareObservations,
  diffLines,
  markRows,
  editableCount,
  flowOf,
  hunks,
  lineColumn,
  notEditable,
  observationKey,
  ownerRoot,
  placeAt,
  previousText,
  settleUnknown,
  shouldReread,
} from './editing';
import type { Diff, Known, MarkRow, ObservationChange } from './editing';
import { splitExpected } from './expected';
import { useI18n } from './i18n';
import { issueInfo, projectPath } from './observations';
import type { Tone } from './observations';
import type { EditText, FileNode, Issue, Model } from './types';
import { Modal } from './Dialogs';
import './editor.css';

/** What the state line of the editor says after a save, an undo or a failed attempt. */
export type Outcome =
  | {
      kind: 'saved';
      /** Undone: the previous text was written back. Checked: the answer was lost and a new read found the text. */
      undone: boolean;
      checked: boolean;
      durable: boolean;
      before: string;
      after: string;
      added: number;
      removed: number;
      /** The reading after the save: on its way, not done because the last one was slow, or done. */
      reading:
        | 'pending'
        | 'stale'
        | { change: ObservationChange; node: 'same' | 'changed' | 'unverified' | 'gone' };
    }
  | { kind: 'unchanged'; durable: boolean }
  | { kind: 'not-saved' }
  | { kind: 'no-answer'; intended: string; mode: Mode }
  | { kind: 'missing' }
  /** `gone`: the snapshot says the folder of the project is no longer at its path. */
  | { kind: 'not-granted'; refused: Refused; gone: boolean }
  | { kind: 'metadata' }
  | { kind: 'message'; refused: Refused }
  /** The user's text, discarded in a conflict for the version on disk; Undo gives it back. */
  | { kind: 'discarded'; text: string };
type Mode = 'save' | 'undo';
/**
 * A refusal of the server: the route, the stable `code` and the server's text. The screen words each known
 * code itself and shows the server's text only for an unknown code; the server's text stays in the tooltip.
 */
export type Refused = { op: 'enable' | 'read' | 'save'; code?: string; server: string };
const refusedOf = (error: unknown, op: Refused['op']): Refused => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return {
    op,
    code: typeof code === 'string' ? code : flowOf(error) === 'unknown' ? 'no-answer' : undefined,
    server: (error as Error | undefined)?.message ?? '',
  };
};

/**
 * A document being edited, by the path `/api/edit/read` returned. It does not depend on the model: it
 * stays when the file leaves the reading, the project leaves the screen or the server restarts.
 */
export type Draft = {
  path: string;
  /** The opened project the file belonged to when it was read (the most specific one). */
  root: string;
  name: string;
  /** The text and hash the server gave: a save must present this hash. */
  baseText: string;
  baseSha256: string;
  text: string;
  dirty: boolean;
  eol: EditText['eol'];
  bom: boolean;
  /** The editor is shown when this file's text is on the File tab. */
  open: boolean;
  busy?: 'saving' | 'checking';
  outcome?: Outcome;
  /** The version on disk after a refused save or a reading: the conflict dialog compares both with the base. */
  conflict?: Known;
  /** The conflict dialog is open; a conflict found by a reading only changes the state line. */
  resolving?: boolean;
  /** After "Keep my text" over a newer version on disk: the next save shows what it changes first. */
  review?: boolean;
  reviewing?: boolean;
  /** The text the last save replaced, and the hash of what that save wrote. */
  undo?: { text: string; against: string };
  /** The text shows its changes and takes no typing. */
  marks?: boolean;
  /** Save with nothing new: said next to the last outcome, which stays (with its undo). */
  nothing?: boolean;
};

/**
 * What the text with its changes compares: with unsaved text, the draft against the disk (what Save will
 * change); else what the last save or undo wrote against the text it replaced. Nothing while a conflict is
 * pending or before any change.
 */
export function comparisonOf(draft: Draft) {
  if (draft.conflict) return undefined;
  if (draft.dirty) return { before: draft.baseText, after: draft.text, kind: 'draft' as const };
  const outcome = draft.outcome;
  if (outcome?.kind === 'saved' && outcome.after === draft.text)
    return {
      before: outcome.before,
      after: outcome.after,
      kind: outcome.undone ? ('undone' as const) : ('saved' as const),
    };
  return undefined;
}

/** The drafts of the window, outside React state so that typing renders only the editor. */
class DraftStore {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  private keys = { pending: '', open: '', waiting: '', review: '', resolve: '' };
  private changes = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  get = (path: string) => this.drafts.get(path);
  list = () => [...this.drafts.values()];
  /** Paths with unsaved text, joined: a snapshot that changes only when that set changes. */
  pendingKey = () => this.keys.pending;
  openKey = () => this.keys.open;
  waitingKey = () => this.keys.waiting;
  /** The draft whose save waits for the review of what it changes on disk, if any. */
  reviewKey = () => this.keys.review;
  /** The draft whose conflict dialog is open. */
  resolveKey = () => this.keys.resolve;
  /** Bumped by every change: a snapshot for a view of every draft (the list of unsaved documents). */
  version = () => this.changes;
  put(draft: Draft) {
    this.drafts.set(draft.path, draft);
    this.changed();
  }
  update(path: string, change: Partial<Draft> | ((draft: Draft) => Partial<Draft>)) {
    const draft = this.drafts.get(path);
    if (!draft) return;
    const next = { ...draft, ...(typeof change === 'function' ? change(draft) : change) };
    next.dirty = next.text !== next.baseText;
    this.drafts.set(path, next);
    this.changed();
  }
  remove(path: string) {
    if (this.drafts.delete(path)) this.changed();
  }
  private changed() {
    this.changes++;
    const list = this.list();
    const key = (keep: (draft: Draft) => boolean) =>
      list
        .filter(keep)
        .map((draft) => draft.path)
        .sort()
        .join('\n');
    this.keys = {
      pending: key((draft) => draft.dirty),
      open: key((draft) => draft.open),
      waiting: key((draft) => draft.outcome?.kind === 'no-answer' && !draft.busy),
      review: key((draft) => !!draft.reviewing),
      resolve: key((draft) => !!draft.resolving && !!draft.conflict),
    };
    for (const listener of this.listeners) listener();
  }
}

/** What the window gives the editing: its model and the few actions that belong to the rest of the screen. */
export type EditingContext = {
  model: Model | undefined;
  /** The projects with editing on, as the server answered (enable, disable, a snapshot). */
  setEditing: (editing: Model['editing']) => void;
  /** Reads the projects again after a save, keeping selection, history, editor and traced path. */
  reread: () => Promise<unknown>;
  /** How long the last reading of the disk this window asked for took, from the request to the screen. */
  lastReading: () => number | undefined;
  /** How many readings of the disk this window has asked for; and which one gave a model, if any. */
  readingsAsked: () => number;
  readingOf: (model: Model) => number | undefined;
  /** A save changed the file on disk: the read-only preview loads it again. */
  changed: (path: string) => void;
  /** Shows a file of the reading in the inspector, on the File tab. */
  reveal: (path: string) => void;
  /** An error of an action without a place of its own (turning editing off). */
  error: (message: string) => void;
};

type Question = {
  title: string;
  message: string;
  action: string;
  resolve: (yes: boolean) => void;
};
type Permission = {
  root: string;
  path: string;
  /** What follows the permission: open the editor, or save the kept draft. */
  after: 'read' | 'save';
  refused?: Refused;
  working?: boolean;
};
/** Where the cursor of the editor on the screen is, and the line breaks and BOM its file keeps. */
export type Cursor = { line: number; column: number; eol: EditText['eol']; bom: boolean };

/** The editing of the window. Called once by `App`; what it returns is passed to the pieces below. */
export function useEditing(context: EditingContext) {
  const { t, plural } = useI18n();
  const [store] = useState(() => new DraftStore());
  const ctx = useRef(context);
  ctx.current = context;
  const pendingKey = useSyncExternalStore(store.subscribe, store.pendingKey);
  const openKey = useSyncExternalStore(store.subscribe, store.openKey);
  const waitingKey = useSyncExternalStore(store.subscribe, store.waitingKey);
  const [permission, setPermission] = useState<Permission>();
  const [question, setQuestion] = useState<Question>();
  const [listShown, setListShown] = useState(false);
  const [refusals, setRefusals] = useState<Record<string, Refused>>({});
  // Paths saved while the last reading was slow: the reading on the screen is older than them.
  const [stale, setStale] = useState<{ path: string; after: number }[]>([]);
  const writing = useRef(new Set<string>());
  // Paths whose save was asked again while one ran.
  const queued = useRef(new Set<string>());
  // What a save needs to report on the next reading: the hash written and the observations before it.
  // `after`: the readings asked before the save; only a later one reports on it.
  const saved = useRef(new Map<string, { sha256: string; before: Issue[]; after: number }>());
  // Where the cursor was in each draft, kept while its editor is off the screen.
  const positions = useRef(new Map<string, { start: number; end: number; scroll: number }>());
  // Drafts whose editor takes the focus when it mounts (opened by Edit or by a line).
  const focusing = useRef(new Set<string>());

  const pending = useMemo(
    () => (pendingKey ? pendingKey.split('\n').map((path) => store.get(path)!) : []),
    [pendingKey, store],
  );
  const openPaths = useMemo(() => new Set(openKey ? openKey.split('\n') : []), [openKey]);
  const activeIssues = () => {
    const model = ctx.current.model;
    return model ? splitExpected(model).issues : [];
  };
  const pendingIn = (roots: string[]) =>
    store.list().filter((draft) => draft.dirty && roots.includes(draft.root));

  /**
   * After an action that took away the focused control: the focus goes to a predictable place, never to
   * the page.
   */
  function settleFocus(path?: string) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        const dialog = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(-1);
        const editor = path
          ? [...document.querySelectorAll<HTMLTextAreaElement>('.file-editor .editor-text')].find(
              (area) => area.closest('.file-editor')?.getAttribute('data-path') === path,
            )
          : undefined;
        (
          dialog?.querySelector<HTMLElement>('[data-autofocus], button') ??
          editor ??
          document.querySelector<HTMLElement>('.file-editor .editor-text') ??
          document.querySelector<HTMLElement>('.inspector .edit-button, .inspector .edit-save') ??
          document.querySelector<HTMLElement>('#editing-menu-button') ??
          document.querySelector<HTMLElement>('.app-header .reread-button')
        )
          // No scroll: the text stays where it is.
          ?.focus({ preventScroll: true });
      }),
    );
  }

  /** Asks a question in a dialog with Cancel focused; resolves true when the action is chosen. */
  const ask = (title: string, message: string, action: string) =>
    new Promise<boolean>((resolve) => setQuestion({ title, message, action, resolve }));

  /** Takes which projects have editing on from a snapshot; returns the snapshot, when it came. */
  async function refreshEditing() {
    try {
      const snapshot = await loadModel('workspace');
      ctx.current.setEditing(snapshot.editing);
      return snapshot;
    } catch {
      return undefined; // The bar stays as it was; the next reading corrects it.
    }
  }

  /** Reads a document for editing and opens its editor; a draft with unsaved text opens as it is. */
  async function read(path: string, root: string) {
    try {
      const disk = await editRead(path);
      const existing = store.get(path);
      if (existing?.dirty) {
        store.update(path, { open: true });
        return;
      }
      // A draft kept closed after its save keeps its undo while the disk is still what that save wrote.
      const same = existing && existing.baseSha256 === disk.sha256;
      store.put({
        path: disk.path,
        root,
        name: disk.path.split('/').at(-1)!,
        baseText: disk.text,
        baseSha256: disk.sha256,
        text: disk.text,
        dirty: false,
        eol: disk.eol,
        bom: disk.bom,
        open: true,
        undo: same ? existing.undo : undefined,
        outcome: same ? existing.outcome : undefined,
      });
    } catch (error) {
      const flow = flowOf(error);
      if (flow === 'not-granted') {
        void refreshEditing();
        setPermission({ root, path, after: 'read', refused: refusedOf(error, 'read') });
      } else setRefusals((previous) => ({ ...previous, [path]: refusedOf(error, 'read') }));
    }
  }

  /** Starts editing: the permission first when the project has none; then the editor, at the line shown. */
  async function start(path: string) {
    const model = ctx.current.model;
    const root = model && ownerRoot(model.roots, path);
    if (!model || !root) return;
    focusing.current.add(path);
    setRefusals(({ [path]: _, ...rest }) => rest);
    const existing = store.get(path);
    if (existing?.dirty) return store.update(path, { open: true });
    if (!model.editing[root]) return setPermission({ root, path, after: 'read' });
    await read(path, root);
  }

  async function allow() {
    const request = permission;
    if (!request) return;
    setPermission({ ...request, working: true, refused: undefined });
    try {
      ctx.current.setEditing(await editEnable(request.root));
    } catch (error) {
      setPermission({ ...request, working: false, refused: refusedOf(error, 'enable') });
      return;
    }
    setPermission(undefined);
    if (request.after === 'save') {
      settleFocus(request.path);
      save(request.path);
    } else await read(request.path, request.root);
  }

  /** Closes the editor; the draft stays, with its undo. */
  function close(path: string) {
    const draft = store.get(path);
    if (!draft) return;
    leaveHolds.get(path)?.();
    store.update(path, { open: false, reviewing: false, marks: false });
    settleFocus();
  }

  /** After a successful save: a reading when the last one was fast, else the stale notice. */
  async function follow(path: string) {
    if (shouldReread(ctx.current.lastReading())) {
      try {
        await ctx.current.reread();
        return;
      } catch {
        /* Treated as slow: the reading on the screen is older than the save. */
      }
    }
    const after = ctx.current.readingsAsked();
    setStale((previous) => [...previous.filter((item) => item.path !== path), { path, after }]);
    store.update(path, (draft) =>
      draft.outcome?.kind === 'saved'
        ? { outcome: { ...draft.outcome, reading: 'stale' as const } }
        : {},
    );
  }

  function succeed(
    path: string,
    base: Known,
    intended: string,
    result: { sha256: string; previousSha256?: string; unchanged: boolean; durable: boolean },
    mode: Mode,
    checked: boolean,
  ) {
    if (result.unchanged) {
      // Not a save: the outcome and the undo of the last real save stay.
      store.update(path, (draft) => ({
        baseText: intended,
        baseSha256: result.sha256,
        conflict: undefined,
        review: false,
        reviewing: false,
        nothing: true,
        outcome: draft.outcome ?? { kind: 'unchanged', durable: result.durable },
      }));
      return;
    }
    // The previous text only when the window has the pair whose hash the answer names.
    const previous =
      checked || !result.previousSha256 ? undefined : previousText([base], result.previousSha256);
    const diff = diffLines(base.text, intended);
    saved.current.set(path, {
      sha256: result.sha256,
      before: activeIssues(),
      after: ctx.current.readingsAsked(),
    });
    store.update(path, (draft) => ({
      baseText: intended,
      baseSha256: result.sha256,
      // An undo replaces the draft; a save keeps what was typed while it ran.
      text: mode === 'undo' ? intended : draft.text,
      conflict: undefined,
      review: false,
      reviewing: false,
      undo:
        mode === 'save' && previous !== undefined
          ? { text: previous, against: result.sha256 }
          : undefined,
      outcome: {
        kind: 'saved',
        undone: mode === 'undo',
        checked,
        durable: result.durable,
        before: base.text,
        after: intended,
        added: diff.added,
        removed: diff.removed,
        reading: 'pending',
      },
    }));
    ctx.current.changed(path);
    void follow(path);
  }

  /** The answer said nothing: read the disk and tell what is there, never a failure without looking. */
  async function settle(path: string, intended: string, mode: Mode) {
    const draft = store.get(path);
    if (!draft) return;
    const base = { text: draft.baseText, sha256: draft.baseSha256 };
    store.update(path, { busy: 'checking', outcome: undefined });
    let disk: EditText;
    try {
      disk = await editRead(path);
    } catch (error) {
      store.update(path, {
        busy: undefined,
        outcome:
          flowOf(error) === 'missing' ? { kind: 'missing' } : { kind: 'no-answer', intended, mode },
      });
      return;
    }
    store.update(path, { busy: undefined });
    const verdict = settleUnknown(disk, intended, base.sha256);
    if (verdict === 'saved')
      succeed(
        path,
        base,
        intended,
        { sha256: disk.sha256, unchanged: false, durable: true },
        mode,
        true,
      );
    else if (verdict === 'not-saved') store.update(path, { outcome: { kind: 'not-saved' } });
    // A save met the conflict: its dialog opens.
    else store.update(path, { conflict: disk, resolving: true });
  }

  /** One save (or undo) of a document at a time; a conflict of metadata only is tried once more. */
  async function write(path: string, intended: string, mode: Mode, retried = false) {
    const draft = store.get(path);
    if (!draft) return;
    if (!retried) {
      if (writing.current.has(path)) return;
      writing.current.add(path);
      store.update(path, { busy: 'saving', outcome: undefined, nothing: false });
    }
    const base = { text: draft.baseText, sha256: draft.baseSha256 };
    try {
      const result = await editSave(path, base.sha256, intended);
      store.update(path, { busy: undefined });
      succeed(path, base, intended, result, mode, false);
    } catch (error) {
      store.update(path, { busy: undefined });
      const flow = flowOf(error);
      if (flow === 'conflict') {
        let disk: EditText | undefined;
        try {
          disk = await editRead(path);
        } catch {
          disk = undefined;
        }
        if (!disk)
          store.update(path, { outcome: { kind: 'message', refused: refusedOf(error, 'save') } });
        else if (disk.sha256 !== base.sha256)
          store.update(path, { conflict: disk, resolving: true });
        else if (!retried) {
          // Only the metadata changed while saving (a chmod, a touch): the same save once more.
          store.update(path, { busy: 'saving' });
          await write(path, intended, mode, true);
        } else store.update(path, { outcome: { kind: 'metadata' } });
      } else if (flow === 'unknown') await settle(path, intended, mode);
      else if (flow === 'missing') store.update(path, { outcome: { kind: 'missing' } });
      else if (flow === 'not-granted') {
        // What is known: the snapshot says whether the folder of the project is still at its path.
        const snapshot = await refreshEditing();
        const gone =
          snapshot?.savedCases.find((item) => item.path === draft.root)?.available === false;
        store.update(path, {
          outcome: { kind: 'not-granted', refused: refusedOf(error, 'save'), gone },
        });
      } else
        store.update(path, { outcome: { kind: 'message', refused: refusedOf(error, 'save') } });
    } finally {
      if (!retried) {
        writing.current.delete(path);
        if (store.get(path)?.busy === 'saving') store.update(path, { busy: undefined });
        // The queued save runs only if the text is new and this one went through (a refusal or a
        // conflict is decided first).
        const now = store.get(path);
        if (
          queued.current.delete(path) &&
          now?.dirty &&
          now.outcome?.kind === 'saved' &&
          !now.conflict
        )
          save(path);
      }
    }
  }

  /** Save and Ctrl+S: direct, except after keeping the user's text over a conflict (review first). */
  function save(path: string, confirmed = false) {
    const draft = store.get(path);
    if (!draft) return;
    // One save at a time: a Save or Ctrl+S during one waits for it (once, however many times it was
    // pressed) and then saves the text of that moment, with the same check of the disk.
    if (draft.busy === 'saving' || writing.current.has(path)) {
      queued.current.add(path);
      return;
    }
    if (draft.busy) return;
    // Nothing typed since the last save or read: the disk is looked at before saying so.
    if (!draft.dirty && !draft.conflict) return void unchanged(path);
    if (draft.review && !confirmed) return void review(path);
    void write(path, draft.text, 'save');
  }
  /**
   * Save with nothing typed is not a save (the last outcome and its undo stay), but never silence over a
   * disk that changed: if the file is no longer the base, the version on disk is offered as a conflict.
   */
  async function unchanged(path: string) {
    store.update(path, { busy: 'checking' });
    let disk: EditText | undefined;
    try {
      disk = await editRead(path);
    } catch (error) {
      store.update(path, {
        busy: undefined,
        outcome:
          flowOf(error) === 'missing'
            ? { kind: 'missing' }
            : { kind: 'message', refused: refusedOf(error, 'read') },
      });
      return;
    }
    store.update(path, { busy: undefined });
    const current = store.get(path);
    if (!current) return;
    if (current.dirty) return; // Typed while the disk was read: the next Save saves it.
    if (disk.sha256 === current.baseSha256)
      store.update(path, { nothing: true, review: false, reviewing: false });
    else store.update(path, { conflict: disk, resolving: true, review: false, reviewing: false });
  }
  /**
   * The review compares with the disk of now: if the disk changed again since the conflict, that is a new
   * conflict, never a comparison with an old version.
   */
  async function review(path: string) {
    const draft = store.get(path);
    if (!draft || draft.busy) return;
    store.update(path, { busy: 'checking' });
    let disk: EditText | undefined;
    try {
      disk = await editRead(path);
    } catch {
      disk = undefined;
    }
    store.update(path, { busy: undefined });
    const current = store.get(path);
    if (!current) return;
    if (disk && disk.sha256 !== current.baseSha256)
      store.update(path, { conflict: disk, resolving: true });
    else store.update(path, { reviewing: true });
  }
  /** Undo: with text typed after the save, a dialog asks first, because the draft is replaced. */
  async function undo(path: string) {
    const draft = store.get(path);
    if (!draft?.undo || draft.busy) return;
    if (
      draft.dirty &&
      !(await ask(
        t('Undo the last save?'),
        t('Undo returns the file to the previous text and discards what you typed after saving.'),
        t('Undo'),
      ))
    )
      return;
    const current = store.get(path);
    if (current?.undo) void write(path, current.undo.text, 'undo');
    settleFocus(path);
  }
  function keepMine(path: string) {
    settleFocus(path);
    store.update(path, (draft) =>
      draft.conflict
        ? {
            baseText: draft.conflict.text,
            baseSha256: draft.conflict.sha256,
            conflict: undefined,
            resolving: false,
            review: true,
            undo: undefined,
            outcome: undefined,
          }
        : {},
    );
  }
  function takeDisk(path: string) {
    settleFocus(path);
    store.update(path, (draft) =>
      draft.conflict
        ? {
            baseText: draft.conflict.text,
            baseSha256: draft.conflict.sha256,
            text: draft.conflict.text,
            conflict: undefined,
            resolving: false,
            review: false,
            reviewing: false,
            undo: undefined,
            outcome: undefined,
          }
        : {},
    );
  }
  /** No question: the conflict dialog is the decision, and Undo stays until the next edit or leaving. */
  function discardMine(path: string) {
    const text = store.get(path)?.text ?? '';
    takeDisk(path);
    store.update(path, { outcome: { kind: 'discarded', text } });
  }
  /** Undo of a discard: the text back over the version on disk, as `keepMine` does. */
  function restoreDiscarded(path: string) {
    settleFocus(path);
    store.update(path, (draft) =>
      draft.outcome?.kind === 'discarded'
        ? { text: draft.outcome.text, review: true, outcome: undefined, nothing: false }
        : {},
    );
  }
  /** Turning editing on again is giving the permission, so the same dialog asks. */
  function allowAndSave(path: string) {
    const draft = store.get(path);
    if (draft) setPermission({ root: draft.root, path, after: 'save' });
  }
  /** Discards a draft from the list of unsaved documents, after a question. */
  async function confirmDiscard(path: string) {
    const draft = store.get(path);
    if (
      draft &&
      (await ask(
        t('Discard the unsaved text of {name}?', { name: draft.name }),
        t('The file on disk does not change; the text typed here is lost.'),
        t('Discard'),
      ))
    )
      discard(path);
  }
  function retry(path: string) {
    const outcome = store.get(path)?.outcome;
    if (outcome?.kind === 'no-answer') void settle(path, outcome.intended, outcome.mode);
  }

  async function disable(root: string) {
    const left = pendingIn([root]);
    const name = ctx.current.model?.roots.find((item) => item.path === root)?.name ?? root;
    if (
      left.length &&
      !(await ask(
        t('Turn off editing in {project}?', { project: name }),
        plural(
          left.length,
          '{count} document has unsaved edits in {project}. It stays in the list of unsaved documents; saving it needs editing on again.',
          '{count} documents have unsaved edits in {project}. They stay in the list of unsaved documents; saving them needs editing on again.',
          { project: name },
        ),
        t('Turn off editing'),
      ))
    )
      return;
    try {
      ctx.current.setEditing(await editDisable(root));
    } catch (error) {
      ctx.current.error((error as Error).message);
    }
    settleFocus();
  }

  /** Before projects leave the screen: asks when one of them has unsaved documents. */
  async function confirmLeaving(roots: string[], action: 'remove' | 'switch') {
    const left = pendingIn(roots);
    if (!left.length) return true;
    const model = ctx.current.model;
    const names = [...new Set(left.map((draft) => draft.root))]
      .map((root) => model?.roots.find((item) => item.path === root)?.name ?? root)
      .join(', ');
    return ask(
      action === 'remove' ? t('Close the project?') : t('Switch projects?'),
      plural(
        left.length,
        '{count} document has unsaved edits in {projects}. It stays in the list of unsaved documents, only to copy.',
        '{count} documents have unsaved edits in {projects}. They stay in the list of unsaved documents, only to copy.',
        { projects: names },
      ),
      action === 'remove' ? t('Close') : t('Switch'),
    );
  }

  function discard(path: string) {
    store.remove(path);
    saved.current.delete(path);
    positions.current.delete(path);
  }

  // A new reading: the report of the saves that waited for it, and an early look at the other drafts.
  const nodes = context.model?.nodes;
  const lastNodes = useRef(nodes);
  useEffect(() => {
    const model = ctx.current.model;
    if (!model || nodes === lastNodes.current) return;
    lastNodes.current = nodes;
    // 0 for a snapshot (after a restart, the new server's snapshot was read before the save).
    const reading = ctx.current.readingOf(model) ?? 0;
    setStale((previous) => previous.filter((item) => item.after >= reading));
    const active = splitExpected(model).issues;
    // Files of the reading only: a renamed document is still a node, as the missing target of its links.
    const byId = new Map(model.nodes.filter(isDocument).map((node) => [node.id, node]));
    for (const draft of store.list()) {
      const report = saved.current.get(draft.path);
      if (
        report &&
        reading > report.after &&
        draft.outcome?.kind === 'saved' &&
        typeof draft.outcome.reading === 'string'
      ) {
        saved.current.delete(draft.path);
        const node = byId.get(draft.path);
        const check = !node
          ? ('gone' as const)
          : !node.sha256
            ? ('unverified' as const)
            : node.sha256 !== report.sha256
              ? ('changed' as const)
              : ('same' as const);
        const change = compareObservations(report.before, active, draft.path);
        store.update(draft.path, (current) =>
          current.outcome?.kind === 'saved'
            ? { outcome: { ...current.outcome, reading: { change, node: check } } }
            : {},
        );
      }
      // The disk changed since the draft was read: said before the user tries to save.
      if (draft.busy || draft.conflict || !byId.has(draft.path) || !model.editing[draft.root])
        continue;
      const base = draft.baseSha256;
      editRead(draft.path)
        .then((disk) => {
          const current = store.get(draft.path);
          if (!current || current.busy || current.conflict || current.baseSha256 !== base) return;
          if (disk.sha256 === base) return;
          // Never in silence: with text typed, the conflict; with nothing typed, the version on disk is
          // offered, and the editor keeps what it showed until then.
          store.update(draft.path, { conflict: disk });
        })
        .catch(() => {
          /* The save says what is wrong, if it is still wrong then. */
        });
    }
  }, [nodes, store]);

  // A save without an answer: the disk is looked at again every few seconds, until the server answers.
  useEffect(() => {
    if (!waitingKey) return;
    const timer = setInterval(() => {
      for (const path of waitingKey.split('\n')) retry(path);
    }, 3000);
    return () => clearInterval(timer);
  }, [waitingKey]);

  // Closing or reloading the window with unsaved text asks first (the browser's own question).
  useEffect(() => {
    if (!pendingKey) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pendingKey]);

  // Line and column of the editor on the screen, for the bottom bar; reported by the editor after a pause.
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const reportCursor = useCallback(
    (next: Cursor | null) =>
      setCursor((previous) =>
        previous === next ||
        (previous &&
          next &&
          previous.line === next.line &&
          previous.column === next.column &&
          previous.eol === next.eol &&
          previous.bom === next.bom)
          ? previous
          : next,
      ),
    [],
  );
  const takeFocus = useCallback((path: string) => focusing.current.delete(path), []);
  const requestFocus = useCallback((path: string) => void focusing.current.add(path), []);

  return {
    store,
    pending,
    isOpen: (path: string) => !!path && openPaths.has(path),
    stale,
    refusal: (path: string) => refusals[path],
    start,
    close,
    save,
    undo,
    keepMine,
    /** The version on disk replaces the draft; the conflict dialog is the confirmation. */
    takeDisk,
    discardMine,
    restoreDiscarded,
    /** The offer to give a discarded text back ends with the next edit or leaving the file. */
    forgetDiscarded: (path: string) =>
      store.update(path, (draft) =>
        draft.outcome?.kind === 'discarded' ? { outcome: undefined } : {},
      ),
    /** Opens the conflict dialog; `decideLater` (or Esc) closes it and the conflict stays. */
    resolve: (path: string) => store.update(path, { resolving: true }),
    decideLater: (path: string) => store.update(path, { resolving: false }),
    /** The text with its changes, or back to the editor; the line in view is noted first, to stay put. */
    toggleMarks: (path: string, on?: boolean) => {
      const draft = store.get(path);
      if (!draft) return;
      const next = on ?? !draft.marks;
      if (next === !!draft.marks || (next && !comparisonOf(draft))) return;
      markHolds.get(path)?.();
      store.update(path, { marks: next });
    },
    confirmDiscard,
    allowAndSave,
    retry,
    disable,
    confirmLeaving,
    discard,
    positions: positions.current,
    cursor,
    reportCursor,
    takeFocus,
    requestFocus,
    reveal: (path: string) => {
      // A conflict is decided in its dialog, where both versions show.
      store.update(path, (draft) => ({ open: true, resolving: !!draft.conflict }));
      requestFocus(path);
      ctx.current.reveal(path);
      setListShown(false);
    },
    showList: () => setListShown(true),
    /** The state line's rescan after a slow save: the same reading as after a save. */
    rescan: () => ctx.current.reread().catch(() => {}),
    dialogs: {
      permission,
      cancelPermission: () => {
        setPermission(undefined);
        settleFocus();
      },
      allow: () => void allow(),
      question,
      answer: (yes: boolean) => {
        question?.resolve(yes);
        setQuestion(undefined);
        settleFocus();
      },
      listShown,
      hideList: () => {
        setListShown(false);
        settleFocus();
      },
    },
    settleFocus,
    model: context.model,
  };
}
export type Editing = ReturnType<typeof useEditing>;

/** A file the reading found on disk (not the missing target of a link, which has the same path). */
const isDocument = (node: FileNode) =>
  node.status === 'resolved' && !['directory', 'symlink', 'unresolved'].includes(node.kind);

/** The draft of a path, rendering again only when that draft changes. */
function useDraft(editing: Editing, path: string) {
  return useSyncExternalStore(editing.store.subscribe, () => editing.store.get(path));
}

/** A file size limit as people read it: "256 KiB". */
const sizeText = (bytes: number) =>
  bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes.toLocaleString()} bytes`;

/**
 * The editing actions in the line of the file's actions. A button that appears under the pointer ignores
 * the second click of a double click. Edit is unavailable, with the reason, when the window already knows
 * the file is not editable; what only the server knows comes once clicked.
 */
export function EditButton({
  editing,
  node,
  shown,
  onShow,
  onTab,
}: {
  editing: Editing;
  node: FileNode;
  /** The file whose text the File tab shows (the selected one, or the origin of an evidence). */
  shown: string;
  /** The File tab, with the selected file's own text. */
  onShow: () => void;
  /** The File tab as it is, where the state line of the editor is. */
  onTab: () => void;
}) {
  const { t } = useI18n();
  const open = editing.isOpen(shown) ? shown : '';
  const draft = useSyncExternalStore(editing.store.subscribe, () =>
    open ? editing.store.get(open) : undefined,
  );
  const repeated = useNewborn(!!(open && draft));
  // While a save or an undo runs with the changes in view, the button stays as it was.
  const comparison =
    draft &&
    (comparisonOf(draft) ?? (draft.busy && draft.marks ? { kind: 'busy' as const } : undefined));
  const limits = editLimits();
  if (!limits) return null;
  if (open && draft) {
    const working = !!draft.busy;
    return (
      <>
        <button
          className="primary edit-save"
          aria-disabled={working || undefined}
          title={t('Save the file (Ctrl+S)')}
          onClick={(event) => {
            if (repeated(event)) return;
            onTab();
            editing.save(open);
          }}
        >
          {t('Save')}
        </button>
        <button
          className="edit-close"
          onClick={(event) => {
            if (repeated(event)) return;
            editing.close(open);
          }}
        >
          {t('Close editor')}
        </button>
        <button
          className="edit-marks"
          aria-pressed={!!draft.marks}
          aria-disabled={!comparison || undefined}
          title={
            draft.conflict
              ? t('Resolve the conflict first')
              : !comparison
                ? t('Nothing changed yet: type or save first')
                : draft.marks
                  ? t('Back to the text to edit (Esc)')
                  : comparison.kind === 'draft'
                    ? t('Show in the text what saving will change')
                    : t('Show in the text what the last save changed')
          }
          onClick={(event) => {
            if (repeated(event) || !comparison) return;
            editing.toggleMarks(open);
          }}
        >
          {t('Show changes')}
        </button>
      </>
    );
  }
  const why = notEditable(node, limits);
  const reason = !why
    ? ''
    : why.reason === 'type'
      ? why.extension
        ? t('{extension} is not editable here: the app edits Markdown', {
            extension: why.extension,
          })
        : t('A file without extension is not editable here: the app edits Markdown')
      : why.reason === 'size'
        ? t('Larger than {size}: not editable here', { size: sizeText(why.maxBytes) })
        : why.reason === 'symlink'
          ? t('Symbolic link: not editable here')
          : t('Not a file of the scan: not editable here');
  return (
    <button
      className="edit-button"
      aria-disabled={why ? true : undefined}
      title={reason || t('Edit this document in the inspector')}
      onClick={(event) => {
        // The second click of a double click: the first one is already opening the editor.
        if (why || event.detail > 1) return;
        onShow();
        void editing.start(node.path);
      }}
    >
      {t('Edit')}
    </button>
  );
}

/** An item of the "…" menu of the state line, in the shape of the app's menus. */
export type MenuItem = {
  label: string;
  /** None for a fact to read (a text part of the state line that did not fit). */
  icon?: LucideIcon;
  info?: boolean;
  title?: string;
  onSelect: () => void;
};
/** Draws the "…" menu of the state line with the app's menu button (App owns it). */
export type MenuRender = (items: MenuItem[]) => ReactNode;

/**
 * The File tab's text: the editor when this file has an open draft, in the place of the read-only
 * preview (`children`); with the server's refusal above the preview when Edit was refused.
 */
export function EditorSlot({
  editing,
  path,
  line,
  target,
  syntax,
  jump,
  foot,
  observations,
  opened,
  menu,
  children,
}: {
  editing: Editing;
  path: string;
  line: number;
  target?: string;
  syntax?: string;
  jump?: number;
  /** The foot of the inspector, under its area, where the state line is drawn. */
  foot: HTMLElement | null;
  /** The active observations of the file now, and the one opened at the highlighted line, if any. */
  observations: Issue[];
  opened?: Issue;
  menu: MenuRender;
  children: ReactNode;
}) {
  const refusal = editing.refusal(path);
  if (editing.isOpen(path))
    return (
      <FileEditor
        key={path}
        editing={editing}
        path={path}
        line={line}
        target={target}
        syntax={syntax}
        jump={jump}
        foot={foot}
        observations={observations}
        opened={opened}
        menu={menu}
      />
    );
  return (
    <>
      {refusal && <RefusalNote refused={refusal} />}
      {children}
    </>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];
/**
 * The screen's sentence for a refusal of the edit routes, by its code (and route, where the same code
 * means another thing); an unknown code shows the server's text.
 */
export function refusedText({ op, code, server }: Refused, t: Translate) {
  switch (code) {
    case 'no-answer':
      return t('No answer from the server.');
    case 'session':
      return t('Invalid session. Reopen the app.');
    case 'edit-not-granted':
      return op === 'enable'
        ? t(
            'Editing cannot be turned on in the system root, the home folder or a folder above it: it would reach the documents and agent settings of every project. Open the project folder and turn editing on there.',
          )
        : t('Editing is not on in the open project that contains this file.');
    case 'not-in-workspace':
      return op === 'enable'
        ? t('The project is not open or not available. Rescan the projects.')
        : t('This path is not a file of the current scan of this project. Rescan the projects.');
    case 'app-state':
      return t('Files of the app state are not editable.');
    case 'protected':
      return op === 'enable'
        ? t(
            'This path is protected by AAE_PROTECTED_PATHS or by protected-paths.txt. Editing respects that list too. The protection applies to you here in the app too. Taking off the list the entry that protects this project allows editing, and also creation and state of any program in that path.',
          )
        : t(
            'This path is protected by AAE_PROTECTED_PATHS or by protected-paths.txt. Editing respects that list too.',
          );
    case 'not-editable-type':
      return t('The app edits only Markdown documents (.md and .markdown).');
    case 'not-regular':
      return t(
        'On disk, this path is not a regular file or goes through a symbolic link. Rescan the projects.',
      );
    case 'hardlink':
      return t('The file has more than one name (a hard link); saving would split the names.');
    case 'other-owner':
      return t('The file belongs to another user.');
    case 'other-group':
      return t('The system did not let the app keep the group of the file. Nothing was saved.');
    case 'read-only-file':
      return t('The file has no write permission.');
    case 'binary':
      return t('The file has a null byte: it looks binary.');
    case 'not-utf8':
      return t('The file is not valid UTF-8 text.');
    case 'mixed-eol':
      return t('The file mixes line breaks or has a lone carriage return.');
    case 'invalid-text':
      return t(
        'The text cannot be saved: it starts with a BOM (U+FEFF), or has a null byte or a character that does not exist in UTF-8.',
      );
    case 'too-large':
      return t('The file, or the new text, is larger than 256 KiB.');
    case 'conflict':
      return t('The file changed on disk after it was opened for editing. Nothing was saved.');
    case 'missing':
      return t('The file, or a folder of its path, no longer exists on disk.');
    case 'folder-changed':
      return t('The folder of the file was moved or replaced during the save. Nothing was saved.');
    case 'write-failed':
      return t('Could not save the file. Nothing was saved.');
    case 'unconfirmed':
      return t(
        'Could not confirm whether the file was replaced. Read the file again before saving again.',
      );
    default:
      return server;
  }
}
/** A refusal as a note: the screen's sentence in the problem tone, the server's text on hover. */
function RefusalNote({ refused }: { refused: Refused }) {
  const { t } = useI18n();
  const text = refusedText(refused, t);
  return (
    <p className="edit-note" role="alert">
      <span
        className="tone-problem"
        title={refused.server && refused.server !== text ? refused.server : undefined}
      >
        {text}
      </span>
    </p>
  );
}

/*
 * The editor takes the place of the read-only text with the same metrics, in the inspector's area
 * (`.inspector-scroll`), which is what scrolls. Switching between the two keeps a line where it was on the
 * screen: the side that leaves notes a line and its top, and the side that arrives puts that line at the
 * same top. It matters for a long file, whose read-only text shows only some of its lines.
 */
/** The lines to keep in place across the switch, best first, and their tops on the screen. */
let held:
  | { path: string; from: 'read' | 'edit'; at: number; lines: { line: number; top: number }[] }
  | undefined;
/** The space above the first line of the editor's text (its padding), as in the read-only text. */
const TEXT_TOP = 8;
/** Called before the text turns into its changes or back: the editor of each path notes the line in view. */
const markHolds = new Map<string, () => void>();
/** Called before the editor closes: it notes the line in view before the read-only text is drawn. */
const leaveHolds = new Map<string, () => void>();
/** The place held by the side that left, if it left in this switch (not by an older one). */
function take(path: string, from: 'read' | 'edit') {
  const place = held;
  held = undefined;
  return place && place.path === path && place.from === from && performance.now() - place.at < 250
    ? place
    : undefined;
}

/** The line the editor had in view as it left for the read-only text of `path`, without taking it. */
export function heldEditorLine(path: string) {
  const place = held;
  return place && place.path === path && place.from === 'edit' && performance.now() - place.at < 250
    ? place.lines[0]?.line
    : undefined;
}

/** The area that scrolls the File tab (with the editor open, it ends at the state line). */
function areaOf(element: Element) {
  const area = element.closest<HTMLElement>('.inspector-scroll');
  if (!area) return undefined;
  const box = area.getBoundingClientRect();
  return { area, top: box.top, bottom: box.bottom };
}

/**
 * The height of each of `texts` as a line of the textarea, measured on a copy with the same width, letter
 * and wrapping (one block per line, so a line that wraps takes its visual lines). Fractions of a pixel are
 * kept (offsetTop rounds): thousands of lines down, they add up.
 */
function measureLines(area: HTMLTextAreaElement, texts: string[]) {
  const style = getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const property of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'paddingLeft',
    'paddingRight',
    'wordBreak',
    'overflowWrap',
    'fontVariantLigatures',
    'fontFeatureSettings',
  ] as const)
    mirror.style[property] = style[property];
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-10000px',
    boxSizing: 'border-box',
    width: `${area.clientWidth}px`,
    whiteSpace: 'pre-wrap',
    border: '0',
  });
  for (const text of texts) {
    const line = document.createElement('div');
    // An empty line still takes a line, as in the textarea.
    line.textContent = text || '\u200b';
    mirror.append(line);
  }
  document.body.append(mirror);
  const heights = [...mirror.children].map((line) => line.getBoundingClientRect().height);
  mirror.remove();
  return heights;
}

/** The top of each line of a textarea, from its top edge (its padding included). */
function lineTops(area: HTMLTextAreaElement) {
  const heights = measureLines(area, area.value.split('\n'));
  let top = parseFloat(getComputedStyle(area).paddingTop) || 0;
  return heights.map((height) => {
    const at = top;
    top += height;
    return at;
  });
}

/**
 * Where each line of the editor is, kept as the text changes: measured whole when the editor opens or its
 * width changes, then only the lines a change touched (a key typed measures one line).
 */
export class LineMap {
  lines: string[] = [];
  /** Where each line starts in the text, and the height and top of each one (tops has one more: the end). */
  starts: number[] = [0];
  heights: number[] = [];
  tops: number[] = [0];
  private width = -1;
  private text = '';
  /** Brings the map to `text` (the draft's) at the textarea's width; true when anything changed. */
  sync(area: HTMLTextAreaElement, text: string) {
    const width = area.clientWidth;
    if (width === this.width && text === this.text) return false;
    const lines = text.split('\n');
    if (width !== this.width || !this.heights.length) this.heights = measureLines(area, lines);
    else {
      // Only the lines between the same start and the same end are measured again.
      const old = this.lines;
      let first = 0;
      while (first < old.length && first < lines.length && old[first] === lines[first]) first++;
      let end = 0;
      while (
        end < old.length - first &&
        end < lines.length - first &&
        old[old.length - 1 - end] === lines[lines.length - 1 - end]
      )
        end++;
      this.heights.splice(
        first,
        old.length - first - end,
        ...measureLines(area, lines.slice(first, lines.length - end)),
      );
    }
    this.width = width;
    this.text = text;
    this.lines = lines;
    this.starts = [0];
    this.tops = [0];
    for (let index = 0; index < lines.length; index++) {
      this.starts.push(this.starts[index] + lines[index].length + 1);
      this.tops.push(this.tops[index] + this.heights[index]);
    }
    return true;
  }
  /** The index of the line at `y` from the top of the first line (clamped to the text). */
  lineAt(y: number) {
    return Math.max(0, Math.min(this.lines.length - 1, upperBound(this.tops, y) - 1));
  }
  /** The index of the line of a position in the text. */
  lineOf(offset: number) {
    return Math.max(0, Math.min(this.lines.length - 1, upperBound(this.starts, offset) - 1));
  }
}
/** The first index whose value is greater than `value`, in an ascending list. */
function upperBound(list: number[], value: number) {
  let low = 0,
    high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Called by the read-only text as it leaves for the editor: the lines to keep in place. */
export function holdReadOnlyPlace(path: string, code: HTMLElement | null) {
  const place = code && areaOf(code);
  if (!code || !place) return;
  const rows = [...code.querySelectorAll<HTMLElement>(':scope > [data-line]')];
  const seen = (row: HTMLElement) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > place.top && rect.top < place.bottom;
  };
  const chosen = [
    rows.find((row) => row.classList.contains('highlight-line') && seen(row)),
    rows.find(seen),
    rows[0],
  ].filter((row): row is HTMLElement => !!row);
  held = {
    path,
    from: 'read',
    at: performance.now(),
    lines: chosen.map((row) => ({
      line: Number(row.dataset.line),
      top: row.getBoundingClientRect().top,
    })),
  };
}
/** Called by the read-only text as it arrives from the editor: the line the editor had, at the same top. */
export function restoreReadOnlyPlace(path: string, code: HTMLElement | null) {
  const place = take(path, 'edit');
  const found = code && areaOf(code);
  if (!code || !found || !place) return;
  for (const { line, top } of place.lines) {
    const row = code.querySelector<HTMLElement>(`:scope > [data-line="${line}"]`);
    if (!row) continue;
    const wanted = found.area.scrollTop + row.getBoundingClientRect().top - top;
    found.area.scrollTop = wanted;
    // The editor's field reached the state line (a short file): the read-only text keeps that room
    // below it, so that leaving does not pull the text down.
    const short = wanted - found.area.scrollTop;
    if (short > 0.5) {
      code.style.marginBottom = `${short}px`;
      found.area.scrollTop = wanted;
    }
    return;
  }
}
/** The editor as it leaves: the highlighted line when it is in view, else the first line in view. */
function holdEditorPlace(path: string, element: HTMLTextAreaElement, highlighted: number) {
  const place = areaOf(element);
  if (!place) return;
  const origin = element.getBoundingClientRect().top;
  const tops = lineTops(element);
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 0;
  const seen = (index: number) => {
    const top = origin + tops[index];
    const bottom = index + 1 < tops.length ? origin + tops[index + 1] : top + lineHeight;
    return bottom > place.top && top < place.bottom;
  };
  const known = highlighted > 0 && highlighted <= tops.length;
  const chosen = [
    known && seen(highlighted - 1) ? highlighted : 0,
    tops.findIndex((_, index) => seen(index)) + 1,
    known ? highlighted : 0,
  ].filter((line) => line > 0);
  held = {
    path,
    from: 'edit',
    at: performance.now(),
    lines: chosen.map((line) => ({ line, top: origin + tops[line - 1] })),
  };
}
/** The editor as it arrives: the line the read-only text had, at the same top. False when none was held. */
function restoreEditorPlace(path: string, element: HTMLTextAreaElement) {
  const place = take(path, 'read');
  const found = areaOf(element);
  if (!found || !place?.lines.length) return false;
  const tops = lineTops(element);
  const kept = place.lines.find((item) => item.line <= tops.length);
  if (kept)
    found.area.scrollTop += element.getBoundingClientRect().top + tops[kept.line - 1] - kept.top;
  // The line of the cursor (the destination opened) never under the state line that just came.
  const place2 = areaOf(element);
  const cursor = lineColumn(element.value, element.selectionStart).line - 1;
  if (place2 && cursor < tops.length) {
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 0;
    const top = element.getBoundingClientRect().top + tops[cursor];
    const bottom =
      cursor + 1 < tops.length
        ? element.getBoundingClientRect().top + tops[cursor + 1]
        : top + lineHeight;
    if (bottom > place2.bottom && top - (bottom - place2.bottom) >= place2.top)
      place2.area.scrollTop += bottom - place2.bottom;
  }
  return true;
}

/** Slides the area to `to` in the time of the panels (none when the system asks for less motion). */
function slide(area: HTMLElement, to: number) {
  const time = getComputedStyle(document.documentElement).getPropertyValue('--motion-panel').trim();
  const duration = time.endsWith('ms') ? parseFloat(time) : parseFloat(time) * 1000 || 0;
  const from = area.scrollTop;
  if (!duration || Math.abs(to - from) < 1) {
    area.scrollTop = to;
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    // The ease of the panels: fast at first, slow to stop.
    area.scrollTop = from + (to - from) * (1 - Math.pow(1 - progress, 3));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * After entering: when fewer than eight lines of text are in view above the state line (a small window,
 * the observations filling it), the area slides until the text starts at its top.
 */
function makeRoom(element: HTMLTextAreaElement) {
  const place = areaOf(element);
  if (!place) return;
  const style = getComputedStyle(element);
  const lineHeight = parseFloat(style.lineHeight) || 0;
  const textTop = element.getBoundingClientRect().top + parseFloat(style.paddingTop);
  if (place.bottom - Math.max(place.top, textTop) >= 8 * lineHeight - 0.5) return;
  const max = place.area.scrollHeight - place.area.clientHeight;
  slide(place.area, Math.min(max, place.area.scrollTop + textTop - place.top));
}

/** A line of the editor in the middle of the area (a click on a line number while editing). */
function centerLine(element: HTMLTextAreaElement, line: number) {
  const place = areaOf(element);
  if (!place) return;
  const tops = lineTops(element);
  if (line < 1 || line > tops.length) return;
  const top = element.getBoundingClientRect().top + tops[line - 1];
  place.area.scrollTop += top - (place.top + (place.bottom - place.top) / 2);
}

/** A control that appears under the pointer (the action row switching) ignores the rest of a double click. */
export function useNewborn(key: unknown) {
  const born = useRef(0);
  useLayoutEffect(() => {
    born.current = performance.now();
  }, [key]);
  return (event: { detail: number }) => event.detail > 1 && performance.now() - born.current < 400;
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const [failed, setFailed] = useState(false);
  return {
    copied,
    failed,
    copy: (text: string) =>
      navigator.clipboard.writeText(text).then(
        () => {
          setFailed(false);
          setCopied(true);
        },
        () => setFailed(true),
      ),
  };
}

/** The lines of a comparison, drawn as the read-only preview draws a file, with the sign of each change. */
function DiffList({ diff, label }: { diff: Diff; label: string }) {
  const { t, plural } = useI18n();
  const groups = useMemo(() => hunks(diff), [diff]);
  const LIMIT = 500;
  let shown = 0;
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  return (
    <div className="diff-list" role="group" aria-label={label}>
      {diff.replaced && (
        <p className="diff-note">
          {t('Too many changes to compare line by line: shown as one block replaced.')}
        </p>
      )}
      {!groups.length && <p className="diff-note">{t('No difference.')}</p>}
      {groups.map((lines, index) => {
        if (shown >= LIMIT) return null;
        const visible = lines.slice(0, LIMIT - shown);
        shown += visible.length;
        return (
          <pre className="source-code diff-hunk" key={index}>
            {visible.map((line, at) => (
              <div className={`diff-line diff-${line.kind}`} key={at}>
                <span className="diff-number">{line.after ?? line.before}</span>
                <b className={`diff-sign ${line.kind}`}>
                  <span aria-hidden="true">
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
                  </span>
                  <i className="visually-hidden">
                    {line.kind === 'added'
                      ? t('Added:')
                      : line.kind === 'removed'
                        ? t('Removed:')
                        : ''}
                  </i>
                </b>
                <code>{line.text || ' '}</code>
              </div>
            ))}
          </pre>
        );
      })}
      {total > LIMIT && (
        <p className="diff-note">
          {plural(total - LIMIT, '{count} more line not shown', '{count} more lines not shown')}
        </p>
      )}
    </div>
  );
}

/**
 * A refusal as the state line says it: a sentence that, with its action, fits the narrowest inspector,
 * and the action that resolves it, where one helps. `refusedText` and the server's text go in the tooltip.
 */
function shortRefusal({ code }: Refused, t: Translate): { text: string; fix?: 'rescan' } {
  switch (code) {
    case 'no-answer':
      return { text: t('No answer from the server') };
    case 'session':
      return { text: t('Invalid session; reopen the app') };
    case 'edit-not-granted':
      return { text: t('Editing off in this project') };
    case 'not-in-workspace':
      return { text: t('Not in the current scan'), fix: 'rescan' };
    case 'app-state':
      return { text: t('A file of the app state') };
    case 'protected':
      return { text: t('Protected path') };
    case 'not-editable-type':
      return { text: t('Only Markdown is editable') };
    case 'not-regular':
      return { text: t('Not a regular file on disk'), fix: 'rescan' };
    case 'hardlink':
      return { text: t('A file with more than one name') };
    case 'other-owner':
      return { text: t('A file of another user') };
    case 'other-group':
      return { text: t('Could not keep the file group') };
    case 'read-only-file':
      return { text: t('No write permission') };
    case 'binary':
      return { text: t('The file looks binary') };
    case 'not-utf8':
      return { text: t('Not valid UTF-8 text') };
    case 'mixed-eol':
      return { text: t('Mixed line breaks') };
    case 'invalid-text':
      return { text: t('A character that cannot be saved') };
    case 'too-large':
      return { text: t('Larger than 256 KiB') };
    case 'conflict':
      return { text: t('Changed on disk; nothing saved') };
    case 'missing':
      return { text: t('The file no longer exists') };
    case 'folder-changed':
      return { text: t('The folder moved while saving'), fix: 'rescan' };
    case 'write-failed':
      return { text: t('Could not save the file') };
    case 'unconfirmed':
      return { text: t('Save not confirmed') };
    default:
      return { text: t('The server refused the save') };
  }
}

/** One part of the state line after its first sentence: more of the sentence, or an action. */
type Piece = {
  key: string;
  kind: 'text' | 'action';
  /** Higher stays longer: what does not fit leaves whole for the "…" menu, lowest first. */
  priority: number;
  node: ReactNode;
  menu: MenuItem;
};
/**
 * The observation the editing started from, opened at its line. Entering by Edit chooses none: after a
 * save, the state line then counts the observations resolved and new instead of naming one.
 */
type Motive = { key: string; line?: number; target?: string; title: string; tone: Tone };
function motiveOf(opened?: Issue): Motive | undefined {
  if (!opened) return undefined;
  const info = issueInfo(opened);
  return {
    key: observationKey(opened),
    line: opened.line || undefined,
    target: opened.target,
    title: info.title,
    tone: info.tone,
  };
}

/**
 * The state line of the editor, held at the foot of the inspector while the editor is open, and never
 * cut: one short sentence on the left, its actions on the right. What does not fit leaves whole for a
 * "…" menu at the end; the long sentences are in the tooltips.
 */
const EditorStatus = memo(function EditorStatus({
  editing,
  draft,
  motive,
  motiveShown,
  onMotive,
  menu,
  changes,
}: {
  editing: Editing;
  draft: Draft;
  motive: Motive | undefined;
  /** The observation takes the sentence: its line in the list is out of view, and nothing else is said. */
  motiveShown: boolean;
  onMotive: () => void;
  menu: MenuRender;
  /** The changes the text shows, whose count the sentence says. */
  changes?: Diff;
}) {
  const { t, plural } = useI18n();
  const { copy, copied, failed } = useCopy();
  const outcome = draft.outcome;
  let tone: '' | 'warning' | 'problem' = '';
  // The tone belongs to a part of the line, not to its lead (a save that worked, with a caveat).
  let partTone = false;
  let lead: ReactNode = null;
  let leadTitle = '';
  const pieces: Piece[] = [];
  const text = (key: string, priority: number, label: string, title?: string, partOf?: 'warning') =>
    pieces.push({
      key,
      kind: 'text',
      priority,
      node: (
        <span className={`editor-status-part${partOf ? ` tone-${partOf}` : ''}`} title={title}>
          {label}
        </span>
      ),
      menu: { label, info: true, title, onSelect: () => {} },
    });
  const action = (
    key: string,
    priority: number,
    label: string,
    icon: LucideIcon,
    run: () => void,
    title?: string,
  ) =>
    pieces.push({
      key,
      kind: 'action',
      priority,
      node: (
        <button className="text-button" title={title} onClick={run}>
          {label}
        </button>
      ),
      menu: { label, icon, title, onSelect: run },
    });
  const copyAction = (priority: number) =>
    action(
      'copy',
      priority,
      copied ? t('Copied') : t('Copy'),
      Copy,
      () => void copy(draft.text),
      t('Copy your text'),
    );
  // The action of the last save stays while it is the last one (also when the sentence is another).
  const saveActions = () => {
    if (outcome?.kind === 'saved' && draft.undo)
      action(
        'undo',
        9,
        t('Undo'),
        Undo2,
        () => void editing.undo(draft.path),
        t('Undo the last save'),
      );
  };
  if (draft.busy === 'saving') lead = t('Saving…');
  else if (draft.busy === 'checking') lead = t('Checking the file on disk…');
  else if (failed) {
    tone = 'problem';
    lead = t('Could not copy the text.');
  } else if (draft.conflict) {
    tone = 'warning';
    lead = t('Changed on disk since you opened it');
    leadTitle = t('The file changed on disk since you opened it.');
    action(
      'resolve',
      10,
      t('Resolve…'),
      Scale,
      () => editing.resolve(draft.path),
      t('Compare the two versions and decide'),
    );
  } else if (changes && draft.dirty) {
    // The text shows what saving will change: the count is that of its signs.
    lead = t('Not saved');
    text('count', 8.5, `+${changes.added} −${changes.removed}`, t('Lines added and removed'));
    if (changes.replaced)
      text('block', 8, t('one block replaced'), t('Too many changes to compare line by line.'));
  } else if (motiveShown && motive) {
    lead = (
      <button className="editor-motive" title={t('Go to the observation')} onClick={onMotive}>
        {motive.line ? <span className="editor-motive-line">L{motive.line}</span> : null}
        {/* A space between the parts for the name read aloud; the gap draws it. */}
        {motive.line && motive.target !== undefined ? ' ' : null}
        {motive.target !== undefined && <code>{motive.target}</code>}
        <span className="editor-motive-title">
          {motive.line || motive.target !== undefined ? ' · ' : ''}
          <span className={`tone-${motive.tone}`}>{motive.title}</span>
        </span>
      </button>
    );
    saveActions();
  } else if (draft.nothing || !outcome) {
    // Save with nothing new: said in place of the last outcome, whose undo stays.
    if (draft.nothing) lead = t('Nothing new to save');
    saveActions();
  } else if (outcome.kind === 'saved' && draft.dirty) {
    // Text typed after the save (or while it ran): never "saved" over text newer than the disk.
    lead = t('Not saved');
    saveActions();
  } else
    switch (outcome.kind) {
      case 'discarded':
        lead = t('Your text was discarded');
        leadTitle = t('The editor took the version on disk; Undo gives your text back.');
        action(
          'restore',
          10,
          t('Undo'),
          Undo2,
          () => editing.restoreDiscarded(draft.path),
          t('Give your text back'),
        );
        break;
      case 'saved': {
        lead = outcome.undone ? t('Save undone') : t('Saved');
        text('count', 8.5, `+${outcome.added} −${outcome.removed}`, t('Lines added and removed'));
        if (changes?.replaced)
          text('block', 8, t('one block replaced'), t('Too many changes to compare line by line.'));
        {
          const reading = outcome.reading;
          if (reading === 'pending') text('reading', 4, t('rescanning the projects…'));
          else if (reading === 'stale') {
            tone = 'warning';
            partTone = true;
            // The reason and its way out stay in the line before the count.
            text(
              'stale',
              9,
              t('stale scan'),
              t('The scan on the screen is older than the save.'),
              'warning',
            );
            action('reread', 9, t('Rescan'), RefreshCw, () => void editing.rescan());
          } else if (!outcome.undone) {
            const { change, node } = reading;
            const own =
              motive && change.resolved.some((item) => observationKey(item) === motive.key);
            if (own && motive)
              text(
                'resolved',
                7,
                motive.line ? t('L{line} resolved', { line: String(motive.line) }) : t('resolved'),
              );
            else if (change.resolved.length)
              text(
                'resolved',
                7,
                plural(change.resolved.length, '{count} resolved', '{count} resolved'),
              );
            if (change.added.length) {
              const first = change.added[0];
              text(
                'added',
                7,
                plural(change.added.length, '{count} new', '{count} new'),
                first.target
                  ? t('{title} ({target}), line {line}', {
                      title: issueInfo(first).title,
                      target: first.target,
                      line: String(first.line ?? ''),
                    })
                  : t('{title}, line {line}', {
                      title: issueInfo(first).title,
                      line: String(first.line ?? ''),
                    }),
              );
            }
            if (change.resolvedElsewhere)
              text(
                'elsewhere-resolved',
                2,
                plural(
                  change.resolvedElsewhere,
                  '{count} resolved in other files',
                  '{count} resolved in other files',
                ),
              );
            if (change.addedElsewhere)
              text(
                'elsewhere-added',
                2,
                plural(
                  change.addedElsewhere,
                  '{count} new in other files',
                  '{count} new in other files',
                ),
              );
            if (node === 'changed') {
              tone = 'warning';
              partTone = true;
              text(
                'changed',
                6,
                t('the file changed again on disk after your save'),
                undefined,
                'warning',
              );
            }
            if (node === 'unverified') text('unverified', 3, t('not verified in this scan'));
            if (node === 'gone') text('gone', 3, t('the file is no longer in the scan'));
          }
          if (outcome.checked) text('checked', 3, t('checked by reading again'));
          if (!outcome.durable) {
            tone = 'warning';
            partTone = true;
            text(
              'durable',
              5,
              t('not confirmed on disk'),
              t('the system did not confirm the save to disk'),
              'warning',
            );
          }
        }
        saveActions();
        break;
      }
      case 'unchanged':
        lead = t('Nothing new to save');
        if (!outcome.durable)
          text(
            'durable',
            5,
            t('not confirmed on disk'),
            t('the system did not confirm the save to disk'),
          );
        break;
      case 'not-saved':
        tone = 'warning';
        lead = t('Not saved; the disk did not change');
        leadTitle = t('Not saved: the file on disk is still the one you opened.');
        action('save', 10, t('Save'), Save, () => editing.save(draft.path));
        break;
      case 'no-answer':
        tone = 'problem';
        lead = t('No answer from the server');
        leadTitle = t('No answer from the server. Your text stays in this window.');
        action('retry', 10, t('Try again'), RefreshCw, () => editing.retry(draft.path));
        copyAction(8);
        break;
      case 'missing':
        tone = 'problem';
        lead = t('The file no longer exists');
        leadTitle = t(
          'The file no longer exists on disk. The app does not create it again; your text stays in the list of unsaved documents.',
        );
        copyAction(10);
        break;
      case 'not-granted':
        tone = 'problem';
        if (outcome.gone) {
          // What the snapshot says: the folder is no longer at this path; turning editing on would fail.
          lead = t('The project folder moved');
          leadTitle = t(
            'The folder of this project moved or no longer exists. Rescan the projects.',
          );
          copyAction(10);
        } else {
          lead = t('Editing off in this project');
          leadTitle = refusedText(outcome.refused, t);
          action(
            'allow',
            10,
            t('Allow and save'),
            Save,
            () => void editing.allowAndSave(draft.path),
          );
        }
        break;
      case 'metadata':
        tone = 'warning';
        lead = t('Another program is changing the file');
        leadTitle = t(
          'Another program is changing this file without changing its text; try again.',
        );
        action('again', 10, t('Try again'), RefreshCw, () => editing.save(draft.path));
        break;
      case 'message': {
        tone = 'problem';
        const short = shortRefusal(outcome.refused, t);
        lead = short.text;
        leadTitle = refusedText(outcome.refused, t);
        if (short.fix === 'rescan')
          action('reread', 10, t('Rescan'), RefreshCw, () => void editing.rescan());
        copyAction(short.fix ? 8 : 10);
        break;
      }
    }
  // With the changes in view, the count is always that of their signs, whatever the sentence.
  if (changes && !pieces.some((piece) => piece.key === 'count'))
    text('count', 8.5, `+${changes.added} −${changes.removed}`, t('Lines added and removed'));
  const detail =
    !motiveShown && outcome && (outcome.kind === 'message' || outcome.kind === 'not-granted')
      ? outcome.refused.server
      : '';
  const title = [leadTitle, detail && detail !== leadTitle ? detail : '']
    .filter(Boolean)
    .join('\n');
  const head = (
    <>
      {tone && !partTone ? <span className={`editor-status-tone tone-${tone}`}>{lead}</span> : lead}
    </>
  );
  // What fits: measured on copies of every part in a hidden box, so that the line itself never overflows.
  const line = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const signature = pieces.map((piece) => `${piece.key}:${piece.priority}`).join(' ');
  const fit = useCallback(() => {
    const box = line.current;
    const copies = measure.current;
    if (!box || !copies) return;
    const gap = (element: Element | null) =>
      element ? parseFloat(getComputedStyle(element).columnGap) || 0 : 0;
    const style = getComputedStyle(box);
    // The width as laid out: clientWidth is rounded to a whole pixel, and the line's width is not (the
    // inspector's is fractional), so a part that overflows by a fraction of a pixel would be kept and
    // the flex line would shrink the sentence under its text.
    const room =
      box.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.borderLeftWidth) -
      parseFloat(style.borderRightWidth);
    const [lineGap, textGap, actionGap] = [
      gap(box),
      gap(box.querySelector('.editor-status-text')),
      gap(box.querySelector('.editor-status-actions')),
    ];
    const width = (key: string) =>
      copies.querySelector<HTMLElement>(`[data-key="${key}"]`)?.getBoundingClientRect().width ?? 0;
    const order = [...pieces].sort((a, b) => a.priority - b.priority);
    const out: string[] = [];
    // The sentence and its parts on the left, the actions (and the "…" menu) on the right.
    const used = () => {
      const kept = pieces.filter((piece) => !out.includes(piece.key));
      const texts = kept.filter((piece) => piece.kind === 'text');
      const actions = kept
        .filter((piece) => piece.kind === 'action')
        .map((piece) => width(piece.key));
      if (out.length) actions.push(width('more'));
      return (
        width('lead') +
        texts.reduce((sum, piece) => sum + textGap + width(piece.key), 0) +
        (actions.length
          ? lineGap +
            actions.reduce((sum, each) => sum + each, 0) +
            actionGap * (actions.length - 1)
          : 0)
      );
    };
    for (const piece of order) {
      if (used() <= room) break;
      out.push(piece.key);
    }
    const next = out.sort().join(' ');
    setHidden((previous) => (previous.slice().sort().join(' ') === next ? previous : out));
    // The parts depend on the draft and the language; their keys and priorities say when to measure again.
  }, [signature, lead, copied]);
  useLayoutEffect(fit);
  useEffect(() => {
    const box = line.current;
    if (!box) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(box);
    return () => observer.disconnect();
  }, [fit]);
  const shown = (kind: Piece['kind']) =>
    pieces
      .filter((piece) => piece.kind === kind && !hidden.includes(piece.key))
      .map((piece) => (
        <span key={piece.key} className="editor-status-slot">
          {kind === 'text' && <span aria-hidden="true">{' · '}</span>}
          {piece.node}
        </span>
      ));
  const left = pieces.filter((piece) => hidden.includes(piece.key));
  return (
    <>
      <div className="editor-status editor-outcome" role="status" ref={line}>
        <span className="editor-status-text" title={title || undefined}>
          {head}
          {shown('text')}
        </span>
        <span className="editor-status-actions">
          {shown('action')}
          {left.length > 0 && menu(left.map((piece) => piece.menu))}
        </span>
      </div>
      {/* Out of the line, so that neither its text nor its width counts as the line's. */}
      <span className="editor-status-measure" aria-hidden="true" inert ref={measure}>
        <span data-key="lead" className="editor-status-lead">
          {head}
        </span>
        {pieces.map((piece) => (
          <span key={piece.key} data-key={piece.key}>
            {piece.kind === 'text' && ' · '}
            {piece.node}
          </span>
        ))}
        <span data-key="more" className="editor-status-more-size" />
      </span>
    </>
  );
});

type EditorProps = {
  editing: Editing;
  path: string;
  line: number;
  target?: string;
  syntax?: string;
  /** Bumped by each click on a line number, also on the line already highlighted. */
  jump?: number;
  foot: HTMLElement | null;
  observations: Issue[];
  opened?: Issue;
  menu: MenuRender;
};
/** The editor of the draft of `path`, while that draft exists (a discarded one leaves at once). */
function FileEditor(props: EditorProps) {
  const draft = useDraft(props.editing, props.path);
  return draft ? <DraftEditor {...props} draft={draft} /> : null;
}
/**
 * The text with its changes, to read only: each row at the top the line map gives it, only the rows around
 * the view drawn. Signs and numbers are left out of the copy and of what is read aloud, which says the
 * change instead; a removed line is left out of the copy too.
 */
function MarksView({
  ref,
  rows,
  tops,
  from,
  to,
  block,
  name,
}: {
  ref: Ref<HTMLDivElement>;
  rows: MarkRow[];
  tops: number[];
  from: number;
  to: number;
  block: (count: number) => string;
  name: string;
}) {
  const { t } = useI18n();
  return (
    <div
      ref={ref}
      className="editor-marks"
      role="group"
      aria-label={t('Changes in {name}', { name })}
      style={{ height: tops[tops.length - 1] + 2 * TEXT_TOP }}
    >
      {rows.slice(from, to).map((row, offset) => {
        const index = from + offset;
        const top = TEXT_TOP + tops[index];
        if (row.kind === 'block')
          return (
            <div key={index} className="marks-row marks-removed marks-block" style={{ top }}>
              <span className="marks-sign" aria-hidden="true">
                −
              </span>
              <span className="marks-number" aria-hidden="true" />
              <code>{block(row.count)}</code>
            </div>
          );
        const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : '';
        const text = row.text;
        return (
          <div
            key={index}
            className={`marks-row marks-${row.kind}`}
            data-line={row.kind === 'removed' ? undefined : row.line}
            style={{ top }}
          >
            {sign && (
              <span className="marks-sign" aria-hidden="true">
                {sign}
              </span>
            )}
            <span className="marks-number" aria-hidden="true">
              {row.kind === 'removed' ? '' : row.line}
            </span>
            <code>
              {sign && (
                <i className="visually-hidden">
                  {row.kind === 'added' ? t('Added:') : t('Removed:')}{' '}
                </i>
              )}
              {row.changed ? (
                <>
                  {text.slice(0, row.changed[0])}
                  <u>{text.slice(row.changed[0], row.changed[1])}</u>
                  {text.slice(row.changed[1])}
                </>
              ) : (
                // An empty line as a text editor copies it: a line break, never a space.
                text || <br />
              )}
            </code>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The editor of one draft, in the place of the read-only text: a plain textarea with the same metrics and
 * no scroll of its own (it grows with the text; the inspector's area scrolls).
 */
function DraftEditor({
  editing,
  path,
  line,
  target,
  syntax,
  jump,
  foot,
  observations,
  opened,
  menu,
  draft,
}: EditorProps & { draft: Draft }) {
  const { t, plural } = useI18n();
  const area = useRef<HTMLTextAreaElement>(null);
  // The position goes to the bottom bar after a short pause, so that typing does not draw the window.
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { reportCursor } = editing;
  // Where the cursor is, kept at once (the bar hears of it after the pause).
  const selection = useRef({ start: 0, end: 0 });
  const track = useCallback(() => {
    const element = area.current;
    if (element) {
      selection.current = { start: element.selectionStart, end: element.selectionEnd };
      // After a key the map is a key behind until the text is drawn; `view` sets it again then.
      setCursorLine(map.current.lineOf(element.selectionStart));
    }
    clearTimeout(pause.current);
    pause.current = setTimeout(() => {
      const element = area.current;
      if (!element) return;
      const { line, column } = lineColumn(element.value, element.selectionStart);
      reportCursor({ line, column, eol: draft.eol, bom: draft.bom });
    }, 120);
  }, [reportCursor, draft.eol, draft.bom]);
  useEffect(
    () => () => {
      clearTimeout(pause.current);
      reportCursor(null);
    },
    [reportCursor],
  );
  // A new click on a line number takes the observation of that line.
  const [motive, setMotive] = useState(() => motiveOf(opened));
  const active = !!motive && observations.some((item) => observationKey(item) === motive.key);
  // The sentence of an outcome yields to the observation once the user types over it.
  const [typedOver, setTypedOver] = useState<Outcome | undefined>();
  const [motiveInView, setMotiveInView] = useState(true);
  // The numbers of the lines: where each line is, the lines in view (with a few around them) and the
  // line of the cursor.
  const map = useRef(new LineMap());
  const text = useRef(draft.text);
  text.current = draft.text;
  const [numbered, setNumbered] = useState({ from: 0, to: 0, version: 0 });
  const [cursorLine, setCursorLine] = useState(-1);
  // The text with its changes, drawn in rows (only those around the view).
  const marks = !!draft.marks;
  // While a save or an undo runs, the text keeps showing what it showed (the pair changes once it ends).
  const lastComparison = useRef(comparisonOf(draft));
  const comparison = comparisonOf(draft) ?? (draft.busy ? lastComparison.current : undefined);
  lastComparison.current = comparison;
  const marksOn = useRef(marks);
  marksOn.current = marks;
  const diff = useMemo(
    () => (marks && comparison ? diffLines(comparison.before, comparison.after) : undefined),
    [marks, comparison?.before, comparison?.after],
  );
  const rows = useMemo(() => (diff ? markRows(diff) : undefined), [diff]);
  // The height of each row: a line of the text as the map measured it; a removed line (or the block)
  // measured the same way. Read while drawing, from the textarea that stays behind.
  const blockText = (count: number) =>
    plural(count, '{count} line replaced as one block', '{count} lines replaced as one block');
  const layout = useMemo(() => {
    const element = area.current;
    if (!rows || !element || !comparison) return undefined;
    map.current.sync(element, comparison.after);
    const others = measureLines(
      element,
      rows.flatMap((row) =>
        row.kind === 'removed' ? [row.text] : row.kind === 'block' ? [blockText(row.count)] : [],
      ),
    );
    let next = 0;
    const tops = [0];
    rows.forEach((row, index) =>
      tops.push(
        tops[index] +
          (row.kind === 'same' || row.kind === 'added'
            ? (map.current.heights[row.line - 1] ?? 0)
            : others[next++]),
      ),
    );
    return { tops };
    // The rows and the language of the block; the width is the textarea's, unchanged while they show.
  }, [rows, plural]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const marksBox = useRef<HTMLDivElement>(null);
  const [shownRows, setShownRows] = useState<{ from: number; to: number; tops?: number[] }>({
    from: 0,
    to: 0,
  });
  /**
   * The lines (or rows) in view, with some around them, after a change of the text, of the scroll or of
   * the width: the map follows the text, and the numbers are drawn only where they can be seen.
   */
  const view = useCallback(() => {
    const element = area.current;
    const place = element && areaOf(element);
    if (!element || !place) return;
    const changed = map.current.sync(element, text.current);
    const room = place.bottom - place.top;
    if (marksOn.current) {
      const box = marksBox.current;
      const tops = layoutRef.current?.tops;
      if (!box || !tops) return;
      // Three times the rows that fit, at most: one view above, the view, one view below; drawn again
      // only when the view comes within a quarter of a view of the edge of what is drawn.
      const origin = box.getBoundingClientRect().top + TEXT_TOP;
      const rowAt = (y: number) => Math.max(0, upperBound(tops, y) - 1);
      const last = tops.length - 1;
      const need = {
        from: rowAt(place.top - origin - room / 4),
        to: Math.min(last, upperBound(tops, place.bottom - origin + room / 4)),
      };
      const from = rowAt(place.top - origin - room);
      const to = Math.min(last, upperBound(tops, place.bottom - origin + room));
      setShownRows((previous) =>
        previous.tops === tops && previous.from <= need.from && previous.to >= need.to
          ? previous
          : { from, to, tops },
      );
      return;
    }
    const origin = element.getBoundingClientRect().top + TEXT_TOP;
    const from = map.current.lineAt(place.top - origin - room / 4);
    const to = map.current.lineAt(place.bottom - origin + room / 4) + 1;
    setNumbered((previous) =>
      !changed && previous.from === from && previous.to === to
        ? previous
        : { from, to, version: previous.version + 1 },
    );
    setCursorLine(map.current.lineOf(selection.current.start));
  }, []);
  // After each change of the text (a key, an undo) and each switch, before the screen is drawn.
  useLayoutEffect(view, [draft.text, marks, layout, view]);
  useEffect(() => {
    const element = area.current;
    const place = element && areaOf(element);
    if (!element || !place) return;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(view);
    };
    place.area.addEventListener('scroll', later, { passive: true });
    // A change of width wraps the lines again: the map measures them all.
    const observer = new ResizeObserver(later);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      place.area.removeEventListener('scroll', later);
      observer.disconnect();
    };
  }, [view]);
  // Switching keeps the first line of the file in view where it is: what a removed line adds above it
  // is given back by the scroll.
  const marksHeld = useRef<{ line: number; top: number }>(undefined);
  useEffect(() => {
    markHolds.set(path, () => {
      const element = area.current;
      const place = element && areaOf(element);
      marksHeld.current = undefined;
      if (!element || !place) return;
      if (!marksOn.current) {
        map.current.sync(element, text.current);
        const origin = element.getBoundingClientRect().top + TEXT_TOP;
        const index = map.current.lineAt(place.top - origin);
        marksHeld.current = { line: index + 1, top: origin + map.current.tops[index] };
        return;
      }
      const box = marksBox.current;
      const tops = layoutRef.current?.tops;
      const list = rowsRef.current;
      if (!box || !tops || !list) return;
      const origin = box.getBoundingClientRect().top + TEXT_TOP;
      for (
        let index = Math.max(0, upperBound(tops, place.top - origin) - 1);
        index < list.length;
        index++
      ) {
        const row = list[index];
        if (row.kind === 'same' || row.kind === 'added') {
          marksHeld.current = { line: row.line, top: origin + tops[index] };
          return;
        }
      }
    });
    return () => void markHolds.delete(path);
  }, [path]);
  const firstSwitch = useRef(true);
  useLayoutEffect(() => {
    if (firstSwitch.current) {
      firstSwitch.current = false;
      return;
    }
    const element = area.current;
    const place = element && areaOf(element);
    const held = marksHeld.current;
    marksHeld.current = undefined;
    if (!element || !place) return;
    if (held) {
      let top: number | undefined;
      if (marks) {
        const box = marksBox.current;
        const index = rowsRef.current?.findIndex(
          (row) => (row.kind === 'same' || row.kind === 'added') && row.line === held.line,
        );
        if (box && layout && index !== undefined && index >= 0)
          top = box.getBoundingClientRect().top + TEXT_TOP + layout.tops[index];
      } else top = element.getBoundingClientRect().top + TEXT_TOP + map.current.tops[held.line - 1];
      if (top !== undefined) place.area.scrollTop += top - held.top;
    }
    if (marks) {
      // No change in view: the area slides to the nearest one.
      const box = marksBox.current;
      const list = rowsRef.current;
      if (!box || !list || !layout) return;
      const origin = box.getBoundingClientRect().top + TEXT_TOP;
      let nearest: { top: number; bottom: number; distance: number } | undefined;
      list.forEach((row, index) => {
        if (row.kind === 'same') return;
        const top = origin + layout.tops[index];
        const bottom = origin + layout.tops[index + 1];
        const distance =
          bottom <= place.top ? place.top - bottom : top >= place.bottom ? top - place.bottom : 0;
        if (!nearest || distance < nearest.distance) nearest = { top, bottom, distance };
      });
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 0;
      const max = place.area.scrollHeight - place.area.clientHeight;
      let by = 0;
      if (nearest && nearest.distance > 0)
        by =
          nearest.top >= place.bottom
            ? nearest.bottom - place.bottom + 2 * lineHeight
            : nearest.top - place.top - 2 * lineHeight;
      // And at least eight lines of text in view: the text goes up until it starts at the top of the
      // area, if it must.
      const textTop = box.getBoundingClientRect().top + TEXT_TOP - by;
      if (place.bottom - Math.max(place.top, textTop) < 8 * lineHeight - 0.5)
        by = Math.max(by, textTop + by - place.top);
      if (by) slide(place.area, Math.max(0, Math.min(max, place.area.scrollTop + by)));
    }
    view();
    // Only on a switch; the rest is read as it is then.
  }, [marks]);
  // Esc goes back to the text to edit (a dialog on top answers its own Esc first).
  useEffect(() => {
    if (!marks) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      editing.toggleMarks(path, false);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [marks, path]);
  // Nothing left to compare (a conflict came): back to the text to edit.
  useEffect(() => {
    if (marks && !comparison) editing.toggleMarks(path, false);
  });
  // At the highlighted line (only the destination written there selected), else where the cursor was.
  // Entering keeps the line the read-only text had where it was; a later click on a line number brings
  // that line to the middle of the area.
  const first = useRef(true);
  const lineRef = useRef(line);
  lineRef.current = line;
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const entering = first.current;
    first.current = false;
    const focus = editing.takeFocus(path) || !entering;
    const kept = editing.positions.get(path);
    const at = line > 0 ? placeAt(element.value, line, target, syntax) : undefined;
    if (focus) element.focus({ preventScroll: true });
    if (at) element.setSelectionRange(at.start, at.end);
    else if (entering && kept) element.setSelectionRange(kept.start, kept.end);
    else if (entering) element.setSelectionRange(0, 0);
    track();
    if (entering) {
      if (restoreEditorPlace(path, element)) makeRoom(element);
    } else if (line > 0) {
      setMotive(motiveOf(opened) ?? motive);
      centerLine(element, line);
    }
    // The line, its destination and a new click on it move the cursor; the rest is read as it is.
  }, [line, target, syntax, jump]);
  // The text replaced from outside the field (Undo, the version on disk): the cursor stays where it
  // was instead of going to the end, which would scroll the area to the end of the file.
  const shownText = useRef(draft.text);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element || shownText.current === draft.text) return;
    shownText.current = draft.text;
    if (element.value !== draft.text) return;
    const { start, end } = selection.current;
    const length = element.value.length;
    element.setSelectionRange(Math.min(start, length), Math.min(end, length));
  }, [draft.text]);
  // Leaving (Close editor, another file): the line in view stays where it is for the read-only text.
  useEffect(() => {
    leaveHolds.set(path, () => {
      if (area.current) holdEditorPlace(path, area.current, lineRef.current);
    });
    return () => void leaveHolds.delete(path);
  }, [path]);
  useLayoutEffect(() => {
    const element = area.current;
    const positions = editing.positions;
    return () => {
      if (!element) return;
      positions.set(path, {
        start: element.selectionStart,
        end: element.selectionEnd,
        scroll: 0,
      });
      holdEditorPlace(path, element, lineRef.current);
      // Leaving the file ends the offer to give back a discarded text.
      queueMicrotask(() => editing.forgetDiscarded(path));
    };
  }, [path, editing.positions]);
  // Ctrl+S anywhere in the window saves this file while its editor is on the screen, and never reaches
  // the browser (which would offer to save the page).
  const save = useRef(editing.save);
  save.current = editing.save;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save.current(path);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [path]);
  // Whether the line of the observation in the list is in view, above the state line.
  const motiveRow = useCallback(() => {
    const element = area.current;
    const place = element && areaOf(element);
    if (!place || !motive) return undefined;
    const rows = [
      ...place.area.querySelectorAll<HTMLElement>('.file-observations [data-observation-key]'),
    ];
    return { place, row: rows.find((row) => row.dataset.observationKey === motive.key) };
  }, [motive]);
  useLayoutEffect(() => {
    const element = area.current;
    const place = element && areaOf(element);
    if (!place) return;
    const check = () => {
      const found = motiveRow();
      const rect = found?.row?.querySelector('.file-observation-row')?.getBoundingClientRect();
      setMotiveInView(
        !!rect &&
          !!found &&
          rect.top >= found.place.top - 0.5 &&
          rect.bottom <= found.place.bottom + 0.5,
      );
    };
    check();
    place.area.addEventListener('scroll', check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(place.area);
    return () => {
      place.area.removeEventListener('scroll', check);
      observer.disconnect();
    };
  }, [motiveRow, observations]);
  /** A click on the observation named in the state line: the area slides to the list of observations. */
  const toMotiveNow = () => {
    const found = motiveRow();
    if (!found) return;
    const { place } = found;
    const list = place.area.querySelector<HTMLElement>('.file-observations');
    const target = found.row ?? list;
    if (!target) return;
    const room = place.bottom - place.top;
    const listTop = (list ?? target).getBoundingClientRect().top - place.top + place.area.scrollTop;
    const rowBottom = target.getBoundingClientRect().bottom - place.top + place.area.scrollTop;
    slide(place.area, Math.max(0, rowBottom - listTop > room ? rowBottom - room : listTop));
  };
  // The same function for every drawing: the state line is drawn again only when what it says changes
  // (scrolling draws the numbers, not the line).
  const motiveNow = useRef(toMotiveNow);
  motiveNow.current = toMotiveNow;
  const toMotive = useCallback(() => motiveNow.current(), []);
  const outcome = draft.outcome;
  const motiveShown =
    active &&
    !motiveInView &&
    !draft.busy &&
    !draft.conflict &&
    !draft.nothing &&
    (!outcome || typedOver === outcome);
  return (
    <section
      className="file-editor"
      data-path={path}
      aria-label={t('Editor of {name}', { name: draft.name })}
    >
      <div
        className="editor-lines"
        style={{ '--line-digits': String(draft.text.split('\n').length).length } as CSSProperties}
      >
        {/* The numbers of the lines in view, at the top of each line as the map measured it (a line
            that wraps has its number on its first visual line). */}
        {!marks && (
          <div className="editor-gutter" aria-hidden="true">
            {Array.from({ length: Math.max(0, numbered.to - numbered.from) }, (_, offset) => {
              const index = numbered.from + offset;
              return (
                <span
                  key={index}
                  className={index === cursorLine ? 'is-current' : undefined}
                  style={{ top: map.current.tops[index] }}
                >
                  {index + 1}
                </span>
              );
            })}
          </div>
        )}
        {marks && rows && layout && (
          <MarksView
            ref={marksBox}
            rows={rows}
            tops={layout.tops}
            from={shownRows.from}
            to={shownRows.to}
            block={blockText}
            name={draft.name}
          />
        )}
        <textarea
          ref={area}
          className={`editor-text${marks ? ' is-behind' : ''}`}
          aria-hidden={marks || undefined}
          tabIndex={marks ? -1 : undefined}
          readOnly={marks}
          aria-label={t('Text of {name}', { name: draft.name })}
          spellCheck={false}
          value={draft.text}
          onChange={(event) => {
            shownText.current = event.target.value;
            // The next edit also ends the offer to give back a discarded text.
            editing.store.update(path, (current) => ({
              text: event.target.value,
              nothing: false,
              ...(current.outcome?.kind === 'discarded' ? { outcome: undefined } : {}),
            }));
            setTypedOver(draft.outcome);
            track();
          }}
          onSelect={track}
          onKeyUp={track}
          onClick={track}
        />
      </div>
      {/* At the foot of the inspector, out of the area that scrolls: focusing one of its actions never
          scrolls the text, and the caret is never under it. */}
      {foot &&
        createPortal(
          <EditorStatus
            editing={editing}
            draft={draft}
            motive={motive}
            motiveShown={motiveShown}
            onMotive={toMotive}
            menu={menu}
            changes={marks ? diff : undefined}
          />,
          foot,
        )}
    </section>
  );
}

/** The stale scan notice, in the line of notices under the bar. */
export function StaleNotice({ editing, onRescan }: { editing: Editing; onRescan: () => void }) {
  const { plural, t, formatDate } = useI18n();
  if (!editing.stale.length) return null;
  const at = editing.model?.delta?.current.at;
  const time = at ? formatDate(at, 'time') : '';
  return (
    <div className="change-notice stale-notice" role="status">
      <span>
        {time
          ? plural(
              editing.stale.length,
              'Stale scan: {count} file saved after the scan of {time}',
              'Stale scan: {count} files saved after the scan of {time}',
              { time },
            )
          : plural(
              editing.stale.length,
              'Stale scan: {count} file saved after the scan',
              'Stale scan: {count} files saved after the scan',
            )}
      </span>
      <button onClick={onRescan}>{t('Rescan')}</button>
    </div>
  );
}

/** "Line 5, column 16 · CRLF · BOM": the editor's cursor, as the bottom bar says it. */
export function cursorText(cursor: Cursor, t: ReturnType<typeof useI18n>['t']) {
  return [
    t('Line {line}, column {column}', {
      line: String(cursor.line),
      column: String(cursor.column),
    }),
    cursor.eol === 'crlf' ? 'CRLF' : '',
    cursor.bom ? 'BOM' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One unsaved document in the list, drawn as a row of the saved projects list. */
function PendingItem({ editing, draft }: { editing: Editing; draft: Draft }) {
  const { t } = useI18n();
  const { copy, copied } = useCopy();
  const [shown, setShown] = useState(false);
  const model = editing.model;
  const node = model?.nodes.some((item) => item.id === draft.path && isDocument(item));
  const granted = !!model?.editing[draft.root];
  const state = draft.busy
    ? t('Saving…')
    : draft.conflict
      ? t('Changed on disk')
      : draft.outcome?.kind === 'missing'
        ? t('No longer on disk')
        : !node
          ? t('Not in the current scan')
          : !granted
            ? t('Editing off in this project')
            : t('Not saved');
  return (
    <li className="pending-item">
      <div className="pending-head">
        <FileText size={14} aria-hidden="true" />
        <strong title={draft.path}>
          {model ? projectPath(model.roots, draft.path) : draft.path}
        </strong>
        <span className="pending-state">{state}</span>
      </div>
      <div className="pending-actions">
        <button
          onClick={() => (node ? editing.reveal(draft.path) : setShown(!shown))}
          aria-expanded={node ? undefined : shown}
        >
          {node ? t('Open') : t('Show text')}
        </button>
        <button onClick={() => void copy(draft.text)}>{copied ? t('Copied') : t('Copy')}</button>
        {node && granted && (
          <button
            aria-disabled={!!draft.busy || undefined}
            onClick={() => {
              // A conflict or the review after one is decided where both versions show.
              if (draft.review || draft.conflict) editing.reveal(draft.path);
              if (!draft.conflict) editing.save(draft.path);
            }}
          >
            {t('Save')}
          </button>
        )}
        <button onClick={() => void editing.confirmDiscard(draft.path)}>{t('Discard')}</button>
      </div>
      {shown && !node && (
        <textarea
          className="pending-text"
          readOnly
          aria-label={t('Text of {name}', { name: draft.name })}
          value={draft.text}
        />
      )}
    </li>
  );
}

/**
 * The conflict, as the wide dialog: what you changed and what changed on disk side by side, each list
 * scrolling in the body so that the ways out in the footer stay in the window. With nothing typed there is
 * nothing of the user's to keep: only the version on disk to take.
 */
function ConflictDialog({ editing, draft }: { editing: Editing; draft: Draft }) {
  const { t } = useI18n();
  const { copy, copied } = useCopy();
  const disk = draft.conflict!;
  const mine = useMemo(() => diffLines(draft.baseText, draft.text), [draft.baseText, draft.text]);
  const theirs = useMemo(() => diffLines(draft.baseText, disk.text), [draft.baseText, disk.text]);
  const later = () => editing.decideLater(draft.path);
  return (
    <Modal
      title={t('The file changed on disk')}
      subtitle={t('Another program saved {name} after you opened it. Nothing was overwritten.', {
        name: draft.name,
      })}
      wide
      onClose={later}
    >
      <div className={`edit-dialog-body conflict-body${draft.dirty ? '' : ' single'}`}>
        {draft.dirty && (
          <section>
            <h3>{t('What you changed')}</h3>
            <DiffList diff={mine} label={t('What you changed')} />
          </section>
        )}
        <section>
          <h3>{t('What changed on disk')}</h3>
          <DiffList diff={theirs} label={t('What changed on disk')} />
        </section>
      </div>
      <footer className="modal-footer">
        {draft.dirty ? (
          <button className="text-button" onClick={() => void copy(draft.text)}>
            {copied ? t('Copied') : t('Copy my text')}
          </button>
        ) : (
          <span />
        )}
        <div>
          <button data-autofocus onClick={later}>
            {t('Decide later')}
          </button>
          {draft.dirty ? (
            <>
              <button className="danger" onClick={() => editing.discardMine(draft.path)}>
                {t('Discard my text')}
              </button>
              <button
                className="primary"
                title={t(
                  'Keeps your text over the new version on disk; saving then shows what of that version it undoes.',
                )}
                onClick={() => editing.keepMine(draft.path)}
              >
                {t('Keep my text')}
              </button>
            </>
          ) : (
            <button className="primary" onClick={() => editing.takeDisk(draft.path)}>
              {t('Reload from disk')}
            </button>
          )}
        </div>
      </footer>
    </Modal>
  );
}

/** The dialogs of editing, all with the app's `Modal`: the safe button focused, Esc cancels. */
export function EditingDialogs({ editing }: { editing: Editing }) {
  const { t, plural } = useI18n();
  const resolving = useSyncExternalStore(editing.store.subscribe, editing.store.resolveKey);
  const conflict = useSyncExternalStore(editing.store.subscribe, () =>
    resolving ? editing.store.get(resolving.split('\n')[0]) : undefined,
  );
  const { permission, question } = editing.dialogs;
  // The list follows each draft (saving, conflict) while it is open.
  useSyncExternalStore(editing.store.subscribe, () =>
    editing.dialogs.listShown ? editing.store.version() : 0,
  );
  const reviewing = useSyncExternalStore(editing.store.subscribe, editing.store.reviewKey);
  const review = reviewing ? editing.store.get(reviewing.split('\n')[0]) : undefined;
  const reviewDiff = useMemo(
    () => (review ? diffLines(review.baseText, review.text) : undefined),
    [review],
  );
  const limits = editLimits();
  const model = editing.model;
  const pending = editing.store.list().filter((draft) => draft.dirty);
  return (
    <>
      {permission && model && limits && (
        <Modal
          title={t('Allow the app to save the documents of {project}?', {
            project:
              model.roots.find((root) => root.path === permission.root)?.name ?? permission.root,
          })}
          onClose={editing.dialogs.cancelPermission}
        >
          <div className="edit-dialog-body">
            <p>
              {plural(
                editableCount(model.roots, model.nodes, permission.root, limits),
                'Up to {count} Markdown file, which may hold instructions, commands or skills: what is saved in it applies to the agents and can make them run commands.',
                'Up to {count} Markdown files, and some are instructions, commands or skills: what is saved in them applies to the agents and can make them run commands.',
              )}
            </p>
            <p>
              {t(
                'Editing stays on in this project until you turn it off in the bottom bar; the app keeps no earlier versions, so use Git for history.',
              )}
            </p>
            {permission.refused && <RefusalNote refused={permission.refused} />}
          </div>
          <footer className="modal-footer">
            <span />
            <div>
              <button data-autofocus onClick={editing.dialogs.cancelPermission}>
                {t('Cancel')}
              </button>
              <button
                className="primary"
                aria-disabled={permission.working || undefined}
                onClick={() => !permission.working && editing.dialogs.allow()}
              >
                {t('Allow editing')}
              </button>
            </div>
          </footer>
        </Modal>
      )}
      {review && reviewDiff && (
        <Modal
          title={t('Save over the version on disk?')}
          wide
          onClose={() => editing.store.update(review.path, { reviewing: false })}
        >
          <div className="edit-dialog-body">
            <p>
              {t(
                'You kept your text over a newer version on disk. Saving replaces that version; what it changes:',
              )}
            </p>
            <DiffList diff={reviewDiff} label={t('What the save changes on disk')} />
          </div>
          <footer className="modal-footer">
            <span />
            <div>
              <button
                data-autofocus
                onClick={() => editing.store.update(review.path, { reviewing: false })}
              >
                {t('Cancel')}
              </button>
              <button
                className="primary"
                onClick={() => {
                  editing.store.update(review.path, { reviewing: false });
                  editing.save(review.path, true);
                }}
              >
                {t('Confirm save')}
              </button>
            </div>
          </footer>
        </Modal>
      )}
      {editing.dialogs.listShown && (
        <Modal title={t('Unsaved documents')} onClose={editing.dialogs.hideList}>
          <div className="edit-dialog-body">
            {pending.length ? (
              <ul className="pending-list">
                {pending.map((draft) => (
                  <PendingItem key={draft.path} editing={editing} draft={draft} />
                ))}
              </ul>
            ) : (
              <p>{t('No unsaved documents.')}</p>
            )}
          </div>
        </Modal>
      )}
      {conflict?.conflict && <ConflictDialog editing={editing} draft={conflict} />}
      {question && (
        <Modal title={question.title} onClose={() => editing.dialogs.answer(false)}>
          <div className="edit-dialog-body">
            <p>{question.message}</p>
          </div>
          <footer className="modal-footer">
            <span />
            <div>
              <button data-autofocus onClick={() => editing.dialogs.answer(false)}>
                {t('Cancel')}
              </button>
              <button className="danger" onClick={() => editing.dialogs.answer(true)}>
                {question.action}
              </button>
            </div>
          </footer>
        </Modal>
      )}
    </>
  );
}

/** The projects with editing on and the unsaved count, as the bottom bar says them. */
export function editingStatus(editing: Editing, model: Model | undefined) {
  const on = (model?.roots ?? []).filter((root) => model?.editing[root.path]);
  return { on, pending: editing.pending.length };
}
