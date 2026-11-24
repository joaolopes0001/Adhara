import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { linkSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditRow, showAudit } from './audit-list';
import { selectFile } from './helpers';
import {
  editProject,
  editorText,
  enableEditing,
  openForEditing,
  outcome,
  selection,
  startEditing,
} from './edit-helpers';

// Editing-screen cases, one test each: a save without change keeps the undo; Ctrl+S anywhere saves; the
// focus never falls to the page; no ligatures in the editor, the preview and the differences; the
// refusals in the interface language; nothing jumps when a note appears; the conflict actions as text
// buttons of 24 px; a second click on the same line; the review against the disk of now.
const files = {
  'AGENTS.md': '# Projeto\n[Guia](guia.md)\n',
  'guia.md': '# Guia\n\nUm.\n\nLeia [o anexo](anexo-ausente.md) depois.\n\nFim.\n',
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

async function editing(page: Page, extra: Record<string, string> = {}) {
  const root = editProject({ ...files, ...extra });
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  await page.reload();
  return { root, file: join(root, 'guia.md'), cleanup };
}
/** The element with the focus, as "TAG.class". */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active ? `${active.tagName}.${active.className}` : 'none';
  });

test('a save without change keeps the outcome and the undo of the last save (Ctrl+S again, triple click, Ctrl+S held)', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await selectFile(page, file);
    const text = await startEditing(page, 'guia.md');
    const saves: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/edit/save')) saves.push(request.url());
    });
    await text.press('Control+End');
    await page.keyboard.type('Mais.\n');
    await text.press('Control+s');
    // The reading after the save is done (nothing resolved, nothing new): the sentence and its undo.
    const sentence = outcome(page).locator('.editor-status-text');
    await expect(sentence).toHaveText('Gravado · +1 −0');
    await expect(outcome(page).getByRole('button', { name: 'Desfazer' })).toBeVisible();
    // Ctrl+S once more, nothing typed: said in place of the
    // outcome, whose undo stays.
    await text.press('Control+s');
    await expect(sentence).toHaveText('Nada novo a gravar');
    await expect(outcome(page).getByRole('button', { name: 'Desfazer' })).toBeVisible();
    // Triple click on Gravar and Ctrl+S held (25 key repeats): not one more request.
    const save = page.locator('.inspector .endpoint-actions .edit-save');
    await save.click({ clickCount: 3 });
    for (let repeat = 0; repeat < 25; repeat++) await page.keyboard.press('Control+s');
    await expect(outcome(page).getByRole('button', { name: 'Desfazer' })).toBeVisible();
    expect(saves).toHaveLength(1);
    // The undo still gives the text before the save.
    await outcome(page).getByRole('button', { name: 'Desfazer' }).click();
    await expect(outcome(page)).toContainText('Gravação desfeita');
    expect(readFileSync(file, 'utf8')).toBe(files['guia.md']);
    // Typing again clears the mark; a new save is a real one.
    await text.press('Control+End');
    await page.keyboard.type('Outra.\n');
    await expect(outcome(page)).not.toContainText('Nada novo a gravar');
  } finally {
    await cleanup();
  }
});

test('Ctrl+S saves from anywhere in the window while an editor is open, never reaching the browser; the focus goes back to Editar, to the editor or to the dialog, never to the page', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await selectFile(page, file);
    const text = await startEditing(page, 'guia.md');
    // Records whether the page let the key reach the browser (default not prevented).
    await page.evaluate(() => {
      (window as unknown as { prevented: boolean[] }).prevented = [];
      window.addEventListener('keydown', (event) => {
        // Read once the event went through every listener of the page.
        if (event.ctrlKey && event.key === 's')
          setTimeout(() =>
            (window as unknown as { prevented: boolean[] }).prevented.push(event.defaultPrevented),
          );
      });
    });
    const prevented = () =>
      page.evaluate(() => (window as unknown as { prevented: boolean[] }).prevented);
    await text.fill(files['guia.md'].replace('Um.', 'Um, mudado.'));
    // The focus on the page itself, then on a tab of the inspector: Ctrl+S saves.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await focused(page)).toBe('BODY.');
    await page.keyboard.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · +1 −1');
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Relações' }).focus();
    await page.keyboard.press('Control+s');
    await expect.poll(prevented).toEqual([true, true]);
    await page.locator('.inspector-tabs').getByRole('button', { name: 'Arquivo' }).click();

    // A conflict and "Manter meu texto": the focus goes to the text,
    // and Ctrl+S opens the review.
    await text.fill(files['guia.md'].replace('Fim.', 'Fim, meu.'));
    writeFileSync(file, files['guia.md'].replace('Um.', 'Um, de fora.'));
    await text.press('Control+s');
    await page
      .getByRole('dialog', { name: 'O arquivo mudou no disco' })
      .getByRole('button', { name: 'Manter meu texto' })
      .click();
    await expect(text).toBeFocused();
    await page.keyboard.press('Control+s');
    const review = page.getByRole('dialog', { name: 'Gravar sobre a versão do disco?' });
    await expect(review.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    // Leaving the dialog: the focus goes back to where it came from.
    await page.keyboard.press('Escape');
    await expect(text).toBeFocused();
    await page.keyboard.press('Control+s');
    await review.getByRole('button', { name: 'Confirmar gravação' }).click();
    await expect(outcome(page)).toContainText('Gravado');
    expect(await focused(page)).not.toBe('BODY.');
    // Fechar editor, by keyboard: the focus goes to Editar.
    await page.locator('.inspector .edit-close').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.inspector .edit-button')).toBeFocused();
    // The same by mouse.
    await page.keyboard.press('Enter');
    await expect(text).toBeFocused();
    await page.locator('.inspector .edit-close').click();
    await expect(page.locator('.inspector .edit-button')).toBeFocused();
  } finally {
    await cleanup();
  }
});

