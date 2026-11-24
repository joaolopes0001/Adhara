import { useMemo } from 'react';
import { Folder, FolderOpen, Plus } from 'lucide-react';
import type { Issue, Model } from './types';
import { isFile } from './types';
import { useI18n } from './i18n';
import { projectOf, showsMarker } from './observations';
import { ObservationMarker } from './Diagnosis';
import { Count } from './StructureView';
import { ForgetButton } from './Dialogs';
import './structure.css';

/** A path under the home folder written from `~`, as the user types it; any other path as it is. */
function shortPath(path: string, home: string) {
  if (!home || home === '/') return path;
  return path === home ? '~' : path.startsWith(home + '/') ? `~${path.slice(home.length)}` : path;
}

/** Home: the open projects, one row each, then the saved and closed ones. Never a canvas or a card per project. */
export default function HomeList({
  model,
  observations,
  home,
  busy,
  dialogOpen,
  onShow,
  onOpen,
  onForget,
  onAudit,
  onAdd,
  onCreate,
}: {
  model: Model;
  /** Active observations: the ones marked as expected are left out. */
  observations: Issue[];
  home: string;
  busy: boolean;
  dialogOpen: boolean;
  onShow: (path: string) => void;
  onOpen: (path: string) => void;
  onForget: (path: string) => void;
  onAudit: (path: string) => void;
  onAdd: () => void;
  onCreate: () => void;
}) {
  const { t, plural } = useI18n();
  const facts = useMemo(() => {
    const byRoot = new Map(
      model.roots.map((root) => [
        root.path,
        { files: 0, instructions: [] as string[], issues: [] as Issue[] },
      ]),
    );
    for (const node of model.nodes) {
      const item = node.root ? byRoot.get(node.root) : undefined;
      if (!item || !isFile(node)) continue;
      if (node.kind !== 'symlink') item.files++;
      if (node.kind === 'entry' && node.status === 'resolved')
        item.instructions.push(node.relative);
    }
    for (const issue of observations) {
      const root = projectOf(model.roots, issue.node);
      if (root) byRoot.get(root.path)?.issues.push(issue);
    }
    return byRoot;
  }, [model, observations]);
  const opened = new Set(model.roots.map((root) => root.path));
  const closed = model.savedCases.filter((item) => !opened.has(item.path));
  const row = (path: string, name: string, open: boolean, available: boolean) => {
    const fact = facts.get(path);
    const go = () => (open ? onShow(path) : available && onOpen(path));
    return (
      <li key={path}>
        <div
          className={`structure-row home-row ${open ? 'is-folder' : 'is-closed'}${available ? '' : ' is-unavailable'}`}
          data-project={path}
          // Anywhere on the row does what its name does; the controls on it keep their own action.
          onClick={(event) => {
            if (!(event.target as Element).closest('button, a, input')) go();
          }}
        >
          <span className="structure-name">
            <button
              className="structure-open"
              aria-label={
                open ? t('Show project {name}', { name }) : t('Open project {name}', { name })
              }
              title={`${path}\n${open ? t('Show its structure') : available ? t('Open this project') : t('The folder no longer exists or cannot be read')}`}
              disabled={!open && (!available || busy)}
              onClick={go}
            >
              {open ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{name}</span>
            </button>
            {!available && (
              <span
                className="structure-listing"
                title={t('The folder no longer exists or cannot be read')}
              >
                {t('unavailable')}
              </span>
            )}
          </span>
          <span className="structure-class home-path" title={path}>
            <bdi>{shortPath(path, home)}</bdi>
          </span>
          {fact ? (
            <>
              <Count
                value={fact.files}
                label={plural(fact.files, '{count} file', '{count} files')}
                title={plural(fact.files, '{count} file', '{count} files')}
              />
              <Count
                value={fact.instructions.length}
                label={plural(
                  fact.instructions.length,
                  '{count} instruction file',
                  '{count} instruction files',
                )}
                title={fact.instructions.join('\n') || t('No AGENTS.md or CLAUDE.md')}
              />
              <span className="structure-marker">
                {showsMarker(fact.issues) && (
                  <ObservationMarker items={fact.issues} onOpen={() => onAudit(path)} audit />
                )}
              </span>
            </>
          ) : (
            <>
              <span />
              <span />
              <span />
            </>
          )}
          <span className="home-actions">
            <ForgetButton name={name} disabled={busy} onForget={() => onForget(path)} />
          </span>
        </div>
      </li>
    );
  };
  return (
    <div className="home">
      <div className="welcome-actions">
        <button onClick={onAdd}>
          <FolderOpen size={16} /> {t('Add folder')}
        </button>
        <button onClick={onCreate}>
          <Plus size={16} /> {t('New architecture')}
        </button>
      </div>
      <div
        className="structure-view home-list"
        role="region"
        aria-label={t('Projects')}
        style={dialogOpen ? { visibility: 'hidden' } : undefined}
      >
        <div className="structure-columns">
          <div className="structure-grid">
            <span className="structure-summary">
              {plural(model.roots.length, '{count} open project', '{count} open projects')}
            </span>
            <span className="structure-heading is-class" aria-hidden="true">
              {t('folder')}
            </span>
            <span className="structure-heading is-number" aria-hidden="true">
              {t('files')}
            </span>
            <span className="structure-heading is-number" aria-hidden="true">
              {t('instructions')}
            </span>
            <span
              className="structure-heading is-number"
              aria-hidden="true"
              title={t('Problems and warnings of the Audit in the files of the project')}
            >
              {t('observations')}
            </span>
            <span />
          </div>
        </div>
        <ul className="structure-list structure-root">
          {model.roots.map((root) => row(root.path, root.name, true, true))}
          {closed.length > 0 && (
            <li className="home-group">
              {t('Saved and closed · {count}', { count: closed.length })}
            </li>
          )}
          {closed.map((item) => row(item.path, item.name, false, item.available))}
        </ul>
      </div>
    </div>
  );
}
