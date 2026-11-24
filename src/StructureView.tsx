import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  FileSymlink,
  FileText,
  Folder,
} from 'lucide-react';
import type { FileNode, Model } from './types';
import { analyzedExtensions, isFile, kinds, outsideInventory } from './types';
import { dirname } from './scopeNavigation';
import { ItemDecorationsContext } from './itemDecorations';
import { plural, t, useI18n } from './i18n';
import { listingCauses, omittedAtLeast } from './partialReading';
import { folderBoundary } from './folderMap';
import './structure.css';

const PAGE = 200;
/** A real item of the reading (file, folder or symlink), never a reference placeholder. */
const inventoried = (node: FileNode) =>
  (isFile(node) || node.kind === 'directory') && !outsideInventory.has(node.status);
const extension = (name: string) =>
  name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
/** Why a file has no references of its own in this reading, or null when its text was analysed. */
function readingState(node: FileNode) {
  if (node.kind === 'symlink')
    return {
      label: t('not followed'),
      title: t('Symbolic link listed without following its target.'),
    };
  if (node.analysis === 'parsed') return null;
  if (node.analysis === 'partial')
    return {
      label: t('partly read'),
      title: t('Text partly read: the limits are in the Audit.'),
    };
  if (node.analysis === 'skipped')
    return {
      label: t('not read'),
      title: t('Text listed but not read: size limit or read failure (see the Audit).'),
    };
  return {
    label: t('not read'),
    title: t(
      'Type not read ({extension}): the reader only looks for references in {extensions}. Other files can still be referenced.',
      {
        extension: extension(node.name) || t('no extension'),
        extensions: analyzedExtensions.join(', '),
      },
    ),
  };
}

/**
 * A folder cut by the inventory limit or left in part out of the reading by a name it could not read ("not
 * read" / "partly read"), never shown as an empty folder; null when read. The tooltip names the cause.
 * `bounded`: the names-only walk past the limit hit its own limit, so the count of items left out is a minimum.
 */
function listingState(node: FileNode | undefined, bounded: boolean) {
  if (!node || node.kind !== 'directory') return null;
  if (node.listing !== 'unread' && node.listing !== 'partial') return null;
  const omitted = node.omitted ?? 0;
  const atLeast = omittedAtLeast(node);
  // Whole sentences, joined by a space at the end of the tooltip.
  const minimum = [
    ...(bounded && omitted
      ? [t('The number is a minimum: the count beyond the limit also stopped.')]
      : []),
    ...(atLeast
      ? [
          t(
            'The number is a minimum: what is inside a folder with an unreadable name is not counted.',
          ),
        ]
      : []),
  ];
  const { limit, unreadable } = listingCauses(node);
  const see = t('see the folder observation');
  const limitWords = t(
    'There may be observations missing here, and references into it are checked for existence only.',
  );
  if (node.listing === 'unread') {
    const main = !unreadable
      ? t(
          'The item limit stopped before this folder: nothing in it was listed or read. {limitWords} Open it as a project to read it.',
          { limitWords },
        )
      : limit
        ? t(
            'Nothing in this folder entered the scan: there is a name that is not valid UTF-8 ({see}), and the item limit left the rest out. {limitWords} Open it as a project to read it.',
            { see, limitWords },
          )
        : t(
            'Nothing in this folder entered the scan: the reader could not read the folder or the names in it ({see}). There may be observations missing here.',
            { see },
          );
    return {
      label: !omitted
        ? t('not read', { context: 'folder' })
        : atLeast
          ? plural(
              omitted,
              'not read · at least {count} item on disk',
              'not read · at least {count} items on disk',
            )
          : plural(omitted, 'not read · {count} item on disk', 'not read · {count} items on disk'),
      title: [main, ...minimum].join(' '),
    };
  }
  const main = !unreadable
    ? t(
        'The item limit stopped in the middle of this folder: part of the items was neither listed nor read. {limitWords} Open it as a project to read all of it.',
        { limitWords },
      )
    : limit
      ? t(
          'Part of the items in this folder was left out of the scan: the item limit stopped in the middle of it, and there is a name that is not valid UTF-8 ({see}). {limitWords} Open it as a project to read all of it.',
          { see, limitWords },
        )
      : t(
          'There is a name in this folder that is not valid UTF-8: that item was left out of the scan ({see}). There may be observations missing here.',
          { see },
        );
  return {
    label: atLeast
      ? plural(
          omitted,
          'partly read · at least {count} item left out',
          'partly read · at least {count} items left out',
        )
      : plural(
          omitted,
          'partly read · {count} item left out',
          'partly read · {count} items left out',
        ),
    title: [main, ...minimum].join(' '),
  };
}

