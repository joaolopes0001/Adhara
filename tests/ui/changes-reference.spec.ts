import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, inBothThemes, sessionHeaders, writeTree } from './helpers';
import { runMoreAction } from './more-menu';

// Origin of the reference in "Alterações". Restarting the test server inside Playwright is not practical:
// the real server provides the reading and the delta, and a mocked /api/workspace marks the reference as
// loaded from disk (persisted) or as not saved, as a restarted server or a failed write would report.
const files: Record<string, string> = {
  'AGENTS.md': '# Pacote\n[Contrato](core/contrato.md)\n[Obsoleto](obsoleto/ausente.md)\n',
  'core/contrato.md': '# Contrato\n',
  'notas/rascunho.md': '# Rascunho\n',
};
const yesterday = '2026-10-01T18:05:00-03:00';

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-reference-')), 'pacote');
  writeTree(root, files);
  return root;
}

/** Opens only `root` in the test server and edits a link, so the real delta has one relation added and one removed. */
async function openEdited(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  const agents = join(root, 'AGENTS.md');
  writeFileSync(
    agents,
    readFileSync(agents, 'utf8').replace(
      '[Obsoleto](obsoleto/ausente.md)',
      '[Rascunho](notas/rascunho.md)',
    ),
  );
  const refreshed = await (await page.request.post('/api/refresh', { headers, data: {} })).json();
  expect(refreshed.delta.relations.totals).toEqual({ added: 1, removed: 1 });
}

