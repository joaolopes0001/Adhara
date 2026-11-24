// Compares the English phrases of the interface with a translation pack. Read-only.
// Usage: npm run i18n:check [-- --strict] [--json] [--project tsconfig.json] [--pack src/i18n/pt-BR.ts]
//
// It lists (a) phrases of the code without an entry in the pack (they show in English), (b) entries
// the code does not use (ignored), (c) entries whose translation has other parameters or tags than
// the English phrase, or is malformed (it would show broken text), and (d) calls whose phrase or
// context is not a literal (nothing can be checked for them). The calls are found with the
// TypeScript compiler: every call that resolves to `t`, `plural` or `rich` of src/i18n/translate.ts.
// Exit 0; with --strict, 1 when a list is not empty; 2 when the arguments or the files are wrong.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = resolve(repo, 'src/i18n');
const translateFile = resolve(i18nDir, 'translate.ts');
// The same key format as src/i18n/translate.ts (PLURAL_SEPARATOR and packKey).
const PLURAL_SEPARATOR = ' | ';
const packKey = (phrase, context) => (context ? `[${context}] ${phrase}` : phrase);
const CONTEXT_PREFIX = /^\[[^\]]*\] /;

function fail(message) {
  console.error(`i18n-check: ${message}`);
  process.exit(2);
}

const options = {
  strict: false,
  json: false,
  project: resolve(repo, 'tsconfig.json'),
  pack: resolve(repo, 'src/i18n/pt-BR.ts'),
};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (arg === '--strict') options.strict = true;
  else if (arg === '--json') options.json = true;
  else if (arg === '--project' || arg === '--pack') {
    if (!argv[index + 1]) fail(`${arg} needs a path`);
    options[arg.slice(2)] = resolve(argv[++index]);
  } else fail(`unknown argument ${arg}`);
}
const base = dirname(options.project);
const where = (node) => {
  const file = node.getSourceFile();
  return {
    file: relative(base, file.fileName),
    line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  };
};

// The program of the project, as `tsc` sees it.
const config = ts.readConfigFile(options.project, ts.sys.readFile);
if (config.error) fail(`cannot read ${options.project}`);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, base);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: { ...parsed.options, noEmit: true },
});
const checker = program.getTypeChecker();

/** The texts an argument can take when it is written as literals (a conditional of literals too). */
function literals(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const [yes, no] = [literals(node.whenTrue), literals(node.whenFalse)];
    return yes && no ? [...yes, ...no] : null;
  }
  return null;
}

/** The context of the options argument: `undefined` when there is none, `null` when it is not a literal. */
function contextOf(node) {
  if (!node) return undefined;
  if (ts.isObjectLiteralExpression(node)) {
    const property = node.properties.find((p) => p.name && p.name.getText() === 'context');
    if (!property) return node.properties.some((p) => ts.isSpreadAssignment(p)) ? null : undefined;
    if (!ts.isPropertyAssignment(property)) return null;
    const texts = literals(property.initializer);
    return texts?.length === 1 ? texts[0] : null;
  }
  return checker.getTypeAtLocation(node).getProperty('context') ? null : undefined;
}

const uses = new Map(); // key → [{ file, line, plural }]
const nonLiteral = [];
const use = (key, node, plural) => {
  if (!uses.has(key)) uses.set(key, []);
  uses.get(key).push({ ...where(node), plural });
};

function visit(node) {
  if (ts.isCallExpression(node)) {
    const declaration = checker.getResolvedSignature(node)?.declaration;
    const name = declaration?.name?.getText();
    if (
      declaration &&
      resolve(declaration.getSourceFile().fileName) === translateFile &&
      ['t', 'plural', 'rich'].includes(name)
    ) {
      const plural = name === 'plural';
      const [phrases, others] = plural
        ? [literals(node.arguments[1] ?? node), literals(node.arguments[2] ?? node)]
        : [literals(node.arguments[0] ?? node), ['']];
      const context = contextOf(node.arguments[plural ? 3 : 1]);
      if (
        !phrases ||
        !others ||
        context === null ||
        (plural && (phrases.length > 1 || others.length > 1))
      )
        nonLiteral.push({
          ...where(node),
          call: node.getText().replace(/\s+/g, ' ').slice(0, 120),
        });
      else if (plural) use(packKey(phrases[0] + PLURAL_SEPARATOR + others[0], context), node, true);
      else for (const phrase of phrases) use(packKey(phrase, context), node, false);
    }
  }
  ts.forEachChild(node, visit);
}
const roots = new Set(parsed.fileNames.map((file) => resolve(file)));
for (const file of program.getSourceFiles())
  if (roots.has(resolve(file.fileName)) && !resolve(file.fileName).startsWith(i18nDir + '/'))
    visit(file);

