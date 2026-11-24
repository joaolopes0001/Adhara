import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { lstatSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditRow, showAudit } from './audit-list';
import { readable, selectFile } from './helpers';
import { runMoreAction } from './more-menu';
import {
  editProject,
  editorText,
  enableEditing,
  openForEditing,
  pickFile,
  outcome,
  permissionDialog,
  selection,
  startEditing,
} from './edit-helpers';

// Editing a document from the inspector: the permission asked once per project, the editor at the line of
// the observation with only the destination selected, the direct save, the reading after it (the
// observation goes away), the differences, the undo, and the bottom bar that says editing is on.
const files = {
  'AGENTS.md': '# Projeto\n[Guia](docs/guia.md)\n[Config](config.json)\n',
  'docs/guia.md': '# Guia\n\nPrimeiro passo.\n\nLeia [o anexo](anexo-ausente.md) depois.\n\nFim.\n',
  'docs/certo.md': '# Certo\n',
  'config.json': '{"a": 1}\n',
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

test('edit: the permission once per project, the editor at the observation, a direct save that resolves it, the differences and the undo', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = editProject(files);
  const guide = join(root, 'docs/guia.md');
  const cleanup = await openForEditing(page, root);
  try {
    // Read-only by default: the bar says so, and nothing edits until asked.
    const bar = page.locator('.status-bar');
    await expect(bar.locator('[data-key="readonly"]')).toHaveText('Somente leitura');
    await expect(bar.locator('[data-key="editing"]')).toHaveCount(0);
    await expect(page.locator('.file-editor')).toHaveCount(0);

    // A file that is not Markdown: Editar is unavailable, with the reason.
    await selectFile(page, join(root, 'config.json'));
    const edit = page.locator('.inspector .edit-button');
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    await expect(edit).toHaveAttribute(
      'title',
      '.json ainda não é editável aqui: o app edita Markdown',
    );
    // Unavailable (aria-disabled, so the tooltip stays): a click does nothing.
    await edit.click({ force: true });
    await expect(permissionDialog(page)).toHaveCount(0);

    // The observation from the Auditoria: the file at line 5, the destination written there marked.
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Problemas');
    await auditRow(page, 'anexo-ausente.md').first().locator('.file-observation-line').click();
    await expect(page.locator('.inspector .highlight-line')).toHaveAttribute('data-line', '5');
    const center = await page.locator('.breadcrumbs').textContent();
    const mode = await page.locator('#top-view-mode [aria-pressed="true"]').textContent();

    // Editar asks first, with the project's name and how many files it allows; Cancel has the focus.
    await expect(edit).not.toHaveAttribute('aria-disabled');
    await edit.click();
    const dialog = permissionDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      // What is known, never a promise: the server may still refuse some of them.
      'Até 3 arquivos Markdown, e alguns são instruções, comandos ou skills: o que for gravado neles passa a valer para os agentes e pode fazê-los executar comandos.',
    );
    await expect(dialog).toContainText(
      'A permissão fica ligada neste projeto até você desligar na barra inferior; o app não guarda versões anteriores, então use o Git para ter histórico.',
    );
    await expect(dialog.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
    // Esc closes it, and nothing was enabled.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(bar.locator('[data-key="readonly"]')).toBeVisible();
    await expect(page.locator('.file-editor')).toHaveCount(0);

    // Allowed: the editor opens on this file, at line 5, with only the destination selected.
    const text = await startEditing(page, 'guia.md', { allow: true });
    await expect(text).toBeFocused();
    expect(await selection(page, 'guia.md')).toEqual({
      text: 'anexo-ausente.md',
      start: readFileSync(guide, 'utf8').indexOf('anexo-ausente.md'),
      end: readFileSync(guide, 'utf8').indexOf('anexo-ausente.md') + 'anexo-ausente.md'.length,
    });
    // The line and column are state: in the bottom bar.
    await expect(page.locator('.status-bar [data-key="cursor"]')).toHaveText('Linha 5, coluna 16');
    // One click changes one thing: the center did not move.
    await expect(page.locator('.breadcrumbs')).toHaveText(center!);
    // The bar says editing is on, in the place of "Somente leitura".
    await expect(bar.locator('[data-key="readonly"]')).toHaveCount(0);
    await expect(bar.locator('[data-key="editing"]')).toHaveText('Edição ligada: projeto');

    // Typing replaces only the destination; Ctrl+S saves directly.
    await page.keyboard.type('certo.md');
    await expect(bar.locator('[data-key="editing"]')).toHaveText(
      'Edição ligada: projeto · 1 não gravado',
    );
    await page.keyboard.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · +1 −1');
    await expect(outcome(page).getByRole('button', { name: 'Desfazer' })).toBeVisible();
    expect(readFileSync(guide, 'utf8')).toBe(
      '# Guia\n\nPrimeiro passo.\n\nLeia [o anexo](certo.md) depois.\n\nFim.\n',
    );
    // The reading after the save: the observation corrected went away, the editor stayed; in the
    // inspector its line stays, marked resolved.
    await expect(outcome(page)).toContainText('L5 resolvida');
    await expect(page.locator('.inspector .file-observation-resolved')).toHaveText('resolvida');
    // A state is said by its words: no check mark before "Gravado" nor before "resolvida".
    await expect(outcome(page).locator('svg.lucide-check')).toHaveCount(0);
    await expect(page.locator('.inspector .file-observation-resolved svg')).toHaveCount(0);
    await expect(auditRow(page, 'anexo-ausente.md')).toHaveCount(0);
    await expect(text).toBeVisible();
    await expect(bar.locator('[data-key="editing"]')).toHaveText('Edição ligada: projeto');
    await expect(page.locator('.breadcrumbs')).toHaveText(center!);
    await expect(page.locator('#top-view-mode [aria-pressed="true"]')).toHaveText(mode!);
    // Alterações lists the file as changed, from the same reading.
    await page.getByRole('button', { name: 'Alterações', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: 'Arquivos' })
        .or(page.locator('section[aria-label="Arquivos"]')),
    ).toContainText('docs/guia.md');
    await page.getByRole('button', { name: 'Alterações', exact: true }).click();

    // How to see the changes of a save waits for its design (in the text itself); the state line
    // counts them ("+1 −1"). The lists of changes are checked in the conflict dialog (edit-conflict).

    // Undo writes the previous text back, against the hash of the save, and replaces the draft.
    await outcome(page).getByRole('button', { name: 'Desfazer' }).click();
    await expect(outcome(page)).toContainText('Gravação desfeita · +1 −1');
    await expect(text).toHaveValue(files['docs/guia.md']);
    expect(readFileSync(guide, 'utf8')).toBe(files['docs/guia.md']);
    // No redo: the strip offers no undo of the undo.
    await expect(outcome(page).getByRole('button', { name: 'Desfazer' })).toHaveCount(0);
    // The observation is back: its line in the inspector is no longer marked resolved.
    await expect(page.locator('.inspector .file-observation-resolved')).toHaveCount(0);

    // Closing the editor goes back to the read-only text, with the text on disk.
    await page.getByRole('button', { name: 'Fechar editor', exact: true }).click();
    await expect(page.locator('.file-editor')).toHaveCount(0);
    await expect(page.locator('.inspector .source-code')).toContainText('anexo-ausente.md');

    // Turning editing off in the bar.
    await bar.getByRole('button', { name: 'Edição ligada: projeto' }).click();
    await page.getByRole('menuitem', { name: 'Desligar edição em projeto', exact: true }).click();
    await expect(bar.locator('[data-key="readonly"]')).toBeVisible();
    await expect(bar.locator('[data-key="editing"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await cleanup();
  }
});

/** Every file below `root` (not following links): its bytes, mode and inode; and whether a temporary of a save is left. */
function tree(root: string) {
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else
        files[path.slice(root.length + 1)] = `${info.mode}:${info.ino}:${
          info.isSymbolicLink() ? 'link' : readFileSync(path).toString('base64')
        }`;
    }
  };
  walk(root);
  return files;
}