/** Both themes: contrast of `selectors` and a capture of the tool panel. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: false, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('reference saved on disk: a restarted server compares with the reading of the day before', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  await openEdited(page, root);
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    const model = await response.json();
    model.delta.reference = { at: yesterday, uniform: true };
    model.delta.roots = model.delta.roots.map((item: any) => ({
      ...item,
      referenceAt: yesterday,
      referenceOrigin: 'persisted',
      referenceSaved: true,
    }));
    model.delta.warnings = [];
    await route.fulfill({ response, json: model });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.dock-tools .dock-count')).toBeVisible();
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await expect(page.locator('.changes-times > span').first()).toContainText(
    'Referência: leitura de 01/10 18:05',
  );
  await expect(page.locator('.changes-origin')).toHaveText('salva em disco');
  await expect(page.locator('.changes-origin')).toHaveAttribute(
    'title',
    /Carregada do estado do aplicativo/,
  );
  await expect(page.locator('.changes-origin.unsaved')).toHaveCount(0);
  await expect(page.locator('.changes-warning')).toHaveCount(0);
  // The explanation is in the collapsed "Sobre a referência" and says "projeto".
  await expect(page.locator('.changes-about')).toContainText(
    'continua valendo depois de reiniciar o servidor; excluir o projeto a apaga',
  );
  await expect(page.locator('.changes-content')).not.toContainText('se perde ao reiniciá-lo');
  const relations = page.locator('.changes-section[aria-label="Relações"]');
  await expect(relations.locator('h3')).toContainText('1 adicionada · 1 removida');
  await expect(page.getByRole('button', { name: 'Atualizar referência' })).toBeEnabled();
  await inBothThemes(
    page,
    ['.changes-origin', '.changes-times strong', '.changes-about summary'],
    'reference-persisted',
  );
  // The help text says the reference survives a restart.
  await runMoreAction(page, 'Ajuda');
  await expect(page.locator('.help-content')).toContainText(
    'continua valendo depois de reiniciar o servidor e é apagada ao excluir o projeto',
  );
  expect(errors).toEqual([]);
});

test('reference not saved: ignored file and failed write are visible, and adopting tries to save again', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  await openEdited(page, root);
  const ignored =
    'Referência salva ignorada: arquivo corrompido ou truncado. Esta leitura passou a ser a referência.';
  const unsaved =
    'Referência não salva: falha de gravação (sem permissão). Ela vale só até reiniciar o servidor.';
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    const model = await response.json();
    // As if the first reading had happened now: the reference equals the current reading, but is not on disk.
    // A first reading has no differences: since a non-empty delta is never treated as the reference itself
    // (readings have one-second resolution), the mock empties it to stay the scenario it describes.
    model.delta.files = { ...model.delta.files, added: [], removed: [], changed: [] };
    model.delta.files.totals = { added: 0, removed: 0, changed: 0 };
    model.delta.relations = { added: [], removed: [], totals: { added: 0, removed: 0 } };
    model.delta.findings = {
      ...model.delta.findings,
      new: [],
      resolved: [],
      totals: { new: 0, resolved: 0 },
    };
    model.delta.reference = { at: model.delta.current.at, uniform: true };
    model.delta.roots = model.delta.roots.map((item: any) => ({
      ...item,
      referenceAt: model.delta.current.at,
      referenceOrigin: 'first-reading',
      referenceSaved: false,
    }));
    model.delta.warnings = [
      { root, code: 'reference-ignored', message: ignored },
      { root, code: 'reference-not-saved', message: unsaved },
    ];
    await route.fulfill({ response, json: model });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await expect(page.locator('.changes-origin').first()).toHaveText('desta sessão');
  await expect(page.locator('.changes-origin').first()).not.toHaveAttribute(
    'title',
    /salva no estado/,
  );
  await expect(page.locator('.changes-origin.unsaved')).toHaveText('não salva');
  await expect(page.locator('.changes-warning[role="alert"]')).toHaveText([ignored, unsaved]);
  const adopt = page.getByRole('button', { name: 'Atualizar referência' });
  // The reference already is the current reading, but it is not saved: the button retries the write.
  await expect(adopt).toBeEnabled();
  await expect(adopt).toHaveAttribute('title', /Tentar salvar de novo/);
  await inBothThemes(
    page,
    ['.changes-origin.unsaved', '.changes-warning', '.changes-origin'],
    'reference-unsaved',
  );
  // The real server saves it (its state directory is writable): the warnings and the mark go away.
  await adopt.click();
  await expect(page.locator('.changes-confirmation')).toContainText(
    'Referência atualizada: leitura de',
  );
  await expect(page.locator('.changes-origin.unsaved')).toHaveCount(0);
  await expect(page.locator('.changes-warning')).toHaveCount(0);
  await expect(page.locator('.changes-origin')).toHaveText('desta sessão');
  await expect(adopt).toBeDisabled();
  expect(errors).toEqual([]);
});

test('same second: a reading with differences taken in the second of the reference can still become the reference; an empty one cannot', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  await openEdited(page, root);
  // Deterministic version of the race the changes flow only meets by chance: readings have one-second
  // resolution, so the mock gives the current reading the exact instant of the saved reference.
  let empty = false;
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    const model = await response.json();
    expect(model.delta.relations.totals).toEqual({ added: 1, removed: 1 });
    const at = model.delta.roots[0].referenceAt;
    model.delta.current = { at };
    model.delta.reference = { at, uniform: true };
    model.delta.roots = model.delta.roots.map((item: any) => ({
      ...item,
      referenceAt: at,
      referenceOrigin: 'persisted',
      referenceSaved: true,
    }));
    if (empty) {
      model.delta.files = { ...model.delta.files, added: [], removed: [], changed: [] };
      model.delta.files.totals = { added: 0, removed: 0, changed: 0 };
      model.delta.relations = { added: [], removed: [], totals: { added: 0, removed: 0 } };
      model.delta.findings = {
        ...model.delta.findings,
        new: [],
        resolved: [],
        totals: { new: 0, resolved: 0 },
      };
    }
    await route.fulfill({ response, json: model });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  const adopt = page.getByRole('button', { name: 'Atualizar referência' });
  await expect(page.locator('.changes-section[aria-label="Relações"] h3')).toContainText(
    '1 adicionada · 1 removida',
  );
  await expect(page.locator('.changes-times')).toContainText('Referência: leitura de');
  // Same instant and saved, but with differences: the current reading is not the reference.
  await expect(adopt).toBeEnabled();
  // Control: the same instant without differences is the reference itself, nothing to adopt.
  empty = true;
  await page.reload();
  await page.getByRole('button', { name: 'Alterações', exact: true }).click();
  await expect(page.locator('.changes-empty')).toHaveText('Nenhuma alteração.');
  await expect(adopt).toBeDisabled();
  expect(errors).toEqual([]);
});