test('the editor, the read-only text and the lists of the conflict draw characters as written, without ligatures or contextual alternates', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page, {
    'guia.md': '# Guia\n\na <= b, a != b, a -> b, ../AGENTS.md, <!-- x -->\n',
  });
  try {
    await selectFile(page, file);
    const preview = page.locator('.inspector .source-code code').nth(2);
    await expect(preview).toContainText('<=');
    const style = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => {
          const computed = getComputedStyle(element);
          return [computed.fontVariantLigatures, computed.fontFeatureSettings];
        });
    // The browser lists the features in its own order.
    const none = ['none', '"calt" 0, "clig" 0, "dlig" 0, "liga" 0'];
    expect(await style('.inspector .source-code code')).toEqual(none);
    const text = await startEditing(page, 'guia.md');
    expect(await style('.file-editor .editor-text')).toEqual(none);
    await text.press('Control+End');
    await page.keyboard.type('x != y\n');
    writeFileSync(file, '# Guia\n\na <= b, de fora -> b\n');
    await text.press('Control+s');
    await expect(page.getByRole('dialog', { name: 'O arquivo mudou no disco' })).toBeVisible();
    expect(await style('.conflict-body .diff-list .diff-added code')).toEqual(none);
  } finally {
    await cleanup();
  }
});

/** Selects a file by the search, in English (the helper of the suite uses the Portuguese labels). */
async function pick(page: Page, name: string) {
  await page.keyboard.press('Control+k');
  // The search field is not translated yet: its label is the same in both languages.
  await page.getByLabel(/^(Search files|Buscar arquivos)$/).fill(name);
  const result = page.locator('.search-results button', { hasText: name }).first();
  await result.click();
  await result.click();
  await expect(page.locator('.inspector .copy-path code')).toHaveText(new RegExp(`/${name}$`));
}

test.describe('in English', () => {
  // A new profile, in English (as tests/ui/language.spec.ts).
  test.use({ storageState: { cookies: [], origins: [] } });

  test("refusals of the edit routes are said in the interface's language, and so is the server's text on hover", async ({
    page,
  }) => {
    const { root, file, cleanup } = await editing(page, { 'ligado.md': '# Ligado\n' });
    linkSync(join(root, 'ligado.md'), join(root, '..', 'outro-nome.md'));
    await page.reload();
    try {
      // Refused when Edit is clicked (a hard link).
      await pick(page, 'ligado.md');
      await page.locator('.inspector .edit-button').click();
      const note = page.locator('.inspector-scroll > .edit-note[role="alert"]');
      await expect(note).toHaveText(
        'The file has more than one name (a hard link); saving would split the names.',
      );
      // The server says the same sentence, in English too: there is nothing else to show on hover.
      expect(await note.locator('span').getAttribute('title')).toBeNull();
      // Refused when saving (a BOM pasted at the start).
      await pick(page, 'guia.md');
      await page.locator('.inspector .edit-button').click();
      const text = page.getByRole('textbox', { name: 'Text of guia.md' });
      await text.press('Control+Home');
      await page.keyboard.insertText('﻿');
      await text.press('Control+s');
      // A short sentence in the state line; the whole one, and the server's text, on hover.
      await expect(outcome(page)).toContainText('A character that cannot be saved');
      const sentence = outcome(page).locator('.editor-status-text');
      expect(await sentence.getAttribute('title')).toContain(
        'The text cannot be saved: it starts with a BOM (U+FEFF), or has a null byte or a character that does not exist in UTF-8.',
      );
      // The server's own sentence, which says more, is English too, and only on hover.
      expect(await sentence.getAttribute('title')).toContain(
        'The text sent starts with a BOM (U+FEFF); the text always goes without it, and the BOM of the file is the one on disk.',
      );
      expect(await sentence.getAttribute('title')).not.toMatch(/O texto enviado|não|é o que/);
      await expect(outcome(page)).not.toContainText('The text sent');
      expect(readFileSync(file, 'utf8')).toBe(files['guia.md']);
    } finally {
      await cleanup();
    }
  });
});

