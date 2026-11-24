// Editing-screen cases, one test each: leaving the editor in a long file keeps the line in view, eight
// lines in view with the changes shown, the count with "nothing new", a save asked during a save, nothing
// under the state line and leaving a short file, no observation named without one chosen, the band of the
// evidence in one form, the copy of an empty line, the plain look of a button that appeared under the
// pointer, and a discard in the conflict that can be undone.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPOSITION_AGENTS, begin, compositionProject, editProject, still } from './edit-helpers';

const WINDOWS = [
  { width: 1536, height: 960 },
  { width: 749, height: 396 },
];
const status = (page: Page) => page.locator('.inspector .editor-status');
const sentence = (page: Page) => page.locator('.inspector .editor-status .editor-status-text');

/** The first line in view (its number and top), in the editor or in the read-only text. */
const firstLine = (page: Page) =>
  page.evaluate(() => {
    const area = document.querySelector('.inspector-scroll')!.getBoundingClientRect();
    const editing = !!document.querySelector('.editor-text');
    const list = editing
      ? [...document.querySelectorAll('.editor-gutter > span')].map(
          (span) => [Number(span.textContent), span.getBoundingClientRect().top] as const,
        )
      : [...document.querySelectorAll<HTMLElement>('.inspector .source-code > [data-line]')].map(
          (row) => [Number(row.dataset.line), row.getBoundingClientRect().top] as const,
        );
    const shown = list.filter(([, top]) => top >= area.top - 1).sort((a, b) => a[0] - b[0]);
    return shown[0] ? { line: shown[0][0], top: shown[0][1] } : null;
  });

/** Scrolls the editor so that `line` is the first line in view. */
const scrollToLine = (page: Page, line: number) =>
  page.evaluate((target) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
    const area = document.querySelector<HTMLElement>('.inspector-scroll')!;
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const property of [
      'fontFamily',
      'fontSize',
      'lineHeight',
      'paddingTop',
      'paddingLeft',
      'paddingRight',
      'whiteSpace',
      'overflowWrap',
    ] as const)
      mirror.style[property] = style[property];
    Object.assign(mirror.style, {
      position: 'absolute',
      left: '-10000px',
      top: '0',
      boxSizing: 'border-box',
      width: `${textarea.clientWidth}px`,
      visibility: 'hidden',
    });
    for (const text of textarea.value.split('\n').slice(0, target)) {
      const row = document.createElement('div');
      row.textContent = text || '​';
      mirror.append(row);
    }
    document.body.append(mirror);
    const top = (mirror.lastElementChild as HTMLElement).getBoundingClientRect().top;
    const origin = mirror.getBoundingClientRect().top;
    mirror.remove();
    area.scrollTop +=
      textarea.getBoundingClientRect().top + (top - origin) - area.getBoundingClientRect().top;
  }, line);

