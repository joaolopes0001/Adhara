import { createContext } from 'react';
import type { ReactNode } from 'react';
import type { FileNode } from './types';

/**
 * Extension point for per-item decorations of file listings (the Structure view and the explorer tree)
 * and of map tiles. Provided once around the workspace (App); nothing is drawn by default.
 */
export type ItemDecorations = {
  /** Content of the slot reserved on every listed item (the marker with the observation count). */
  marker?: (node: FileNode) => ReactNode;
  /** Items kept in the listing (the class filter); a folder stays while a descendant is kept. */
  include?: (node: FileNode) => boolean;
  /** Name of the filter that `include` applies, as the summary of the Structure says it. */
  filterName?: string;
  /** Discreet badge of a map tile: at most one per file; it opens the observations in the inspector. */
  badge?: (node: FileNode) => ReactNode;
};
export const ItemDecorationsContext = createContext<ItemDecorations>({});
/**
 * The inspector as a map sees it: whether it is open (the selected tile offers to open it while it is
 * not) and how to open it once the clicked tile is selected. Null outside the workspace.
 */
export type InspectorAccess = { open: boolean; show: () => void };
export const InspectorContext = createContext<InspectorAccess | null>(null);
