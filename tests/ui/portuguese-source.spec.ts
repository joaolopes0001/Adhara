import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { englishForms, isPortuguese, packForms, portugueseIn } from './portuguese';

// The source of the interface is written in English: no string literal, template piece, JSX text or
// attribute of src/ (but the Portuguese pack itself) may look Portuguese, by the same detector as the
// screen. No browser: it reads the files.
const repo = process.cwd();
const src = join(repo, 'src');

/** What may look Portuguese in the source, each with its reason. */
const EXCEPTIONS: { file: string; text: string; why: string }[] = [
  { file: 'src/i18n/translate.ts', text: 'Português', why: 'the name of the language, in itself' },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !path.endsWith(join('i18n', 'pt-BR.ts')) ? [path] : [];
  });
}

/** Every text of a source file that may reach the screen: literals, template pieces, JSX text. */
function textsOf(path: string) {
  const code = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, text: string) =>
    found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !ts.isImportDeclaration(node.parent) &&
      !ts.isExportDeclaration(node.parent) &&
      // A type never reaches the screen, and `as` names an HTML element (`em` is emphasis, not "in").
      !ts.isLiteralTypeNode(node.parent) &&
      !(ts.isJsxAttribute(node.parent) && node.parent.name.getText() === 'as')
    )
      add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      add(node, node.text);
    else if (ts.isJsxText(node) && node.text.trim()) add(node, node.text.trim());
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test('portuguese in the source: no literal, JSX text or attribute of src/ outside the pack is Portuguese', () => {
  const found: string[] = [];
  const used = new Set<(typeof EXCEPTIONS)[number]>();
  for (const path of sources(src)) {
    const name = relative(repo, path).split('\\').join('/');
    for (const { line, text } of textsOf(path)) {
      const why = portugueseIn(text);
      if (!why) continue;
      const exception = EXCEPTIONS.find((item) => item.file === name && item.text === text);
      if (exception) used.add(exception);
      else found.push(`${name}:${line} (${why}) ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  expect(found).toEqual([]);
  // An exception that no longer matches anything is removed, so the list stays true.
  expect(EXCEPTIONS.filter((item) => !used.has(item)).map((item) => item.text)).toEqual([]);
});

test('portuguese in the source: the detector sees the whole pack and none of the English phrases', () => {
  // The only translations it cannot tell from English: they are written with English words.
  expect(packForms().filter((form) => !isPortuguese(form))).toEqual([
    'Link Markdown',
    '3 e 3',
    'link Markdown',
    '3 e 3',
    'no-3',
  ]);
  expect(englishForms().filter(isPortuguese)).toEqual([]);
  // Unaccented Portuguese of the pack, and accented Portuguese that is not in it.
  for (const text of ['Atualizar', 'Tema claro', 'Ferramentas', 'Copiar caminho', 'Concluído'])
    expect(isPortuguese(text), text).toBe(true);
  for (const text of ['Rescan', 'Switch to light theme', 'Tools', 'Copy path', 'Done'])
    expect(isPortuguese(text), text).toBe(false);
});