test('when a note appears, nothing already on the screen moves: neither the observations nor the editor', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Problemas');
    await auditRow(page, 'anexo-ausente.md').first().locator('.file-observation-line').click();
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    const text = await startEditing(page, 'guia.md');
    const scroller = page.locator('.inspector-scroll');
    const where = async () => ({
      scroll: await scroller.evaluate((element) => element.scrollTop),
      observations: Math.round(
        (await page.locator('.inspector .file-observations').boundingBox())!.y,
      ),
      editor: Math.round((await text.boundingBox())!.y),
    });
    // A click in the text and the cursor at its end. The editor fits the room
    // under the observations, so taking the focus does not scroll the inspector.
    await text.click();
    await text.press('Control+End');
    const before = await where();
    expect(before.scroll).toBe(0);
    // "Nada novo a gravar", a real save, and a refusal with a long sentence.
    await text.press('Control+s');
    await expect(outcome(page)).toHaveText('Nada novo a gravar');
    expect(await where()).toEqual(before);
    await text.fill(files['guia.md'].replace('anexo-ausente.md', 'guia.md'));
    await page.route('**/api/edit/save', (route) =>
      route.fulfill({ status: 500, json: { error: 'Falha interna do leitor (KeyError).' } }),
    );
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Não gravado; o disco não mudou');
    expect(await where()).toEqual(before);
    await page.unrouteAll();
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('L5 resolvida');
    // The observation was resolved: its line stays in the inspector, marked, so neither the
    // observations nor the editor moved.
    await expect(page.locator('.inspector .file-observation-resolved')).toHaveText('resolvida');
    expect(await where()).toEqual(before);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanup();
  }
});

test('the ways out of the conflict are the buttons of its dialog, every text button is 24 px tall, a second click on the same line moves the cursor, and the review compares with the disk of now', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Problemas');
    await auditRow(page, 'anexo-ausente.md').first().locator('.file-observation-line').click();
    const text = await startEditing(page, 'guia.md');
    expect((await selection(page, 'guia.md')).text).toBe('anexo-ausente.md');
    // The cursor moved away, then a click on the same line number brings it back.
    await text.press('Control+Home');
    expect((await selection(page, 'guia.md')).start).toBe(0);
    await page
      .locator('.inspector .file-observations')
      .getByRole('button', { name: 'Ir para a linha 5' })
      .click();
    await expect.poll(async () => (await selection(page, 'guia.md')).text).toBe('anexo-ausente.md');

    // The text buttons of the state line are click targets of at least 24 px.
    await text.fill(files['guia.md'].replace('Um.', 'Um, meu.'));
    await text.press('Control+s');
    expect(
      (await outcome(page).getByRole('button', { name: 'Desfazer' }).boundingBox())!.height,
    ).toBeGreaterThanOrEqual(24);
    // The ways out of the conflict are the footer of its dialog: Copiar meu texto a text button,
    // the decisions buttons; all at least 24 px.
    await text.fill(files['guia.md'].replace('Um.', 'Um, meu de novo.'));
    writeFileSync(file, files['guia.md'].replace('Fim.', 'Fim, de fora.'));
    await text.press('Control+s');
    const dialog = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
    const actions = dialog.locator('.modal-footer button');
    await expect(actions).toHaveText([
      'Copiar meu texto',
      'Decidir depois',
      'Descartar meu texto',
      'Manter meu texto',
    ]);
    await expect(actions.first()).toHaveClass('text-button');
    for (const action of await actions.all())
      expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    // Kept my text, then the disk changed again before saving: the save shows
    // the new conflict, never the review of the old version.
    await dialog.getByRole('button', { name: 'Manter meu texto' }).click();
    writeFileSync(file, files['guia.md'].replace('Fim.', 'Fim, de fora outra vez.'));
    await text.press('Control+s');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('group', { name: 'O que mudou no disco' }).locator('.diff-added code'),
    ).toHaveText(['Fim, de fora outra vez.']);
    await expect(page.getByRole('dialog', { name: 'Gravar sobre a versão do disco?' })).toHaveCount(
      0,
    );
    expect(readFileSync(file, 'utf8')).toBe(
      files['guia.md'].replace('Fim.', 'Fim, de fora outra vez.'),
    );
  } finally {
    await cleanup();
  }
});

