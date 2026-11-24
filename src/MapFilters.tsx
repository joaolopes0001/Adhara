import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FileQuestion, Filter, Pencil, Plus, X } from 'lucide-react';
import Canvas from './Canvas';
import { Modal } from './Dialogs';
import { useI18n } from './i18n';
import { evaluateFilter, FILTER_NODE_LIMIT } from './mapFilters';
import type { FilterResult, MapFilter } from './mapFilters';
import type { Model } from './types';
import { isFile, isUnresolved, statuses, unresolvedLabels } from './types';
import type { Theme } from './theme';

export function FilterDialog({
  model,
  filters,
  initial,
  onSave,
  onDelete,
  onHighlight,
  onOpen,
  onClose,
}: {
  model: Model;
  filters: MapFilter[];
  initial: string;
  onSave: (filter: MapFilter) => void;
  onDelete: (id: string) => void;
  onHighlight: (id: string) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { t, plural } = useI18n();
  const blank = (): MapFilter => ({
    id: '',
    name: '',
    files: model.nodes.some((node) => node.id === initial && node.kind !== 'directory')
      ? [initial]
      : [],
    kind: 'connections',
    direction: 'both',
    conventions: false,
  });
  const [draft, setDraft] = useState<MapFilter>(blank);
  const [query, setQuery] = useState('');
  const matches = useMemo(
    () =>
      model.nodes.filter(
        (node) =>
          node.kind !== 'directory' &&
          node.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
          !draft.files.includes(node.id),
      ),
    [model.nodes, query, draft.files],
  );
  // Unresolved destinations are not files: they stay collapsed under the real candidates.
  const candidates = matches.filter(isFile),
    unresolved = matches.filter(isUnresolved);
  const valid = draft.name.trim() && draft.files.length >= (draft.kind === 'paths' ? 2 : 1);
  const save = (action: 'highlight' | 'pane') => {
    const filter = { ...draft, id: draft.id || crypto.randomUUID(), name: draft.name.trim() };
    onSave(filter);
    if (action === 'highlight') onHighlight(filter.id);
    else onOpen(filter.id);
    onClose();
  };
  return (
    <Modal title={t('Map filters')} wide onClose={onClose}>
      <div className="filter-editor">
        <nav className="saved-filters" aria-label={t('Saved filters')}>
          <button
            onClick={() => {
              setDraft(blank());
              setQuery('');
            }}
          >
            <Plus size={14} /> {t('New filter')}
          </button>
          {filters.map((filter) => (
            <div key={filter.id}>
              <strong title={filter.name}>{filter.name}</strong>
              <small>
                {filter.kind === 'paths'
                  ? t('{count} files · paths', { count: filter.files.length })
                  : t('{count} files · relations', { count: filter.files.length })}
              </small>
              <div>
                <button
                  onClick={() => {
                    onHighlight(filter.id);
                    onClose();
                  }}
                >
                  {t('Highlight')}
                </button>
                <button
                  onClick={() => {
                    onOpen(filter.id);
                    onClose();
                  }}
                >
                  {t('Open view')}
                </button>
                <button
                  aria-label={t('Edit filter {name}', { name: filter.name })}
                  onClick={() => {
                    setDraft(filter);
                    setQuery('');
                  }}
                >
                  <Pencil size={12} />
                </button>
                <button
                  aria-label={t('Delete filter {name}', { name: filter.name })}
                  onClick={() => {
                    onDelete(filter.id);
                    if (draft.id === filter.id) setDraft(blank());
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}
        </nav>
        <div className="filter-form">
          <label>
            {t('Filter name')}
            <input
              aria-label={t('Filter name')}
              placeholder={t('E.g. CLAUDE relations')}
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="filter-options">
            <label>
              {t('Show')}
              <select
                aria-label={t('Filter type')}
                value={draft.kind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    kind: e.target.value as MapFilter['kind'],
                    direction: 'both',
                  })
                }
              >
                <option value="connections">{t('File relations')}</option>
                <option value="paths">{t('Paths between files')}</option>
              </select>
            </label>
            <label>
              {t('Direction')}
              <select
                aria-label={t('Filter direction')}
                value={draft.direction}
                onChange={(e) =>
                  setDraft({ ...draft, direction: e.target.value as MapFilter['direction'] })
                }
              >
                <option value="both">
                  {draft.kind === 'paths' ? t('Both directions') : t('Incoming and outgoing')}
                </option>
                <option value="outgoing">
                  {draft.kind === 'paths' ? t('Follow arrows') : t('Outgoing only')}
                </option>
                {draft.kind === 'connections' && (
                  <option value="incoming">{t('Incoming only')}</option>
                )}
              </select>
            </label>
          </div>
          {draft.kind === 'paths' && (
            <p>
              {t(
                'Union of one shortest path per pair. Intermediate files are included; arrows keep their original direction.',
              )}
            </p>
          )}
          <div className="filter-files" aria-label={t('Filter files')}>
            {draft.files.map((path) => (
              <div key={path}>
                <code title={path}>{path}</code>
                <button
                  aria-label={t('Remove {path} from the filter', { path })}
                  onClick={() =>
                    setDraft({ ...draft, files: draft.files.filter((id) => id !== path) })
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <label>
            {t('Add files')}
            <input
              aria-label={t('Search file for filter')}
              placeholder={t('Name or path, e.g. CLAUDE.md')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="filter-candidates" aria-label={t('Filter search results')}>
            {candidates.slice(0, 60).map((node) => (
              <button
                key={node.id}
                title={node.path}
                onClick={() => {
                  setDraft({ ...draft, files: [...draft.files, node.id] });
                  setQuery('');
                }}
              >
                <Plus size={13} />
                <span>
                  {node.name}
                  <small>{node.path}</small>
                </span>
              </button>
            ))}
            {!candidates.length && <p>{t('No other file matches the search.')}</p>}
            {candidates.length > 60 && (
              <p>
                {t('{count} results. Narrow the search to see other paths.', {
                  count: candidates.length,
                })}
              </p>
            )}
          </div>
          {unresolved.length > 0 && (
            <details className="unresolved-group filter-unresolved">
              <summary>
                {plural(unresolved.length, '{count} target not found', '{count} targets not found')}
              </summary>
              {unresolved.slice(0, 60).map((node) => (
                <button
                  key={node.id}
                  className="unresolved-item"
                  title={node.path}
                  onClick={() => {
                    setDraft({ ...draft, files: [...draft.files, node.id] });
                    setQuery('');
                  }}
                >
                  <FileQuestion size={13} />
                  <span>
                    {node.name}
                    <small>{node.path}</small>
                  </span>
                  <em className={`unresolved-tag ${node.status}`}>
                    {unresolvedLabels[node.status] || statuses[node.status] || node.status}
                  </em>
                </button>
              ))}
              {unresolved.length > 60 && (
                <p>
                  {t('First {limit} of {count}. Narrow the search.', {
                    limit: 60,
                    count: unresolved.length,
                  })}
                </p>
              )}
            </details>
          )}
          <label className="filter-conventions">
            <input
              type="checkbox"
              checked={draft.conventions}
              onChange={(e) => setDraft({ ...draft, conventions: e.target.checked })}
            />{' '}
            {t('Include scope conventions')}
          </label>
        </div>
      </div>
      <footer className="modal-footer">
        <span>
          {t('Filters are saved in this browser.')}
          <br />
          {draft.kind === 'paths' && draft.files.length < 2
            ? t('Select at least two files.')
            : plural(draft.files.length, '{count} file selected', '{count} files selected')}
        </span>
        <div>
          <button disabled={!valid} onClick={() => save('highlight')}>
            {t('Save and highlight')}
          </button>
          <button className="primary" disabled={!valid} onClick={() => save('pane')}>
            {t('Save and open view')}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

function FilterSummary({
  result,
  filter,
  model,
}: {
  result: FilterResult;
  filter: MapFilter;
  model: Model;
}) {
  const { t, plural, rich } = useI18n();
  const warnings = result.missing.length + result.disconnected.length;
  return (
    <details className="filter-summary">
      <summary>
        {plural(result.edges.size, '{count} relation', '{count} relations')} ·{' '}
        {plural(result.nodes.size, '{count} element', '{count} elements')}
        {warnings > 0 && ` · ${plural(warnings, '{count} warning', '{count} warnings')}`}
        {result.limited && ` · ${t('partial result')}`}
      </summary>
      <div>
        <p>
          {t('{kind} · {direction} · {scope}.', {
            kind: filter.kind === 'paths' ? t('One shortest path per pair') : t('Direct relations'),
            direction:
              filter.direction === 'both'
                ? t('both directions')
                : filter.direction === 'incoming'
                  ? t('incoming')
                  : t('following the arrows'),
            scope: filter.conventions ? t('includes conventions') : t('explicit references'),
          })}
        </p>
        {result.edges.size === 0 && <p>{t('No relation found.')}</p>}
        {result.limited && (
          <p>
            {t(
              'Partial result: limit of {limit} elements, 600 relation pairs or search budget reached. {omitted} relations/paths omitted. Refine the filter; the paths shown stay complete.',
              { limit: FILTER_NODE_LIMIT, omitted: result.omitted },
            )}
          </p>
        )}
        {result.reversed.size > 0 && (
          <p>
            {plural(
              result.reversed.size,
              '{count} relation followed in reverse.',
              '{count} relations followed in reverse.',
            )}
          </p>
        )}
        {result.missing.map((path) => (
          <p key={path}>
            {rich('File outside the open folders: <code>{path}</code>', {
              path,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        ))}
        {result.disconnected.slice(0, 100).map(([a, b]) => (
          <p key={`${a}\0${b}`}>
            {rich('No path: <code>{from}</code> {arrow} <code>{to}</code>', {
              from: a,
              to: b,
              arrow: filter.direction === 'both' ? '↔' : '→',
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        ))}
        {result.disconnected.length > 100 && (
          <p>
            {t('{count} more pairs without a path. Refine the filter.', {
              count: result.disconnected.length - 100,
            })}
          </p>
        )}
        {model.issues.some((issue) => ['limit', 'unreadable'].includes(issue.code)) && (
          <p>{t('Partial scan: a relation may be missing.')}</p>
        )}
        <p>{t('Filter files:')}</p>
        {filter.files.map((path) => (
          <code className="filter-origin" key={path}>
            {path}
          </code>
        ))}
      </div>
    </details>
  );
}

export function FilterMap({
  model,
  filter,
  theme,
  isolate,
  onSelect,
  onEdge,
  onClose,
  controls,
}: {
  model: Model;
  filter: MapFilter;
  theme: Theme;
  isolate: boolean;
  onSelect: (id: string) => void;
  onEdge: (id: string) => void;
  onClose: () => void;
  controls?: ReactNode;
}) {
  const { t } = useI18n();
  const result = useMemo(() => evaluateFilter(model, filter), [model, filter]);
  const [selected, setSelected] = useState('');
  const anchor = filter.files.find((id) => model.nodes.some((node) => node.id === id)) || '';
  return (
    <section
      className="filter-pane"
      aria-label={t('Filter view {name}', { name: filter.name })}
      data-filter={filter.id}
    >
      <header>
        <Filter size={14} />
        <strong>{filter.name}</strong>
        <span>{isolate ? t('Filtered view') : t('Highlight', { context: 'view' })}</span>
        {controls || (
          <button
            className="icon-button"
            aria-label={
              isolate
                ? t('Close view {name}', { name: filter.name })
                : t('Close highlight {name}', { name: filter.name })
            }
            onClick={onClose}
          >
            <X size={14} />
          </button>
        )}
      </header>
      <Canvas
        model={model}
        theme={theme}
        selected={result.nodes.has(selected) ? selected : anchor}
        overviewPath=""
        trace={null}
        showConventions={filter.conventions}
        filter={result}
        isolate={isolate}
        pathsOnly={isolate && filter.kind === 'paths'}
        onSelect={(id) => {
          setSelected(id);
          onSelect(id);
        }}
        onEdge={onEdge}
      />
      <FilterSummary result={result} filter={filter} model={model} />
    </section>
  );
}
