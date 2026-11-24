// Does a text look Portuguese? The Portuguese pack is the inventory: a word that some translation of
// src/i18n/pt-BR.ts uses and no English phrase of the code uses is Portuguese, and so is a letter with
// an accent of Portuguese. Used by the specs that check that the default interface is all English: on
// the screen (language.spec.ts) and in the source (portuguese-source.spec.ts).
import { ptBR } from '../../src/i18n/pt-BR';

/** A word without its accents, in lower case: "Ação" and "acao" are the same word. */
export const plainWord = (word: string) =>
  word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** The words of a text, without `{parameters}` and `<tags>`. */
export const wordsOf = (text: string) =>
  text
    .replace(/\{\w+\}|<\/?\w+>/g, ' ')
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .map(plainWord);

/** A phrase of the pack without its context: `[state] Open` → `Open`. */
const phraseOf = (key: string) => key.replace(/^\[[^\]]*\] /, '');

const english = new Set(Object.keys(ptBR).flatMap((key) => wordsOf(phraseOf(key))));
// Words of the pack that are also plain English, which an English phrase may use one day.
const ALSO_ENGLISH = new Set(
  'a e o final par ex la le lo los si ha ir set via real total local normal global data vale'.split(
    ' ',
  ),
);
/**
 * Every word that only the Portuguese of the pack uses. A single letter tells nothing: the Portuguese
 * ones are English too, and the others come from code in a phrase (`\\r`, `R` for a side).
 */
export const PORTUGUESE_WORDS = new Set(
  Object.values(ptBR)
    .flatMap(wordsOf)
    .filter((word) => word.length > 1 && !english.has(word) && !ALSO_ENGLISH.has(word)),
);
const ACCENTED = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;

/** The reason a text looks Portuguese (an accent or the first Portuguese word), or null. */
export function portugueseIn(text: string): string | null {
  const accent = text.match(ACCENTED);
  if (accent) return `accent “${accent[0]}”`;
  const word = wordsOf(text).find((item) => PORTUGUESE_WORDS.has(item));
  return word ? `word “${word}”` : null;
}
export const isPortuguese = (text: string) => portugueseIn(text) !== null;

/** Every form of the pack that is a translation (not equal to its English), plain: for the self-test. */
export function packForms() {
  return Object.entries(ptBR).flatMap(([key, value]) => {
    const englishForms = phraseOf(key).split(' | ');
    return value
      .split(' | ')
      .filter((form, index) => form !== englishForms[index])
      .map((form) => form.replace(/<\/?\w+>/g, '').replace(/\{\w+\}/g, '3'));
  });
}
/** Every English form of the code (the keys of the pack), plain: for the self-test. */
export const englishForms = () =>
  Object.keys(ptBR).flatMap((key) =>
    phraseOf(key)
      .split(' | ')
      .map((form) => form.replace(/<\/?\w+>/g, '').replace(/\{\w+\}/g, '3')),
  );
