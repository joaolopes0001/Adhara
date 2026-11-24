/**
 * The interface language. The code is written in English; Portuguese is an optional pack
 * (`pt-BR.ts`), and what it lacks shows in English. The choice is kept in `localStorage['aae-lang']`
 * like the theme; the browser language is never consulted.
 *
 * In a component, `const { t, plural, rich } = useI18n()`: the call subscribes the component, so it
 * renders again when the language changes, and the functions change identity with the language
 * (put them in the dependencies of a `useMemo`). Outside components (pure functions such as those of
 * `observations.ts`), import `t`, `plural` or `rich` from this module: they read the active language
 * at the time of the call.
 *
 *   t('Help')                                        → "Help" / "Ajuda"
 *   t('Open {name}', { name: 'AGENTS.md' })          → "Open AGENTS.md" / "Abrir AGENTS.md"
 *   plural(n, '{count} file', '{count} files')       → "1,000 files" / "1.000 arquivos"
 *   rich('Press <kbd>Ctrl+K</kbd> to search', { kbd: (c) => <kbd>{c}</kbd> })
 *
 * Importing this module applies the saved language to `<html lang>` before React mounts.
 */
import { useSyncExternalStore } from 'react';
import { ptBR } from './pt-BR';
import { LANGUAGES, translator } from './translate';
import type { DateStyle, Language, Translator } from './translate';

export { LANGUAGES };
export type { DateStyle, Language, Translator };

const STORAGE_KEY = 'aae-lang';

/** The saved language; anything else, or storage that cannot be read, is English. */
export function readLanguage(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'pt' ? 'pt' : 'en';
  } catch {
    return 'en';
  }
}

// One per language, so that `t` keeps its identity while the language does not change.
const translators: Record<Language, Translator> = {
  en: translator('en'),
  pt: translator('pt', ptBR),
};

let current = readLanguage();
const listeners = new Set<() => void>();

function reflect(language: Language) {
  if (typeof document !== 'undefined') document.documentElement.lang = LANGUAGES[language].tag;
}

/** The active language. */
export const getLanguage = () => current;

/** Changes the language: `<html lang>`, the components that use `useI18n()`, and the saved choice. */
export function setLanguage(language: Language) {
  if (language !== current) {
    current = language;
    reflect(language);
    for (const listener of listeners) listener();
  }
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    /* Still usable without storage, for this session. */
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * `t`, `plural`, `rich`, `formatNumber` and `formatDate` in the active language, for code outside
 * components.
 */
export const t: Translator['t'] = (phrase, ...args) => translators[current].t(phrase, ...args);
export const plural: Translator['plural'] = (count, one, other, ...args) =>
  translators[current].plural(count, one, other, ...args);
export const rich: Translator['rich'] = (phrase, ...args) =>
  translators[current].rich(phrase, ...args);
export const formatNumber = (value: number) => translators[current].formatNumber(value);
export const formatDate = (value: string | number | Date, style: DateStyle) =>
  translators[current].formatDate(value, style);

/** The language and its translator in a component, which renders again when the language changes. */
export function useI18n() {
  const language = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  return { language, setLanguage, ...translators[language] };
}

reflect(current);
