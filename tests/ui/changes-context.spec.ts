import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, readable, sessionHeaders, writeTree } from './helpers';

// "Alterações" compares relations and observations only with a baseline read with the same open projects, in the
// same order. Opening a second project leaves those of the first not compared, with the reason in one line; updating
// the baseline compares them again.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-changes-context-'));
  const first = join(base, 'primeiro');
  const second = join(base, 'segundo');
  writeTree(first, { 'AGENTS.md': '# Primeiro\n[X](x.md)\n', 'x.md': '# X\n' });
  writeTree(second, { 'AGENTS.md': '# Segundo\n' });
  return { first, second };
}

test('changes context: another open project leaves relations and observations not compared until the baseline is updated', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { first, second } = fixture();
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  const open = async (path: string) =>
    expect((await page.request.post('/api/open', { headers, data: { path } })).status()).toBe(200);
  try {
    await open(first);
    await page.goto('/');
    const tool = page.getByRole('button', { name: 'Alterações', exact: true });
    await expect(tool.locator('.dock-count')).toHaveCount(0);
    await tool.click();
    const panel = page.locator('.tool-panel');
    await expect(panel).toContainText('Nenhuma alteração.');
    await expect(page.locator('.changes-context')).toHaveCount(0);

    await open(second);
    await page.reload();
    // Nothing changed on disk, but the comparison is not "no change": the dock says it is unknown.
    await expect(tool.locator('.dock-count')).toHaveText('?');
    if ((await tool.getAttribute('aria-expanded')) !== 'true') await tool.click();
    const note = page.locator('.changes-context');
    await expect(note).toHaveText(
      'Relações e observações de primeiro não comparadas: os projetos abertos, ou a ordem deles, mudaram desde a referência.',
    );
    expect(await readable(note.locator('span'))).toBeGreaterThanOrEqual(4.5);
    await expect(panel).not.toContainText('Nenhuma alteração.');
    await expect(page.locator('.changes-section[aria-label="Relações"] h3')).toContainText(
      'não comparadas em primeiro',
    );
    await expect(page.locator('.changes-section[aria-label="Arquivos"] h3')).toContainText(
      'nenhuma alteração',
    );

    // The baseline update, in the header of the tool, compares again in the new context.
    await expect(page.getByRole('button', { name: 'Atualizar referência' })).toBeEnabled();
    await page.getByRole('button', { name: 'Atualizar referência' }).click();
    await expect(note).toHaveCount(0);
    await expect(panel).toContainText('Nenhuma alteração.');
    await expect(tool.locator('.dock-count')).toHaveCount(0);

    // Same context after a reload: nothing to say.
    await page.reload();
    if ((await tool.getAttribute('aria-expanded')) !== 'true') await tool.click();
    await expect(panel).toContainText('Nenhuma alteração.');
    await expect(note).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const path of [second, first])
      await page.request.post('/api/close', { headers, data: { path } });
  }
});

test('changes context: two projects opened in the same second still offer the baseline update', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { first, second } = fixture();
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  try {
    // Back to back: the reference of the first and the current scan usually share their second.
    for (const path of [first, second])
      expect((await page.request.post('/api/open', { headers, data: { path } })).status()).toBe(
        200,
      );
    await page.goto('/');
    const tool = page.getByRole('button', { name: 'Alterações', exact: true });
    if ((await tool.getAttribute('aria-expanded')) !== 'true') await tool.click();
    await expect(page.locator('.changes-context')).toHaveCount(1);
    const adopt = page.getByRole('button', { name: 'Atualizar referência' });
    await expect(adopt).toBeEnabled();
    await expect(adopt).not.toHaveAttribute('title', 'A referência já é a leitura atual');
    await adopt.click();
    await expect(page.locator('.changes-context')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const path of [second, first])
      await page.request.post('/api/close', { headers, data: { path } });
  }
});
