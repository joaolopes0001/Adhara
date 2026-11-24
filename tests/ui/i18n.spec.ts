import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LANGUAGES, translator } from '../../src/i18n/translate';

// The translation core with packs written here, and scripts/i18n-check.mjs, without a browser.

const html = (node: ReactNode) => renderToStaticMarkup(createElement('p', null, node));
const strong = (chunks: ReactNode) => createElement('strong', null, chunks);

/** Runs the check tool; `--json` unless told otherwise. */
function check(...args: string[]) {
  const run = spawnSync(process.execPath, ['scripts/i18n-check.mjs', ...args], {
    encoding: 'utf8',
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('i18n: the English phrase is the text; the pack translates it, and what it lacks stays English', () => {
  const pack = { 'Open project': 'Abrir projeto', 'Open {name}': 'Abrir {name}' };
  const en = translator('en');
  const pt = translator('pt', pack);
  expect(en.t('Open project')).toBe('Open project');
  expect(pt.t('Open project')).toBe('Abrir projeto');
  expect(pt.t('Open {name}', { name: 'AGENTS.md' })).toBe('Abrir AGENTS.md');
  // A phrase without an entry: English, with no error.
  expect(pt.t('Close project')).toBe('Close project');
  expect(pt.t('Line {line} of {name}', { line: '12', name: 'x' })).toBe('Line 12 of x');
  // Only the pack's own entries count, never what every object inherits.
  expect(pt.t('toString')).toBe('toString');
  expect(pt.t('constructor')).toBe('constructor');
});

test('i18n: an empty pack shows everything in English, with the numbers of the language', () => {
  const pt = translator('pt', {});
  expect(pt.t('Open project')).toBe('Open project');
  expect(pt.t('{count} relations', { count: 1000 })).toBe('1.000 relations');
  expect(pt.plural(1000, '{count} file', '{count} files')).toBe('1.000 files');
  expect(pt.plural(1, '{count} file', '{count} files')).toBe('1 file');
  expect(html(pt.rich('Press <kbd>F1</kbd>', { kbd: strong }))).toBe(
    '<p>Press <strong>F1</strong></p>',
  );
});

test('i18n: plural by Intl.PluralRules with 0, 1, 2 and 1,000 in both languages', () => {
  const pack = { '{count} file | {count} files': '{count} arquivo | {count} arquivos' };
  const en = translator('en');
  const pt = translator('pt', pack);
  const results = [0, 1, 2, 1000, 1.5].map((count) => [
    en.plural(count, '{count} file', '{count} files'),
    pt.plural(count, '{count} file', '{count} files'),
  ]);
  expect(results).toEqual([
    ['0 files', '0 arquivos'],
    ['1 file', '1 arquivo'],
    ['2 files', '2 arquivos'],
    ['1,000 files', '1.000 arquivos'],
    ['1.5 files', '1,5 arquivos'],
  ]);
  // A form need not repeat the number; other parameters fill both forms.
  const folders = {
    'A file in {folder} | {count} files in {folder}':
      'Um arquivo em {folder} | {count} arquivos em {folder}',
  };
  const p = translator('pt', folders);
  expect(p.plural(1, 'A file in {folder}', '{count} files in {folder}', { folder: 'docs' })).toBe(
    'Um arquivo em docs',
  );
  expect(p.plural(3, 'A file in {folder}', '{count} files in {folder}', { folder: 'docs' })).toBe(
    '3 arquivos em docs',
  );
  // Without the pair, or with a translation that is not a pair: the English forms, by English rules.
  expect(pt.plural(0, '{count} item', '{count} items')).toBe('0 items');
  const broken = translator('pt', { '{count} item | {count} items': '{count} itens' });
  expect(broken.plural(1, '{count} item', '{count} items')).toBe('1 item');
});

test('i18n: a context gives one English phrase two translations, and only where asked', () => {
  const pack = {
    Open: 'Abrir',
    '[state] Open': 'Aberto',
    '[state] {count} open | {count} open': '{count} aberto | {count} abertos',
  };
  const pt = translator('pt', pack);
  const en = translator('en');
  expect(pt.t('Open')).toBe('Abrir');
  expect(pt.t('Open', { context: 'state' })).toBe('Aberto');
  expect(en.t('Open', { context: 'state' })).toBe('Open');
  expect(pt.t('Open', { context: 'other' })).toBe('Open');
  expect(pt.plural(2, '{count} open', '{count} open', { context: 'state' })).toBe('2 abertos');
});

test('i18n: parameters and numbers; a missing parameter stays written; tags are text in t()', () => {
  const en = translator('en');
  const pt = translator('pt', { 'Line {line} of {name}': 'Linha {line} de {name}' });
  expect(en.t('Line {line} of {name}', { line: 1200, name: 'AGENTS.md' })).toBe(
    'Line 1,200 of AGENTS.md',
  );
  expect(pt.t('Line {line} of {name}', { line: 1200, name: 'AGENTS.md' })).toBe(
    'Linha 1.200 de AGENTS.md',
  );
  expect(pt.formatNumber(1234567.5)).toBe('1.234.567,5');
  expect(en.formatNumber(1234567.5)).toBe('1,234,567.5');
  // Dates and times too, in the local time of the computer: Portuguese as the interface wrote them
  // before, English in its own order and clock; what is not a date stays as it came.
  const moment = new Date(2026, 10, 7, 9, 5).toISOString();
  expect(pt.formatDate(moment, 'date')).toBe('07/11/2026');
  expect(pt.formatDate(moment, 'day-time')).toBe('07/11 09:05');
  expect(pt.formatDate(moment, 'time')).toBe('09:05');
  expect(en.formatDate(moment, 'date')).toBe('11/07/2026');
  expect(en.formatDate(moment, 'day-time')).toBe('11/07 9:05 AM');
  expect(en.formatDate(moment, 'time')).toBe('9:05 AM');
  expect(en.formatDate(new Date(2026, 10, 18, 13, 56), 'day-time')).toBe('11/18 1:56 PM');
  expect(en.formatDate('not a date', 'date')).toBe('not a date');
  // Past the types (`as never`), a missing parameter shows instead of throwing or vanishing.
  expect(en.t('Open {name}', {} as never)).toBe('Open {name}');
  expect(en.t('Press <kbd>Ctrl+K</kbd> to search <b>{name}</b>', { name: 'x' })).toBe(
    'Press Ctrl+K to search x',
  );
});

test('i18n: rich text puts elements in the middle of a translated phrase, with no concatenation', () => {
  const pt = translator('pt', {
    'The file <b>{name}</b> references {count} targets':
      'O arquivo <b>{name}</b> cita {count} destinos',
  });
  expect(
    html(
      pt.rich('The file <b>{name}</b> references {count} targets', {
        b: strong,
        name: 'AGENTS.md',
        count: 1000,
      }),
    ),
  ).toBe('<p>O arquivo <strong>AGENTS.md</strong> cita 1.000 destinos</p>');
  const en = translator('en');
  expect(
    html(
      en.rich('See {link} or <b>press <kbd>F1</kbd></b>', {
        link: createElement('a', { href: '#help' }, 'Help'),
        b: strong,
        kbd: (chunks: ReactNode) => createElement('kbd', null, chunks),
      }),
    ),
  ).toBe('<p>See <a href="#help">Help</a> or <strong>press <kbd>F1</kbd></strong></p>');
});

test('i18n: each language names itself, and is written with its own tag', () => {
  expect([LANGUAGES.en.name, LANGUAGES.pt.name]).toEqual(['English', 'Português']);
  expect([LANGUAGES.en.tag, LANGUAGES.pt.tag]).toEqual(['en', 'pt-BR']);
});

test('i18n: every translation of the Portuguese pack keeps the parameters and tags of its phrase', () => {
  const run = check('--json');
  expect(run.status, run.stderr).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result.entries).toBeGreaterThan(0);
  // A translation with another {parameter} or <tag> would show broken text: this list must be empty.
  expect(result.mismatched).toEqual([]);
});

test('i18n: the check lists missing, orphan, broken and unreadable phrases, and fails only with --strict', () => {
  const root = mkdtempSync(join(tmpdir(), 'aae-i18n-check-'));
  const { compilerOptions } = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'texts.ts'),
    `import { plural, t, useI18n } from ${JSON.stringify(resolve('src/i18n'))};
declare const label: string;
declare const yes: boolean;
export function texts() {
  const i18n = useI18n();
  return [
    t('Used and translated'),
    t('Used, not translated'),
    i18n.t('Open {name}', { name: 'AGENTS.md' }),
    plural(2, '{count} file', '{count} files'),
    plural(3, '{count} item', '{count} items'),
    t('Open', { context: 'state' }),
    t(yes ? 'Yes' : 'No'),
    t(label),
    t(\`Hello \${label}\`),
  ];
}
`,
  );
  writeFileSync(
    join(root, 'pack.ts'),
    `export const pack = {
  'Used and translated': 'Usada e traduzida',
  'Open {name}': 'Abrir {nome}',
  '{count} file | {count} files': '{count} arquivo | {count} arquivos',
  '{count} item | {count} items': '{count} itens',
  '[state] Open': 'Aberto',
  'Yes': 'Sim',
  'Orphan phrase': 'Frase órfã',
  'Broken <b>tag</b>': 'Tag <b>quebrada',
};
`,
  );
  const args = ['--project', join(root, 'tsconfig.json'), '--pack', join(root, 'pack.ts')];
  const run = check(...args, '--json');
  expect(run.status, run.stderr).toBe(0);
  const result = JSON.parse(run.stdout);
  const phrases = (items: { phrase?: string; key?: string }[]) =>
    items.map((item) => item.phrase ?? item.key).sort();
  expect(phrases(result.missing)).toEqual(['No', 'Used, not translated']);
  expect(phrases(result.orphans)).toEqual(['Broken <b>tag</b>', 'Orphan phrase']);
  expect(phrases(result.mismatched)).toEqual([
    'Broken <b>tag</b>',
    'Open {name}',
    '{count} item | {count} items',
  ]);
  expect(result.mismatched.find((m: { key: string }) => m.key === 'Open {name}').problem).toBe(
    'parameters {nome}, the English has {name}',
  );
  expect(result.nonLiteral.map((n: { call: string }) => n.call)).toEqual([
    't(label)',
    't(`Hello ${label}`)',
  ]);
  expect(result.missing[0].file).toBe(join('src', 'texts.ts'));

  // The report is text by default, exit 0; --strict fails while a list is not empty; bad use is 2.
  const text = check(...args);
  expect(text.status).toBe(0);
  expect(text.stdout).toContain('(a) Phrases without a translation, shown in English (2)');
  expect(check(...args, '--strict').status).toBe(1);
  expect(check('--nope').status).toBe(2);
});