test('edit limits: Markdown up to the size the server gives opens and saves; one byte more, a symbolic link or another type is unavailable with the reason', async ({
  page,
}) => {
  const limit = 256 * 1024;
  const line = 'linha de texto sem referencias, so ASCII\n';
  const fill = (size: number) =>
    `# T\n${line.repeat(Math.ceil(size / line.length))}`.slice(0, size - 1) + '\n';
  const root = editProject({
    'AGENTS.md': '# Projeto\n[L](limite.md) [E](exato.md) [G](grande.md) [N](notas.txt)\n',
    'limite.md': fill(limit - 1),
    'exato.md': fill(limit),
    'grande.md': fill(limit + 1),
    'notas.txt': 'texto\n',
  });
  symlinkSync(join(root, 'limite.md'), join(root, 'atalho.md'));
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  try {
    await page.reload();
    const edit = page.locator('.inspector .edit-button');
    for (const [name, title] of [
      ['grande.md', 'Arquivo acima de 256 KiB: não é editável aqui'],
      ['notas.txt', '.txt ainda não é editável aqui: o app edita Markdown'],
      ['atalho.md', 'Link simbólico: não é editável aqui'],
    ]) {
      await selectFile(page, join(root, name));
      await expect(edit).toHaveAttribute('aria-disabled', 'true');
      await expect(edit).toHaveAttribute('title', title);
    }
    // Exactly the limit is editable; one byte less opens, changes a character and saves at the same size.
    await selectFile(page, join(root, 'exato.md'));
    await expect(edit).not.toHaveAttribute('aria-disabled');
    await selectFile(page, join(root, 'limite.md'));
    const text = await startEditing(page, 'limite.md');
    await text.press('Control+Home');
    await text.press('Delete');
    await text.press('Delete');
    await page.keyboard.type('X');
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · +1 −1');
    const saved = readFileSync(join(root, 'limite.md'));
    expect(saved.length).toBe(limit - 2);
    expect(saved.subarray(0, 4).toString()).toBe('XT\nl');
  } finally {
    await cleanup();
  }
});