// The session sentence, a review with no difference, a project moved, Ctrl+S during a save. The case that
// needs a server restart is in edit-server.spec.ts.

test('Gravar with nothing typed looks at the disk first; a file changed by another program is shown, never "nothing to save"', async ({
  page,
}) => {
  const { file, cleanup } = await editing(page);
  try {
    await selectFile(page, file);
    const text = await startEditing(page, 'guia.md');
    // Nothing typed, another program writes the file, Ctrl+S.
    writeFileSync(file, '# Guia\n\nDe outro programa.\n');
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Mudou no disco desde que você abriu');
    await expect(outcome(page)).not.toContainText('Nada novo a gravar');
    const conflict = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
    // Nothing typed: nothing of the user's to keep, only the version on disk to take.
    await expect(conflict.locator('.modal-footer button')).toHaveText([
      'Decidir depois',
      'Recarregar do disco',
    ]);
    await expect(conflict.getByRole('group', { name: 'O que você mudou' })).toHaveCount(0);
    await expect(
      conflict.getByRole('group', { name: 'O que mudou no disco' }).locator('.diff-added code'),
    ).toHaveText(['De outro programa.']);
    await conflict.getByRole('button', { name: 'Recarregar do disco' }).click();
    await expect(text).toHaveValue('# Guia\n\nDe outro programa.\n');
    await expect(conflict).toHaveCount(0);
    // The variant: a save, another program, Ctrl+S with nothing typed.
    await text.press('Control+End');
    await page.keyboard.type('Meu.\n');
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · ');
    writeFileSync(file, '# Guia\n\nOutra vez de fora.\n');
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Mudou no disco desde que você abriu');
    // Unchanged on disk: then, and only then, "nothing new to save".
    await conflict.getByRole('button', { name: 'Recarregar do disco' }).click();
    await text.press('Control+s');
    await expect(outcome(page)).toHaveText('Nada novo a gravar');
    expect(readFileSync(file, 'utf8')).toBe('# Guia\n\nOutra vez de fora.\n');
  } finally {
    await cleanup();
  }
});

for (const size of [
  { width: 1536, height: 960 },
  { width: 749, height: 396 },
])
  test(`${size.width}×${size.height}: saving moves nothing that was on the screen (from the line of an observation), and the editor shows at least eight lines`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const lines = Array.from({ length: 40 }, (_, index) =>
      index === 2 ? 'Leia [o anexo](anexo-ausente.md) depois.' : `Linha ${index + 1}.`,
    );
    const { cleanup } = await editing(page, {
      'guia.md': lines.join('\n') + '\n',
      'outro.md': '# Outro\n[x](falta-outro.md)\n',
    });
    try {
      // The main path: the observation, its line number, Editar.
      await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
      await showAudit(page, 'Problemas');
      await auditRow(page, 'anexo-ausente.md').first().locator('.file-observation-line').click();
      await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
      const text = await startEditing(page, 'guia.md');
      const status = page.locator('.inspector .editor-status');
      // The text grows as it is typed (the area scrolls, not the editor): its top and the rest stay.
      const where = () =>
        page.evaluate(() => {
          const top = (selector: string) =>
            Math.round(document.querySelector(selector)!.getBoundingClientRect().top);
          return {
            scroll: document.querySelector('.inspector-scroll')!.scrollTop,
            tabs: top('.inspector-tabs'),
            status: top('.inspector .editor-status'),
            text: top('.file-editor .editor-text'),
          };
        });
      // At rest (in the small window the text slides up when the editor opens), at least eight lines
      // of text in view above the state line.
      const fit = () =>
        text.evaluate((area) => {
          const box = area.closest('.inspector-scroll')!.getBoundingClientRect();
          const style = getComputedStyle(area);
          const textTop = area.getBoundingClientRect().top + parseFloat(style.paddingTop);
          return (box.bottom - Math.max(box.top, textTop)) / parseFloat(style.lineHeight);
        });
      await expect.poll(fit).toBeGreaterThanOrEqual(8);
      await expect(status).toHaveCSS('height', '28px');
      // Typing at the end brings the end into view (the gesture); each save is measured from there:
      // the save, the reading after it, a refusal and the save that resolves the observation.
      const saved = async (expected: () => Promise<void>) => {
        const before = await where();
        await text.press('Control+s');
        await expected();
        await expect.poll(where).toEqual(before);
      };
      await text.press('Control+End');
      await page.keyboard.type('Mais uma.\n');
      // The reading after the save is done: nothing resolved, nothing new.
      await saved(() =>
        expect(outcome(page).locator('.editor-status-text')).toHaveText('Gravado · +1 −0'),
      );
      await page.route('**/api/edit/save', (route) =>
        route.fulfill({ status: 500, json: { error: 'Falha interna do leitor (KeyError).' } }),
      );
      await page.keyboard.type('E outra.\n');
      await saved(() => expect(outcome(page)).toContainText('Não gravado'));
      await page.unrouteAll();
      await text.fill(lines.join('\n').replace('anexo-ausente.md', 'guia.md') + '\n');
      await saved(() => expect(outcome(page)).toContainText('L3 resolvida'));
      await expect(status).toHaveCSS('height', '28px');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await cleanup();
    }
  });

