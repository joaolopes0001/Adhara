import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, sessionHeaders } from './helpers';

// The scope note and the partial comparison of "Alterações", and the unresolved
// destinations of the search. Synthetic projects in temporary directories.

// openOnly of helpers.ts for one root; returns page errors and headers.
async function openOnly(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { errors, headers };
}

test('review: a scope declared between readings is named in "Alterações" as compare-audit names it, without internal terms', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'aae-layout',
      JSON.stringify({ inspector: false, bottom: false, bottomHeight: 420 }),
    ),
  );
  const root = join(mkdtempSync(join(tmpdir(), 'aae-review-scope-')), 'pacote');
  execFileSync('mkdir', ['-p', root]);
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# Pacote\n[Trabalho](work/x.md)\n[Manifesto](agent-architecture.json)\n',
  );
  writeFileSync(join(root, 'agent-architecture.json'), '{"version": 1}\n');
  const { errors, headers } = await openOnly(page, root);
  writeFileSync(
    join(root, 'agent-architecture.json'),
    JSON.stringify({ version: 1, scope: { version: 1, runtimeWorkspace: ['work/**'] } }),
  );
  const refreshed = await (await page.request.post('/api/refresh', { headers, data: {} })).json();
  expect(refreshed.delta.findings.context.map((item: any) => item.scopeSource)).toEqual([
    { before: null, after: 'manifest' },
  ]);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Alterações/ })
    .first()
    .click();
  const note = page.locator('.changes-content .changes-warning', {
    hasText: 'escopo declarado mudou',
  });
  await expect(note).toHaveText(
    'O escopo declarado mudou entre as leituras (fonte na referência: nenhuma; na leitura atual: agent-architecture.json): parte das observações novas ou resolvidas pode vir da declaração de escopo, não de alterações nos documentos.',
  );
  await expect(page.locator('.changes-content')).not.toContainText('.: ');
  expect(errors).toEqual([]);
});

test('review: a partial comparison in "Alterações" is said once, naming the projects', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'aae-layout',
      JSON.stringify({ inspector: false, bottom: false, bottomHeight: 420 }),
    ),
  );
  const parent = mkdtempSync(join(tmpdir(), 'aae-review-partial-'));
  const roots = ['alfa', 'beta'].map((name) => {
    const root = join(parent, name);
    execFileSync('mkdir', ['-p', root]);
    writeFileSync(join(root, 'AGENTS.md'), '# Pacote\n[Grande](grande.md)\n');
    // Over the per-file text limit: the reading of the project is partial.
    writeFileSync(join(root, 'grande.md'), 'x'.repeat(1024 * 1024 + 10));
    return root;
  });
  const { errors, headers } = await openOnly(page, roots[0]);
  await page.request.post('/api/open', { headers, data: { path: roots[1] } });
  // The baseline of both projects with both open: otherwise the first one is not compared at all.
  await page.request.post('/api/reference', { headers, data: {} });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Alterações/ })
    .first()
    .click();
  const note = page.locator('.changes-content .changes-partial');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveText(
    'Leitura parcial em alfa e beta: observação ausente não prova resolução.',
  );
  await expect(page.locator('.changes-content')).not.toContainText('inconclusiva');
  expect(errors).toEqual([]);
});

test('review: collapsed unresolved destinations do not claim that an unanalysed file does not exist', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'aae-layout',
      JSON.stringify({ inspector: false, bottom: false, bottomHeight: 420 }),
    ),
  );
  const root = join(mkdtempSync(join(tmpdir(), 'aae-review-unscanned-')), 'pacote');
  execFileSync('mkdir', ['-p', join(root, 'node_modules', 'guia')]);
  writeFileSync(
    join(root, 'node_modules', 'guia', 'guia.md'),
    '# Guia existente, fora da análise\n',
  );
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# Pacote\n[Guia](node_modules/guia/guia.md)\n[Ausente](guia-ausente.md)\n',
  );
  const { errors } = await openOnly(page, root);
  await page.goto('/');
  await expect(page.locator('.status-bar .status-files')).toHaveText('1 de 1 arquivo lido');
  await expect(page.locator('.status-bar .status-unresolved')).toHaveText(
    '2 citados não encontrados',
  );
  await page.keyboard.press('Control+k');
  await page.locator('#workspace-search').fill('guia');
  const group = page.locator('.search-unresolved');
  await group.locator('summary').click();
  await expect(
    group
      .locator('.unresolved-item', { hasText: 'node_modules/guia/guia.md' })
      .locator('.unresolved-tag'),
  ).toHaveText('em pasta não lida');
  await expect(
    group.locator('.unresolved-item', { hasText: 'guia-ausente.md' }).locator('.unresolved-tag'),
  ).toHaveText('não existe');
  await expect(group).not.toContainText('inventário');
  await expect(group).not.toContainText('Não existem como arquivo');
  expect(errors).toEqual([]);
});
