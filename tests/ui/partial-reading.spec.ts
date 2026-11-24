import { expect, test, type Page } from '@playwright/test';
import { auditFiles, auditRows, auditTab } from './audit-list';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, enterProject, sessionHeaders } from './helpers';

// A reading is partial for the same reasons the CLI answers "inconclusive": besides the inventory limit
// (reader-limits.spec.ts, with a strip below the header) and the relation cap, a text over the size
// limit or a file that cannot be read. Those show one link in the footer and never the strip; a complete
// reading shows neither.
// openOnly of helpers.ts for one root, and then it reloads the page; nothing is returned.
async function openOnly(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  await page.goto('/');
}

function folder(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'aae-partial-reading-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

test('partial reading: a text over the size limit gives the footer link, not the strip', async ({
  page,
}) => {
  const root = folder({
    'AGENTS.md': '# Entrada\n[Grande](grande.md)\n',
    // Over the 1 MiB limit of one text: listed, not analysed.
    'grande.md': `# Grande\n${'linha sem referências\n'.repeat(60000)}`,
  });
  await openOnly(page, root);
  const footer = page.locator('.status-bar');
  const link = footer.getByRole('button', { name: 'Leitura parcial' });
  await expect(link).toBeVisible();
  // The link says the cause as a fact, with its count.
  await expect(link).toHaveText('1 arquivo não lido');
  await expect(link).toHaveAttribute(
    'title',
    'Leitura parcial (limite de texto): pode faltar observação.',
  );
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await link.click();
  // The audit opens on the warnings, with the type of limit chosen and its file open.
  await expect(auditTab(page, 'Avisos')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Tipo de observação')).toHaveValue('limit');
  await expect(auditFiles(page).first().locator('.observation-group-head')).toContainText(
    'grande.md',
  );
  await expect(auditRows(page).first()).toBeVisible();
});

test('partial reading: a file that cannot be read gives the footer link, which opens the read failures', async ({
  page,
}) => {
  const root = folder({ 'AGENTS.md': '# Entrada\n[Fechado](fechado.md)\n', 'fechado.md': '# x\n' });
  chmodSync(join(root, 'fechado.md'), 0o000);
  let readable = false;
  try {
    readFileSync(join(root, 'fechado.md'));
    readable = true;
  } catch {
    /* Expected: the permission is what this test needs. */
  }
  test.skip(readable, 'Running with privileges that read any file: no read failure to show.');
  try {
    await openOnly(page, root);
    const link = page.locator('.status-bar').getByRole('button', { name: 'Leitura parcial' });
    await expect(link).toHaveText('1 falha de leitura');
    await expect(link).toHaveAttribute(
      'title',
      'Leitura parcial (arquivo ilegível): pode faltar observação.',
    );
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await link.click();
    await expect(auditTab(page, 'Avisos')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Tipo de observação')).toHaveValue('unreadable');
    await expect(auditFiles(page).first().locator('.observation-group-head')).toContainText(
      'fechado.md',
    );
  } finally {
    chmodSync(join(root, 'fechado.md'), 0o644);
  }
});

test('partial reading: a name that is not UTF-8 leaves its folder read in part, and says why', async ({
  page,
}) => {
  const root = folder({ 'AGENTS.md': '# Entrada\n[Nota](notas/a.md)\n' });
  mkdirSync(join(root, 'notas'));
  writeFileSync(join(root, 'notas', 'a.md'), '# A\n');
  // The name `n\xff.md` as bytes: it is not valid UTF-8, so it cannot enter the model.
  writeFileSync(
    Buffer.concat([Buffer.from(`${root}/notas/`), Buffer.from([0x6e, 0xff, 0x2e, 0x6d, 0x64])]),
    '# x\n',
  );
  await openOnly(page, root);
  const footer = page.locator('.status-bar');
  await expect(footer.getByRole('button', { name: 'Leitura parcial' })).toHaveText(
    '1 falha de leitura',
  );
  // Not the inventory limit: no strip.
  await expect(page.locator('.error-banner')).toHaveCount(0);
  const name = root.split('/').at(-1)!;
  // From Home, the list of projects, by the row of the project.
  await enterProject(page, name);
  const structure = page.getByRole('region', { name: `Estrutura de ${name}` }).first();
  const listing = structure
    .locator('.structure-row.is-folder', { hasText: 'notas' })
    .locator('.structure-listing');
  // Before: the folder said nothing, as if listed whole.
  await expect(listing).toHaveText('lida em parte · 1 item fora');
  await expect(listing).toHaveAttribute('title', /não é UTF-8 válido/);
  await expect(listing).not.toHaveAttribute('title', /limite de itens/);
  // The inspector of the folder says the cause and shows the observation that names the file.
  await page.locator('.explorer .tree-item', { hasText: 'notas' }).click();
  const inside = page.getByRole('region', { name: 'Estrutura de notas' }).first();
  await expect(inside.locator('.structure-summary .structure-listing')).toHaveAttribute(
    'title',
    /não é UTF-8 válido/,
  );
  // A file opens the inspector; the folder then shows its overview there.
  await page.locator('.explorer .tree-item', { hasText: 'a.md' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('a.md');
  await page.locator('.explorer .tree-item', { hasText: 'notas' }).click();
  await expect(page.locator('.directory-overview h2')).toHaveText('notas');
  await expect(page.locator('.directory-listing')).toHaveText(
    'Lida em parte · 1 item fora (nome que não é UTF-8 válido: veja a observação abaixo).',
  );
  await expect(page.locator('.directory-overview')).toContainText('n\\xff.md');
});

test('partial reading: a complete reading shows neither the strip nor the footer link', async ({
  page,
}) => {
  const root = folder({ 'AGENTS.md': '# Entrada\n[Nota](nota.md)\n', 'nota.md': '# Nota\n' });
  await openOnly(page, root);
  await expect(page.locator('.status-bar .status-files')).toHaveText('2 de 2 arquivos lidos');
  await expect(
    page.locator('.status-bar').getByRole('button', { name: 'Leitura parcial' }),
  ).toHaveCount(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);
});
