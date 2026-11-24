import { expect, test } from '@playwright/test';
import { auditRow, showAudit } from './audit-list';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, sessionHeaders } from './helpers';

// The file preview in the inspector mounts the first 400 lines of a long text, with "Mostrar mais 400", instead
// of every line of up to 1 MiB; an evidence line beyond them is still shown and highlighted.
const LINES = 22000;
const EVIDENCE = 21500;

function project() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-source-preview-')), 'pacote');
  mkdirSync(root);
  writeFileSync(join(root, 'AGENTS.md'), '# Pacote\n[Histórico](historico.md)\n');
  writeFileSync(join(root, 'fim.md'), '# Fim\n');
  const lines = Array.from({ length: LINES }, (_, index) =>
    index + 1 === EVIDENCE
      ? 'Ao terminar, leia [o fim](fim.md) antes de seguir.'
      : `Linha ${String(index + 1).padStart(5, '0')} do histórico, sem referências.`,
  );
  writeFileSync(join(root, 'historico.md'), lines.join('\n') + '\n');
  return root;
}

test('source preview: a long file mounts its first lines, shows more on request and still reaches an evidence line', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = project();
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  await page.goto('/');
  // The app opens on Home, where the explorer comes in when asked for.
  await page.getByRole('button', { name: 'Explorador', exact: true }).click();
  // The first click on the file shows its map; a second one on it opens the inspector.
  const item = page.locator('.explorer').getByTitle(join(root, 'historico.md'), { exact: true });
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'true');
  await item.click();
  const inspector = page.locator('.inspector');
  const lines = inspector.locator('.source-code [data-line]');
  await expect(lines.first()).toContainText('Linha 00001 do histórico');
  // Only the first 400 lines are mounted; the rest comes 400 at a time.
  await expect(lines).toHaveCount(400);
  const more = inspector.getByRole('button', { name: /^Mostrar mais/ });
  await expect(more).toHaveText(
    `Mostrar mais 400 · faltam ${(LINES - 400 + 1).toLocaleString('pt-BR')}`,
  );
  // Only the mounted lines are on the page: the button says the browser search and copy reach no further.
  await expect
    .soft(more)
    .toHaveAttribute('title', /busca do navegador \(Ctrl\+F\) e o copiar não alcançam/);
  await more.click();
  await expect(lines).toHaveCount(800);
  await expect(lines.last()).toHaveAttribute('data-line', '800');

  // The evidence of the reference at line 21,500 shows that line, highlighted and in view.
  await inspector.getByRole('button', { name: 'Evidências', exact: true }).click();
  await inspector
    .getByRole('button', { name: 'Ler evidência em historico.md', exact: true })
    .click();
  const highlight = inspector.locator('.highlight-line');
  await expect(highlight).toHaveAttribute('data-line', String(EVIDENCE));
  await expect(highlight).toContainText('[o fim](fim.md)');
  await expect(highlight).toBeInViewport();
  // Only the lines around it are mounted: 200 before and 200 after.
  await expect(lines).toHaveCount(401);
  await expect(lines.first()).toHaveAttribute('data-line', String(EVIDENCE - 200));
  // The lines before the window come back on request, 400 at a time; the highlight stays.
  const before = inspector.getByRole('button', { name: /^Mostrar 400 anteriores/ });
  await expect(before).toHaveText(
    `Mostrar 400 anteriores · faltam ${(EVIDENCE - 201).toLocaleString('pt-BR')}`,
  );
  await before.click();
  await expect(lines).toHaveCount(801);
  await expect(highlight).toHaveAttribute('data-line', String(EVIDENCE));

  // Shortened on disk after the reading: the evidence line no longer exists. The text that exists is shown,
  // with a notice, never an empty preview.
  writeFileSync(
    join(root, 'historico.md'),
    Array.from({ length: 100 }, (_, index) => `Linha ${index + 1}`).join('\n') + '\n',
  );
  const tree = page.locator('.explorer');
  await tree.getByTitle(join(root, 'AGENTS.md'), { exact: true }).click();
  await tree.getByTitle(join(root, 'historico.md'), { exact: true }).click();
  await inspector.getByRole('button', { name: 'Evidências', exact: true }).click();
  await inspector
    .getByRole('button', { name: 'Ler evidência em historico.md', exact: true })
    .click();
  await expect(lines).toHaveCount(101);
  await expect(highlight).toHaveCount(0);
  await expect(inspector.getByRole('status').filter({ hasText: 'A linha' })).toHaveText(
    `A linha ${EVIDENCE.toLocaleString('pt-BR')} não existe na versão do arquivo no disco, que termina na linha 101: ele mudou depois da leitura. Releia os diretórios.`,
  );
  expect(errors).toEqual([]);
});

test('source preview: an observation beyond the first 400 lines opens the file on that line', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = join(mkdtempSync(join(tmpdir(), 'aae-source-preview-')), 'pacote');
  mkdirSync(root);
  writeFileSync(join(root, 'AGENTS.md'), '# Pacote\n[Notas](notas.md)\n');
  writeFileSync(
    join(root, 'notas.md'),
    Array.from({ length: 1000 }, (_, index) =>
      index + 1 === 650 ? 'Veja [o anexo](anexo-ausente.md).' : `Nota ${index + 1}`,
    ).join('\n') + '\n',
  );
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  await page.request.post('/api/open', { headers, data: { path: root } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  await showAudit(page, 'Todas');
  await auditRow(page, 'anexo-ausente.md').first().locator('.file-observation-line').click();
  const inspector = page.locator('.inspector');
  const highlight = inspector.locator('.highlight-line');
  await expect(highlight).toHaveAttribute('data-line', '650');
  await expect(highlight).toBeInViewport();
  // The window around the line, 200 above and 200 below, never the 1,000 lines.
  const lines = inspector.locator('.source-code [data-line]');
  await expect(lines).toHaveCount(401);
  await expect(lines.first()).toHaveAttribute('data-line', '450');
  await expect(inspector.getByRole('button', { name: /^Mostrar mais/ })).toHaveText(
    'Mostrar mais 151 · faltam 151',
  );
  expect(errors).toEqual([]);
});