test('edit bytes: CRLF and the BOM are kept on save; a pasted carriage return never reaches the file, and a pasted BOM at the start is refused with the server message and the draft stays', async ({
  page,
}) => {
  const root = editProject({
    'AGENTS.md': '# Projeto\n[W](windows.md) [U](unix.md)\n',
    'windows.md': '\ufeff# Windows\r\n\r\nUm.\r\nDois.\r\n',
    'unix.md': '# Unix\n\nUm.\n',
  });
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  try {
    await page.reload();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await selectFile(page, join(root, 'windows.md'));
    const text = await startEditing(page, 'windows.md');
    // The editor shows the text with \n and without the BOM; both are said and kept.
    await expect(text).toHaveValue('# Windows\n\nUm.\nDois.\n');
    await expect(page.locator('.status-bar [data-key="cursor"]')).toContainText('CRLF · BOM');
    await text.fill('# Windows\n\nUm.\nDois, mudado.\n');
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · +1 −1');
    expect(readFileSync(join(root, 'windows.md'))).toEqual(
      Buffer.from('\ufeff# Windows\r\n\r\nUm.\r\nDois, mudado.\r\n'),
    );

    // A carriage return pasted alone: the textarea gives the page \n (HTML normalizes line breaks), so
    // no stray \r reaches the server or the file.
    await selectFile(page, join(root, 'unix.md'));
    const unix = await startEditing(page, 'unix.md');
    await page.evaluate(() => navigator.clipboard.writeText('colado\rsolto'));
    await unix.press('Control+End');
    await unix.press('Control+v');
    expect(await unix.inputValue()).not.toContain('\r');
    await unix.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · ');
    expect(readFileSync(join(root, 'unix.md'), 'utf8')).toBe('# Unix\n\nUm.\ncolado\nsolto');

    // A BOM pasted at the start: the server refuses it with its message; the draft stays as typed.
    await page.evaluate(() => navigator.clipboard.writeText('\ufeff'));
    await unix.press('Control+Home');
    await unix.press('Control+v');
    expect((await unix.inputValue()).startsWith('\ufeff')).toBe(true);
    await unix.press('Control+s');
    // The short sentence in the state line; the whole one (the server's text, in Portuguese) on hover.
    await expect(outcome(page)).toContainText('Caractere que não se grava');
    expect(await outcome(page).locator('.editor-status-text').getAttribute('title')).toContain(
      'O texto enviado não pode ser gravado: começa com um BOM (U+FEFF) ou tem byte nulo ou um caractere que não existe em UTF-8.',
    );
    expect((await unix.inputValue()).startsWith('\ufeff#')).toBe(true);
    expect(readFileSync(join(root, 'unix.md'), 'utf8')).toBe('# Unix\n\nUm.\ncolado\nsolto');
    await expect(page.locator('.status-bar [data-key="editing"]')).toContainText('1 não gravado');
  } finally {
    await cleanup();
  }
});

