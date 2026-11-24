import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ptBR } from '../../src/i18n/pt-BR';
import { ALERT_ICONS, enterProject, openOnly, sessionHeaders, writeTree } from './helpers';
import { pickFile } from './edit-helpers';
import { menuButton, runMenuAction } from './more-menu';
import { portugueseIn } from './portuguese';

// The interface language: English in the code, Portuguese from the optional pack, chosen in the More
// menu. This spec runs without the transitional Portuguese of the rest of the suite
// (playwright.config.ts): every test starts as a new profile, with nothing stored.
test.use({ storageState: { cookies: [], origins: [] } });

const english = [
  /^(Show|Hide) inspector$/,
  /^(Show|Hide) explorer/,
  /^(Show|Hide) panels$/,
  'Reset layout',
  'Switch to light theme',
  'Português',
  'Help',
];
const portuguese = [
  /^(Mostrar|Recolher) inspetor$/,
  /^(Mostrar|Recolher) explorador/,
  /^(Mostrar|Recolher) painéis$/,
  'Restaurar disposição',
  'Ativar tema claro',
  'English',
  'Ajuda',
];
/** The language item: the other language by its own name, in its language, with a title. */
const toPortuguese = {
  name: 'Português',
  lang: 'pt-BR',
  title: 'Show the interface in Portuguese',
};
const toEnglish = { name: 'English', lang: 'en', title: 'Mostrar a interface em inglês' };

/** Opens a small project, so that the More menu shows all of its items. */
async function openProject(page: Page) {
  const root = mkdtempSync(join(tmpdir(), 'aae-language-'));
  writeTree(root, { 'AGENTS.md': '# Agent\n\n[Notes](notes.md)\n', 'notes.md': '# Notes\n' });
  return await openOnly(page, [root]);
}

const stored = (page: Page) => page.evaluate(() => localStorage.getItem('aae-lang'));
const choosePortuguese = (page: Page) =>
  page.addInitScript(() => localStorage.setItem('aae-lang', 'pt'));

/**
 * What on the screen looks like a phrase not written out: a `{parameter}` or a `<tag>`, in the
 * visible text or in `title`, `aria-label` and `placeholder`.
 */
async function rawPhrases(page: Page) {
  return await page.evaluate(() => {
    const attributes = ['title', 'aria-label', 'placeholder'];
    const texts = [
      document.body.innerText,
      ...[...document.querySelectorAll('[title], [aria-label], [placeholder]')].flatMap((element) =>
        attributes.map((name) => element.getAttribute(name) ?? ''),
      ),
    ];
    return texts.flatMap((text) => text.match(/\{[A-Za-z]\w*\}|<\/?[A-Za-z]\w*>/g) ?? []);
  });
}

