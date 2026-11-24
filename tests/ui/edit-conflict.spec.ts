import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectFile } from './helpers';
import {
  editProject,
  editorText,
  enableEditing,
  openForEditing,
  outcome,
  startEditing,
} from './edit-helpers';

// What a save does when the disk is not what the editor read: the conflict with both lists and three ways
// out, the review that "Keep my text" makes mandatory, a conflict of metadata only, the outcome of an answer
// that says nothing (checked by reading the file again), a file deleted, the second of two windows, and an
// undo after another program changed the file. Real conflicts are made by writing the file from the test;
// a lost or unclear answer of the server is simulated by intercepting the request (said in each test).
const files = {
  'AGENTS.md': '# Projeto\n[Notas](notas.md)\n',
  'notas.md': '# Notas\n\nUm.\nDois.\nTrês.\n',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

/** Opens the project with editing on and the editor of notas.md; returns the root, the file and the undo. */
async function editing(page: Page) {
  const root = editProject(files);
  const file = join(root, 'notas.md');
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  await page.reload();
  await selectFile(page, file);
  const text = await startEditing(page, 'notas.md');
  return { root, file, text, cleanup };
}
/** Replaces the whole text of the editor, as typing would. */
async function retype(page: Page, value: string) {
  const area = editorText(page, 'notas.md');
  await area.fill(value);
}
/** The conflict: the app's wide dialog, opened by a save that meets it or by "Resolver…". */
const conflict = (page: Page) => page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
/** The sentence of the conflict in the state line, and its long form in the tooltip. */
async function saysConflict(page: Page) {
  await expect(outcome(page)).toContainText('Mudou no disco desde que você abriu');
  await expect(outcome(page).locator('.editor-status-text')).toHaveAttribute(
    'title',
    'O arquivo mudou no disco desde que você abriu.',
  );
}

test('edit conflict: the file changed on disk after it was opened; nothing is overwritten, both lists show, and "Keep my text" makes the next save show what it undoes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { file, cleanup } = await editing(page);
  try {
    await retype(page, '# Notas\n\nUm.\nDois, meu.\nTrês.\n');
    // Another program writes the file.
    writeFileSync(file, '# Notas\n\nUm.\nDois.\nTrês, deles.\n');
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    const panel = conflict(page);
    // The sentence in the state line; the save that met the conflict opens its dialog, which says
    // nothing was overwritten, with Decidir depois focused.
    await saysConflict(page);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(
      'Outro programa gravou notas.md depois que você o abriu. Nada foi sobrescrito.',
    );
    await expect(panel.getByRole('button', { name: 'Decidir depois' })).toBeFocused();
    // Nothing was overwritten.
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nUm.\nDois.\nTrês, deles.\n');
    const mine = panel.getByRole('group', { name: 'O que você mudou' });
    const theirs = panel.getByRole('group', { name: 'O que mudou no disco' });
    await expect(mine.locator('.diff-added code')).toHaveText(['Dois, meu.']);
    await expect(mine.locator('.diff-removed code')).toHaveText(['Dois.']);
    await expect(theirs.locator('.diff-added code')).toHaveText(['Três, deles.']);
    await expect(theirs.locator('.diff-removed code')).toHaveText(['Três.']);
    // Each changed line: its sign, its number and its text, with the change named for screen readers;
    // two lines of context around the change, and nothing else.
    await expect(mine.locator('.diff-removed .diff-sign [aria-hidden="true"]')).toHaveText('−');
    await expect(mine.locator('.diff-removed .visually-hidden')).toHaveText('Excluída:');
    await expect(mine.locator('.diff-removed .diff-number')).toHaveText('4');
    await expect(mine.locator('.diff-added .diff-sign [aria-hidden="true"]')).toHaveText('+');
    await expect(mine.locator('.diff-same code')).toHaveText([' ', 'Um.', 'Três.', ' ']);
    // No "force" anywhere: copy, decide later, and the two ways out.
    await expect(panel.locator('.modal-footer button')).toHaveText([
      'Copiar meu texto',
      'Decidir depois',
      'Descartar meu texto',
      'Manter meu texto',
    ]);
    // Decidir depois (and Esc) closes it; the conflict stays in the state line, and Resolver… opens it.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await saysConflict(page);
    await outcome(page).getByRole('button', { name: 'Resolver…' }).click();
    await expect(panel).toBeVisible();
    // Copy my text puts it on the clipboard.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.getByRole('button', { name: 'Copiar meu texto' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '# Notas\n\nUm.\nDois, meu.\nTrês.\n',
    );

    // Keep my text: the base becomes the version on disk, the text stays; saving now reviews first.
    await panel.getByRole('button', { name: 'Manter meu texto' }).click();
    await expect(conflict(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    // The review is the app's dialog, with Cancelar focused.
    const review = page.getByRole('dialog', { name: 'Gravar sobre a versão do disco?' });
    await expect(review).toContainText(
      'Você manteve o seu texto sobre uma versão mais nova do disco. Gravar substitui essa versão; o que muda:',
    );
    await expect(review.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    // What the save undoes of the other program is in the list.
    await expect(review.locator('.diff-removed code')).toHaveText(['Dois.', 'Três, deles.']);
    await expect(review.locator('.diff-added code')).toHaveText(['Dois, meu.', 'Três.']);
    // Cancel keeps everything; the disk is still theirs.
    await review.getByRole('button', { name: 'Cancelar' }).click();
    await expect(review).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nUm.\nDois.\nTrês, deles.\n');
    // Ctrl+S also reviews, and Confirmar gravação writes.
    await editorText(page, 'notas.md').press('Control+s');
    await review.getByRole('button', { name: 'Confirmar gravação' }).click();
    await expect(outcome(page)).toContainText('Gravado · +2 −2');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nUm.\nDois, meu.\nTrês.\n');

    // Undo after keeping my text gives back the other program's version, not the one before the conflict.
    await outcome(page).getByRole('button', { name: 'Desfazer' }).click();
    await expect(outcome(page)).toContainText('Gravação desfeita');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nUm.\nDois.\nTrês, deles.\n');
    expect(errors).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('edit conflict: "Discard my text" in the conflict dialog (the confirmation, Decidir depois focused) takes the version on disk; a file deleted is never created again and its text stays in the unsaved list', async ({
  page,
}) => {
  const { file, root, cleanup } = await editing(page);
  try {
    await retype(page, '# Notas\n\nMeu texto.\n');
    writeFileSync(file, '# Notas\n\nDo disco.\n');
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    // The dialog is the question: Decidir depois has the focus, Esc decides later and keeps the text.
    await expect(conflict(page).getByRole('button', { name: 'Decidir depois' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(conflict(page)).toHaveCount(0);
    await expect(editorText(page, 'notas.md')).toHaveValue('# Notas\n\nMeu texto.\n');
    await outcome(page).getByRole('button', { name: 'Resolver…' }).click();
    await conflict(page).getByRole('button', { name: 'Descartar meu texto' }).click();
    await expect(conflict(page)).toHaveCount(0);
    await expect(editorText(page, 'notas.md')).toHaveValue('# Notas\n\nDo disco.\n');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nDo disco.\n');
    await expect(page.locator('.status-bar [data-key="editing"]')).toHaveText(
      'Edição ligada: projeto',
    );

    // Deleted by another program: the save is refused, the app does not create the file again.
    await retype(page, '# Notas\n\nDe novo.\n');
    rmSync(file);
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('O arquivo não existe mais');
    await expect(outcome(page).locator('.editor-status-text')).toHaveAttribute(
      'title',
      'O arquivo não existe mais no disco. O app não o recria; seu texto fica na lista de documentos não gravados.',
    );
    expect(() => readFileSync(file)).toThrow();
    // The draft is in the list of unsaved documents of the bar.
    const bar = page.locator('.status-bar');
    await expect(bar.locator('[data-key="editing"]')).toHaveText(
      'Edição ligada: projeto · 1 não gravado',
    );
    await bar.getByRole('button', { name: 'Edição ligada: projeto · 1 não gravado' }).click();
    await page.getByRole('menuitem', { name: '1 documento não gravado' }).click();
    const list = page.getByRole('dialog', { name: 'Documentos não gravados' });
    await expect(list.locator('.pending-item')).toHaveCount(1);
    await expect(list.locator('.pending-head strong')).toHaveText('notas.md');
    await expect(list.locator('.pending-state')).toHaveText('Não existe mais no disco');
    await page.keyboard.press('Escape');
    expect(() => readFileSync(file)).toThrow();
    void root;
  } finally {
    await cleanup();
  }
});

test('edit conflict: a conflict of metadata only is tried again once, without the dialog; repeated, it says so (simulated answers)', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await retype(page, '# Notas\n\nMetadados.\n');
    // SIMULATED: the server answers `conflict` once while the bytes on disk did not change (a chmod
    // during the save); the window reads the same hash and saves again, which the real server accepts.
    let refused = 0;
    const once = async (route: Route) => {
      if (refused++ === 0)
        return route.fulfill({
          status: 409,
          json: {
            error: 'O arquivo mudou no disco depois de aberto para edição. Nada foi gravado.',
            code: 'conflict',
          },
        });
      return route.continue();
    };
    await page.route('**/api/edit/save', once);
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Gravado · +1 −3');
    expect(refused).toBe(2);
    await expect(conflict(page)).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nMetadados.\n');
    await page.unroute('**/api/edit/save', once);

    // SIMULATED: always `conflict` with the same bytes: one retry, then the sentence, never a loop.
    let attempts = 0;
    await page.route('**/api/edit/save', (route) => {
      attempts++;
      return route.fulfill({
        status: 409,
        json: {
          error: 'O arquivo mudou no disco depois de aberto para edição. Nada foi gravado.',
          code: 'conflict',
        },
      });
    });
    await retype(page, '# Notas\n\nOutra vez.\n');
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Outro programa está mudando o arquivo');
    await expect(outcome(page).locator('.editor-status-text')).toHaveAttribute(
      'title',
      'Outro programa está mexendo neste arquivo sem mudar o conteúdo; tente de novo.',
    );
    await expect(conflict(page)).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nMetadados.\n');
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanup();
  }
});

test('edit outcome unknown: unconfirmed, a server error or no answer are checked by reading the file again, and never shown as "not saved" without looking (simulated answers)', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  const original = readFileSync(file, 'utf8');
  try {
    // SIMULATED: the save happens on the real server, and the answer becomes `unconfirmed`.
    await retype(page, '# Notas\n\nGravado de fato.\n');
    await page.route('**/api/edit/save', async (route) => {
      await route.fetch();
      await route.fulfill({
        status: 409,
        json: {
          error:
            'Não foi possível confirmar se o arquivo foi trocado. Releia o arquivo antes de gravar de novo.',
          code: 'unconfirmed',
        },
      });
    });
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Gravado · +1 −3 · conferido relendo o arquivo');
    // Without the answer there is no previous hash: no undo.
    await expect(outcome(page).getByRole('button', { name: 'Desfazer' })).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nGravado de fato.\n');
    await page.unrouteAll();

    // SIMULATED: a server error (500) without saving: the disk still has the base, "Não gravado", with Gravar.
    await retype(page, '# Notas\n\nNão chegou.\n');
    await page.route('**/api/edit/save', (route) =>
      route.fulfill({ status: 500, json: { error: 'Falha interna do leitor (KeyError).' } }),
    );
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Não gravado; o disco não mudou');
    await expect(outcome(page).locator('.editor-status-text')).toHaveAttribute(
      'title',
      'Não gravado: o arquivo no disco ainda é o que você abriu.',
    );
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nGravado de fato.\n');
    await page.unrouteAll();
    await outcome(page).getByRole('button', { name: 'Gravar' }).click();
    await expect(outcome(page)).toContainText('Gravado · ');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nNão chegou.\n');

    // SIMULATED: the connection drops after the real save (the answer is lost): checked, saved.
    await retype(page, '# Notas\n\nResposta perdida.\n');
    await page.route('**/api/edit/save', async (route) => {
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('conferido relendo o arquivo');
    await expect(outcome(page)).toContainText('Gravado · ');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nResposta perdida.\n');
    await page.unrouteAll();

    // SIMULATED: `unconfirmed`, and another program wrote the file meanwhile: the conflict, not "saved".
    await retype(page, '# Notas\n\nMeu.\n');
    await page.route('**/api/edit/save', async (route) => {
      writeFileSync(file, '# Notas\n\nDe outro programa.\n');
      await route.fulfill({
        status: 409,
        json: {
          error: 'Não foi possível confirmar se o arquivo foi trocado.',
          code: 'unconfirmed',
        },
      });
    });
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await saysConflict(page);
    await expect(conflict(page)).toBeVisible();
    await expect(outcome(page)).not.toContainText('Gravado');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nDe outro programa.\n');
    void original;
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanup();
  }
});

test('edit outcome unknown: with the server unreachable the screen never says "saved", the text stays, and when it answers again the window checks the disk (simulated)', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await retype(page, '# Notas\n\nSem servidor.\n');
    // SIMULATED: every request to the API fails as with the server stopped (connection refused).
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Sem resposta do servidor');
    await expect(outcome(page).locator('.editor-status-text')).toHaveAttribute(
      'title',
      'Sem resposta do servidor. Seu texto continua nesta janela.',
    );
    await expect(outcome(page)).not.toContainText('Gravado');
    await expect(editorText(page, 'notas.md')).toHaveValue('# Notas\n\nSem servidor.\n');
    await outcome(page).getByRole('button', { name: 'Copiar' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '# Notas\n\nSem servidor.\n',
    );
    // "Tentar de novo" while it is still down: the same sentence, never "not saved".
    await outcome(page).getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(outcome(page)).toContainText('Sem resposta do servidor');
    expect(readFileSync(file, 'utf8')).toBe(files['notas.md']);
    // The server answers again: on its own, within a few seconds, the window reads the file and says
    // the save did not happen, with Gravar.
    await page.unrouteAll();
    await expect(outcome(page)).toContainText('Não gravado; o disco não mudou', {
      timeout: 10000,
    });
    await outcome(page).getByRole('button', { name: 'Gravar' }).click();
    await expect(outcome(page)).toContainText('Gravado · ');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nSem servidor.\n');
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanup();
  }
});

test('edit conflict: two windows on the same file, the second to save gets the conflict; an undo after another program changed the file is refused as a conflict', async ({
  page,
  context,
}) => {
  const { file, cleanup } = await editing(page);
  const other = await context.newPage();
  try {
    await other.goto('/');
    await selectFile(other, file);
    await startEditing(other, 'notas.md');
    // The first window saves.
    await retype(page, '# Notas\n\nPrimeira janela.\n');
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Gravado · ');
    // The second, opened before, saves on top: conflict, nothing overwritten.
    await editorText(other, 'notas.md').fill('# Notas\n\nSegunda janela.\n');
    await other.getByRole('button', { name: 'Gravar', exact: true }).click();
    await saysConflict(other);
    await expect(conflict(other)).toBeVisible();
    await expect(
      conflict(other)
        .getByRole('group', { name: 'O que mudou no disco' })
        .locator('.diff-added code'),
    ).toHaveText(['Primeira janela.']);
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nPrimeira janela.\n');

    // Undo in the first window after another program changed the file: the conflict, not the old text.
    writeFileSync(file, '# Notas\n\nOutro programa.\n');
    await outcome(page).getByRole('button', { name: 'Desfazer' }).click();
    await saysConflict(page);
    await expect(conflict(page)).toBeVisible();
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nOutro programa.\n');
  } finally {
    await other.close();
    await cleanup();
  }
});

test('edit conflict: after a reading, a draft whose file changed on disk says the conflict before any save, in the state line only; Resolver… shows it', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await retype(page, '# Notas\n\nAinda não gravado.\n');
    writeFileSync(file, '# Notas\n\nMudou por fora.\n');
    // No save: only a reading of the projects.
    await page.getByRole('button', { name: 'Reler diretórios' }).click();
    await saysConflict(page);
    // Found by a reading, not by a save: no dialog opens by itself.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await outcome(page).getByRole('button', { name: 'Resolver…' }).click();
    await expect(conflict(page)).toBeVisible();
    await expect(
      conflict(page)
        .getByRole('group', { name: 'O que mudou no disco' })
        .locator('.diff-added code'),
    ).toHaveText(['Mudou por fora.']);
    await expect(editorText(page, 'notas.md')).toHaveValue('# Notas\n\nAinda não gravado.\n');
    expect(readFileSync(file, 'utf8')).toBe('# Notas\n\nMudou por fora.\n');
  } finally {
    await cleanup();
  }
});
