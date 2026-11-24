import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Trash2,
  X,
  FileText,
  Check,
} from 'lucide-react';
import { api, loadModel } from './api';
import { useI18n } from './i18n';
import type { Translator } from './i18n';
import type { Model } from './types';

/** The dialogs on the screen, in the order they opened: only the last one answers the keyboard. */
const openModals: object[] = [];

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
  small = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** The small dialog of a confirmation. */
  small?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // Read when a key arrives: a caller that passes a new function on each render does not move the focus.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const token = {};
    openModals.push(token);
    // The control marked `data-autofocus` (Cancel, in a confirmation), else the first one.
    (
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('input,button')
    )?.focus();
    const key = (event: KeyboardEvent) => {
      // A dialog opened over another one (a confirmation) takes the keys; the one below waits.
      if (openModals.at(-1) !== token) return;
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select,textarea,summary,[tabindex="0"]',
          ) || [],
        );
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      openModals.splice(openModals.indexOf(token), 1);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      // A press on the shade (the second click of a double click that opened the dialog) keeps the focus
      // where it is, on Cancel in a confirmation.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        ref={ref}
        className={`modal${wide ? ' wide' : ''}${small ? ' small' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label={t('Close dialog')} onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function OpenDialog({
  home,
  onClose,
  onOpen,
}: {
  home: string;
  onClose: () => void;
  onOpen: (path: string) => Promise<void>;
}) {
  const { t, plural } = useI18n();
  const [path, setPath] = useState(home);
  const [listing, setListing] = useState<{
    path: string;
    parent: string;
    directories: { name: string; path: string }[];
  }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pathVersion = useRef(0);
  async function browse(value: string) {
    const version = pathVersion.current;
    setBusy(true);
    setError('');
    try {
      const data = await api<NonNullable<typeof listing>>(
        `directories?path=${encodeURIComponent(value)}`,
      );
      setListing(data);
      if (pathVersion.current === version) setPath(data.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void browse(home);
  }, [home]);
  return (
    <Modal
      title={t('Add folder')}
      subtitle={t('The folder is saved as a project and opens alongside the current ones.')}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void browse(path);
        }}
        className="path-form"
      >
        <input
          aria-label={t('Folder path')}
          value={path}
          onChange={(e) => {
            pathVersion.current++;
            setPath(e.target.value);
          }}
          placeholder="/home/…"
        />
        <button disabled={busy}>
          {t('Go')} <ChevronRight size={15} />
        </button>
      </form>
      <div className="browser-toolbar">
        <button onClick={() => void browse(listing?.parent || home)} disabled={busy}>
          <ArrowLeft size={14} /> {t('Up')}
        </button>
        <span>
          {plural(listing?.directories.length ?? 0, '{count} folder', '{count} folders', {
            context: 'listing',
          })}
        </span>
      </div>
      <div className="directory-list">
        {listing?.directories.map((dir) => (
          <button key={dir.path} onClick={() => void browse(dir.path)} disabled={busy}>
            <Folder size={17} />
            <span>{dir.name}</span>
            <ChevronRight size={14} />
          </button>
        ))}
        {listing?.directories.length === 0 && <p className="empty-small">{t('No subfolders.')}</p>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-footer">
        <span />
        <button
          className="primary"
          disabled={busy || !path.trim()}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const directory = await api<{ path: string }>(
                `directories?path=${encodeURIComponent(path)}`,
              );
              await onOpen(directory.path);
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          <FolderOpen size={16} />
          {busy ? t('Scanning…', { context: 'button' }) : t('Open this folder')}
        </button>
      </footer>
    </Modal>
  );
}

/**
 * The × that forgets a project (open or closed): the same icon button wherever a project is listed, with a
 * name that says what it does and to which project. It only asks; `ForgetDialog` does the rest.
 */
export function ForgetButton({
  name,
  disabled,
  onForget,
  size = 14,
}: {
  name: string;
  disabled?: boolean;
  onForget: () => void;
  size?: number;
}) {
  const { t } = useI18n();
  return (
    <button
      className="icon-button forget-button"
      aria-label={t('Forget project {name}…', { name })}
      title={t('Forget…')}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onForget();
      }}
    >
      <X size={size} aria-hidden="true" />
    </button>
  );
}

/**
 * "Forget": the project leaves the app, closed first when it is open. It always asks, in the small dialog of
 * the app, saying what is erased and what is not touched; Cancel has the focus, and Esc or Cancel change
 * nothing. When the project has notes (`notes`, counted by the server: what the option erases), a box
 * offers to erase them too, unchecked each time the dialog opens, with a sentence that follows it. Both
 * sentences keep their place, so checking the box never moves the buttons. `drafts`: unsaved note drafts of
 * the project, which are discarded either way. `edits`: documents of the project with unsaved edits, which
 * stay in the list of unsaved documents, only to copy.
 */
export function ForgetDialog({
  name,
  notes,
  drafts,
  edits,
  onForget,
  onClose,
}: {
  name: string;
  notes: number;
  drafts: number;
  edits: number;
  /** Resolves when the project left the app; a rejection is shown here and the dialog stays. */
  onForget: (eraseNotes: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t, plural } = useI18n();
  const [erase, setErase] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  // While the request runs, Esc and the × of the dialog wait for it.
  const busy = useRef(false);
  const close = () => {
    if (!busy.current) onClose();
  };
  const kept = plural(
    notes,
    'The {count} note stays saved and comes back if you add {name} again.',
    'The {count} notes stay saved and come back if you add {name} again.',
    { name },
  );
  const erased = plural(
    notes,
    'The {count} note is erased now. It cannot be recovered.',
    'The {count} notes are erased now. They cannot be recovered.',
  );
  return (
    <Modal title={t('Forget {name}?', { name })} onClose={close} small>
      <div className="confirm-body">
        <p>
          {t(
            'The project leaves the app. Its Changes baseline, its marks of “expected” and its editing permission are erased. The folder and the files on disk are not touched.',
          )}
        </p>
        {notes > 0 && (
          <div className="confirm-option">
            <label>
              <input
                type="checkbox"
                checked={erase}
                disabled={working}
                onChange={(event) => setErase(event.target.checked)}
              />
              {plural(
                notes,
                'Also erase the {count} note of this project',
                'Also erase the {count} notes of this project',
              )}
            </label>
            <p className="confirm-consequence">
              <span aria-hidden={erase || undefined}>{kept}</span>
              <span aria-hidden={!erase || undefined}>{erased}</span>
            </p>
          </div>
        )}
        {drafts > 0 && (
          <p>
            {plural(
              drafts,
              '{count} note draft of this project was not saved and is discarded.',
              '{count} note drafts of this project were not saved and are discarded.',
            )}
          </p>
        )}
        {edits > 0 && (
          <p>
            {plural(
              edits,
              '{count} document of this project has unsaved edits. It stays in the list of unsaved documents, only to copy: with the project out of the app, it cannot be saved to the file.',
              '{count} documents of this project have unsaved edits. They stay in the list of unsaved documents, only to copy: with the project out of the app, they cannot be saved to the files.',
            )}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-footer">
        <span />
        <div>
          <button data-autofocus disabled={working} onClick={close}>
            {t('Cancel')}
          </button>
          <button
            className="danger"
            disabled={working}
            onClick={async () => {
              busy.current = true;
              setWorking(true);
              setError('');
              try {
                await onForget(erase);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                busy.current = false;
                setWorking(false);
              }
            }}
          >
            {t('Forget project')}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

export function CasesDialog({
  model,
  onClose,
  onAdd,
  onOpen,
  onForget,
}: {
  model: Model;
  onClose: () => void;
  onAdd: () => void;
  onOpen: (path: string, replace?: boolean) => Promise<void>;
  /** Asks to forget a saved project, in the dialog of the app, over this one. */
  onForget: (path: string) => void;
}) {
  const { t } = useI18n();
  const [cases, setCases] = useState(model.savedCases);
  // A project forgotten over this dialog leaves its list.
  useEffect(() => {
    setCases(model.savedCases);
  }, [model.savedCases]);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    loadModel('workspace')
      .then((next) => {
        if (!cancelled) setCases(next.savedCases);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const current = cases.find((item) => item.path === selected);
  const visible = cases.filter((item) =>
    `${item.name} ${item.path}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  async function open(replace: boolean) {
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      await onOpen(current.path, replace);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      // Also when the switch was cancelled (unsaved documents in a project that would leave).
      setBusy(false);
    }
  }
  return (
    <Modal title={t('Open project')} onClose={onClose}>
      <div className="case-toolbar">
        <input
          aria-label={t('Search saved projects')}
          placeholder={t('Name or folder path…')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button disabled={busy} onClick={onAdd}>
          <Plus size={15} /> {t('Add folder')}
        </button>
      </div>
      <div className="saved-case-list" aria-label={t('Saved projects')} aria-busy={loading}>
        {visible.map((item) => {
          const opened = model.roots.some((root) => root.path === item.path);
          return (
            <div className="saved-case" key={item.path}>
              <button
                className="case-choice"
                aria-pressed={selected === item.path}
                disabled={busy}
                onClick={() => setSelected(item.path)}
              >
                <Folder size={17} />
                <span>
                  <strong>{item.name}</strong>
                  <code>{item.path}</code>
                  <small>
                    {item.available
                      ? opened
                        ? t('Opened')
                        : t('Saved · closed')
                      : t('Unavailable · check that the folder exists and can be read')}
                  </small>
                </span>
              </button>
              <ForgetButton
                name={item.name}
                disabled={busy || loading}
                onForget={() => onForget(item.path)}
              />
            </div>
          );
        })}
        {!visible.length && (
          <p className="empty-small">
            {loading
              ? t('Checking projects…')
              : cases.length
                ? t('No project matches the search.')
                : t('No saved projects.')}
          </p>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-footer case-footer">
        <span>{t('Switch closes the other projects.')}</span>
        <div>
          <button disabled={busy || loading || !current?.available} onClick={() => void open(true)}>
            {t('Switch')}
          </button>
          <button
            className="primary"
            disabled={busy || loading || !current?.available}
            onClick={() => void open(false)}
          >
            <FolderOpen size={15} />
            {busy ? t('Working…') : t('Open')}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

const nodeTypes = ['agent', 'memory', 'tool', 'policy', 'workflow', 'document'] as const;
type NodeType = (typeof nodeTypes)[number];
// The type of a node is a contract code; its label is resolved when shown.
function nodeTypeLabel(type: NodeType, t: Translator['t']) {
  switch (type) {
    case 'agent':
      return t('Agent');
    case 'memory':
      return t('Memory');
    case 'tool':
      return t('Tool');
    case 'policy':
      return t('Policy');
    case 'workflow':
      return t('Workflow');
    case 'document':
      return t('Document');
  }
}
export function CreateDialog({
  parent: initialParent,
  onClose,
  onCreated,
}: {
  parent: string;
  onClose: () => void;
  onCreated: (model: Model) => void;
}) {
  const { t, plural, language: interfaceLanguage } = useI18n();
  const [parent, setParent] = useState(initialParent);
  // The default names and the starter text are in the language of the moment the dialog opens, so
  // the review and the creation send the same one.
  const [language] = useState(interfaceLanguage);
  const [name, setName] = useState(() => t('my-architecture'));
  // Each file has a stable id, never its name: the relations point to it, so typing a name that is
  // for a moment equal to another file's cannot move that file's relations. Names enter only the body.
  const nextId = useRef(3);
  const [primitives, setPrimitives] = useState(() => [
    {
      id: 0,
      name: t('assistant'),
      type: 'agent',
      description: t('what this agent does and hands back; open it when you take this role.'),
    },
    {
      id: 1,
      name: t('context'),
      type: 'memory',
      description: t('decisions in force; read before changing what was already decided.'),
    },
    {
      id: 2,
      name: t('rules'),
      type: 'policy',
      description: t('rules the work must follow; read before you finish a task.'),
    },
  ]);
  const [relationships, setRelationships] = useState(() => [
    { source: 0, target: 1, type: 'reads' },
    { source: 2, target: 0, type: 'governs' },
  ]);
  const nameOf = (id: number) => primitives.find((p) => p.id === id)?.name ?? '';
  const fileList = useRef<HTMLDivElement>(null);
  // After a file is removed, the focus goes to the control that took the place of its button.
  const [refocus, setRefocus] = useState<number>();
  useEffect(() => {
    if (refocus === undefined) return;
    setRefocus(undefined);
    const box = fileList.current?.children[Math.min(refocus, primitives.length - 1)];
    const remove = box?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (remove ?? box?.querySelector<HTMLInputElement>('input'))?.focus();
  }, [refocus, primitives.length]);
  const [preview, setPreview] = useState<Record<string, string>>();
  const [active, setActive] = useState('AGENTS.md');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const payload = {
    parent,
    name,
    language,
    primitives: primitives.map(({ name, type, description }) => ({ name, type, description })),
    relationships: relationships.map((r) => ({
      source: nameOf(r.source),
      target: nameOf(r.target),
      type: r.type,
    })),
  };
  const currentPayload = useRef('');
  currentPayload.current = JSON.stringify(payload);
  // While the server answers, the buttons stay focusable (aria-disabled): disabling them would drop
  // the focus to the page. When the review appears, the focus goes to its open file in the list; back
  // in the form, to its first field, as when the dialog opens.
  const blueprintNav = useRef<HTMLElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const reviewed = useRef(false);
  useEffect(() => {
    if (preview) {
      reviewed.current = true;
      blueprintNav.current?.querySelector<HTMLElement>('.active')?.focus({ preventScroll: true });
    } else if (reviewed.current) form.current?.querySelector<HTMLElement>('input')?.focus();
  }, [preview]);
  // The open file is brought into view inside the list, never by scrolling the dialog.
  useEffect(() => {
    const nav = blueprintNav.current;
    const item = nav?.querySelector<HTMLElement>('.active');
    if (!nav || !item) return;
    const top = item.getBoundingClientRect().top - nav.getBoundingClientRect().top;
    if (top < 0 || top + item.offsetHeight > nav.clientHeight)
      nav.scrollTop += top - (nav.clientHeight - item.offsetHeight) / 2;
  }, [preview, active]);
  async function reviewOrCreate() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (preview) {
        onCreated(await loadModel('create', payload));
      } else {
        const requested = currentPayload.current;
        const result = await api<{ files: Record<string, string> }>('blueprint', payload);
        if (currentPayload.current !== requested)
          throw new Error(t('The proposal changed while reading. Review the files again.'));
        setActive('AGENTS.md');
        setPreview(result.files);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changePrimitive(index: number, key: string, value: string) {
    setPrimitives(primitives.map((p, i) => (i === index ? { ...p, [key]: value } : p)));
  }
  return (
    <Modal
      title={preview ? t('Review new architecture') : t('New architecture')}
      subtitle={
        preview
          ? undefined
          : t('Each file below is created on disk; each relation becomes a Markdown link.')
      }
      onClose={onClose}
      wide
    >
      {!preview ? (
        <div className="create-form" ref={form}>
          <div className="form-grid">
            <label>
              {t('Parent folder')}
              <input value={parent} onChange={(e) => setParent(e.target.value)} />
            </label>
            <label>
              {t('New folder name')}
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <div className="section-heading">
            <h3>{t('Files', { context: 'form' })}</h3>
            <button
              onClick={() =>
                setPrimitives([
                  ...primitives,
                  {
                    id: nextId.current++,
                    name: t('file-{number}', { number: String(primitives.length + 1) }),
                    type: 'document',
                    description: '',
                  },
                ])
              }
            >
              <Plus size={14} /> {t('Add file')}
            </button>
          </div>
          <div className="primitive-list" ref={fileList}>
            {primitives.map((p, i) => (
              <div className="primitive primitive-file" key={p.id}>
                <FileText size={16} />
                <input
                  aria-label={t('File {number} name', { number: i + 1 })}
                  value={p.name}
                  onChange={(e) => changePrimitive(i, 'name', e.target.value)}
                />
                <select
                  aria-label={t('File {number} type', { number: i + 1 })}
                  value={p.type}
                  onChange={(e) => changePrimitive(i, 'type', e.target.value)}
                >
                  {nodeTypes.map((type) => (
                    <option key={type} value={type}>
                      {nodeTypeLabel(type, t)}
                    </option>
                  ))}
                </select>
                <input
                  className="primitive-description"
                  aria-label={t('File {number} description', { number: i + 1 })}
                  placeholder={t('When to open')}
                  maxLength={200}
                  value={p.description}
                  // One line: a pasted tab becomes a space, as the browser already does with a line break.
                  onChange={(e) =>
                    changePrimitive(i, 'description', e.target.value.replace(/\p{Cc}/gu, ' '))
                  }
                />
                <button
                  aria-label={t('Remove file {number}', { number: i + 1 })}
                  className="icon-button"
                  disabled={primitives.length < 2}
                  onClick={() => {
                    setPrimitives(primitives.filter((_, j) => i !== j));
                    setRefocus(i);
                    setRelationships(
                      relationships.filter((r) => r.source !== p.id && r.target !== p.id),
                    );
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
          <div className="section-heading">
            <h3>{t('Relations', { context: 'form' })}</h3>
            <button
              disabled={!primitives.length}
              onClick={() =>
                setRelationships([
                  ...relationships,
                  {
                    source: primitives[0].id,
                    target: primitives.at(-1)!.id,
                    type: 'references',
                  },
                ])
              }
            >
              <Plus size={14} /> {t('Connect files')}
            </button>
          </div>
          <div className="primitive-list">
            {relationships.map((r, i) => (
              <div className="primitive" key={i}>
                <select
                  aria-label={t('Relation {number} source', { number: i + 1 })}
                  value={r.source}
                  onChange={(e) =>
                    setRelationships(
                      relationships.map((v, j) =>
                        j === i ? { ...v, source: Number(e.target.value) } : v,
                      ),
                    )
                  }
                >
                  {primitives.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('Relation {number} type', { number: i + 1 })}
                  value={r.type}
                  onChange={(e) =>
                    setRelationships(
                      relationships.map((v, j) => (j === i ? { ...v, type: e.target.value } : v)),
                    )
                  }
                >
                  <option value="references">{t('references →')}</option>
                  <option value="reads">{t('reads →')}</option>
                  <option value="uses">{t('uses →')}</option>
                  <option value="governs">{t('governs →')}</option>
                </select>
                <select
                  aria-label={t('Relation {number} target', { number: i + 1 })}
                  value={r.target}
                  onChange={(e) =>
                    setRelationships(
                      relationships.map((v, j) =>
                        j === i ? { ...v, target: Number(e.target.value) } : v,
                      ),
                    )
                  }
                >
                  {primitives.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={t('Remove relation {number}', { number: i + 1 })}
                  className="icon-button"
                  onClick={() => setRelationships(relationships.filter((_, j) => i !== j))}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="blueprint">
          <div className="blueprint-location">
            <Folder size={16} />
            {parent}/{name}
          </div>
          <div className="blueprint-body">
            <nav ref={blueprintNav}>
              {Object.keys(preview).map((file) => (
                <button
                  className={active === file ? 'active' : ''}
                  key={file}
                  onClick={() => setActive(file)}
                >
                  <FileText size={14} />
                  {file}
                </button>
              ))}
            </nav>
            <pre>{preview[active]}</pre>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-footer">
        <span>
          {preview ? plural(Object.keys(preview).length, '{count} file', '{count} files') : ''}
        </span>
        <div>
          {preview && (
            <button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) setPreview(undefined);
              }}
            >
              {t('Back')}
            </button>
          )}
          <button
            className="primary"
            aria-disabled={busy || undefined}
            onClick={() => void reviewOrCreate()}
          >
            {preview ? <Check size={16} /> : <ChevronRight size={16} />}{' '}
            {busy ? t('Working…') : preview ? t('Create and open') : t('Review files')}
          </button>
        </div>
      </footer>
    </Modal>
  );
}