test('edit reading: after a slow reading a save says the reading is stale and offers Reler; a node without hash is "not verified"; a file changed again after the save is said', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = editProject(files);
  const guide = join(root, 'docs/guia.md');
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  try {
    await page.reload();
    // SIMULATED slowness: the reading asked by Reler answers after 1.3 s, so it is measured as slow.
    await page.route('**/api/refresh', async (route) => {
      await new Promise((done) => setTimeout(done, 1300));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Reler diretórios' }).click();
    await expect(page.locator('.app-footer')).toContainText('Pronto');
    await page.unrouteAll();
    await selectFile(page, guide);
    const text = await startEditing(page, 'guia.md');
    await text.fill(files['docs/guia.md'].replace('anexo-ausente.md', 'certo.md'));
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · +1 −1 · leitura desatualizada');
    for (const name of ['Reler', 'Desfazer'])
      await expect(outcome(page).getByRole('button', { name })).toBeVisible();
    expect(readFileSync(guide, 'utf8')).toContain('(certo.md)');
    // The notice under the bar, from any tool; the observation is still in the old reading.
    const notice = page.locator('.stale-notice');
    await expect(notice).toContainText(
      /^Leitura desatualizada: 1 arquivo gravado depois da leitura de \d\d:\d\dReler$/,
    );
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Problemas');
    await expect(auditRow(page, 'anexo-ausente.md')).toHaveCount(1);
    // Reler in the strip reads the projects and reports.
    // Entered by Editar (no observation chosen): the count of the resolved ones.
    await outcome(page).getByRole('button', { name: 'Reler' }).click();
    await expect(outcome(page)).toContainText('1 resolvida');
    await expect(notice).toHaveCount(0);
    await expect(auditRow(page, 'anexo-ausente.md')).toHaveCount(0);

    // SIMULATED: the reading after the save gives the file without its hash (a text the reader did not read).
    await page.route('**/api/refresh', async (route) => {
      const response = await route.fetch();
      const model = await response.json();
      for (const node of model.nodes) if (node.id === guide) delete node.sha256;
      await route.fulfill({ response, json: model });
    });
    await text.fill(
      files['docs/guia.md'].replace('anexo-ausente.md', 'certo.md').replace('Fim.', 'Fim!'),
    );
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('não verificado nesta leitura');
    await page.unrouteAll();

    // Another program writes the file right after the save, before the reading: the reading reports it
    // ("mudou de novo") and the look at the disk that follows every reading shows the version on disk,
    // which the state line then says; with nothing typed, the editor offers it instead of taking it in
    // silence.
    await page.route('**/api/refresh', async (route) => {
      writeFileSync(guide, '# Guia\n\nDe outro programa.\n');
      await route.continue();
    });
    await text.fill('# Guia\n\nMeu.\n');
    await text.press('Control+s');
    // Found by a reading, not by a save: only the state line says it; Resolver… shows the versions.
    await expect(outcome(page)).toContainText('Mudou no disco desde que você abriu');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await outcome(page).getByRole('button', { name: 'Resolver…' }).click();
    const versions = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
    await expect(
      versions.getByRole('group', { name: 'O que mudou no disco' }).locator('.diff-added code'),
    ).toHaveText(['De outro programa.']);
    await expect(text).toHaveValue('# Guia\n\nMeu.\n');
    await versions.getByRole('button', { name: 'Recarregar do disco' }).click();
    await expect(versions).toHaveCount(0);
    await expect(text).toHaveValue('# Guia\n\nDe outro programa.\n');
    await page.unrouteAll();
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanup();
  }
});

for (const size of [
  { width: 1536, height: 960 },
  { width: 749, height: 396 },
])
  test(`edit layout ${size.width}×${size.height}: the inspector keeps its width while editing, the bar keeps "Edição ligada" last, and both themes are readable`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const root = editProject(files);
    const cleanup = await openForEditing(page, root);
    try {
      await pickFile(page, join(root, 'docs/guia.md'));
      const saved = await page.evaluate(() => localStorage.getItem('aae-layout'));
      const inspector = page.locator('aside.inspector');
      const before = (await inspector.boundingBox())!.width;
      const text = await startEditing(page, 'guia.md', { allow: true });
      // The editor takes the place of the text: the inspector keeps its width, the saved one too.
      expect((await inspector.boundingBox())!.width).toBe(before);
      expect(await page.evaluate(() => localStorage.getItem('aae-layout'))).toBe(saved);
      await expect(text).toBeInViewport();
      await text.fill(files['docs/guia.md'].replace('Fim.', 'Fim, mudado.'));
      await expect(page.getByRole('button', { name: 'Gravar', exact: true })).toBeInViewport();
      await text.press('Control+s');
      await expect(outcome(page)).toContainText('Gravado · +1 −1');
      // Another program changes the file: the save that follows opens the conflict, with both lists.
      writeFileSync(join(root, 'docs/guia.md'), '# Guia\n\nDe outro programa.\n');
      await text.press('Control+End');
      await page.keyboard.type('Meu.\n');
      await text.press('Control+s');
      const versions = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
      await expect(versions).toBeVisible();
      await page.keyboard.press('Escape');
      // "Edição ligada" is the last to leave the bar: whatever had to leave, it stays.
      const bar = page.locator('.status-bar');
      await expect(bar.locator('[data-key="editing"]')).not.toHaveAttribute('data-hidden');
      // In the narrow window others had to leave, and they did before it.
      if (size.width < 1000)
        await expect(bar.locator('.status-slot[data-hidden]')).not.toHaveCount(0);
      await expect(bar.getByRole('button', { name: 'Edição ligada: projeto' })).toBeInViewport({
        ratio: 1,
      });
      // Both themes: the editor's texts, the state line, the lists of the conflict and the bar read at
      // 4.5:1 at least.
      for (const [theme, next] of [
        ['dark', 'claro'],
        ['light', 'escuro'],
      ]) {
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const selector of [
          '.status-bar .status-cursor',
          '.inspector .editor-status .editor-status-text',
          '.inspector .editor-status .text-button',
          '.file-editor .editor-text',
          '.status-editing span',
          '.inspector .edit-close',
        ])
          expect(
            await readable(page.locator(selector).first()),
            `${selector} (${theme}, ${size.width})`,
          ).toBeGreaterThanOrEqual(4.5);
        await outcome(page).getByRole('button', { name: 'Resolver…' }).click();
        await expect(versions).toBeVisible();
        for (const selector of [
          '.diff-list .diff-added code',
          '.diff-list .diff-removed code',
          '.diff-list .diff-number',
        ])
          expect(
            await readable(versions.locator(selector).first()),
            `${selector} (${theme}, ${size.width})`,
          ).toBeGreaterThanOrEqual(4.5);
        await page.screenshot({
          path: test.info().outputPath(`editor-${size.width}-${theme}.png`),
        });
        await versions.getByRole('button', { name: 'Decidir depois' }).click();
        await expect(versions).toHaveCount(0);
        await runMoreAction(page, `Ativar tema ${next}`);
      }
      // Leaving the editor: the inspector still has its width.
      await versions.waitFor({ state: 'detached' });
      await outcome(page).getByRole('button', { name: 'Resolver…' }).click();
      await versions.getByRole('button', { name: 'Descartar meu texto' }).click();
      await page.getByRole('button', { name: 'Fechar editor', exact: true }).click();
      expect((await inspector.boundingBox())!.width).toBe(before);
      // Focus is visible on the editor's buttons (keyboard).
      await page.locator('.inspector .edit-button').focus();
      await page.keyboard.press('Enter');
      await expect(text).toBeFocused();
      // Back to the file's actions by keyboard: the focus is drawn on them.
      await page.locator('.inspector .edit-close').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const focused = page.locator('.inspector .endpoint-actions button:focus-visible');
      await expect(focused).toHaveCount(1);
      expect(await focused.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
        'none',
      );
    } finally {
      await cleanup();
    }
  });

