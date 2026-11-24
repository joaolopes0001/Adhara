// Compile-time checks of the phrase types, never imported: `npm run build` type-checks this file and
// fails when a `@ts-expect-error` below stops finding its error, that is, when the types of `t()`,
// `plural()` and `rich()` loosen. scripts/i18n-check.mjs skips src/i18n/, so these phrases are not
// taken for interface text.
import type { ReactNode } from 'react';
import type { Translator } from './translate';

declare const i18n: Translator;
declare const node: ReactNode;
declare const label: string;

i18n.t('Help');
// @ts-expect-error A phrase without placeholders takes no parameters.
i18n.t('Help', { name: 'x' });
i18n.t('Open {name}', { name: 'AGENTS.md' });
i18n.t('Line {line} of {name}', { line: 3, name: 'AGENTS.md' });
// @ts-expect-error A missing parameter is an error.
i18n.t('Open {name}');
// @ts-expect-error So is one of two.
i18n.t('Line {line} of {name}', { line: 3 });
// @ts-expect-error And a misspelled one.
i18n.t('Open {name}', { nmae: 'AGENTS.md' });

// A context for the rare phrase with two translations; `context` is not a placeholder name.
i18n.t('Open', { context: 'state' });
i18n.t('Open {name}', { name: 'AGENTS.md', context: 'state' });
// @ts-expect-error
i18n.t('Open {context}', { context: 'x' });

// A phrase that is not a literal compiles, unchecked: `npm run i18n:check` lists the call.
i18n.t(label);

i18n.plural(2, '{count} file', '{count} files');
i18n.plural(2, 'One file in {folder}', '{count} files in {folder}', { folder: 'docs' });
// @ts-expect-error The count is a number,
i18n.plural('2', '{count} file', '{count} files');
// @ts-expect-error the parameters of both forms are required,
i18n.plural(2, 'One file in {folder}', '{count} files in {folder}');
// @ts-expect-error and `{count}` is the count, not a parameter.
i18n.plural(2, '{count} file', '{count} files', { count: 2 });

// In `t()` a tag is only text; in `rich()` it needs its function, and placeholders take nodes.
i18n.t('Press <kbd>Ctrl+K</kbd> to search');
i18n.rich('Press <kbd>Ctrl+K</kbd> to search', { kbd: (chunks) => chunks });
i18n.rich('The file {name} is missing', { name: node });
// @ts-expect-error A tag without its function is an error.
i18n.rich('Press <kbd>Ctrl+K</kbd> to search');
// @ts-expect-error As is a placeholder without its node.
i18n.rich('The file <b>{name}</b> is missing', { b: (chunks) => chunks });
