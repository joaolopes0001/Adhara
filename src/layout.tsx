import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { reducedMotion } from './theme';
import { t } from './i18n';

type Layout = {
  explorer: boolean;
  inspector: boolean;
  bottom: boolean;
  explorerWidth: number;
  inspectorWidth: number;
  /** Tool panel height in px; null until the user resizes it (then `defaultBottomHeight` applies). */
  bottomHeight: number | null;
};
export const defaults: Layout = {
  explorer: true,
  inspector: false,
  bottom: false,
  explorerWidth: 246,
  inspectorWidth: 380,
  bottomHeight: null,
};
/** Default tool panel height: at most 45% of the window, so the map keeps room. */
export const defaultBottomHeight = () => Math.round(Math.min(420, innerHeight * 0.45));
/** The same default as a CSS length, so it follows the window while no height is saved. */
export const defaultBottomHeightCss = 'min(420px, 45vh)';
/** Limits of each panel size. The inspector also has a drawn limit (`inspectorMax`); its bound here only keeps a saved number sane. */
export const bounds = {
  explorerWidth: [180, 420],
  inspectorWidth: [260, 4000],
  bottomHeight: [100, 800],
} as const;
/** The least width of a view in the centre grid; mirrors the `minmax` columns of `.map-workspace` (map-workspace.css). */
export const paneMinWidth = (compact: boolean) => (compact ? 240 : 270);
/**
 * The least height of a view: its header, the header line of its Structure, three list rows and the line
 * under it. The grid never draws a view lower than that (`.map-workspace` rows); `low` is the window up
 * to 550 px high.
 */
export const paneMinHeight = (low: boolean) =>
  low ? 30 + 25 + 3 * 24 + 24 : 36 + 31 + 3 * 30 + 31;
/** The least height of the bottom panel (mirrors `.tool-panel`); `short` is the window up to 600 px high. */
export const toolPanelMinHeight = (short: boolean) => (short ? 130 : 125);
/**
 * The least width the centre keeps beside the inspector: 320 px per column of views, so each view still
 * shows names, not their first letter. Views may be narrower in a narrow window, never because the
 * inspector was dragged.
 */
export function centerMinWidth(columns: number) {
  return columns * 320 + columns - 1;
}
/** Two columns of views at their least width, 1 px apart. */
export const twoColumnsMinWidth = (compact: boolean) => 2 * paneMinWidth(compact) + 1;
/**
 * The widest the inspector is drawn: the window less the explorer, the two 1 px dividers and the centre's
 * minimum for its columns of views; never below the inspector's own minimum. A compact window caps it at
 * 44% of the window and does not narrow it for a second column (the views stack instead, App
 * `twoColumnsFit`), so its buttons never crowd. A saved width above the limit is drawn at the limit and
 * stays saved.
 */