/** Opens the More menu, checks its items and the language item, and closes it with Esc. */
async function checkMenu(
  page: Page,
  name: 'More' | 'Mais',
  items: (string | RegExp)[],
  language: typeof toPortuguese,
) {
  await menuButton(page, name).click();
  const menu = page.getByRole('menu', { name });
  await expect(menu.getByRole('menuitem')).toHaveText(items);
  const item = menu.getByRole('menuitem', { name: language.name, exact: true });
  await expect(item.locator('span')).toHaveAttribute('lang', language.lang);
  await expect(item).toHaveAttribute('title', language.title);
  expect(await rawPhrases(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

/**
 * Serves the application with the Portuguese pack edited: `remove` takes entries out, `add` puts
 * entries in. The pack is an object literal in the bundle, so each edit must match exactly once;
 * returns what did not, which the test expects to be nothing.
 */
async function editPack(page: Page, remove: string[], add: Record<string, string> = {}) {
  const problems: string[] = [];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = (key: string) =>
    new RegExp(
      `(?:${escape(JSON.stringify(key))}|${escape(key)}):${escape(JSON.stringify(ptBR[key]))},?`,
      'g',
    );
  const once = (body: string, key: string) => {
    const found = body.match(entry(key))?.length ?? 0;
    if (found !== 1) problems.push(`${key}: ${found} matches in the bundle`);
  };
  await page.route('**/assets/index-*.js', async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const added = Object.entries(add)
      .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)},`)
      .join('');
    once(body, 'Help');
    body = body.replace(entry('Help'), (help) => added + help);
    for (const key of remove) {
      once(body, key);
      body = body.replace(entry(key), '');
    }
    await route.fulfill({ response, body });
  });
  return () => problems;
}

test('language: a new profile is in English, with nothing stored and no raw phrase on the screen', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const close = await openProject(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(menuButton(page, 'More')).toHaveAttribute(
    'title',
    'Panels, theme, language and help',
  );
  await checkMenu(page, 'More', english, toPortuguese);
  // The default is not written: only a choice is.
  expect(await stored(page)).toBeNull();
  expect(errors).toEqual([]);
  await close();
});

test('language: switching renders again at once, without reloading, and persists after reloading', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const close = await openProject(page);
  await page.goto('/');
  await page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));

  await runMenuAction(page, 'More', 'Português');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(menuButton(page, 'Mais')).toHaveAttribute('title', 'Painéis, tema, idioma e ajuda');
  expect(await stored(page)).toBe('pt');
  // The same document: the change did not reload the page.
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  await checkMenu(page, 'Mais', portuguese, toEnglish);

  await page.reload();
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(false);
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await checkMenu(page, 'Mais', portuguese, toEnglish);

  await runMenuAction(page, 'Mais', 'English');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(menuButton(page, 'More')).toBeVisible();
  expect(await stored(page)).toBe('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await checkMenu(page, 'More', english, toPortuguese);
  expect(errors).toEqual([]);
  await close();
});

test('language: a phrase missing in the pack shows in English, and an orphan entry is ignored', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const edited = await editPack(page, ['Reset layout'], {
    'A phrase the code no longer uses': 'Uma frase que o código não usa mais',
  });
  await choosePortuguese(page);
  const close = await openProject(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await checkMenu(
    page,
    'Mais',
    portuguese.map((item) => (item === 'Restaurar disposição' ? 'Reset layout' : item)),
    toEnglish,
  );
  await expect(page.getByText('Uma frase que o código não usa mais')).toHaveCount(0);
  expect(edited()).toEqual([]);
  expect(errors).toEqual([]);
  await close();
});

test('language: with an empty pack, Portuguese chosen shows everything in English, without error', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const edited = await editPack(page, Object.keys(ptBR));
  await choosePortuguese(page);
  const close = await openProject(page);
  await page.goto('/');
  // The language is Portuguese (<html lang>, the selector offers English); the text is English.
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await checkMenu(
    page,
    'More',
    english.map((item) => (item === 'Português' ? 'English' : item)),
    { ...toEnglish, title: 'Show the interface in English' },
  );
  expect(edited()).toEqual([]);
  expect(errors).toEqual([]);
  await close();
});

test('language: the saved language is in the first render, with no English before the Portuguese', async ({
  page,
}) => {
  // Every state of the More button as the page builds, with the language of the document then.
  await page.addInitScript(() => {
    localStorage.setItem('aae-lang', 'pt');
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    new MutationObserver(() => {
      const button = document.getElementById('more-menu-button');
      if (button) seen.push(`${document.documentElement.lang} ${button.textContent}`);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto('/');
  await expect(menuButton(page, 'Mais')).toBeVisible();
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  expect(seen.length).toBeGreaterThan(0);
  expect(new Set(seen)).toEqual(new Set(['pt-BR Mais']));
});

for (const variant of ['methods', 'getter'] as const)
  test(`language: storage that throws on read and on write (${variant}) means English, and the switch still works`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((variant) => {
      const fail = () => {
        throw new Error('storage unavailable');
      };
      if (variant === 'methods') {
        Storage.prototype.getItem = fail;
        Storage.prototype.setItem = fail;
      } else Object.defineProperty(window, 'localStorage', { get: fail });
    }, variant);
    const close = await openProject(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(menuButton(page, 'More')).toBeVisible();
    // For this session only: nothing could be stored.
    await runMenuAction(page, 'More', 'Português');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(menuButton(page, 'Mais')).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(menuButton(page, 'More')).toBeVisible();
    expect(errors).toEqual([]);
    await close();
  });

test('language: an invalid saved value means English, without error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  for (const value of ['xx', 'PT', 'pt-BR', 'pt ', '', '"pt"']) {
    await page.evaluate((value) => localStorage.setItem('aae-lang', value), value);
    await page.reload();
    await expect(page.locator('html'), JSON.stringify(value)).toHaveAttribute('lang', 'en');
    await expect(menuButton(page, 'More')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

// The Audit and Changes tools. The buttons that open them belong to the top and bottom bars (another
// area), so their name is taken in either language.
const openTool = (page: Page, name: RegExp) => page.getByRole('button', { name }).first().click();

test('language: the audit and the changes are in English, and switching renders them again with the Audit open', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'aae-layout',
      JSON.stringify({ inspector: true, bottom: false, bottomHeight: 520 }),
    );
  });
  const root = mkdtempSync(join(tmpdir(), 'aae-language-audit-'));
  writeTree(root, { 'AGENTS.md': '# Agent\n\nSee [missing](missing.md).\n' });
  const close = await openOnly(page, [root]);
  await page.goto('/');
  await page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));

  await openTool(page, /^(Auditoria|Audit)$/);
  const tabs = page.getByRole('tablist', { name: 'Observation level' });
  await expect(tabs.getByRole('tab', { name: /^Problems\b/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(tabs.getByRole('tab', { name: /^All\b/ })).toBeVisible();
  await expect(page.locator('.audit-type-name')).toHaveText('Broken reference');
  await expect(page.locator('.audit-type-meaning')).toContainText(
    'The referenced file does not exist at the written path',
  );
  await page
    .getByRole('button', { name: /^View detail/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: /^Mark as expected/ }).first()).toBeVisible();
  await expect(page.locator('.diagnosis-searched')).toContainText('Looked in');
  expect(await rawPhrases(page)).toEqual([]);

  // The language changes with the Audit open, without reloading: the same elements, now in Portuguese.
  await runMenuAction(page, 'More', 'Português');
  await expect(
    page
      .getByRole('tablist', { name: 'Nível das observações' })
      .getByRole('tab', { name: /^Problemas\b/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.audit-type-name')).toHaveText('Referência ausente');
  await expect(page.locator('.diagnosis-searched')).toContainText('Procurou em');
  await expect(page.getByRole('button', { name: /^Marcar como esperada/ }).first()).toBeVisible();
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  expect(await rawPhrases(page)).toEqual([]);

  // Changes: the header of the tool, in Portuguese and back in English.
  await openTool(page, /^(Alterações|Changes)$/);
  await expect(page.locator('.changes-times')).toContainText('Referência:');
  // The moment of a scan in the format of the language: day/month and a 24-hour clock here,
  // month/day and AM or PM in English.
  await expect(page.locator('.changes-times')).toContainText(
    /Leitura atual: \d{2}\/\d{2} \d{2}:\d{2}(?! [AP]M)/,
  );
  await expect(page.locator('.changes-empty')).toHaveText('Nenhuma alteração.');
  await runMenuAction(page, 'Mais', 'English');
  await expect(page.locator('.changes-times')).toContainText('Baseline:');
  await expect(page.locator('.changes-times')).toContainText(
    /Current scan: \d{2}\/\d{2} \d{1,2}:\d{2} [AP]M/,
  );
  const [day, month] = await page.evaluate(() => {
    const now = new Date();
    return [now.getDate(), now.getMonth() + 1].map((value) => String(value).padStart(2, '0'));
  });
  // Scanned in this test: today, month first (unless the test ran across midnight).
  await expect(page.locator('.changes-times')).toContainText(`Current scan: ${month}/${day} `);
  await expect(page.locator('.changes-empty')).toHaveText('No changes.');
  await expect(
    page.locator('.tool-panel').getByRole('button', { name: 'Rescan now' }),
  ).toBeVisible();
  expect(await rawPhrases(page)).toEqual([]);
  expect(errors).toEqual([]);
  await close();
});

// No Portuguese in the default language, on the screen: every line of the visible text, `aria-label`,
// `title` and `placeholder`, by the detector of portuguese.ts (the Portuguese pack is its inventory).
// Data is taken out first: the text of the open files (the read-only preview and the lines of a
// comparison) and the names and paths of the projects, files and folders.
const FILE_TEXT = '.source-code, [class^="diff-"] code, [class*=" diff-"] code';
// The name of each language, in its own language, in the More menu: Portuguese by design.
const LANGUAGE_NAME = 'Português';

/** The lines of the screen that look Portuguese, each with the reason. */
async function portugueseOnScreen(page: Page) {
  const headers = await sessionHeaders(page);
  const model = await (await page.request.get('/api/workspace', { headers })).json();
  const items: { path: string; name: string }[] = [
    ...model.roots,
    ...model.savedCases,
    ...model.nodes,
  ];
  const paths = [...new Set(items.map((item) => item.path))].sort((a, b) => b.length - a.length);
  const names = new Set(items.map((item) => item.name));
  const lines = await page.evaluate((data) => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.style.cssText = 'position: absolute; left: -99999px; top: 0; width: 1536px';
    for (const element of copy.querySelectorAll(data)) element.remove();
    document.body.append(copy);
    const visible = copy.innerText;
    copy.remove();
    const attributes = [
      ...document.querySelectorAll('[title], [aria-label], [placeholder]'),
    ].flatMap((element) =>
      ['title', 'aria-label', 'placeholder'].map((name) => element.getAttribute(name) ?? ''),
    );
    return [visible, ...attributes].flatMap((text) => text.split('\n')).map((line) => line.trim());
  }, FILE_TEXT);
  const withoutData = (line: string) =>
    paths
      .reduce((rest, path) => rest.split(path).join(' '), line)
      .split(/(\s+|[()·:,"“”…?!])/)
      .filter((piece) => !names.has(piece))
      .join('');
  return [
    ...new Set(
      lines
        .filter((line) => line && line !== LANGUAGE_NAME)
        .map((line) => [line, portugueseIn(withoutData(line))] as const)
        .filter(([, why]) => why)
        .map(([line, why]) => `${line} — ${why}`),
    ),
  ];
}

/** Checks the screen; `where` names it in the failure. */
async function noPortuguese(page: Page, where: string) {
  await page.waitForTimeout(150);
  expect(await portugueseOnScreen(page), where).toEqual([]);
  expect(await rawPhrases(page), where).toEqual([]);
}

const layoutWithPanels = (page: Page) =>
  page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });

/** Opens a menu of the top bar, checks it and closes it. */
async function checkTopMenu(page: Page, name: 'More' | 'Projects') {
  await menuButton(page, name).click();
  await expect(page.getByRole('menu', { name })).toBeVisible();
  await noPortuguese(page, `${name} menu`);
  await page.keyboard.press('Escape');
}
/** Opens a dialog, checks it and closes it with Esc. */
async function checkDialog(page: Page, where: string, open: () => Promise<unknown>) {
  await open();
  await expect(page.getByRole('dialog')).toBeVisible();
  await noPortuguese(page, where);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('language: a new profile sees no Portuguese on an empty Home, its menus and its dialogs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The first use: no project open nor saved (the other specs of the run leave saved ones).
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    const model = await response.json();
    await route.fulfill({
      response,
      json: { ...model, roots: [], savedCases: [], nodes: [], edges: [], issues: [], signals: [] },
    });
  });
  await page.goto('/');
  await expect(page.locator('.welcome')).toBeVisible();
  await noPortuguese(page, 'Empty Home');
  await checkTopMenu(page, 'More');
  await checkTopMenu(page, 'Projects');
  await checkDialog(page, 'Help', async () => {
    await runMenuAction(page, 'More', 'Help');
    for (const section of await page.locator('.help-content details').all())
      await section.evaluate((element) => ((element as HTMLDetailsElement).open = true));
  });
  await checkDialog(page, 'Add folder', () => runMenuAction(page, 'Projects', 'Add folder'));
  await checkDialog(page, 'New architecture', () =>
    runMenuAction(page, 'Projects', 'New architecture'),
  );
  expect(errors).toEqual([]);
});

test('language: a new profile sees no Portuguese on Home, the views, the inspector, the tools, the notices and their empty and error states', async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await layoutWithPanels(page);
  // Copying a path fails, so the strip shows its error.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
  });
  const base = mkdtempSync(join(tmpdir(), 'aae-language-surfaces-'));
  const root = join(base, 'demo');
  const other = join(base, 'other');
  writeTree(root, {
    'AGENTS.md':
      '# Demo\n\n- [Notes](notes.md)\n- [Guide](docs/guide.md)\n- [Gone](gone.md)\n- [Sub](sub/AGENTS.md)\n- [A](a/common.md)\n- [B](b/common.md)\n',
    'notes.md': '# Notes\n\nOne.\n',
    'docs/guide.md': '# Guide\n\n[Back](../AGENTS.md)\n[Notes](../notes.md)\n',
    'sub/AGENTS.md': '# Sub\n\n[Item](item.md)\n',
    'sub/item.md': '# Item\n',
    'a/common.md': '# A\n',
    'b/common.md': '# B\n',
    'lonely.md': '# Lonely\n',
    'memory/MEMORY.md': '# Memory\n\n- [[notes]]\n',
    // Over the text limit of a file: a partial scan, in the bottom bar and in the Audit.
    'big.md': `# Big\n${'x'.repeat(1100 * 1024)}\n`,
  });
  writeTree(other, { 'AGENTS.md': '# Other\n' });
  const close = await openOnly(page, [root, other]);

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.home-list')).toBeVisible();
  await noPortuguese(page, 'Home');
  await checkDialog(page, 'Open project', () => runMenuAction(page, 'Projects', 'Open project'));
  await checkDialog(page, 'Forget project', () =>
    page.getByRole('button', { name: 'Forget project demo…' }).first().click(),
  );

  await enterProject(page, 'demo');
  await expect(page.locator('.status-bar .status-partial')).toBeVisible();
  await noPortuguese(page, 'Structure, with a partial scan');
  await pickFile(page, `${root}/AGENTS.md`);
  await page.locator('.view-mode button').nth(1).click();
  await noPortuguese(page, 'Map of a file');
  for (const tab of ['File', 'Relations', 'Evidence', 'Notes']) {
    await page.locator('.inspector-tabs').getByRole('button', { name: tab }).click();
    await noPortuguese(page, `Inspector › ${tab}`);
  }
  await page.locator('.inspector .copy-path').click();
  await expect(page.locator('.error-banner')).toContainText('Could not copy the path.');
  await noPortuguese(page, 'A failed copy in the strip');
  await page.getByRole('button', { name: 'Dismiss error' }).click();

  // An empty inspector: a file with no relation.
  await pickFile(page, `${root}/lonely.md`);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Evidence' }).click();
  await expect(page.getByText('No relation found for this file.')).toBeVisible();
  await noPortuguese(page, 'Inspector › Evidence, empty');
  await page.locator('.inspector-tabs').getByRole('button', { name: 'File' }).click();

  // The Trace: candidates, no file, no trace, and a trace found.
  await page.getByRole('button', { name: 'Trace', exact: true }).click();
  await page.locator('#trace-start').fill('AGENTS.md');
  await page.locator('#trace-end').fill('common.md');
  await page.locator('#trace-end').press('Enter');
  await expect(page.getByText('2 files match this path. Choose one:')).toBeVisible();
  await expect(page.getByText('No file at this path. With that ending:')).toBeVisible();
  await noPortuguese(page, 'Trace › candidates and no file');
  await page.locator('#trace-start').fill(`${root}/notes.md`);
  await page.locator('#trace-end').fill(`${root}/AGENTS.md`);
  await page.locator('#trace-end').press('Enter');
  await expect(page.getByText('No trace following the arrows.')).toBeVisible();
  await noPortuguese(page, 'Trace › no trace');
  await page.locator('#trace-start').fill(`${root}/AGENTS.md`);
  await page.locator('#trace-end').fill(`${root}/docs/guide.md`);
  await page.locator('#trace-end').press('Enter');
  await expect(page.locator('.trace-summary')).toContainText('Trace found · 1 step');
  await noPortuguese(page, 'Trace › found');

  await page.locator('.dock-tools').getByRole('button', { name: 'Audit' }).click();
  await page.locator('.audit-levels [data-level="all"]').click();
  // Every file group open (each click changes which ones are still closed).
  const closed = page.locator('.tool-panel .observation-group-head[aria-expanded="false"]');
  for (let open = 0; open < 20 && (await closed.count()); open++) await closed.first().click();
  await page
    .getByRole('button', { name: /^View detail/ })
    .first()
    .click();
  await noPortuguese(page, 'Audit, every level, a detail open');
  await page.locator('.dock-tools').getByRole('button', { name: 'Changes' }).click();
  await noPortuguese(page, 'Changes, none');
  await checkDialog(page, 'Filters', () =>
    page.getByRole('button', { name: 'Map filters' }).click(),
  );

  // A change on disk, read again: the notice under the bar and the Changes with a change.
  await page.locator('.dock-tools').getByRole('button', { name: 'Changes' }).click();
  writeFileSync(join(root, 'notes.md'), '# Notes\n\nOne.\n[Guide](docs/guide.md)\n');
  await page.getByRole('button', { name: 'Rescan projects' }).click();
  await expect(page.locator('.change-notice')).toContainText('Since the baseline:');
  await noPortuguese(page, 'The notice of changes');
  await page.locator('.change-notice button').first().click();
  await noPortuguese(page, 'Changes, with changes');

  await page.locator('.breadcrumb-root').click();
  await page.locator('.view-mode button').nth(1).click();
  await noPortuguese(page, 'Map of a folder');
  await pickFile(page, `${root}/sub/AGENTS.md`);
  await expect(page.locator('.workspace-view-strip')).toBeVisible();
  await noPortuguese(page, 'Two views');
  await page.getByRole('button', { name: 'Minimize view demo' }).click();
  await expect(page.getByRole('button', { name: 'Restore view demo' })).toBeVisible();
  await noPortuguese(page, 'A minimized view');

  // Closing a project from the tree: the notice that offers to reopen it.
  await page.getByLabel('Actions for project other', { exact: true }).click();
  await page.locator('.root-menu[open]').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.removed-notice')).toBeVisible();
  await noPortuguese(page, 'The notice of a closed project');

  await page.setViewportSize({ width: 749, height: 396 });
  await page.locator('#status-menu-button').click();
  await noPortuguese(page, 'Window of 749×396, the Status menu');
  // No icon of a tone or a state in the menu (no loading wheel beside "Ready").
  await expect(page.locator('#status-menu')).toBeVisible();
  await expect(page.locator('#status-menu').locator(ALERT_ICONS)).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  await close();
  rmSync(base, { recursive: true, force: true });
});

