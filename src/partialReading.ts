import type { FileNode, Model } from './types';
import { plural, t } from './i18n';

/**
 * Whether a reading is partial, and why: the same rule as the `analysis-partial` finding of `aae audit`
 * (server/audit.py), which makes the CLI answer `inconclusive`. A reading is partial when the reader left
 * an issue `limit` or `unreadable`, a text was analysed in part or skipped, or the stats say the
 * inventory or the relations were cut.
 */
export type PartialCause = 'inventory' | 'relations' | 'text' | 'unreadable' | 'depth';

/** The causes in the order the footer names them. */
const causeOrder: PartialCause[] = ['inventory', 'text', 'unreadable', 'depth', 'relations'];
/** Words of one cause, in the active language. */
function causeWord(cause: PartialCause) {
  switch (cause) {
    case 'inventory':
      return t('item limit');
    case 'text':
      return t('text limit');
    case 'unreadable':
      return t('unreadable file');
    case 'depth':
      return t('JSON beyond the depth read');
    case 'relations':
      return t('relation cap');
  }
}

export type PartialReading = {
  partial: boolean;
  causes: PartialCause[];
  /** The inventory limit left folders out: the only cause shown as a strip across the window. */
  inventoryCut: Model['stats']['inventory'] | null;
};

export function partialReading(model: Model | undefined): PartialReading {
  if (!model) return { partial: false, causes: [], inventoryCut: null };
  const causes = new Set<PartialCause>();
  const inventory = model.stats.inventory;
  const inventoryCut = inventory && !inventory.complete ? inventory : null;
  if (inventoryCut) causes.add('inventory');
  if (model.stats.relations?.complete === false) causes.add('relations');
  for (const node of model.nodes) {
    if (node.skippedBy === 'unreadable') causes.add('unreadable');
    else if (node.skippedBy) causes.add('text');
    else if (node.analysis === 'skipped') causes.add('text');
    if (node.analysis === 'partial') causes.add('depth');
  }
  if (model.issues.some((issue) => issue.code === 'unreadable')) causes.add('unreadable');
  const partial =
    causes.size > 0 ||
    model.issues.some((issue) => issue.code === 'limit' || issue.code === 'unreadable');
  return {
    partial,
    causes: causeOrder.filter((cause) => causes.has(cause)),
    inventoryCut,
  };
}

/** The tooltip of the footer link: the causes found, and what they mean for absent observations. */
export function describePartial(reading: PartialReading) {
  const words = causeOrder.filter((cause) => reading.causes.includes(cause)).map(causeWord);
  return words.length
    ? t('Partial scan ({causes}): an observation may be missing.', { causes: words.join(', ') })
    : t('Partial scan: an observation may be missing.');
}

/**
 * The footer link of a partial reading: the main cause as a fact with its count ("1 file not read",
 * "2 files partly read", "relations cut") and "+N other causes" for the other causes; `cause` is the main one,
 * which decides the type the Audit opens on. Null for a complete reading.
 */
export function partialLabel(model: Model | undefined) {
  const reading = partialReading(model);
  if (!model || !reading.partial) return null;
  const skipped = new Set<string>(),
    unreadable = new Set<string>(),
    depth = new Set<string>();
  for (const node of model.nodes) {
    if (node.skippedBy === 'unreadable') unreadable.add(node.id);
    else if (node.skippedBy || node.analysis === 'skipped') skipped.add(node.id);
    if (node.analysis === 'partial') depth.add(node.id);
  }
  for (const issue of model.issues)
    if (issue.code === 'unreadable') unreadable.add(issue.node ?? issue.id);
  const [cause, ...others] = reading.causes;
  // A limit issue the causes above do not name (a reader of a newer version): the generic words.
  if (!cause) return { cause: undefined, text: t('Partial scan') };
  const fact = {
    inventory: () =>
      plural(
        model.stats.inventory?.omitted ?? 0,
        '{count} item not listed',
        '{count} items not listed',
      ),
    text: () => plural(skipped.size, '{count} file not read', '{count} files not read'),
    unreadable: () => plural(unreadable.size, '{count} read failure', '{count} read failures'),
    depth: () => plural(depth.size, '{count} file partly read', '{count} files partly read'),
    relations: () => t('relations cut'),
  }[cause]();
  // "+N" counts the other causes (named in the tooltip), not files: the words say so.
  const more = others.length
    ? ' ' + plural(others.length, '+{count} other cause', '+{count} other causes')
    : '';
  return { cause, text: `${fact}${more}` };
}

/**
 * Why a folder is `partial` or `unread`, as the reader says for that folder (`leftOutBy`): the inventory limit
 * (`limit`), what it could not read there (`unreadable`: a name that is not valid UTF-8, or a listing that
 * failed), or both. Without the field, the limit.
 */
export function listingCauses(node: FileNode) {
  const by = node.leftOutBy ?? ['limit'];
  return { limit: by.includes('limit'), unreadable: by.includes('unreadable') };
}

/** "at least " when the count of items left out below a folder is a minimum (`omittedMinimum`). */
export function omittedAtLeast(node: FileNode) {
  return node.omittedMinimum ? t('at least') + ' ' : '';
}

/** The strip's sentence when the inventory limit left items out of the reading. */
export function describeInventoryCut(inventory: NonNullable<PartialReading['inventoryCut']>) {
  return inventory.lookupComplete
    ? plural(
        inventory.omitted,
        'Partial scan: {count} item not listed.',
        'Partial scan: {count} items not listed.',
      )
    : plural(
        inventory.omitted,
        'Partial scan: at least {count} item not listed.',
        'Partial scan: at least {count} items not listed.',
      );
}