test('edit a long file: 5,000 lines, opened at line 4,000 from the Auditoria, edited and saved without blocking the page (measured)', async ({
  page,
}) => {
  const lines = Array.from({ length: 5000 }, (_, index) =>
    index + 1 === 4000
      ? 'Veja [o fim](fim-ausente.md) aqui.'
      : `Linha ${index + 1} do documento longo.`,
  );
  const root = editProject({
    'AGENTS.md': '# Projeto\n[Longo](longo.md)\n',
    'longo.md': lines.join('\n') + '\n',
  });
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  try {
    await page.reload();
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Problemas');
    await auditRow(page, 'fim-ausente.md').first().locator('.file-observation-line').click();
    await expect(page.locator('.inspector .highlight-line')).toHaveAttribute('data-line', '4000');
    let started = Date.now();
    const text = await startEditing(page, 'longo.md');
    const openMs = Date.now() - started;
    expect((await selection(page, 'longo.md')).text).toBe('fim-ausente.md');
    // The line is in view, where the read-only text had it: the inspector's area scrolled to it (the
    // editor has no scroll of its own).
    const placed = await text.evaluate((area: HTMLTextAreaElement) => ({
      scroll: area.closest('.inspector-scroll')!.scrollTop,
      own: area.scrollHeight - area.clientHeight,
      lineHeight: parseFloat(getComputedStyle(area).lineHeight),
    }));
    expect(placed.scroll).toBeGreaterThan(placed.lineHeight * 3000);
    expect(placed.own).toBe(0);
    started = Date.now();
    await page.keyboard.type('fim.md');
    const typeMs = Date.now() - started;
    await expect(page.locator('.status-bar [data-key="cursor"]')).toContainText('Linha 4000');
    started = Date.now();
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('L4000 resolvida');
    const saveMs = Date.now() - started;
    expect(readFileSync(join(root, 'longo.md'), 'utf8').split('\n')[3999]).toBe(
      'Veja [o fim](fim.md) aqui.',
    );
    test.info().annotations.push({
      type: 'medida',
      description: `5.000 linhas: abrir o editor na linha 4.000 ${openMs} ms; digitar 6 caracteres ${typeMs} ms; gravar e reler ${saveMs} ms`,
    });
    expect(openMs).toBeLessThan(3000);
    expect(typeMs).toBeLessThan(3000);
    expect(saveMs).toBeLessThan(5000);
  } finally {
    await cleanup();
  }
});

