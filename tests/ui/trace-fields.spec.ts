import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionHeaders, writeTree } from './helpers';
import { runMoreAction } from './more-menu';

// Caminho A → B: besides the absolute path, a path relative to an opened directory (with or without its
// name as prefix) when it designates one file; several candidates are shown next to the field; no
// candidate is an error next to the field. Enter traces; editing clears the error; nothing of this tool
// reaches the global error banner.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-trace-fields-'));
  const tree: Record<string, string> = {
    'loja/CLAUDE.md': '# Loja\nAntes de mexer, leia @docs/arquitetura.md.\n',
    'loja/docs/arquitetura.md': '# Arquitetura\n',
    'loja/memory/decisoes.md': '# Decisões\n',
    'playground/CLAUDE.md': '# Playground\n',
  };
  writeTree(base, tree);
  return { loja: join(base, 'loja'), playground: join(base, 'playground') };
}

async function session(page: Page) {
  const headers = await sessionHeaders(page);
  return {
    close: async () => {
      for (const old of (await (await page.request.get('/api/workspace', { headers })).json())
        .roots)
        await page.request.post('/api/close', { headers, data: { path: old.path } });
    },
    open: async (path: string) =>
      expect((await page.request.post('/api/open', { headers, data: { path } })).status()).toBe(
        200,
      ),
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: false, bottom: false, bottomHeight: 300 }),
      );
  });
});

test('trace fields: relative paths, candidates and errors next to the field, Enter traces, no global banner', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { loja, playground } = fixture();
  const api = await session(page);
  await api.close();
  await api.open(loja);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  const a = page.getByLabel('Arquivo de origem A'),
    b = page.getByLabel('Arquivo de destino B');
  const summary = page.locator('.trace-summary');
  // Nothing to trace yet: the fields say what goes in them, the panel says nothing.
  await expect(page.locator('.bottom-content')).toBeEmpty();

  // With the opened directory name as prefix, and Enter in a field traces.
  await a.fill('loja/CLAUDE.md');
  await b.fill('docs/arquitetura.md');
  await b.press('Enter');
  await expect(summary).toContainText('Caminho encontrado · 1 passo');
  // Without the prefix, and Enter in the other field.
  await a.fill('CLAUDE.md');
  await expect(summary).toHaveCount(0);
  await a.press('Enter');
  await expect(summary).toContainText('1 passo');
  // The absolute path keeps working.
  await a.fill(join(loja, 'CLAUDE.md'));
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(summary).toContainText('1 passo');

  // Following the arrows is the default; the summary does not repeat the direction selector.
  await expect(summary.locator('span')).toHaveCount(0);
  // No file and nothing ending the same way: only the fact.
  await b.fill('nada/decisoes.md');
  await b.press('Enter');
  await expect(page.locator('#trace-end-message span')).toHaveText('Nenhum arquivo neste caminho.');
  await expect(page.locator('#trace-end-message').getByRole('button')).toHaveCount(0);
  // No file: the error is next to the field, with files ending the same way as suggestions.
  await b.fill('decisoes.md');
  await b.press('Enter');
  const message = page.locator('#trace-end-message');
  await expect(message.locator('span')).toHaveText('Nenhum arquivo neste caminho. Com esse final:');
  await expect(b).toHaveAttribute('aria-invalid', 'true');
  await expect(b).toHaveAttribute('aria-describedby', 'trace-end-message');
  await expect(message.getByRole('button')).toHaveText(['loja/memory/decisoes.md']);
  await expect(page.locator('#trace-start-message')).toHaveCount(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(summary).toHaveCount(0);
  await page
    .locator('.tool-panel')
    .screenshot({ path: test.info().outputPath('trace-not-found-dark.png') });
  // Editing clears it; choosing a suggestion fills the field with the file, relative to its project.
  await b.press('End');
  await b.pressSequentially(' ');
  await expect(message).toHaveCount(0);
  await expect(b).not.toHaveAttribute('aria-invalid', /.*/);
  await b.press('Enter');
  await message.getByRole('button', { name: 'loja/memory/decisoes.md' }).click();
  await expect(b).toHaveValue('loja/memory/decisoes.md');
  await expect(message).toHaveCount(0);
  await b.press('Enter');
  await expect(page.locator('.bottom-content')).toHaveText('Nenhum caminho seguindo as setas.');

  // Two opened directories with CLAUDE.md: the candidates appear next to the field, to choose.
  await api.open(playground);
  await page.reload();
  await expect(page.locator('.explorer .root-section')).toHaveCount(2);
  if (!(await page.locator('.tool-trace').isVisible()))
    await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await a.fill('CLAUDE.md');
  await b.fill('docs/arquitetura.md');
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  const choices = page.locator('#trace-start-message');
  await expect(choices).toContainText('2 arquivos correspondem a este caminho. Escolha um:');
  await expect(choices.getByRole('button')).toHaveText(['loja/CLAUDE.md', 'playground/CLAUDE.md']);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  for (const [theme, next] of [
    ['dark', 'claro'],
    ['light', 'escuro'],
  ]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page
      .locator('.tool-panel')
      .screenshot({ path: test.info().outputPath(`trace-candidates-${theme}.png`) });
    await runMoreAction(page, `Ativar tema ${next}`);
  }
  // The prefixed form is unique even with both directories open.
  await a.fill('playground/CLAUDE.md');
  await a.press('Enter');
  await expect(page.locator('.bottom-content')).toHaveText('Nenhum caminho seguindo as setas.');
  await expect(page.locator('#trace-start-message')).toHaveCount(0);
  await a.fill('CLAUDE.md');
  await a.press('Enter');
  await choices.getByRole('button', { name: 'loja/CLAUDE.md' }).click();
  await expect(a).toHaveValue('loja/CLAUDE.md');
  await expect(a).toBeFocused();
  await a.press('Enter');
  await expect(summary).toContainText('1 passo');

  // A refusal by the server stays in the tool too.
  await page.route('**/api/trace', (route) =>
    route.fulfill({ status: 400, json: { error: 'Selecione dois arquivos do workspace.' } }),
  );
  await b.press('Enter');
  await expect(page.locator('.trace-error')).toHaveText('Selecione dois arquivos do workspace.');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await b.fill('docs/arquitetura.md ');
  await expect(page.locator('.trace-error')).toHaveCount(0);
  expect(errors).toEqual([]);
  await api.close();
});

