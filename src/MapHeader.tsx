import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { Crosshair, Layers, Maximize, Minus, MoreHorizontal, Plus, SwatchBook } from 'lucide-react';
import { useI18n } from './i18n';
import { MenuButton } from './MenuButton';
import type { MenuAction } from './MenuButton';

/** The zoom of a map, written by the map and read by its header: only the header renders again. */
export type ZoomStore = {
  value: number;
  set: (value: number) => void;
  subscribe: (listener: () => void) => () => void;
};
export function zoomStore(): ZoomStore {
  const listeners = new Set<() => void>();
  const store: ZoomStore = {
    value: 1,
    set(value) {
      if (value === store.value) return;
      store.value = value;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store;
}

/**
 * What gives way when the line has no room, first to last: the counts, "Focus selection" and the zoom
 * level leave whole for the "…" menu at the end of the line; then the name of the map shrinks to
 * NAME_EM (as the top bar shrinks the name of the project before the item shown); then "Fit"
 * leaves too, and only then the name ends where there is room. The legend and the zoom stay. A name cut
 * ends in an ellipsis and is whole in its tooltip.
 */
const LEAVING = ['count', 'focus', 'level', 'name', 'fit'] as const;
type Leaving = (typeof LEAVING)[number];
const NAME_EM = 14;

/**
 * The header line of a map, in the place and height of the Structure's: what the map shows and its
 * counts on the left; the legend, the zoom, "Fit" and "Focus selection" on the right. Nothing of it is
 * drawn over the map.
 */
export function MapHeader({
  label,
  note,
  count,
  countTitle,
  drawn,
  conventions,
  summed = false,
  zoom,
  minZoom,
  maxZoom,
  onZoomIn,
  onZoomOut,
  outside,
  onFit,
  onFocus,
}: {
  label: string;
  /** Said whole after the name (a partial reading). */
  note?: ReactNode;
  /** Counts of what is drawn, and their explanation in the tooltip. */
  count: string;
  countTitle: string;
  /** A map is drawn (a folder without references between its items says so in words instead). */
  drawn: boolean;
  conventions: boolean;
  /** The map of a folder: the legend also says what the width of an arrow is. */
  summed?: boolean;
  zoom: ZoomStore;
  minZoom: number;
  maxZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Part of the map lies outside the view: "Fit" takes the colour and the underline of a link. */
  outside: boolean;
  onFit: () => void;
  /** Frames the selection again: only with a file selected. */
  onFocus?: () => void;
}) {
  const { t } = useI18n();
  const level = useSyncExternalStore(zoom.subscribe, () => zoom.value);
  const percent = `${Math.round(level * 100)}%`;
  const outsideNote = useId();
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Leaving[]>([]);
  // Widths as if everything were on the line: the slots that left stay measurable, out of view.
  const fit = useCallback(() => {
    const head = box.current;
    if (!head) return;
    const style = getComputedStyle(head);
    const gap = parseFloat(style.columnGap) || 0;
    const room = head.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const width = (element: Element | null | undefined) =>
      element ? element.getBoundingClientRect().width : 0;
    const slot = (key: string) => head.querySelector(`[data-key="${key}"]`);
    const label = head.querySelector<HTMLElement>('.map-head-label');
    const labelGap = label ? parseFloat(getComputedStyle(label).columnGap) || 0 : 0;
    const em = parseFloat(style.fontSize) || 11;
    // The name whole, or shrunk to NAME_EM once the counts, the selection and the level have left.
    const name = (shrunk: boolean) =>
      label
        ? [...label.children].reduce(
            (sum, child, index) =>
              sum +
              (index ? labelGap : 0) +
              (child.classList.contains('map-head-text')
                ? Math.min((child as HTMLElement).scrollWidth, shrunk ? NAME_EM * em : Infinity)
                : width(child)),
            0,
          )
        : 0;
    const caption = head.querySelector<HTMLElement>('.canvas-caption');
    const captionGap = caption ? parseFloat(getComputedStyle(caption).columnGap) || 0 : 0;
    const levelWidth = width(slot('level'));
    // The zoom group as it is with its level: the level may be out of the line now.
    const own = (key: string) =>
      width(slot(key)) +
      (key === 'zoom' && slot('level')?.hasAttribute('data-hidden') ? levelWidth : 0);
    const out: Leaving[] = [];
    const used = () =>
      name(out.includes('name')) +
      (out.includes('count') ? 0 : captionGap + width(slot('count'))) +
      ['legend', 'zoom', 'fit', 'focus']
        .filter((key) => slot(key) && !out.includes(key as Leaving))
        .reduce((sum, key) => sum + gap + own(key), 0) -
      (out.includes('level') ? levelWidth : 0) +
      (out.some((key) => key !== 'name') ? gap + width(slot('more')) : 0);
    for (const key of LEAVING) {
      if (used() <= room + 0.5) break;
      if (key === 'name' || slot(key)) out.push(key);
    }
    // The name is not a slot: it only gives way, and the menu does not list it.
    const left = out.filter((key) => key !== 'name');
    const next = [...left].sort().join('\0');
    setHidden((previous) => ([...previous].sort().join('\0') === next ? previous : left));
  }, []);
  useLayoutEffect(fit);
  useEffect(() => {
    const head = box.current;
    if (!head) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(head);
    let live = true;
    document.fonts?.ready.then(() => live && fit());
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [fit]);
  const away = (key: Leaving) => hidden.includes(key);
  const slot = (key: Leaving) =>
    away(key) ? { 'data-key': key, 'data-hidden': '', 'aria-hidden': true } : { 'data-key': key };
  const fitName = t('Fit the map');
  const outsideText = t('Part of the map out of view');
  // Facts are read in the menu, not run.
  const fact = () => {};
  const menu: MenuAction[] = [
    ...(away('count') ? [{ label: count, info: true, title: countTitle, onSelect: fact }] : []),
    ...(away('focus') && onFocus
      ? [{ label: t('Focus selection'), icon: Crosshair, onSelect: onFocus }]
      : []),
    ...(away('level')
      ? [{ label: t('Zoom {percent}', { percent }), info: true, onSelect: fact }]
      : []),
    ...(away('fit')
      ? [
          {
            label: outside ? t('Part of the map out of view · Fit') : fitName,
            icon: Maximize,
            onSelect: onFit,
          },
        ]
      : []),
  ];
  return (
    <div className="map-head" ref={box}>
      <div className="canvas-caption">
        <span className="map-head-label" title={label}>
          <Layers size={13} aria-hidden="true" />
          <span className="map-head-text">{label}</span>
          {note}
        </span>
        <span className="map-head-count" title={countTitle} {...slot('count')}>
          {count}
        </span>
      </div>
      {drawn && (
        <>
          <details className="canvas-legend" data-key="legend">
            <summary aria-label={t('Map legend')} title={t('Map legend')}>
              <SwatchBook size={12} aria-hidden="true" />
              <span className="canvas-legend-label">{t('Legend')}</span>
            </summary>
            <div>
              <span>
                <i className="green" /> {t('Instructions')}
              </span>
              <span>
                <i className="legend-memory" /> {t('Memory')}
              </span>
              <span>
                <i className="purple" /> {t('Skill')}
              </span>
              <span>
                <i className="legend-manifest" /> {t('Manifest')}
              </span>
              <span>→ {t('Reference direction')}</span>
              {conventions && <span>┄ {t('Convention / hierarchy')}</span>}
              {summed && <small>{t('Thicker arrow: more references')}</small>}
              <a href="https://reactflow.dev" target="_blank" rel="noopener noreferrer">
                React Flow
              </a>
            </div>
          </details>
          <span className="map-zoom" role="group" aria-label={t('Zoom of the map')} data-key="zoom">
            <button
              className="map-tool"
              aria-label={t('Zoom out of the map')}
              title={t('Zoom out of the map')}
              disabled={level <= minZoom}
              onClick={onZoomOut}
            >
              <Minus size={12} aria-hidden="true" />
            </button>
            <span className="map-zoom-level" title={t('Zoom of the map')} {...slot('level')}>
              {percent}
            </span>
            <button
              className="map-tool"
              aria-label={t('Zoom in on the map')}
              title={t('Zoom in on the map')}
              disabled={level >= maxZoom}
              onClick={onZoomIn}
            >
              <Plus size={12} aria-hidden="true" />
            </button>
          </span>
          <button
            className={`map-tool map-fit${outside ? ' canvas-offscreen' : ''}`}
            aria-label={fitName}
            aria-describedby={outside ? outsideNote : undefined}
            title={
              outside
                ? t(
                    'Part of the map out of view. The automatic framing shows every column; the rows that do not fit in this view stay below. Fit shows the whole map, smaller.',
                  )
                : fitName
            }
            onClick={onFit}
            {...slot('fit')}
          >
            <Maximize size={12} aria-hidden="true" />
            <span>{t('Fit')}</span>
          </button>
          {onFocus && (
            <button className="map-tool focus-selection" onClick={onFocus} {...slot('focus')}>
              <Crosshair size={12} aria-hidden="true" />
              <span>{t('Focus selection')}</span>
            </button>
          )}
        </>
      )}
      <span className="map-more" data-key="more" data-hidden={!menu.length || undefined}>
        <MenuButton
          id={`map-more${outsideNote.replace(/:/g, '')}`}
          label={t('More map controls')}
          title={t('Controls and counts of the map that have no room on this line')}
          icon={MoreHorizontal}
          hideLabel
          active={outside && away('fit')}
          actions={menu}
        />
      </span>
      {outside && (
        <span id={outsideNote} className="visually-hidden">
          {outsideText}
        </span>
      )}
    </div>
  );
}
