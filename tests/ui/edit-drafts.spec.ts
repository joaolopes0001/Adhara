import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjectsAction } from './more-menu';
import { openOnly, selectFile, sessionHeaders, writeTree } from './helpers';
import { editorText, enableEditing, outcome, startEditing } from './edit-helpers';

// Drafts belong to the window, not to the model: they survive choosing another file, a reading and a
// file renamed by another program; the bar counts them and lists them with Copiar, Gravar and Descartar;
// leaving with them (closing the window, removing the project, switching projects, turning editing off)
// asks first, with Cancelar focused; forgetting the project (Excluir) says so in its own dialog; and
// editing turned off in another window offers to allow it again.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

function projects() {
  const base = mkdtempSync(join(tmpdir(), 'aae-edit-drafts-'));
  const a = join(base, 'loja'),
    b = join(base, 'outro');
  writeTree(a, {
    'AGENTS.md': '# Loja\n[A](a.md)\n[B](b.md)\n',
    'a.md': '# A\n\nTexto de a.\n',
    'b.md': '# B\n\nTexto de b.\n',
  });
  writeTree(b, { 'AGENTS.md': '# Outro\n' });
  return { a, b };
}

test('edit drafts: a draft survives another file, a reading and a rename; the bar lists it with Copiar, Gravar and Descartar', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { a } = projects();
  const close = await openOnly(page, [a]);
  await enableEditing(page, a);
  try {
    await page.goto('/');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await selectFile(page, join(a, 'a.md'));
    await startEditing(page, 'a.md');
    await editorText(page, 'a.md').fill('# A\n\nTexto de a, editado.\n');
    const bar = page.locator('.status-bar');
    await expect(bar.locator('[data-key="editing"]')).toHaveText(
      'Edição ligada: loja · 1 não gravado',
    );

    // Another file: the editor leaves the front, the draft stays.
    await selectFile(page, join(a, 'b.md'));
    await expect(page.locator('.file-editor')).toHaveCount(0);
    await expect(page.locator('.inspector .source-code')).toContainText('Texto de b.');
    await selectFile(page, join(a, 'a.md'));
    await expect(editorText(page, 'a.md')).toHaveValue('# A\n\nTexto de a, editado.\n');
    // A reading of the projects keeps the editor and its text.
    await page.getByRole('button', { name: 'Reler diretórios' }).click();
    await expect(page.locator('.app-footer')).toContainText('Pronto');
    await expect(editorText(page, 'a.md')).toHaveValue('# A\n\nTexto de a, editado.\n');

    // A draft of b.md, then another program renames b.md and the projects are read again.
    await selectFile(page, join(a, 'b.md'));
    await startEditing(page, 'b.md');
    await editorText(page, 'b.md').fill('# B\n\nTexto de b, editado.\n');
    renameSync(join(a, 'b.md'), join(a, 'c.md'));
    await page.getByRole('button', { name: 'Reler diretórios' }).click();
    await expect(bar.locator('[data-key="editing"]')).toHaveText(
      'Edição ligada: loja · 2 não gravados',
    );

    // The list: both, each with its state and actions; the renamed one only to copy.
    await bar.getByRole('button', { name: 'Edição ligada: loja · 2 não gravados' }).click();
    await page.getByRole('menuitem', { name: '2 documentos não gravados' }).click();
    const list = page.getByRole('dialog', { name: 'Documentos não gravados' });
    const itemA = list.locator('.pending-item', { hasText: 'a.md' });
    const itemB = list.locator('.pending-item', { hasText: 'b.md' });
    await expect(itemA.locator('.pending-state')).toHaveText('Não gravado');
    await expect(itemA.getByRole('button')).toHaveText(['Abrir', 'Copiar', 'Gravar', 'Descartar']);
    await expect(itemB.locator('.pending-state')).toHaveText('Fora da leitura atual');
    await expect(itemB.getByRole('button')).toHaveText(['Mostrar texto', 'Copiar', 'Descartar']);
    await itemB.getByRole('button', { name: 'Mostrar texto' }).click();
    await expect(itemB.getByRole('textbox', { name: 'Texto de b.md' })).toHaveValue(
      '# B\n\nTexto de b, editado.\n',
    );
    await itemB.getByRole('button', { name: 'Copiar' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '# B\n\nTexto de b, editado.\n',
    );
    // Descartar asks first, with Cancelar focused.
    await itemB.getByRole('button', { name: 'Descartar' }).click();
    const question = page.getByRole('dialog', { name: 'Descartar o texto não gravado de b.md?' });
    await expect(question).toContainText(
      'O arquivo no disco não muda; o texto digitado aqui se perde.',
    );
    await expect(question.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    // Esc closes only the question; the list stays.
    await page.keyboard.press('Escape');
    await expect(question).toHaveCount(0);
    await expect(list.locator('.pending-item')).toHaveCount(2);
    await itemB.getByRole('button', { name: 'Descartar' }).click();
    await question.getByRole('button', { name: 'Descartar' }).click();
    await expect(list.locator('.pending-item')).toHaveCount(1);
    // The renamed file was never created again.
    expect(() => readFileSync(join(a, 'b.md'))).toThrow();
    // Gravar from the list saves the other one.
    await itemA.getByRole('button', { name: 'Gravar' }).click();
    await expect(list.locator('.pending-item')).toHaveCount(0);
    await expect(list).toContainText('Nenhum documento não gravado.');
    expect(readFileSync(join(a, 'a.md'), 'utf8')).toBe('# A\n\nTexto de a, editado.\n');
    await page.keyboard.press('Escape');
    await expect(bar.locator('[data-key="editing"]')).toHaveText('Edição ligada: loja');
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/edit/disable', {
      headers: await sessionHeaders(page),
      data: { root: a },
    });
    await close();
  }
});

