// The pure core of the interface language: the phrase types, the lookup in a translation pack,
// interpolation, plural and number formatting, rich text. No state and no browser access, so the
// tests run it directly with any pack; `index.ts` adds the active language and the Portuguese pack.
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';

/** A language of the interface, as kept in `localStorage['aae-lang']`. */
export type Language = 'en' | 'pt';

/**
 * Each language: its own name (the selector shows the other language by it), the BCP 47 tag of
 * `<html lang>` and of number formatting, and the locale whose plural rules choose `one` or `other`.
 */
export const LANGUAGES = {
  en: { name: 'English', tag: 'en', plural: 'en' },
  // CLDR gives Brazilian Portuguese `one` for 0 ("0 arquivo"); the interface says "0 arquivos", with
  // only exactly 1 singular, which is the European Portuguese rule. The text stays pt-BR.
  pt: { name: 'Português', tag: 'pt-BR', plural: 'pt-PT' },
} as const satisfies Record<Language, { name: string; tag: string; plural: string }>;

/**
 * A translation pack: each English phrase, exactly as the code writes it, and its translation. A
 * plural is one entry, its two English forms joined by `PLURAL_SEPARATOR`, and so is its translation.
 * A phrase with a context starts with `[context] `. What is missing shows in English.
 */
export type Pack = Readonly<Record<string, string>>;
/** Joins the `one` and `other` forms of a plural entry (scripts/i18n-check.mjs writes keys alike). */
export const PLURAL_SEPARATOR = ' | ';
/** The key of a phrase in a pack. */
export const packKey = (phrase: string, context?: string) =>
  context ? `[${context}] ${phrase}` : phrase;

/** The names written `{name}` in a phrase. */
type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;
/** The tags written `<name>…</name>` in a phrase (the closing ones are skipped). */
type Tags<S> = S extends `${string}<${infer T}>${infer R}`
  ? T extends `/${string}`
    ? Tags<R>
    : T | Tags<R>
  : never;

/**
 * For the rare English phrase that needs two translations: `t('Open', { context: 'state' })` is
 * looked up as `[state] Open`. `context` is never a placeholder name.
 */
export type Context = { readonly context?: string };
type Value<P, V> = P extends 'context' ? never : V;

/** Parameters of `t()`: every placeholder of the phrase; numbers are formatted for the language. */
export type Params<S extends string> = { [P in Placeholders<S>]: Value<P, string | number> };
/** The arguments after the phrase: none (or a context) without placeholders, else all of them. */
export type Args<S extends string> = [Placeholders<S>] extends [never]
  ? [options?: Context]
  : [params: Params<S> & Context];

/** Parameters of `plural()`: the placeholders of both forms but `{count}`, which is the count. */
type PluralName<S extends string> = Exclude<Placeholders<S>, 'count'>;
export type PluralArgs<S extends string> = [PluralName<S>] extends [never]
  ? [options?: Context]
  : [params: { [P in PluralName<S>]: Value<P, string | number> } & Context];

/** Parameters of `rich()`: each placeholder takes a node, each tag a function of its content. */
export type RichParams<S extends string> = { [P in Placeholders<S>]: Value<P, ReactNode> } & {
  [T in Tags<S>]: (chunks: ReactNode) => ReactNode;
};
export type RichArgs<S extends string> = [Placeholders<S> | Tags<S>] extends [never]
  ? [options?: Context]
  : [params: RichParams<S> & Context];

/** The functions that write the interface in one language. */
export type Translator = {
  /** A phrase as text: `t('Open project')`, `t('Open {name}', { name })`. */
  t<const S extends string>(phrase: S, ...args: Args<S>): string;
  /** One of two forms by `count`, which fills `{count}`: `plural(n, '{count} file', '{count} files')`. */
  plural<const O extends string, const X extends string>(
    count: number,
    one: O,
    other: X,
    ...args: PluralArgs<O | X>
  ): string;
  /** A phrase as React nodes, with an element for a placeholder and a function for each tag. */
  rich<const S extends string>(phrase: S, ...args: RichArgs<S>): ReactNode;
  /** A number written for the language: 1,000 in English, 1.000 in Portuguese. */
  formatNumber(value: number): string;
  /** A date or a time written for the language, in the local time of this computer (`DateStyle`). */
  formatDate(value: string | number | Date, style: DateStyle): string;
};

/**
 * How much of a moment the interface writes: `date` (11/07/2026; 07/11/2026 in Portuguese), `day-time`
 * (11/18 1:56 PM; 18/11 13:56) and `time` (9:05 AM; 09:05).
 */
export type DateStyle = 'date' | 'day-time' | 'time';

type Values = Readonly<Record<string, unknown>>;

const numberFormats = new Map<Language, Intl.NumberFormat>();
export function formatNumber(language: Language, value: number) {
  let format = numberFormats.get(language);
  if (!format)
    numberFormats.set(language, (format = new Intl.NumberFormat(LANGUAGES[language].tag)));
  return format.format(value);
}

