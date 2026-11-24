export type Theme = 'dark' | 'light';

export function readTheme(): Theme {
  try {
    return localStorage.getItem('aae-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#00081b' : '#f6fafd');
  try {
    localStorage.setItem('aae-theme', theme);
  } catch {
    /* Still usable without storage. */
  }
}

applyTheme(readTheme());

/**
 * Durations of the motion that JavaScript drives (the CSS ones are the `--motion-*` variables of
 * style.css): the map moving to a new framing. Zero when the system asks for reduced motion.
 */
export const MAP_GLIDE_MS = 240;
export function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