export function inspectorMax(
  windowWidth: number,
  explorerRoom: number,
  compact: boolean,
  columns = 1,
) {
  const room = windowWidth - explorerRoom - centerMinWidth(compact ? 1 : columns) - 2;
  return Math.max(
    bounds.inspectorWidth[0],
    compact ? Math.min(windowWidth * 0.44, room) : Math.floor(room),
  );
}
/** The width the explorer takes when shown; mirrors `.app-shell .explorer` in style.css. */
export function explorerRoom(windowWidth: number, explorerWidth: number, compact: boolean) {
  return Math.max(180, Math.min(explorerWidth, windowWidth * (compact ? 0.32 : 0.28)));
}
export function useWindowWidth() {
  const [width, setWidth] = useState(() => innerWidth);
  useEffect(() => {
    const resize = () => setWidth(innerWidth);
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, []);
  return width;
}
export function useWindowHeight() {
  const [height, setHeight] = useState(() => innerHeight);
  useEffect(() => {
    const resize = () => setHeight(innerHeight);
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, []);
  return height;
}
/** The drawn height of an element, following its resizes (0 until it is measured). */
export function useHeight(ref: RefObject<HTMLElement | null>) {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(Math.round(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => {
    const initial = { ...defaults };
    try {
      const saved = JSON.parse(localStorage.getItem('aae-layout') || '{}');
      // Only the keys of this layout are read; any other saved key is ignored.
      for (const key of ['explorer', 'inspector', 'bottom'] as const)
        if (typeof saved?.[key] === 'boolean') initial[key] = saved[key];
      for (const key of Object.keys(bounds) as (keyof typeof bounds)[])
        if (typeof saved?.[key] === 'number' && Number.isFinite(saved[key]))
          initial[key] = Math.max(bounds[key][0], Math.min(bounds[key][1], saved[key]));
    } catch {
      /* Storage is optional. */
    }
    return initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem('aae-layout', JSON.stringify(layout));
    } catch {
      /* Storage is optional. */
    }
  }, [layout]);
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 1023px)').matches);
  const [compactPanel, setCompactPanel] = useState<'explorer' | 'inspector' | null>(null);
  useEffect(() => {
    const media = matchMedia('(max-width: 1023px)');
    const change = () => {
      setCompact(media.matches);
      setCompactPanel(null);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const isOpen = (panel: 'explorer' | 'inspector') =>
    compact ? compactPanel === panel : layout[panel];
  const show = useCallback(
    (panel: 'explorer' | 'inspector', open: boolean) => {
      if (compact) setCompactPanel(open ? panel : null);
      else setLayout((previous) => ({ ...previous, [panel]: open }));
    },
    [compact],
  );
  return {
    layout,
    setLayout,
    compact,
    isOpen,
    show,
    reset: () => {
      setLayout({ ...defaults });
      setCompactPanel(null);
    },
  };
}

/**
 * Keeps a side panel mounted while it leaves, so its CSS exit animation can play: `leaving` lasts from
 * `open` turning false until `done` (the animation end) or, if that never comes, `fallback` ms. With
 * reduced motion it leaves at once. While leaving, the panel is inert.
 */
export function usePresence(open: boolean, fallback = 400) {
  const [shown, setShown] = useState(open);
  // Adjusted during the render, so no frame goes without the panel or keeps a closed one.
  if (open && !shown) setShown(true);
  if (!open && shown && reducedMotion()) setShown(false);
  const leaving = shown && !open;
  const done = useCallback(() => setShown(false), []);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(done, fallback);
    return () => clearTimeout(timer);
  }, [leaving, done, fallback]);
  return { mounted: open || shown, leaving, done };
}

export function ResizeHandle({
  label,
  value,
  min,
  max,
  onChange,
  horizontal = false,
  reverse = false,
  reset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  horizontal?: boolean;
  reverse?: boolean;
  reset: number;
}) {
  const drag = useRef<{ coordinate: number; value: number } | null>(null);
  const clamp = (next: number) => onChange(Math.round(Math.max(min, Math.min(max, next))));
  return (
    <div
      className={`resize-handle ${horizontal ? 'horizontal' : 'vertical'}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title={t('{label} · drag or use the arrow keys · double-click to restore', { label })}
      onDoubleClick={() => clamp(reset)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        const panel = horizontal
          ? event.currentTarget.parentElement
          : reverse
            ? event.currentTarget.nextElementSibling
            : event.currentTarget.previousElementSibling;
        const rect = panel?.getBoundingClientRect();
        drag.current = {
          coordinate: horizontal ? event.clientY : event.clientX,
          value: rect ? (horizontal ? rect.height : rect.width) : value,
        };
      }}
      onPointerMove={(event) => {
        if (drag.current)
          clamp(
            drag.current.value +
              ((horizontal ? event.clientY : event.clientX) - drag.current.coordinate) *
                (reverse ? -1 : 1),
          );
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const delta =
          event.key === (horizontal ? 'ArrowDown' : 'ArrowRight')
            ? 20
            : event.key === (horizontal ? 'ArrowUp' : 'ArrowLeft')
              ? -20
              : 0;
        if (delta || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          clamp(
            event.key === 'Home'
              ? min
              : event.key === 'End'
                ? max
                : value + delta * (reverse ? -1 : 1),
          );
        }
      }}
    />
  );
}