test('trace fields show the end of a long path: the project-relative path, the absolute one in the tooltip', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const segment = (name: string) => `${name}-${'com-um-nome-bem-comprido-'.repeat(2)}fim`;
  const loja = join(
    mkdtempSync(join(tmpdir(), 'aae-trace-long-')),
    segment('primeira'),
    segment('segunda'),
    segment('terceira'),
    'loja',
  );
  const record = join(loja, 'docs/decisoes-de-arquitetura/registro-de-decisoes.md');
  mkdirSync(join(record, '..'), { recursive: true });
  writeFileSync(
    join(loja, 'CLAUDE.md'),
    '# Loja\nLeia @docs/decisoes-de-arquitetura/registro-de-decisoes.md.\n',
  );
  writeFileSync(record, '# Registro\n');
  const api = await session(page);
  await api.close();
  await api.open(loja);
  await page.goto('/');
  const a = page.getByLabel('Arquivo de origem A'),
    b = page.getByLabel('Arquivo de destino B');
  // The end of the text (the file name) is inside the visible part of the field.
  const showsEnd = (field: typeof a) =>
    field.evaluate(
      (input: HTMLInputElement) => input.scrollLeft + input.clientWidth >= input.scrollWidth - 1,
    );
  const tooltip = (path: string) =>
    new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`);

  // "Definir como A" from the inspector fills the path relative to the project, which shows the name.
  // The first click on the file in the tree selects it; a second one on it opens the inspector. The app
  // opens on Home, where the explorer comes in when asked for.
  const claude = page.locator('.explorer').getByRole('button', { name: 'CLAUDE.md', exact: true });
  await page.getByRole('button', { name: 'Explorador', exact: true }).click();
  await claude.click();
  await expect(claude).toHaveAttribute('aria-current', 'true');
  await claude.click();
  await page.getByRole('button', { name: 'Definir como A', exact: true }).click();
  await expect.poll(() => showsEnd(a)).toBe(true);
  await expect(a).toHaveValue('loja/CLAUDE.md');
  await expect(a).toHaveAttribute('title', tooltip(join(loja, 'CLAUDE.md')));

  // A typed absolute path longer than the field shows its end once the field is left.
  await b.fill(record);
  expect(await b.evaluate((input: HTMLInputElement) => input.scrollWidth > input.clientWidth)).toBe(
    true,
  );
  await a.focus();
  await expect.poll(() => showsEnd(b)).toBe(true);
  await expect(b).toHaveAttribute('title', tooltip(record));
  await b.press('Enter');
  await expect(page.locator('.trace-summary')).toContainText('Caminho encontrado · 1 passo');
  expect(errors).toEqual([]);
  await api.close();
});

test('trace fields: a chosen file keeps designating it, or leaves the field, when the opened projects change', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const segment = (name: string) => `${name}-${'com-um-nome-bem-comprido-'.repeat(2)}fim`;
  const base = join(mkdtempSync(join(tmpdir(), 'aae-trace-chosen-')), segment('base'));
  const v1 = join(base, segment('v1'), 'loja'),
    v2 = join(base, segment('v2'), 'loja'),
    mono = join(base, 'mono');
  for (const root of [v1, v2, join(mono, 'loja')]) {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# Loja\n[Decisões](docs/d.md)\n');
    writeFileSync(join(root, 'docs/d.md'), '# D\n');
  }
  writeFileSync(join(mono, 'AGENTS.md'), '# Mono\n');
  const call = async (operation: string, path: string) => {
    const response = await page.request.post(`/api/${operation}`, {
      headers: await sessionHeaders(page),
      data: { path },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const api = await session(page);
  await api.close();
  await api.open(v1);
  await page.goto('/');
  const tree = page.locator('.explorer');
  // Home (where the app opens, and where a selection that left goes) shows the tree when asked for.
  const showTree = async () => {
    await expect(page.locator('.home-list, .map-workspace').first()).toBeVisible();
    if (await page.locator('.home-list').count())
      await page.getByRole('button', { name: 'Explorador', exact: true }).click();
    await expect(tree).toBeVisible();
  };
  const a = page.getByLabel('Arquivo de origem A'),
    b = page.getByLabel('Arquivo de destino B');
  const reread = async () => {
    await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reler diretórios', exact: true })).toBeEnabled();
  };
  const showsEnd = () =>
    a.evaluate(
      (input: HTMLInputElement) =>
        input.scrollWidth > input.clientWidth &&
        input.scrollLeft + input.clientWidth >= input.scrollWidth - 1,
    );
  // The first click on the file in the tree selects it; a second one on it opens the inspector.
  const claude = tree.getByTitle(join(v1, 'CLAUDE.md'), { exact: true });
  await showTree();
  await claude.click();
  await expect(claude).toHaveAttribute('aria-current', 'true');
  await claude.click();
  await page.getByRole('button', { name: 'Definir como A', exact: true }).click();
  await expect(a).toHaveValue('loja/CLAUDE.md');

  // Its project closes and another one holds the same relative path: the field never moves to it.
  await call('open', mono);
  await call('close', v1);
  await reread();
  await expect(tree.locator('.root-overview strong')).toHaveText(['mono']);
  await expect(a).toHaveValue('');

  // With the relative path naming two files, "Definir como A" fills the absolute one and shows its end.
  await call('open', v1);
  await reread();
  await showTree();
  await tree.getByTitle(join(v1, 'CLAUDE.md'), { exact: true }).click();
  await page.getByRole('button', { name: 'Definir como A', exact: true }).click();
  await expect(a).toHaveValue(join(v1, 'CLAUDE.md'));
  await expect.poll(showsEnd).toBe(true);

  // Unique again, it is written relative; a second "loja" opens: absolute again, never ambiguous.
  await call('close', mono);
  await reread();
  await expect(a).toHaveValue('loja/CLAUDE.md');
  await call('open', v2);
  await reread();
  await expect(tree.locator('.root-overview strong')).toHaveText(['loja', 'loja']);
  await expect(a).toHaveValue(join(v1, 'CLAUDE.md'));
  await expect(a).toHaveAttribute('title', new RegExp(`^${join(v1, 'CLAUDE.md')}\\n`));
  await b.fill(join(v1, 'docs/d.md'));
  await b.press('Enter');
  await expect(page.locator('#trace-start-message')).toHaveCount(0);
  await expect(page.locator('.trace-summary')).toContainText('Caminho encontrado · 1 passo');
  expect(errors).toEqual([]);
  await api.close();
});
