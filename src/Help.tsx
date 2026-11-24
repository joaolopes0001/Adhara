import type { Model } from './types';
import { Modal } from './Dialogs';
import { useI18n } from './i18n';

/** The Help dialog: how to use each part of the window, and the limits of the reading in force. */
export function HelpDialog({
  policy,
  onClose,
}: {
  policy: Model['policy'] | undefined;
  onClose: () => void;
}) {
  const { t, rich } = useI18n();
  return (
    <Modal title={t('Help')} subtitle="v1.0" onClose={onClose}>
      <div className="help-content">
        <details>
          <summary>{t('Open a project')}</summary>
          <p>
            {rich(
              'In the <b>Projects</b> menu, <b>Add folder</b> saves a folder as a project and opens it. <b>Open project</b> lists the saved projects: Open adds the project to the open ones; Switch closes the others.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
          <p>
            {rich(
              'The house button shows <b>Home</b>: the list of projects. On a view, <b>–</b> hides it (the project stays open and scanned); <b>Close</b>, in the project menu of the tree, closes the project (it stays saved); <b>×</b>, on a row of Home or in Open project, forgets it: it leaves the app, after a confirmation.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
          <p>
            {rich(
              'The app does not rescan by itself: after changing files in another program, use <b>Rescan</b>.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Structure and Map')}</summary>
          <p>
            {t(
              'The Structure lists folders and files with the class, how many files each one references (points to), how many reference it (referenced by) and the observations; clicking a file opens the inspector. In the Map, double-click. The Map of a folder sums the references between its items; the number on an arrow opens the list.',
            )}
          </p>
          <p>
            {rich(
              'A folder with its own AGENTS.md or CLAUDE.md opens a view beside its parent’s; with two or more, each view has a header with Structure | Map, <b>Minimize</b> (kept in the Views strip) and <b>Close view</b> (subfolder or filter).',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Inspector')}</summary>
          <p>
            {rich(
              'Shows the text of the selected file, with its observations above. Tabs: File, Relations (what it references and what references it), Evidence (the excerpt of each reference) and Notes (your notes, saved in the app). <b>Set as A</b> and <b>Set as B</b> fill in the Trace.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
          <p>
            {rich(
              '<b>Edit</b> makes a Markdown file editable; the first time, it asks to turn editing on in the project, which the bottom bar turns off. <b>Save</b> (Ctrl+S) writes at once, never over a file changed on disk. <b>Show changes</b> marks added and removed lines. <b>Undo</b> reverts the last save.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Audit')}</summary>
          <p>
            {t(
              'Lists the observations of the open projects by level: Problems, Warnings, Info and All. Signals (cycles, repeated references, high fan-out) are kept apart, out of the count.',
            )}
          </p>
          <p>
            {rich(
              'The line number opens the file at that line. The rest of the row opens the detail, with <b>Mark as expected</b>, which takes the observation out of the counts in this app only, and <b>Declare in project…</b>, which shows the excerpt to write in the agent-architecture.json of the project.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Trace')}</summary>
          <p>
            {rich(
              'Looks for the shortest path from A to B through the written references. The fields take the absolute path or the path relative to the project; Enter traces. “Both directions” also follows arrows backwards. <b>Clear trace</b> closes the view of the trace.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Changes')}</summary>
          <p>
            {rich(
              'Compares the current scan with the baseline of each project: new or resolved files, relations and observations. The first scan is the baseline; it advances with <b>Update baseline</b>, stays valid after the server restarts and is erased when the project is forgotten.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Filters')}</summary>
          <p>
            {t(
              'Above the tree, the class (All, Instructions, Memory, Skills, Manifests, Other) and With observations filter the tree and the Structure, without changing the map.',
            )}
          </p>
          <p>
            {rich(
              '<b>Filters</b>, in the bottom bar, chooses files by their path and shows their relations or the paths between them, highlighted on the map or in a view of their own.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Create an architecture')}</summary>
          <p>
            {rich(
              '<b>New architecture</b> creates a new folder with files, types and relations, after you review each file, with editable default text; it never overwrites a folder.',
              { b: (chunks) => <strong>{chunks}</strong> },
            )}
          </p>
        </details>
        <details>
          <summary>{t('Shortcuts')}</summary>
          <p>
            {t(
              'Ctrl+O opens a saved project · Ctrl+K searches files · Ctrl+B or the button in the top bar shows or hides the explorer · Alt+←/→ goes back and forward. The More menu hides and shows the panels and switches the theme. The dividers accept dragging and arrow keys; double-click restores the size.',
            )}
          </p>
        </details>
        <details>
          <summary>{t('Scan limits')}</summary>
          <p>
            {t(
              '{items} items divided among the open projects, {file} MiB per file, {text} MiB of text per scan. Symbolic links are not followed.',
              {
                items: policy?.maxNodes ?? 20000,
                file: Math.round((policy?.maxFileBytes ?? 1048576) / 1048576),
                text: Math.round((policy?.maxTextBytes ?? 33554432) / 1048576),
              },
            )}
            {policy?.excluded.length
              ? ` ${t('Ignored folders: {folders}.', { folders: policy.excluded.join(', ') })}`
              : ''}{' '}
            {t(
              'A partial scan shows in the bottom bar or in a strip at the top; the link opens the limits in the Audit.',
            )}
          </p>
        </details>
      </div>
    </Modal>
  );
}