test('edit session: on, two files edited, a conflict, an undo, off; every other file is byte for byte the same, no temporary is left, and the app state has no document text', async ({
  page,
}) => {
  const root = editProject({
    'AGENTS.md': '# Projeto\n[A](a.md)\n[B](docs/b.md)\n',
    'a.md': '# A\n\nTexto único de A.\n',
    'docs/b.md': '# B\n\nTexto único de B.\n',
    'docs/c.md': '# C\n',
    'outros/d.txt': 'D\n',
  });
  const before = tree(root);
  const cleanup = await openForEditing(page, root);
  try {
    await selectFile(page, join(root, 'a.md'));
    const a = await startEditing(page, 'a.md', { allow: true });
    await a.fill('# A\n\nSegredo editado de A.\n');
    await a.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · ');
    await outcome(page).getByRole('button', { name: 'Desfazer' }).click();
    await expect(outcome(page)).toContainText('Gravação desfeita');
    await selectFile(page, join(root, 'docs/b.md'));
    const b = await startEditing(page, 'b.md');
    await b.fill('# B\n\nSegredo editado de B.\n');
    writeFileSync(join(root, 'docs/b.md'), '# B\n\nDe outro programa.\n');
    await b.press('Control+s');
    // The conflict dialog is the confirmation: Decidir depois has the focus.
    const versions = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
    await expect(versions.getByRole('button', { name: 'Decidir depois' })).toBeFocused();
    await versions.getByRole('button', { name: 'Descartar meu texto' }).click();
    await expect(b).toHaveValue('# B\n\nDe outro programa.\n');
    const bar = page.locator('.status-bar');
    await bar.getByRole('button', { name: 'Edição ligada: projeto' }).click();
    await page.getByRole('menuitem', { name: 'Desligar edição em projeto' }).click();
    await expect(bar.locator('[data-key="readonly"]')).toBeVisible();

    const after = tree(root);
    // a.md has its bytes back (a new inode: the save is a rename); b.md has the other program's text.
    expect(Buffer.from(after['a.md'].split(':')[2], 'base64').toString()).toBe(
      '# A\n\nTexto único de A.\n',
    );
    expect(Buffer.from(after['docs/b.md'].split(':')[2], 'base64').toString()).toBe(
      '# B\n\nDe outro programa.\n',
    );
    for (const name of ['a.md', 'docs/b.md']) {
      delete before[name];
      delete after[name];
    }
    expect(after).toEqual(before);
    expect(Object.keys(tree(root)).filter((name) => name.includes('.aae-edit-'))).toEqual([]);
    const state = readFileSync(
      join(process.env.AAE_UI_RUN_DIR!, 'state', 'workspace.json'),
      'utf8',
    );
    for (const secret of ['Segredo editado', 'Texto único', 'De outro programa'])
      expect(state).not.toContain(secret);
    expect(JSON.parse(state).editing?.[root]).toBeUndefined();
  } finally {
    await cleanup();
  }
});

