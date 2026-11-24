import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, readable, sessionHeaders } from './helpers';

// "Alterações" under the inventory limit, on the real server and real folders: the limit (20,000 elements)
// is shared among the opened projects, so a project of a little more than 10,000 files is read whole alone
// and in part once a second project is opened. The files left out are still on disk: the panel never says
// they were removed, says in one sentence how many were not compared, and the dock count leaves them out. The
// baseline was read with the project alone, so its relations and observations are not compared at all.
const FILES = 10050;

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-changes-limit-'));
  const big = join(base, 'grande');
  mkdirSync(join(big, 'z'), { recursive: true });
  writeFileSync(join(big, 'AGENTS.md'), '# Grande\n');
  for (let index = 0; index < FILES; index++)
    writeFileSync(join(big, 'z', `f${String(index).padStart(5, '0')}.dat`), 'x');
  // Past the share of the project once another one is open: its relation and its finding are not compared.
  writeFileSync(join(big, 'z', 'zz.md'), '# Última\n[Entrada](../AGENTS.md)\n');
  const small = join(base, 'pequeno');
  mkdirSync(small);
  writeFileSync(join(small, 'AGENTS.md'), '# Pequeno\n');
  return { big, small };
}

test('changes under the limit: a second project leaves files out, never shown as removed', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { big, small } = fixture();
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  const open = async (path: string) => {
    const response = await page.request.post('/api/open', { headers, data: { path } });
    expect(response.status()).toBe(200);
    return (await response.json()).delta;
  };
  try {
    // Alone, the project is read whole: it is the reference.
    const first = await open(big);
    expect(first.files.uncompared).toBe(0);
    const delta = await open(small);
    // Read in part now: what was left out is not compared, and nothing is removed.
    expect(delta.files.totals).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(delta.files.uncompared).toBeGreaterThan(0);
    expect(delta.relations.totals).toEqual({ added: 0, removed: 0 });
    expect(delta.roots.map((root: { context: string }) => root.context)).toEqual([
      'changed',
      'same',
    ]);
    expect(delta.relations.uncompared).toBe(0);
    expect(delta.findings.uncompared).toBe(0);
    const counted =
      delta.files.totals.added +
      delta.files.totals.removed +
      delta.files.totals.changed +
      delta.relations.totals.added +
      delta.relations.totals.removed +
      delta.findings.totals.new +
      delta.findings.totals.resolved;

    await page.goto('/');
    const tool = page.getByRole('button', { name: 'Alterações', exact: true });
    // The dock counts only what changed, never the files not compared; with relations and observations not
    // compared, it never reads as "no change".
    expect(counted).toBe(0);
    await expect(tool.locator('.dock-count')).toHaveText('?');
    await tool.click();
    const note = page.locator('.changes-uncompared');
    await expect(note).toHaveText(
      `${delta.files.uncompared} arquivos não comparados: ficaram fora do inventário de uma das leituras.`,
    );
    const filesSection = page.locator('.changes-section[aria-label="Arquivos"]');
    await expect(filesSection.locator('h3')).toContainText('nenhuma alteração');
    await expect(page.locator('.change-row.removed')).toHaveCount(0);
    await expect(page.locator('.tool-panel')).not.toContainText('removido');
    expect(await readable(note.locator('span'))).toBeGreaterThanOrEqual(4.5);
    expect(errors).toEqual([]);
  } finally {
    for (const path of [small, big])
      await page.request.post('/api/close', { headers, data: { path } });
  }
});

test('changes under the limit, same projects open: what one scan left out is not compared, in one sentence', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Fits the share of one project out of two at the baseline; grows past it afterwards.
  const base = mkdtempSync(join(tmpdir(), 'aae-changes-limit-same-'));
  const big = join(base, 'grande');
  mkdirSync(join(big, 'z'), { recursive: true });
  writeFileSync(join(big, 'AGENTS.md'), '# Grande\n');
  for (let index = 0; index < 9900; index++)
    writeFileSync(join(big, 'z', `f${String(index).padStart(5, '0')}.dat`), 'x');
  writeFileSync(join(big, 'z', 'zz.md'), '# Última\n[Entrada](../AGENTS.md)\n');
  const small = join(base, 'pequeno');
  mkdirSync(small);
  writeFileSync(join(small, 'AGENTS.md'), '# Pequeno\n');
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  try {
    for (const path of [big, small])
      expect((await page.request.post('/api/open', { headers, data: { path } })).status()).toBe(
        200,
      );
    const adopted = (
      await (await page.request.post('/api/reference', { headers, data: {} })).json()
    ).delta;
    expect(adopted.files.uncompared).toBe(0);
    for (let index = 9900; index < 10150; index++)
      writeFileSync(join(big, 'z', `f${String(index).padStart(5, '0')}.dat`), 'x');
    const delta = (await (await page.request.post('/api/refresh', { headers, data: {} })).json())
      .delta;
    expect(delta.roots.map((root: { context: string }) => root.context)).toEqual(['same', 'same']);
    expect(delta.files.uncompared).toBeGreaterThan(0);
    expect(delta.relations.totals).toEqual({ added: 0, removed: 0 });
    expect(delta.relations.uncompared).toBe(1);
    expect(delta.findings.uncompared).toBeGreaterThan(0);

    await page.goto('/');
    const tool = page.getByRole('button', { name: 'Alterações', exact: true });
    if ((await tool.getAttribute('aria-expanded')) !== 'true') await tool.click();
    const note = page.locator('.changes-uncompared');
    await expect(note).toHaveText(
      `${delta.files.uncompared} ${delta.files.uncompared === 1 ? 'arquivo não comparado' : 'arquivos não comparados'}, com 1 relação e ${delta.findings.uncompared === 1 ? '1 observação' : `${delta.findings.uncompared} observações`}: ${delta.files.uncompared === 1 ? 'ficou' : 'ficaram'} fora do inventário de uma das leituras.`,
    );
    await expect(page.locator('.change-row.removed')).toHaveCount(0);
    await expect(page.locator('.changes-context')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const path of [small, big])
      await page.request.post('/api/close', { headers, data: { path } });
  }
});