for (const size of WINDOWS) {
  const W = size.width;
  test(`leaving the editor anywhere in a long file keeps the line in view where it is, at lines 50, 2,500 and 4,000 ${W}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    const big = `${Array.from({ length: 5000 }, (_, index) =>
      index + 1 === 4000 ? 'line 4000 see [x](missing-4000.md)' : `line ${index + 1}`,
    ).join('\n')}\n`;
    const root = editProject({ 'big.md': big }, 'pf');
    const { close } = await begin(page, size, { root, file: 'big.md' });
    for (const line of [50, 2500, 4000]) {
      // Editar (no line chosen), work near the line, close.
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      await scrollToLine(page, line);
      await still(page);
      const before = await firstLine(page);
      expect(before!.line).toBe(line);
      await page.locator('.edit-close').click();
      await expect(page.locator('.editor-text')).toHaveCount(0);
      await still(page);
      const after = await firstLine(page);
      expect(after!.line, `line ${line}`).toBe(before!.line);
      expect(Math.abs(after!.top - before!.top), `line ${line}`).toBeLessThanOrEqual(1);
    }
    await close();
  });

  test(`nothing under the state line when entering by a line, and leaving a short file moves nothing ${W}`, async ({
    page,
  }) => {
    const { close } = await begin(page, size);
    // The line opened sits in the last pixels of the read-only view: the state line that comes with the
    // editor would cover it.
    await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
    await still(page);
    await page.evaluate(() => {
      const area = document.querySelector<HTMLElement>('.inspector-scroll')!;
      const row = document.querySelector('.inspector .source-code > [data-line="7"]')!;
      area.scrollTop +=
        row.getBoundingClientRect().bottom - area.getBoundingClientRect().bottom + 4;
    });
    await still(page);
    await page.locator('.inspector .edit-button').click();
    await expect(page.locator('.editor-text')).toBeVisible();
    await still(page);
    const seven = async () =>
      page.evaluate(() => {
        const span = [...document.querySelectorAll('.editor-gutter > span')].find(
          (each) => each.textContent === '7',
        )!;
        return {
          bottom: span.getBoundingClientRect().bottom,
          line: document.querySelector('.editor-status')!.getBoundingClientRect().top,
          scroll: document.querySelector('.inspector-scroll')!.scrollTop,
        };
      });
    const entered = await seven();
    expect(entered.bottom).toBeLessThanOrEqual(entered.line + 0.5);
    // Typing on it scrolls nothing.
    await page.keyboard.type('hostil.md');
    await still(page);
    expect((await seven()).scroll).toBe(entered.scroll);
    await page.locator('.edit-close').click();
    await close();
    // A short file: the field reached the state line; leaving keeps the text where it was.
    const root = editProject({ 'curto.md': '# s\n\nline 3\nline 4\nline 5\n' }, 'curto');
    const short = await begin(page, size, { root, file: 'curto.md' });
    await page.locator('.inspector .edit-button').click();
    await expect(page.locator('.editor-text')).toBeVisible();
    await still(page);
    const before = await firstLine(page);
    await page.locator('.edit-close').click();
    await expect(page.locator('.editor-text')).toHaveCount(0);
    await still(page);
    const after = await firstLine(page);
    expect(after!.line).toBe(before!.line);
    expect(Math.abs(after!.top - before!.top)).toBeLessThanOrEqual(1);
    await short.close();
  });

  test(`entering by Editar names no observation; after a save, the count of resolved ones ${W}`, async ({
    page,
  }) => {
    const { close } = await begin(page, size);
    await page.locator('.inspector .edit-button').click();
    await expect(page.locator('.editor-text')).toBeVisible();
    await still(page);
    // Even with the observations out of view (the small window slides), none is named.
    await page
      .locator('.inspector-scroll')
      .evaluate((area) => (area.scrollTop = area.scrollHeight));
    await still(page);
    await expect(sentence(page)).toHaveText('');
    await expect(status(page).locator('.editor-motive')).toHaveCount(0);
    // Fix the problem of line 7: the state line says how many were resolved.
    await page.locator('.editor-text').evaluate((area: HTMLTextAreaElement) => {
      const at = area.value.indexOf('ausente.md');
      area.focus();
      area.setSelectionRange(at, at + 'ausente.md'.length);
    });
    await page.keyboard.type('hostil.md');
    await page.keyboard.press('Control+s');
    await expect(sentence(page)).toHaveText('Gravado · +1 −1 · 1 resolvida');
    await close();
  });

  test(`the changes shown with none in view slide to them and leave eight lines of text in view ${W}`, async ({
    page,
  }) => {
    const { close } = await begin(page, size);
    await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
    await page.locator('.inspector .edit-button').click();
    await expect(page.locator('.editor-text')).toBeVisible();
    await page.keyboard.type('hostil.md');
    // Back to the top: the observations fill the small window, the change is out of view.
    await page.locator('.inspector-scroll').evaluate((area) => (area.scrollTop = 0));
    await still(page);
    await page.locator('.inspector .edit-marks').click();
    await still(page);
    const room = await page.evaluate(() => {
      const area = document.querySelector('.inspector-scroll')!.getBoundingClientRect();
      const box = document.querySelector('.editor-marks')!.getBoundingClientRect();
      const removed = document.querySelector('.marks-removed')!.getBoundingClientRect();
      return {
        text: area.bottom - Math.max(area.top, box.top + 8),
        change: removed.top >= area.top && removed.bottom <= area.bottom,
      };
    });
    expect(room.text).toBeGreaterThanOrEqual(158.4);
    expect(room.change).toBe(true);
    await close();
  });
}

test('with the changes in view, "nothing new to save" keeps the count of their signs', async ({
  page,
}) => {
  const { close } = await begin(page, WINDOWS[0]);
  await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  await page.keyboard.type('hostil.md');
  await page.keyboard.press('Control+s');
  await expect(sentence(page)).toContainText('Gravado · +1 −1');
  await page.locator('.inspector .edit-marks').click();
  await page.keyboard.press('Control+s');
  await expect(sentence(page)).toHaveText('Nada novo a gravar · +1 −1');
  await expect(page.locator('.marks-row .marks-sign')).toHaveText(['−', '+']);
  await close();
});

test('a Ctrl+S during a save is kept, once: the text typed meanwhile is saved after it, and "saved" is never said over newer text', async ({
  page,
}) => {
  const { root, close } = await begin(page, WINDOWS[0]);
  const file = join(root, 'AGENTS.md');
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  // Each save waits until the test lets it go.
  const saves: string[] = [];
  let release: (() => void)[] = [];
  await page.route('**/api/edit/save', async (route) => {
    saves.push(route.request().postDataJSON().text);
    await new Promise<void>((resolve) => release.push(resolve));
    await route.continue();
  });
  await page.locator('.editor-text').press('Control+End');
  await page.keyboard.type('Um.\n');
  await page.keyboard.press('Control+s');
  await expect(sentence(page)).toHaveText('Gravando…');
  await page.keyboard.type('Dois.\n');
  // Pressed three times during the save: one more save, later.
  for (let index = 0; index < 3; index++) await page.keyboard.press('Control+s');
  await expect.poll(() => release.length).toBe(1);
  release[0]();
  // The first save ends with newer text in the editor: never "saved"; the second one runs.
  await expect.poll(() => release.length).toBe(2);
  await expect(sentence(page)).toHaveText('Gravando…');
  await expect(sentence(page)).not.toContainText('Gravado');
  release[1]();
  await expect(sentence(page)).toContainText('Gravado · +1 −0');
  expect(saves).toHaveLength(2);
  expect(saves[1].endsWith('Um.\nDois.\n')).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(`${COMPOSITION_AGENTS}Um.\nDois.\n`);
  // Typing after the save: the state line no longer says "saved".
  await page.keyboard.type('Três.');
  await expect(sentence(page)).toHaveText('Não gravado');
  await expect(status(page).getByRole('button', { name: 'Desfazer' })).toBeVisible();
  release = [];
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await close();
});

test('the band of the evidence keeps its form and language when a save takes its relation away', async ({
  page,
}) => {
  for (const language of ['pt', 'en'] as const) {
    if (language === 'en') await page.evaluate(() => localStorage.setItem('aae-lang', 'en'));
    const { close } = await begin(page, WINDOWS[0]);
    // The list of observations speaks the language of the window too.
    await page
      .getByRole('button', { name: language === 'pt' ? 'Ir para a linha 7' : 'Go to line 7' })
      .click();
    const band = page.locator('.inspector-scroll > .source-context');
    const before =
      language === 'pt'
        ? 'Evidência de AGENTS.md → ausente.md · linha 7'
        : 'Evidence of AGENTS.md → ausente.md · line 7';
    await expect(band).toContainText(before);
    const height = (await band.boundingBox())!.height;
    await page.locator('.inspector .edit-button').click();
    await expect(page.locator('.editor-text')).toBeVisible();
    await page.keyboard.type('hostil.md');
    await page.keyboard.press('Control+s');
    // The same words, in the same language (with "· resolvida" only where it fits the height).
    await expect(page.locator('.inspector-scroll > .held-band')).toHaveCount(1);
    await expect(band).toContainText(before);
    await expect(band.getByRole('button')).toHaveText(
      language === 'pt' ? 'Limpar destaque' : 'Clear highlight',
    );
    expect((await band.boundingBox())!.height).toBe(height);
    await close();
  }
});

test('copying from the text with its changes gives empty lines as empty lines', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const root = compositionProject({ 'vazio.md': '# V\n\nUm.\n\nDois.\n' });
  const { close } = await begin(page, WINDOWS[0], { root, file: 'vazio.md' });
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  await page.locator('.editor-text').press('Control+End');
  await page.keyboard.type('Três.\n');
  await page.locator('.inspector .edit-marks').click();
  await still(page);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.marks-row')].sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    );
    const range = document.createRange();
    range.setStartBefore(rows[1]);
    range.setEndAfter(rows[4]);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    document.execCommand('copy');
  });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\n$/, '')).toBe('\nUm.\n\nDois.');
  await close();
});

test('a button that appears under the pointer when the editor closes does not look hovered until the pointer moves', async ({
  page,
}) => {
  const { close } = await begin(page, WINDOWS[0]);
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  const box = (await page.locator('.edit-close').boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('.editor-text')).toHaveCount(0);
  const background = (index: number) =>
    page.evaluate(
      (at) =>
        getComputedStyle(
          document.querySelectorAll('.inspector-identity .endpoint-actions > button')[at],
        ).backgroundColor,
      index,
    );
  // B, under the pointer, as A (not hovered).
  expect(await background(1)).toBe(await background(0));
  await page.mouse.move(box.x + 20, box.y + 12);
  await expect.poll(() => background(1)).not.toBe(await background(0));
  await close();
});

test('a discard in the conflict dialog is one click and can be undone, until the next edit or leaving the file', async ({
  page,
}) => {
  const { root, close } = await begin(page, WINDOWS[0]);
  const file = join(root, 'AGENTS.md');
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  await page.locator('.editor-text').press('Control+End');
  await page.keyboard.type('meu texto\n');
  const mine = await page.locator('.editor-text').inputValue();
  writeFileSync(file, readFileSync(file, 'utf8').replace('# Aurora', '# Aurora (outro programa)'));
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
  await dialog.getByRole('button', { name: 'Descartar meu texto' }).click();
  await expect(dialog).toHaveCount(0);
  const disk = readFileSync(file, 'utf8');
  await expect(page.locator('.editor-text')).toHaveValue(disk);
  // The state line says it, with Desfazer: the text comes back, over the version on disk.
  await expect(sentence(page)).toHaveText('Seu texto foi descartado');
  await status(page).getByRole('button', { name: 'Desfazer' }).click();
  await expect(page.locator('.editor-text')).toHaveValue(mine);
  expect(readFileSync(file, 'utf8')).toBe(disk);
  // Saving it shows first what it undoes on disk (as "Manter meu texto").
  await page.keyboard.press('Control+s');
  const review = page.getByRole('dialog', { name: 'Gravar sobre a versão do disco?' });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Cancelar' }).click();
  // Discarded again: the next edit ends the offer.
  writeFileSync(file, readFileSync(file, 'utf8').replace('(outro programa)', '(outro, de novo)'));
  await page.keyboard.press('Control+s');
  await dialog.getByRole('button', { name: 'Descartar meu texto' }).click();
  await expect(sentence(page)).toHaveText('Seu texto foi descartado');
  await page.locator('.editor-text').press('Control+End');
  await page.keyboard.type('x');
  await expect(status(page).getByRole('button', { name: 'Desfazer' })).toHaveCount(0);
  // And leaving the file ends it too.
  writeFileSync(file, readFileSync(file, 'utf8').replace('(outro, de novo)', '(terceira vez)'));
  await page.keyboard.press('Control+s');
  await dialog.getByRole('button', { name: 'Descartar meu texto' }).click();
  await expect(sentence(page)).toHaveText('Seu texto foi descartado');
  await page.locator('.edit-close').click();
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  await expect(sentence(page)).not.toContainText('descartado');
  await close();
});