test('the small ones: a Ctrl+S during a save keeps saying "Gravando…" and saves the newer text after it, a review with no difference says there is nothing new to save, a project moved says so', async ({
  page,
}) => {
  const { root, file, cleanup } = await editing(page);
  try {
    await selectFile(page, file);
    const text = await startEditing(page, 'guia.md');
    // SIMULATED delay: the real save answers after 800 ms.
    const saves: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/edit/save')) saves.push(request.url());
    });
    await page.route('**/api/edit/save', async (route) => {
      await new Promise((done) => setTimeout(done, 800));
      await route.continue();
    });
    await text.press('Control+End');
    await page.keyboard.type('Um.\n');
    await text.press('Control+s');
    await expect(outcome(page)).toHaveText('Gravando…');
    await page.keyboard.type('Dois.\n');
    await text.press('Control+s');
    await expect(outcome(page)).toHaveText('Gravando…');
    // The second Ctrl+S waited for the first save and then saved the text typed meanwhile.
    await expect(outcome(page)).toContainText('Gravado · ');
    expect(saves).toHaveLength(2);
    expect(readFileSync(file, 'utf8')).toBe(`${files['guia.md']}Um.\nDois.\n`);
    await page.unrouteAll();

    // "Manter meu texto", then the text made equal to the disk: no review, nothing new to save. (Text
    // typed first: with everything saved, the conflict has nothing of the user's to keep.)
    await page.keyboard.type('Três.\n');
    writeFileSync(file, '# Guia\n\nDe fora.\n');
    await text.press('Control+s');
    await page
      .getByRole('dialog', { name: 'O arquivo mudou no disco' })
      .getByRole('button', { name: 'Manter meu texto' })
      .click();
    await text.fill('# Guia\n\nDe fora.\n');
    await text.press('Control+s');
    await expect(outcome(page)).toHaveText('Nada novo a gravar');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The project moved while editing: the sentence says so, and offers no permission (it would fail).
    await text.press('Control+End');
    await page.keyboard.type('Depois.\n');
    renameSync(root, `${root}-movido`);
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('A pasta do projeto mudou');
    expect(await outcome(page).locator('.editor-status-text').getAttribute('title')).toContain(
      'A pasta deste projeto mudou de lugar ou não existe mais. Releia os diretórios.',
    );
    await expect(outcome(page).getByRole('button', { name: 'Permitir e gravar' })).toHaveCount(0);
    renameSync(`${root}-movido`, root);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanup();
  }
});

test.describe('in English, the session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the refusal of a session is said in the interface language (simulated: the renewed session refused again)', async ({
    page,
  }) => {
    const { cleanup } = await editing(page);
    try {
      await pick(page, 'guia.md');
      await page.locator('.inspector .edit-button').click();
      const text = page.getByRole('textbox', { name: 'Text of guia.md' });
      await text.press('Control+End');
      await page.keyboard.type('More.\n');
      // SIMULATED: every save answers a refused session, so the one repetition is refused too.
      await page.route('**/api/edit/save', (route) =>
        route.fulfill({
          status: 403,
          json: { error: 'Sessão inválida. Reabra o aplicativo.', code: 'session' },
        }),
      );
      await text.press('Control+s');
      await expect(outcome(page)).toContainText('Invalid session; reopen the app');
      expect(await outcome(page).locator('.editor-status-text').getAttribute('title')).toContain(
        'Invalid session. Reopen the app.',
      );
      await expect(outcome(page)).not.toContainText('Sessão');
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await cleanup();
    }
  });
});