test('edit save: "Gravando…" while it runs, one save for a double click, the undo asks when text was typed after the save, and a line of an observation moves the cursor in the editor', async ({
  page,
}) => {
  const root = editProject(files);
  const guide = join(root, 'docs/guia.md');
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  try {
    await page.reload();
    await selectFile(page, guide);
    const text = await startEditing(page, 'guia.md');
    // The cursor at the start, nothing selected, when no line is highlighted.
    expect(await selection(page, 'guia.md')).toEqual({ text: '', start: 0, end: 0 });
    // Saving the text as it is writes nothing: "Nada novo a gravar", no undo, nothing counted as unsaved.
    await text.press('Control+s');
    await expect(outcome(page)).toHaveText('Nada novo a gravar');
    await expect(page.locator('.status-bar [data-key="editing"]')).toHaveText(
      'Edição ligada: projeto',
    );
    await text.fill(files['docs/guia.md'].replace('Primeiro passo.', 'Primeiro passo, revisto.'));
    // SIMULATED delay: the real save answers after 800 ms, so the state while it runs can be seen.
    const saves: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/edit/save')) saves.push(request.postData() ?? '');
    });
    await page.route('**/api/edit/save', async (route) => {
      await new Promise((done) => setTimeout(done, 800));
      await route.continue();
    });
    // Gravar and Fechar editor are in the line of the file's actions, in the boxes of A and B, and Ver
    // mudanças in the box of Editar.
    const save = page.locator('.inspector .endpoint-actions .edit-save');
    await expect(page.locator('.inspector .endpoint-actions button')).toHaveText([
      'Gravar',
      'Fechar editor',
      'Ver mudanças',
    ]);
    await save.dblclick();
    // "Gravando…" in the state line; Gravar keeps its name, unavailable.
    await expect(outcome(page)).toHaveText('Gravando…');
    await expect(save).toHaveText('Gravar');
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('Gravado · +1 −1');
    await expect(save).not.toHaveAttribute('aria-disabled');
    expect(saves).toHaveLength(1);
    await page.unrouteAll();

    // Typed after the save: the undo asks, with Cancelar focused, and Cancelar keeps the text.
    await text.press('Control+End');
    await page.keyboard.type('Depois.\n');
    await outcome(page).getByRole('button', { name: 'Desfazer' }).click();
    const question = page.getByRole('dialog', { name: 'Desfazer a última gravação?' });
    await expect(question).toContainText(
      'Desfazer volta o arquivo ao texto anterior e descarta o que você digitou depois de gravar.',
    );
    await expect(question.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await question.getByRole('button', { name: 'Cancelar' }).click();
    await expect(text).toHaveValue(/Depois\.\n$/);
    expect(readFileSync(guide, 'utf8')).toContain('Primeiro passo, revisto.');
    await outcome(page).getByRole('button', { name: 'Desfazer' }).click();
    await question.getByRole('button', { name: 'Desfazer' }).click();
    await expect(outcome(page)).toContainText('Gravação desfeita');
    await expect(text).toHaveValue(files['docs/guia.md']);
    expect(readFileSync(guide, 'utf8')).toBe(files['docs/guia.md']);

    // The line number of the file's observation, with the editor open: the cursor goes to that line, with
    // only the destination selected.
    await expect(page.locator('.inspector .file-observations')).toBeVisible();
    await page
      .locator('.inspector .file-observations')
      .getByRole('button', { name: 'Ir para a linha 5' })
      .first()
      .click();
    await expect
      .poll(() => selection(page, 'guia.md').then((value) => value.text))
      .toBe('anexo-ausente.md');
    await expect(text).toBeFocused();
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await cleanup();
  }
});