test('edit drafts: closing the window, removing the project, switching projects and turning editing off ask first while a draft is unsaved', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { a, b } = projects();
  const close = await openOnly(page, [b, a]);
  await enableEditing(page, a);
  try {
    await page.goto('/');
    await selectFile(page, join(a, 'a.md'));
    await startEditing(page, 'a.md');
    await editorText(page, 'a.md').fill('# A\n\nNão gravado.\n');

    // Closing the window: the browser's question (dismissed, the page stays).
    const asked: string[] = [];
    page.once('dialog', (dialog) => {
      asked.push(dialog.type());
      void dialog.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => asked).toEqual(['beforeunload']);
    expect(page.isClosed()).toBe(false);

    // Removing the project from the screen.
    await page.getByRole('button', { name: 'Remover loja da tela', exact: true }).click();
    const remove = page.getByRole('dialog', { name: 'Remover da tela?' });
    await expect(remove).toContainText(
      '1 documento tem edição não gravada em loja. Ele continua na lista de documentos não gravados, só para copiar.',
    );
    await expect(remove.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(remove).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Remover loja da tela', exact: true }),
    ).toBeVisible();
    await expect(editorText(page, 'a.md')).toHaveValue('# A\n\nNão gravado.\n');

    // Switching to another saved project from the projects dialog: the question comes over it, and
    // Cancelar keeps that dialog open, with its buttons usable.
    await runProjectsAction(page, 'Abrir projeto');
    const cases = page.getByRole('dialog', { name: 'Abrir projeto' });
    await cases.locator('.case-choice').filter({ hasText: b }).click();
    await cases.getByRole('button', { name: 'Trocar', exact: true }).click();
    const switching = page.getByRole('dialog', { name: 'Trocar de projeto?' });
    await expect(switching.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(switching).toHaveCount(0);
    await expect(cases).toBeVisible();
    await expect(cases.getByRole('button', { name: 'Trocar', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(cases).toHaveCount(0);
    await expect(page.locator('.root-section')).toHaveCount(2);

    // Turning editing off asks too; Cancelar keeps it on.
    const bar = page.locator('.status-bar');
    await bar.getByRole('button', { name: 'Edição ligada: loja · 1 não gravado' }).click();
    await page.getByRole('menuitem', { name: 'Desligar edição em loja' }).click();
    const off = page.getByRole('dialog', { name: 'Desligar a edição em loja?' });
    await expect(off).toContainText(
      '1 documento tem edição não gravada em loja. Ele continua na lista de documentos não gravados; para gravá-lo, ligue a edição de novo.',
    );
    await expect(off.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await off.getByRole('button', { name: 'Cancelar' }).click();
    await expect(bar.locator('[data-key="editing"]')).toBeVisible();

    // Confirmed, removing the project keeps the draft in the list, only to copy.
    await page.getByRole('button', { name: 'Remover loja da tela', exact: true }).click();
    await remove.getByRole('button', { name: 'Remover da tela' }).click();
    await expect(page.locator('.root-section')).toHaveCount(1);
    await expect(bar.locator('[data-key="readonly"]')).toBeVisible();
    await expect(bar.locator('[data-key="unsaved"]')).toHaveText('1 não gravado');
    await bar.getByRole('button', { name: '1 não gravado' }).click();
    const list = page.getByRole('dialog', { name: 'Documentos não gravados' });
    await expect(list.locator('.pending-state')).toHaveText('Fora da leitura atual');
    await expect(list.getByRole('button', { name: 'Gravar' })).toHaveCount(0);
    expect(readFileSync(join(a, 'a.md'), 'utf8')).toBe('# A\n\nTexto de a.\n');
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/edit/disable', {
      headers: await sessionHeaders(page),
      data: { root: a },
    });
    await close();
    await page.request.post('/api/close', {
      headers: await sessionHeaders(page),
      data: { path: a },
    });
  }
});

/** The × that forgets project `name` inside `scope`, and the dialog it opens. */
const forgetButton = (scope: Locator, name: string) =>
  scope.getByRole('button', { name: `Excluir o projeto ${name} do aplicativo…`, exact: true });
const forgetDialog = (page: Page, name: string) =>
  page.getByRole('dialog', { name: `Excluir ${name} do aplicativo?`, exact: true });
const UNSAVED_STAYS =
  '1 documento deste projeto tem edição não gravada. Ele continua na lista de documentos não gravados, só para copiar: com o projeto fora do aplicativo, não pode ser gravado no arquivo.';

// The view of a project has no ×: forgetting is on a row of Home and in Abrir projeto, which keeps the
// project's view (and its editor) on the screen behind it.
for (const where of ['Home', 'Abrir projeto'] as const)
  test(`edit drafts: Excluir from the × of ${where === 'Home' ? 'a row of Home' : 'a project in Abrir projeto'} says, in the same dialog, that an unsaved document stays only to copy; Cancelar keeps everything; confirmed, the draft stays in the list and Copiar works`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { a, b } = projects();
    const close = await openOnly(page, [b, a]);
    await enableEditing(page, a);
    const headers = await sessionHeaders(page);
    const workspace = async () => {
      const model = await (await page.request.get('/api/workspace', { headers })).json();
      return {
        roots: model.roots.map((root: { path: string }) => root.path),
        saved: model.savedCases.map((item: { path: string }) => item.path),
        editing: Object.keys(model.editing),
      };
    };
    /** Opens the dialog of forgetting the project at `path`, from the × of this test. */
    const ask = async (path: string) => {
      const name = path.split('/').at(-1)!;
      if (where === 'Home') {
        await page.getByRole('button', { name: 'Início', exact: true }).click();
        await forgetButton(page.locator(`.home-row[data-project="${path}"]`), name).click();
      } else {
        await runProjectsAction(page, 'Abrir projeto');
        // Earlier tests leave projects of the same name saved: the row of this folder.
        await forgetButton(cases.locator('.saved-case', { hasText: path }), name).click();
      }
      const dialog = forgetDialog(page, name);
      await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
      // One dialog: the sentence is in the dialog of forgetting, never in a second question (over
      // Abrir projeto, the list stays below it).
      await expect(page.getByRole('dialog')).toHaveCount(where === 'Home' ? 1 : 2);
      return dialog;
    };
    const cases = page.getByRole('dialog', { name: 'Abrir projeto' });
    /** Back to the view of loja: from Home by its row; from Abrir projeto, closing the list. */
    const views = async () => {
      if (where === 'Abrir projeto') {
        await page.keyboard.press('Escape');
        await expect(cases).toHaveCount(0);
        return;
      }
      await page.locator(`.home-row[data-project="${a}"]`).click();
      await expect(page.locator(`[data-pane-id="scope:${a}"]`)).toBeVisible();
    };
    try {
      await page.goto('/');
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator(`.home-row[data-project="${a}"]`).click();
      await expect(page.locator(`[data-pane-id="scope:${a}"]`)).toBeVisible();
      // Chosen on Home, loja is alone in the grid; outro stays open, minimized in the strip.
      await expect(page.locator(`[data-pane-id="scope:${b}"]`)).toHaveAttribute(
        'data-minimized',
        'true',
      );
      await selectFile(page, join(a, 'a.md'));
      await startEditing(page, 'a.md');

      // Without an unsaved document, the dialog has no sentence about them.
      let dialog = await ask(a);
      await expect(dialog.locator('.confirm-body > p')).toHaveCount(1);
      await expect(dialog).not.toContainText('edição não gravada');
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toHaveCount(0);
      await views();

      const text = '# A\n\nNão gravado, e o projeto sai do aplicativo.\n';
      await selectFile(page, join(a, 'a.md'));
      await editorText(page, 'a.md').fill(text);
      const bar = page.locator('.status-bar');
      await expect(bar.locator('[data-key="editing"]')).toHaveText(
        'Edição ligada: loja · 1 não gravado',
      );
      const before = await workspace();

      // The draft of loja is not outro's: forgetting outro says nothing about it.
      dialog = await ask(b);
      await expect(dialog.locator('.confirm-body > p')).toHaveCount(1);
      await expect(dialog).not.toContainText('edição não gravada');
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toHaveCount(0);
      await views();

      // loja: the sentence, as the dialog writes its other consequences (a paragraph, no box).
      dialog = await ask(a);
      await expect(dialog.locator('.confirm-body > p').last()).toHaveText(UNSAVED_STAYS);
      // Cancelar keeps everything: the project, its editing, the draft, the file.
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toHaveCount(0);
      expect(await workspace()).toEqual(before);
      await expect(bar.locator('[data-key="editing"]')).toHaveText(
        'Edição ligada: loja · 1 não gravado',
      );
      expect(readFileSync(join(a, 'a.md'), 'utf8')).toBe('# A\n\nTexto de a.\n');
      await views();
      await selectFile(page, join(a, 'a.md'));
      await expect(editorText(page, 'a.md')).toHaveValue(text);

      // Confirmed: the project leaves, with no other question, and the draft stays, only to copy.
      dialog = await ask(a);
      await dialog.getByRole('button', { name: 'Excluir projeto' }).click();
      await expect(dialog).toHaveCount(0);
      if (where === 'Abrir projeto') await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const after = await workspace();
      expect(after.roots).toEqual([b]);
      expect(after.saved).not.toContain(a);
      expect(after.editing).not.toContain(a);
      await expect(page.locator(`[data-pane-id="scope:${a}"]`)).toHaveCount(0);
      await expect(bar.locator('[data-key="readonly"]')).toBeVisible();
      await expect(bar.locator('[data-key="unsaved"]')).toHaveText('1 não gravado');
      await bar.getByRole('button', { name: '1 não gravado' }).click();
      const list = page.getByRole('dialog', { name: 'Documentos não gravados' });
      const item = list.locator('.pending-item');
      await expect(item).toHaveCount(1);
      await expect(item.locator('.pending-state')).toHaveText('Fora da leitura atual');
      await expect(item.getByRole('button')).toHaveText(['Mostrar texto', 'Copiar', 'Descartar']);
      await item.getByRole('button', { name: 'Copiar' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
      expect(readFileSync(join(a, 'a.md'), 'utf8')).toBe('# A\n\nTexto de a.\n');
      expect(errors).toEqual([]);
    } finally {
      await page.request.post('/api/edit/disable', { headers, data: { root: a } });
      await close();
    }
  });

test('edit drafts: editing turned off in another window; the save offers to allow it again and keeps the text, and both bars follow', async ({
  page,
  context,
}) => {
  const { a } = projects();
  const close = await openOnly(page, [a]);
  await enableEditing(page, a);
  const other = await context.newPage();
  try {
    await page.goto('/');
    await other.goto('/');
    await expect(other.locator('.status-bar [data-key="editing"]')).toHaveText(
      'Edição ligada: loja',
    );
    await selectFile(page, join(a, 'a.md'));
    await startEditing(page, 'a.md');
    await editorText(page, 'a.md').fill('# A\n\nDepois de desligar.\n');
    // The other window turns it off (nothing unsaved there: no question).
    await other.locator('.status-bar').getByRole('button', { name: 'Edição ligada: loja' }).click();
    await other.getByRole('menuitem', { name: 'Desligar edição em loja' }).click();
    await expect(other.locator('.status-bar [data-key="readonly"]')).toBeVisible();
    // This window still shows it on; the save is refused with the server's message and the bar corrects.
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Edição desligada neste projeto');
    expect(await outcome(page).locator('.editor-status-text').getAttribute('title')).toContain(
      'A edição não está ligada no projeto aberto que contém este arquivo.',
    );
    await expect(page.locator('.status-bar [data-key="readonly"]')).toBeVisible();
    expect(readFileSync(join(a, 'a.md'), 'utf8')).toBe('# A\n\nTexto de a.\n');
    await expect(editorText(page, 'a.md')).toHaveValue('# A\n\nDepois de desligar.\n');
    // Allowing again is giving the permission: the same dialog, Cancelar focused, then the save.
    await outcome(page).getByRole('button', { name: 'Permitir e gravar' }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Permitir que o app grave nos documentos de loja?',
    });
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    expect(readFileSync(join(a, 'a.md'), 'utf8')).toBe('# A\n\nTexto de a.\n');
    await dialog.getByRole('button', { name: 'Permitir edição' }).click();
    await expect(outcome(page)).toContainText('Gravado · ');
    expect(readFileSync(join(a, 'a.md'), 'utf8')).toBe('# A\n\nDepois de desligar.\n');
    await expect(page.locator('.status-bar [data-key="editing"]')).toHaveText(
      'Edição ligada: loja',
    );
    // The other window learns it at its next snapshot (a reload here).
    await other.reload();
    await expect(other.locator('.status-bar [data-key="editing"]')).toHaveText(
      'Edição ligada: loja',
    );
  } finally {
    await other.close();
    await page.request.post('/api/edit/disable', {
      headers: await sessionHeaders(page),
      data: { root: a },
    });
    await close();
  }
});