/**
 * A label of a cell that may be cut with an ellipsis in a narrow view: the tooltip has its whole text only
 * while it is cut (measured as the pointer comes in), and the explanation of the label, if any, always.
 */
function Cut({
  as: Tag = 'span',
  className,
  text,
  note,
}: {
  as?: 'span' | 'em';
  className: string;
  text: string;
  note?: string;
}) {
  const [cut, setCut] = useState(false);
  const title = cut ? (note ? `${text}\n${note}` : text) : note;
  return (
    <Tag
      className={className}
      title={title || undefined}
      onMouseEnter={(event) =>
        setCut(event.currentTarget.scrollWidth > event.currentTarget.clientWidth)
      }
    >
      {text}
    </Tag>
  );
}
/** Level-2 line for a folder the limit cut: the text in the warning tone. */
function Listing({ state, title }: { state: { label: string; title: string }; title?: string }) {
  return (
    <span className="structure-listing" title={title ?? state.title}>
      {state.label}
    </span>
  );
}

/** A number of a column (Structure, the list of Home): right-aligned, its words for screen readers only. */
export function Count({
  value,
  label,
  title,
}: {
  /** null: not applicable to this item ("–"). */
  value: number | null;
  label: string;
  title: string;
}) {
  const { formatNumber } = useI18n();
  return (
    <span className={`structure-count${value ? '' : ' is-zero'}`} title={title}>
      <span aria-hidden="true">{value === null ? '–' : formatNumber(value)}</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/**
 * Folder structure of the file system, as a list under one header of columns: folders first, every
 * inventoried item (analysed or not), the class of each special file and its references as numbers
 * (the words are in the header once, and in a hidden text per cell). It is never a canvas of all nodes:
 * the map of references opens for one file at a time.
 */
export default function StructureView({
  model,
  directory,
  highlight,
  showConventions,
  onSelect,
}: {
  model: Model;
  directory: string;
  highlight?: string;
  showConventions: boolean;
  /** Files are selected (the list stays, the inspector opens on them); folders are navigated to. */
  onSelect: (id: string) => void;
}) {
  const { t, plural } = useI18n();
  const { marker, include, filterName } = useContext(ItemDecorationsContext);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const list = useRef<HTMLDivElement>(null);
  const children = useMemo(() => {
    const map = new Map<string, FileNode[]>();
    for (const node of model.nodes)
      if (inventoried(node)) {
        const parent = dirname(node.path);
        const siblings = map.get(parent);
        if (siblings) siblings.push(node);
        else map.set(parent, [node]);
      }
    for (const items of map.values())
      items.sort(
        (a, b) =>
          Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
          a.name.localeCompare(b.name),
      );
    return map;
  }, [model.nodes]);
  // Distinct files on the other end, as the inspector counts them; self-references apart.
  const tallies = useMemo(() => {
    const outgoing = new Map<string, Set<string>>(),
      incoming = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, value: string) => {
      const set = map.get(key);
      if (set) set.add(value);
      else map.set(key, new Set([value]));
    };
    for (const edge of model.edges) {
      if (edge.source === edge.target || (!showConventions && edge.kind === 'scope')) continue;
      add(outgoing, edge.source, edge.target);
      add(incoming, edge.target, edge.source);
    }
    return { outgoing, incoming };
  }, [model.edges, showConventions]);
  // A filter keeps the folders on the way to every kept file.
  const keptFolders = useMemo(() => {
    if (!include) return null;
    const folders = new Set<string>();
    for (const node of model.nodes)
      if (inventoried(node) && node.kind !== 'directory' && include(node))
        for (let path = dirname(node.path); path && !folders.has(path); path = dirname(path))
          folders.add(path);
    return folders;
  }, [model.nodes, include]);
  const shown = (node: FileNode) =>
    !include || (node.kind === 'directory' ? !!keptFolders?.has(node.path) : include(node));
  // With a filter, the summary counts the files it keeps in this folder and below (of all of them there).
  const filtered = useMemo(() => {
    if (!include) return null;
    let kept = 0,
      total = 0;
    for (const node of model.nodes)
      if (inventoried(node) && node.kind !== 'directory' && node.path.startsWith(`${directory}/`)) {
        total++;
        if (include(node)) kept++;
      }
    return { kept, total };
  }, [model.nodes, include, directory]);
  useEffect(() => {
    if (!highlight) return;
    const frame = requestAnimationFrame(() =>
      [...(list.current?.querySelectorAll<HTMLElement>('[data-structure-id]') || [])]
        .find((element) => element.dataset.structureId === highlight)
        ?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [highlight, directory]);
  const isRoot = model.roots.some((root) => root.path === directory);
  const parent = dirname(directory);
  const top = (children.get(directory) || []).filter(shown);
  const folders = top.filter((node) => node.kind === 'directory').length;
  const files = top.length - folders;
  const analysed = top.filter((node) => node.kind !== 'directory' && !readingState(node)).length;
  const label = directory.split('/').at(-1) || directory;
  const bounded = model.stats?.inventory?.lookupComplete === false;
  const here = listingState(
    model.nodes.find((node) => node.id === directory),
    bounded,
  );
  function toggle(path: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function row(node: FileNode, depth: number): ReactNode {
    const folder = node.kind === 'directory';
    const open = folder && expanded.has(node.path);
    const state = folder ? null : readingState(node);
    const reads = !state || node.analysis === 'partial';
    const out = tallies.outgoing.get(node.id)?.size || 0,
      into = tallies.incoming.get(node.id)?.size || 0;
    const entries = folder
      ? (children.get(node.path) || [])
          .filter((child) => child.kind === 'entry')
          .map((child) => child.name)
      : [];
    const ownEntry = entries.length
      ? plural(entries.length, 'own {names}', 'own {names}', {
          names: entries.reduce((list, name) =>
            t('{first} and {second}', { first: list, second: name }),
          ),
        })
      : '';
    const items = folder ? (children.get(node.path) || []).filter(shown).length : 0;
    const itemsText = items ? plural(items, '{count} item', '{count} items') : t('empty');
    const listing = listingState(node, bounded);
    const kind = folder || node.kind === 'file' ? null : kinds[node.kind] || node.kind;
    return (
      <li key={node.id}>
        <div
          className={`structure-row ${folder ? 'is-folder' : `is-file kind-${node.kind}`}${state ? ' is-unanalysed' : ''}${highlight === node.id ? ' is-selected' : ''}`}
          data-structure-id={node.id}
          style={{ paddingLeft: 8 + depth * 18 }}
          // Anywhere on a file's line does what its name does; the controls on it keep their own action.
          onClick={
            folder
              ? undefined
              : (event) => {
                  if (!(event.target as Element).closest('button, a, input')) onSelect(node.id);
                }
          }
        >
          <span className="structure-name">
            {folder ? (
              <button
                className="structure-toggle"
                aria-expanded={open}
                aria-label={
                  open
                    ? t('Hide contents of {name}', { name: node.name })
                    : t('Show contents of {name}', { name: node.name })
                }
                title={open ? t('Hide contents') : t('Show contents here')}
                onClick={() => toggle(node.path)}
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : (
              <span className="structure-spacer" />
            )}
            <button
              className="structure-open"
              title={`${node.path}${kind ? ` · ${kind}` : ''}${state ? ` · ${state.label}` : ''}${folder && !listing ? ` · ${itemsText}` : ''}\n${folder ? t("Open this folder's structure") : t('Select and open in the inspector')}`}
              aria-current={highlight === node.id ? 'true' : undefined}
              onClick={() => onSelect(node.id)}
            >
              {folder ? (
                <Folder size={15} />
              ) : node.kind === 'symlink' ? (
                <FileSymlink size={15} />
              ) : (
                <FileText size={15} />
              )}
              <span>{node.name}</span>
            </button>
            {folder &&
              (listing ? (
                <Listing
                  state={listing}
                  title={`${plural(items, '{count} item', '{count} items')}. ${listing.title}`}
                />
              ) : (
                <Cut className="structure-items" text={itemsText} />
              ))}
          </span>
          <span className="structure-class">
            {folder ? (
              entries.length > 0 && (
                <Cut
                  as="em"
                  className="structure-own-entry"
                  text={ownEntry}
                  note={t(
                    'Folder with its own entry point: opening it shows a view of it next to the parent folder view',
                  )}
                />
              )
            ) : (
              <>
                {kind && <Cut className={`structure-kind ${node.kind}`} text={kind} />}
                {state && <Cut className="structure-state" text={state.label} note={state.title} />}
              </>
            )}
          </span>
          {folder ? (
            // A folder: what crosses its edge, in distinct files (the sums of the map of its parent).
            (() => {
              const edge = folderBoundary(model, node.path, showConventions);
              return (
                <>
                  <Count
                    value={edge.out}
                    label={plural(
                      edge.out,
                      'references {count} file outside the folder',
                      'references {count} files outside the folder',
                    )}
                    title={plural(
                      edge.out,
                      'Files of this folder reference {count} file outside it (distinct)',
                      'Files of this folder reference {count} files outside it (distinct)',
                    )}
                  />
                  <Count
                    value={edge.into}
                    label={plural(
                      edge.into,
                      'referenced by {count} file outside the folder',
                      'referenced by {count} files outside the folder',
                    )}
                    title={plural(
                      edge.into,
                      '{count} file outside this folder references files of it (distinct)',
                      '{count} files outside this folder reference files of it (distinct)',
                    )}
                  />
                </>
              );
            })()
          ) : (
            <>
              <Count
                value={reads ? out : null}
                label={
                  reads
                    ? plural(out, 'points to {count} file', 'points to {count} files')
                    : t('points to: {state}', { state: state?.label ?? '' })
                }
                title={
                  reads
                    ? plural(
                        out,
                        'Points to {count} file (distinct)',
                        'Points to {count} files (distinct)',
                      )
                    : state?.title || ''
                }
              />
              <Count
                value={into}
                label={plural(into, 'referenced by {count} file', 'referenced by {count} files')}
                title={plural(
                  into,
                  'Referenced by {count} file (distinct)',
                  'Referenced by {count} files (distinct)',
                )}
              />
            </>
          )}
          <span className="structure-marker" data-slot="marker">
            {marker?.(node)}
          </span>
        </div>
        {open && <ul className="structure-list">{rows(node.path, depth + 1)}</ul>}
      </li>
    );
  }
  function rows(folder: string, depth: number): ReactNode[] {
    const items = (children.get(folder) || []).filter(shown);
    const limit = limits[folder] ?? PAGE;
    const rendered = items.slice(0, limit).map((node) => row(node, depth));
    if (items.length > limit)
      rendered.push(
        <li key="more">
          <button
            className="structure-more"
            style={{ marginLeft: 8 + depth * 18 }}
            onClick={() => setLimits((previous) => ({ ...previous, [folder]: limit + PAGE }))}
          >
            {t('Show more ({count})', { count: items.length - limit })}
          </button>
        </li>,
      );
    return rendered;
  }
  return (
    <div
      className="structure-view"
      ref={list}
      aria-label={t('Structure of {name}', { name: label })}
      role="region"
    >
      <div className="structure-columns">
        <div className="structure-grid">
          <span className="structure-summary">
            {filtered ? (
              <span
                title={t(
                  'The filter above the tree applies to the tree and the Structure; the map does not change',
                )}
              >
                {t('{filter}: {files} in this folder and its subfolders (of {total})', {
                  filter: filterName ?? t('Class filter'),
                  files: plural(filtered.kept, '{count} file', '{count} files'),
                  total: filtered.total,
                })}
              </span>
            ) : (
              <span>
                {plural(folders, '{count} folder', '{count} folders')} ·{' '}
                {plural(files, '{count} file', '{count} files')} ·{' '}
                <span
                  title={t('Read for references: {extensions}', {
                    extensions: analyzedExtensions.join(', '),
                  })}
                >
                  {plural(analysed, '{count} read', '{count} read')}
                </span>
              </span>
            )}
            {/* Reading state of the folder shown (not read, read in part), with or without a class filter. */}
            {here && <Listing state={here} />}
          </span>
          <span className="structure-heading is-class" aria-hidden="true">
            {t('class')}
          </span>
          <span
            className="structure-heading is-number"
            aria-hidden="true"
            title={t('Distinct files the item points to, not counting the file itself')}
          >
            {t('points to')}
          </span>
          <span
            className="structure-heading is-number"
            aria-hidden="true"
            title={t('Distinct files that reference the item, not counting the file itself')}
          >
            {t('referenced by')}
          </span>
          <span
            className="structure-heading is-number"
            aria-hidden="true"
            title={t('Problems and warnings of the Audit about the item')}
          >
            {t('observations')}
          </span>
        </div>
      </div>
      <ul className="structure-list structure-root">
        {!isRoot && parent && (
          <li>
            <button
              className="structure-up"
              title={parent}
              aria-label={t('Folder above: {name}', { name: parent.split('/').at(-1) ?? '' })}
              onClick={() => onSelect(parent)}
            >
              <CornerLeftUp size={14} />
              <span>..</span>
              <small>{parent.split('/').at(-1)}</small>
            </button>
          </li>
        )}
        {rows(directory, 0)}
      </ul>
      {!top.length && (
        <p className="structure-empty">
          {include && children.get(directory)?.length
            ? t(
                'No item of this class filter in this folder. Clear the filter above the tree to see all.',
              )
            : here
              ? t('Folder {label}. {details}', { label: here.label, details: here.title })
              : t('Empty folder.')}
        </p>
      )}
    </div>
  );
}
