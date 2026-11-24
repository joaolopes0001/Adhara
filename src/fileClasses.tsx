import { Braces, Brain, FileSymlink, FileText, ScrollText, Sparkles } from 'lucide-react';
import { useI18n } from './i18n';
import type { Translator } from './i18n';
import type { FileNode } from './types';
import { kinds } from './types';

/**
 * Classes of the class filter, from the node kind the reader assigns (`node.kind`): instructions, memory,
 * skills, manifests and every other file (plain files and symbolic links).
 */
export type FileClass = 'entry' | 'memory' | 'skill' | 'manifest' | 'other';
export type ClassFilter = { only: FileClass | null; observed: boolean };
export const noClassFilter: ClassFilter = { only: null, observed: false };
/** The classes in the order of the selector; each label is resolved when shown (see `classLabel`). */
export const classKeys: FileClass[] = ['entry', 'memory', 'skill', 'manifest', 'other'];
export function classLabel(key: FileClass, t: Translator['t']) {
  switch (key) {
    case 'entry':
      return t('Instructions');
    case 'memory':
      return t('Memory');
    case 'skill':
      return t('Skills');
    case 'manifest':
      return t('Manifests');
    case 'other':
      return t('Other');
  }
}
const named = new Set<string>(['entry', 'memory', 'skill', 'manifest']);
export const classOf = (node: FileNode): FileClass =>
  named.has(node.kind) ? (node.kind as FileClass) : 'other';
export const filterActive = (filter: ClassFilter) => filter.only !== null || filter.observed;

/** Icon of a file class in the tree; the class name is its tooltip. */
export function ClassIcon({ node, size = 14 }: { node: FileNode; size?: number }) {
  const { t } = useI18n();
  const Icon =
    node.kind === 'symlink'
      ? FileSymlink
      : { entry: ScrollText, memory: Brain, skill: Sparkles, manifest: Braces, other: FileText }[
          classOf(node)
        ];
  return (
    <i className={`file-class kind-${node.kind}`} title={kinds[node.kind] || t('File')}>
      <Icon size={size} aria-hidden="true" />
    </i>
  );
}