const DATE_PARTS = {
  date: { day: '2-digit', month: '2-digit', year: 'numeric' },
  day: { day: '2-digit', month: '2-digit' },
  time: { timeStyle: 'short' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function datePart(language: Language, part: keyof typeof DATE_PARTS, date: Date) {
  const key = `${language} ${part}`;
  let format = dateFormats.get(key);
  if (!format)
    dateFormats.set(
      key,
      (format = new Intl.DateTimeFormat(LANGUAGES[language].tag, DATE_PARTS[part])),
    );
  return format.format(date);
}
/**
 * A moment in the local time of this computer, in the format of the language (`DateStyle`); a value
 * that is not a date stays as it came. The day and the time of `day-time` are two parts joined by a
 * space ("18/11 12:36").
 */
export function formatDate(language: Language, value: string | number | Date, style: DateStyle) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return style === 'day-time'
    ? `${datePart(language, 'day', date)} ${datePart(language, 'time', date)}`
    : datePart(language, style, date);
}

const pluralRules = new Map<Language, Intl.PluralRules>();
/** The form of a plural for `count`: any category other than `one` takes `other`. */
export function pluralForm(language: Language, count: number): 'one' | 'other' {
  let rules = pluralRules.get(language);
  if (!rules) pluralRules.set(language, (rules = new Intl.PluralRules(LANGUAGES[language].plural)));
  return rules.select(count) === 'one' ? 'one' : 'other';
}

/** The translation of a key, if the pack has one of its own (never `toString` and the like). */
function entry(pack: Pack | undefined, key: string) {
  const value = pack && Object.hasOwn(pack, key) ? pack[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

const contextOf = (values: Values | undefined) =>
  typeof values?.context === 'string' ? values.context : undefined;

/**
 * The plural form for `count`: from the pack when it has the pair, chosen by the rules of the
 * language; else the English form, by the English rules.
 */
function pluralText(
  language: Language,
  pack: Pack | undefined,
  count: number,
  one: string,
  other: string,
  context: string | undefined,
) {
  const key = packKey(one + PLURAL_SEPARATOR + other, context);
  const forms = entry(pack, key)?.split(PLURAL_SEPARATOR);
  if (forms?.length === 2) return forms[pluralForm(language, count) === 'one' ? 0 : 1];
  return pluralForm('en', count) === 'one' ? one : other;
}

// A tag with its content (no attributes; a tag may hold other tags, not one of the same name) or a
// placeholder.
const TOKEN = /<([A-Za-z]\w*)>([\s\S]*?)<\/\1>|\{([A-Za-z]\w*)\}/g;

/**
 * The pieces of a text: plain strings, placeholders replaced by their values and tags by `wrap`. A
 * placeholder without a value stays written (`{name}`), so a missing parameter shows instead of
 * breaking the screen.
 */
function pieces(
  language: Language,
  source: string,
  values: Values,
  wrap: (tag: string, content: ReactNode[]) => ReactNode,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    const [whole, tag, content, name] = match;
    if (match.index > last) out.push(source.slice(last, match.index));
    if (tag !== undefined) out.push(wrap(tag, pieces(language, content, values, wrap)));
    else {
      const value = name === 'context' ? undefined : values[name];
      out.push(
        value === undefined || value === null
          ? whole
          : typeof value === 'number'
            ? formatNumber(language, value)
            : (value as ReactNode),
      );
    }
    last = match.index + whole.length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

/** A text with its parameters filled in; tags keep only their content. */
export function formatText(language: Language, text: string, values: Values = {}): string {
  return pieces(language, text, values, (_, content) => content.join(''))
    .map(String)
    .join('');
}

const fragment = (nodes: ReactNode[]) => createElement(Fragment, null, ...nodes);

/** A text as React nodes: placeholders may be elements, and each tag is rendered by its function. */
export function formatRich(language: Language, text: string, values: Values = {}): ReactNode {
  return fragment(
    pieces(language, text, values, (tag, content) => {
      const render = values[tag];
      return typeof render === 'function'
        ? (render as (chunks: ReactNode) => ReactNode)(fragment(content))
        : fragment(content);
    }),
  );
}

/**
 * The translator of a language with its pack (none for English). A phrase or plural the pack does
 * not have shows in English; entries the code does not use are never read.
 */
export function translator(language: Language, pack?: Pack): Translator {
  const phrase = (english: string, values: Values | undefined) =>
    entry(pack, packKey(english, contextOf(values))) ?? english;
  return {
    t: (english, ...args) => formatText(language, phrase(english, args[0]), args[0]),
    plural: (count, one, other, ...args) =>
      formatText(language, pluralText(language, pack, count, one, other, contextOf(args[0])), {
        ...args[0],
        count,
      }),
    rich: (english, ...args) => formatRich(language, phrase(english, args[0]), args[0]),
    formatNumber: (value) => formatNumber(language, value),
    formatDate: (value, style) => formatDate(language, value, style),
  };
}