// The pack: the object literal of its exported constant.
let packSource;
try {
  packSource = ts.createSourceFile(
    options.pack,
    readFileSync(options.pack, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
} catch {
  fail(`cannot read the pack ${options.pack}`);
}
let packObject;
for (const statement of packSource.statements)
  if (
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
    for (const declaration of statement.declarationList.declarations) {
      let value = declaration.initializer;
      while (
        value &&
        (ts.isSatisfiesExpression(value) ||
          ts.isAsExpression(value) ||
          ts.isParenthesizedExpression(value))
      )
        value = value.expression;
      if (value && ts.isObjectLiteralExpression(value)) packObject ??= value;
    }
if (!packObject) fail(`no exported object literal in ${options.pack}`);

const PLACEHOLDER = /\{([^{}]*)\}/g;
const TAG = /<([A-Za-z]\w*)>/g;
const names = (text, pattern) =>
  [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();
/** Why a text would not format whole: a stray brace, or a tag not closed in order. */
function malformed(text) {
  if (/[{}]/.test(text.replace(/\{[A-Za-z]\w*\}/g, ''))) return 'a brace that is not a {parameter}';
  const open = [];
  for (const [, close, name] of text.matchAll(/<(\/?)([A-Za-z]\w*)>/g))
    if (!close) open.push(name);
    else if (open.pop() !== name) return `</${name}> closes no open <${name}>`;
  return open.length ? `<${open.at(-1)}> is not closed` : null;
}

const entries = new Map();
const mismatched = [];
for (const property of packObject.properties) {
  const position = where(property);
  const key =
    ts.isPropertyAssignment(property) &&
    (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))
      ? property.name.text
      : null;
  const value = key !== null ? literals(property.initializer) : null;
  if (key === null || !value || value.length !== 1) {
    mismatched.push({
      ...position,
      key: property.getText().slice(0, 80),
      problem: 'not a literal "phrase": "translation" entry',
    });
    continue;
  }
  const translation = value[0];
  entries.set(key, { ...position, translation });
  const english = key.replace(CONTEXT_PREFIX, '');
  const problems = [];
  const plural =
    uses.get(key)?.some((u) => u.plural) ?? english.split(PLURAL_SEPARATOR).length === 2;
  if (plural && translation.split(PLURAL_SEPARATOR).length !== 2)
    problems.push(`a plural needs two forms joined by '${PLURAL_SEPARATOR}'`);
  for (const [kind, pattern] of [
    ['parameters', PLACEHOLDER],
    ['tags', TAG],
  ]) {
    const [expected, found] = [names(english, pattern), names(translation, pattern)];
    if (expected.join() !== found.join())
      problems.push(
        `${kind} ${found.map((n) => (kind === 'tags' ? `<${n}>` : `{${n}}`)).join(' ') || 'none'}, the English has ${expected.map((n) => (kind === 'tags' ? `<${n}>` : `{${n}}`)).join(' ') || 'none'}`,
      );
  }
  const broken = malformed(translation);
  if (broken) problems.push(broken);
  if (problems.length)
    mismatched.push({ ...position, key, translation, problem: problems.join('; ') });
}

const missing = [...uses]
  .filter(([key]) => !entries.has(key))
  .flatMap(([key, at]) => at.map((u) => ({ file: u.file, line: u.line, phrase: key })));
const orphans = [...entries]
  .filter(([key]) => !uses.has(key))
  .map(([key, entry]) => ({ file: entry.file, line: entry.line, phrase: key }));
const result = {
  pack: relative(base, options.pack),
  phrases: uses.size,
  entries: entries.size,
  missing,
  orphans,
  mismatched,
  nonLiteral,
};

if (options.json) console.log(JSON.stringify(result, null, 2));
else {
  const quote = (text) => `'${text}'`;
  console.log(
    `i18n check: ${result.phrases} phrases in the code, ${result.entries} entries in ${result.pack}`,
  );
  const section = (title, items, line) => {
    console.log(`\n${title} (${items.length})`);
    for (const item of items) console.log(`  ${item.file}:${item.line}  ${line(item)}`);
  };
  section('(a) Phrases without a translation, shown in English', missing, (i) => quote(i.phrase));
  section('(b) Entries the code no longer uses, ignored', orphans, (i) => quote(i.phrase));
  section(
    '(c) Translations that would show broken text',
    mismatched,
    (i) => `${quote(i.key)}: ${i.problem}`,
  );
  section('(d) Calls with a phrase or context that is not a literal', nonLiteral, (i) => i.call);
}
const found = missing.length + orphans.length + mismatched.length + nonLiteral.length;
if (!options.json && !options.strict && found)
  console.log('\nExit 0: pass --strict to fail when a list is not empty.');
process.exit(options.strict && found ? 1 : 0);
