/**
 * The sentences the server writes, in the language of the interface.
 *
 * The server writes English (server/texts.py). Next to a sentence made with parameters, the API sends its
 * phrase: `message` comes with `messagePhrase`, `error` with `errorPhrase`, the list `restoreErrors` with
 * `restoreErrorsPhrase`. `serverText(sentence, phrase)` looks the phrase up in the server block of the
 * language pack (`ptBRServer`, at the end of src/i18n/pt-BR.ts), then in the pack of the interface, which
 * already has some of the same sentences, and fills in the parameters; a sentence without parameters is
 * its own phrase. What the pack does not have shows in English, as sent. A phrase that names a parameter
 * it does not hold, or holds one that cannot be written, shows as sent too.
 *
 * Parameters are written as they come, never interpreted: a path with `{`, `%` or quotes stays whole, and a
 * number keeps the digits the server sent. A parameter that is itself a phrase is worded on its own, and a
 * `{ number }` is written for the language (5,000 or 5.000). A parameter the phrase does not name is a fact
 * of the case (`serverFact`), which the interface reads instead of searching the sentence for it.
 *
 * An app state may still hold sentences an earlier server wrote in Portuguese, without a phrase: the findings
 * of a baseline saved before the server wrote English (`earlier` in the finding), the reason of a refused update
 * (`earlier` in the phrase). Such a sentence is never read: a Portuguese interface shows it as it came, as text;
 * another language shows what the server says for it instead (an English phrase of its own, or, for a finding,
 * what its fields say).
 */
import { getLanguage } from './i18n';
import { ptBR, ptBRServer } from './i18n/pt-BR';
import { formatNumber, formatText } from './i18n/translate';
import type { Language, Pack } from './i18n/translate';

/** A parameter of a phrase: a value, another phrase, or a number to be written for the language. */
export type ServerParam = string | number | boolean | null | ServerPhrase | { number: number };
/**
 * The phrase of a sentence of the server and the parameters it was made with; `earlier`, a sentence an earlier
 * server saved in Portuguese, which this phrase says in English.
 */
export type ServerPhrase = {
  phrase: string;
  params?: Record<string, ServerParam>;
  earlier?: string;
};

/** The packs a server phrase is looked up in, in order: the server block, then the interface pack. */
export type ServerPacks = readonly Pack[];
const packs: Record<Language, ServerPacks | undefined> = { en: undefined, pt: [ptBRServer, ptBR] };
/** The language an earlier server wrote its sentences in. */
const EARLIER: Language = 'pt';

/** The translation of a phrase in the first pack that has it as its own entry (never `toString` and the like). */
function own(found: ServerPacks | undefined, key: string) {
  for (const pack of found ?? [])
    if (Object.hasOwn(pack, key) && typeof pack[key] === 'string') return pack[key];
  return undefined;
}

const isPhrase = (value: unknown): value is ServerPhrase =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { phrase?: unknown }).phrase === 'string';

const isNumber = (value: unknown): value is { number: number } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { number?: unknown }).number === 'number';

const PLACEHOLDER = /\{([A-Za-z]\w*)\}/g;
const MAX_DEPTH = 8;

/** The parameters of a phrase, or none when `params` is not an object. */
const paramsOf = (phrase: ServerPhrase): Record<string, ServerParam> =>
  typeof phrase.params === 'object' && phrase.params !== null && !Array.isArray(phrase.params)
    ? phrase.params
    : {};

/** Whether each parameter the phrase names is there and can be written (text, number, flag, phrase). */
function wellFormed(phrase: ServerPhrase, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const params = paramsOf(phrase);
  for (const [, name] of phrase.phrase.matchAll(PLACEHOLDER)) {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (
      !(
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (isNumber(value) && Number.isFinite(value.number)) ||
        (isPhrase(value) && wellFormed(value, depth + 1))
      )
    )
      return false;
  }
  return true;
}

/**
 * A phrase in `language`, with given packs (the tests pass their own); deeper than 8 phrases, as sent. A
 * sentence an earlier server saved (`earlier`) is, in its language, that sentence as it came.
 */
export function wordPhrase(
  language: Language,
  pack: ServerPacks | undefined,
  phrase: ServerPhrase,
  depth = 0,
): string {
  if (language === EARLIER && typeof phrase.earlier === 'string') return phrase.earlier;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(paramsOf(phrase)))
    values[name] = isNumber(value)
      ? formatNumber(language, value.number)
      : isPhrase(value)
        ? depth < MAX_DEPTH
          ? wordPhrase(language, pack, value, depth + 1)
          : value.phrase
        : String(value);
  return formatText(language, own(pack, phrase.phrase) ?? phrase.phrase, values);
}

/**
 * A sentence of the server in the active language. English shows the sentence as sent; another language
 * words the phrase from its pack, or, without a phrase, the sentence itself when the pack has it whole.
 */
export function serverText(sentence: string, phrase?: ServerPhrase | null): string {
  const language = getLanguage();
  const pack = packs[language];
  if (!pack) return sentence;
  if (isPhrase(phrase)) return wellFormed(phrase) ? wordPhrase(language, pack, phrase) : sentence;
  return own(pack, sentence) ?? sentence;
}

/**
 * An item of the model or of an answer with a server sentence in `message` (and its phrase next to it);
 * `earlier`: a finding of a baseline saved before the server wrote English, its message in Portuguese.
 */
export type WithMessage = {
  message: string;
  messagePhrase?: ServerPhrase | null;
  earlier?: boolean;
};
/** Whether an item holds a message an earlier server saved, and the interface is in its language. */
export const earlierHere = (item: { earlier?: boolean }) =>
  item.earlier === true && getLanguage() === EARLIER;
/**
 * The message of an observation, a signal, a warning or a note, in the active language. One an earlier server
 * saved is shown as it came in its language, and in another one not at all (its line says what its fields say).
 */
export const messageText = (item: WithMessage) =>
  item.earlier === true
    ? earlierHere(item)
      ? String(item.message)
      : ''
    : serverText(item.message, item.messagePhrase);

/**
 * A fact of the case the server sent with the message: a parameter of its phrase, by name, when it is a
 * text, a number or a flag. Undefined when the message has no phrase or the phrase has no such parameter.
 */
export function serverFact(item: { messagePhrase?: ServerPhrase | null }, name: string) {
  const params = isPhrase(item.messagePhrase) ? item.messagePhrase.params : undefined;
  const value =
    params && typeof params === 'object' && Object.hasOwn(params, name) ? params[name] : undefined;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

/**
 * The evidence of a relation as shown: the line of the document, as written. Only a convention (`scope`)
 * has a sentence of the server for evidence, which is worded in the active language.
 */
export const relationEvidence = (edge: { kind: string; evidence: string }) =>
  edge.kind === 'scope' ? serverText(edge.evidence) : edge.evidence;