test('edit reading: the reading after a save keeps the traced path and the history, and raises no "Desde a referência" notice', async ({
  page,
}) => {
  const root = editProject(files);
  const guide = join(root, 'docs/guia.md');
  const cleanup = await openForEditing(page, root);
  await enableEditing(page, root);
  try {
    await page.reload();
    await page.getByRole('button', { name: 'Caminho', exact: true }).click();
    await page.getByLabel('Arquivo de origem A').fill('projeto/AGENTS.md');
    await page.getByLabel('Arquivo de destino B').fill('projeto/docs/guia.md');
    await page.getByLabel('Arquivo de destino B').press('Enter');
    const summary = page.locator('.trace-summary');
    await expect(summary).toContainText('Caminho encontrado · 1 passo');
    await selectFile(page, guide);
    const back = page.getByRole('button', { name: 'Voltar seleção' });
    await expect(back).toBeEnabled();
    const text = await startEditing(page, 'guia.md');
    await text.fill(files['docs/guia.md'].replace('anexo-ausente.md', 'certo.md'));
    await text.press('Control+s');
    await expect(outcome(page)).toContainText('1 resolvida');
    // Traced again on the new reading, the same A and B.
    await expect(summary).toContainText('Caminho encontrado · 1 passo');
    await expect(page.getByLabel('Arquivo de origem A')).toHaveValue('projeto/AGENTS.md');
    await expect(back).toBeEnabled();
    await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('guia.md');
    // The save says what changed; no notice under the bar.
    await expect(page.locator('.bar-notices')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