test('language: a new profile sees no Portuguese in the strip of a scan cut by the item limit and in its limits (mocked)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await layoutWithPanels(page);
  const root = join(mkdtempSync(join(tmpdir(), 'aae-language-cut-')), 'cut');
  writeTree(root, { 'AGENTS.md': '# Cut\n\n[Notes](notes.md)\n', 'notes.md': '# Notes\n' });
  const close = await openOnly(page, [root]);
  // The inventory limit needs tens of thousands of items: the reading says it was reached instead.
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    const model = await response.json();
    model.stats.inventory = {
      complete: false,
      lookupComplete: true,
      omitted: 1200,
      omittedFiles: 1000,
      byTopLevel: [],
    };
    await route.fulfill({ response, json: model });
  });
  await page.goto('/');
  await enterProject(page, 'cut');
  const strip = page.locator('.error-banner');
  await expect(strip.locator('.strip-action')).toBeVisible();
  await noPortuguese(page, 'The strip of a scan cut by the item limit');
  await strip.locator('.strip-action').click();
  await expect(page.locator('.tool-panel')).toBeVisible();
  await noPortuguese(page, 'The limits in the Audit');
  expect(errors).toEqual([]);
  await close();
});

test('language: a new profile sees no Portuguese in the editor: permission, draft, conflict, a file gone and the unsaved list', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await layoutWithPanels(page);
  const root = join(mkdtempSync(join(tmpdir(), 'aae-language-editor-')), 'edit');
  writeTree(root, {
    'AGENTS.md': '# Edit\n\n[Notes](notes.md)\n[Guide](guide.md)\n',
    'notes.md': '# Notes\n\nOne.\nTwo.\nThree.\n',
    'guide.md': '# Guide\n',
  });
  const headers = await sessionHeaders(page);
  const close = await openOnly(page, [root]);
  await page.goto('/');
  await enterProject(page, 'edit');
  await pickFile(page, `${root}/notes.md`);
  await checkDialog(page, 'Editing permission', () =>
    page.locator('.inspector .edit-button').click(),
  );
  await page.locator('.inspector .edit-button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Allow editing' }).click();
  const notes = page.getByRole('textbox', { name: 'Text of notes.md', exact: true });
  await notes.fill('# Notes\n\nOne.\nTwo, mine.\nThree.\n');
  await noPortuguese(page, 'Editor with a draft');
  await page.getByRole('button', { name: 'Show changes' }).click();
  await noPortuguese(page, 'Editor › Show changes');
  await page.getByRole('button', { name: 'Show changes' }).click();

  // Another program writes the file: the save meets the conflict.
  writeFileSync(join(root, 'notes.md'), '# Notes\n\nOne.\nTwo.\nThree, theirs.\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await noPortuguese(page, 'The conflict');
  await page.keyboard.press('Escape');
  await noPortuguese(page, 'The conflict in the state line');

  // Another file, gone from the disk before its save.
  await pickFile(page, `${root}/guide.md`);
  await page.locator('.inspector .edit-button').click();
  await page
    .getByRole('textbox', { name: 'Text of guide.md', exact: true })
    .fill('# Guide, mine\n');
  rmSync(join(root, 'guide.md'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);
  await noPortuguese(page, 'A save refused: the file is gone');
  await page.keyboard.press('Escape');

  await page.locator('#editing-menu-button').click();
  await noPortuguese(page, 'The editing menu');
  await page
    .getByRole('menuitem', { name: /unsaved document/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await noPortuguese(page, 'Unsaved documents');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  await page.request.post('/api/edit/disable', { headers, data: { root } });
  await close();
});

test('language: switching without reloading rewrites the notices kept on the screen, both ways', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = join(mkdtempSync(join(tmpdir(), 'aae-language-notice-')), 'notice');
  writeTree(root, { 'AGENTS.md': '# Notice\n\n[Notes](notes.md)\n', 'notes.md': '# Notes\n' });
  const close = await openOnly(page, [root]);
  await page.goto('/');
  await enterProject(page, 'notice');
  writeFileSync(join(root, 'extra.md'), '# Extra\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Notice\n\n[Notes](notes.md)\n[Extra](extra.md)\n');
  await page.getByRole('button', { name: 'Rescan projects' }).click();
  const notice = page.locator('.change-notice').first();
  const words = 'Since the baseline: 1 relation added · 1 file changed · 1 file added';
  const palavras =
    'Desde a referência: 1 relação adicionada · 1 arquivo alterado · 1 arquivo adicionado';
  await expect(notice).toHaveText(words);
  await runMenuAction(page, 'More', 'Português');
  // The whole notice in Portuguese, the words of the changes too, in the text and in the title.
  await expect(notice).toHaveText(palavras);
  await expect(notice.locator('button').first()).toHaveAttribute(
    'title',
    `${palavras}. Abrir Alterações`,
  );
  await runMenuAction(page, 'Mais', 'English');
  await expect(notice).toHaveText(words);
  await expect(notice.locator('button').first()).toHaveAttribute('title', `${words}. Open Changes`);
  expect(await portugueseOnScreen(page)).toEqual([]);
  expect(errors).toEqual([]);
  await close();
});
