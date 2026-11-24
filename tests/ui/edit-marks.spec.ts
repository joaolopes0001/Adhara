// The numbers of the lines in the editor and "Ver mudanças" (the changes in the text itself), by geometry
// and by behavior, in the large window (1536×960) and
// the small one (749×396), and the cases around them (switching ten times, saving with the changes in
// view, a file changed on disk, nothing changed, the first and the last line removed, a trailing space).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast } from './helpers';
import { runMoreAction } from './more-menu';
import { COMPOSITION_AGENTS, begin, compositionProject, editProject, still } from './edit-helpers';

const WINDOWS = [
  { width: 1536, height: 960 },
  { width: 749, height: 396 },
];
const TEXT = 1;

/** The numbers in view: text, top, the edges of the digits (a range over them) and color. */
const numbers = (page: Page) =>
  page.evaluate(() => {
    const area = document.querySelector('.inspector-scroll')!.getBoundingClientRect();
    const inspector = document.querySelector('.inspector')!.getBoundingClientRect();
    return [
      ...document.querySelectorAll<HTMLElement>(
        '.inspector .source-code > [data-line] > span, .editor-gutter > span, .marks-row > .marks-number',
      ),
    ]
      .filter((span) => span.textContent)
      .map((span) => {
        const range = document.createRange();
        range.selectNodeContents(span);
        const digits = range.getBoundingClientRect();
        return {
          n: Number(span.textContent),
          top: span.getBoundingClientRect().top,
          left: digits.left - inspector.left,
          right: digits.right - inspector.left,
          color: getComputedStyle(span).color,
        };
      })
      .filter((number) => number.top >= area.top - 1 && number.top + 19 <= area.bottom + 1);
  });

/** The top of each line of the editor's text (a copy with the same letter and wrapping), by number. */
const editorTops = (page: Page) =>
  page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const property of [
      'fontFamily',
      'fontSize',
      'lineHeight',
      'letterSpacing',
      'tabSize',
      'paddingTop',
      'paddingLeft',
      'paddingRight',
      'wordBreak',
      'overflowWrap',
      'whiteSpace',
    ] as const)
      mirror.style[property] = style[property];
    Object.assign(mirror.style, {
      position: 'absolute',
      visibility: 'hidden',
      top: '0',
      left: '-10000px',
      boxSizing: 'border-box',
      width: `${textarea.clientWidth}px`,
      border: '0',
    });
    for (const text of textarea.value.split('\n')) {
      const line = document.createElement('div');
      line.textContent = text || '​';
      mirror.append(line);
    }
    document.body.append(mirror);
    const origin = textarea.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
    const tops = [...mirror.children].map((line) => origin + line.getBoundingClientRect().top);
    mirror.remove();
    return tops;
  });

/** The rows of the text with its changes: kind, number, top, text, sign and the part underlined. */
const marked = (page: Page) =>
  page.evaluate(() => {
    const inspector = document.querySelector('.inspector')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.marks-row')]
      .map((row) => {
        const sign = row.querySelector<HTMLElement>('.marks-sign');
        const box = sign?.getBoundingClientRect();
        const range = sign && document.createRange();
        range?.selectNodeContents(sign!);
        const glyph = range?.getBoundingClientRect();
        const code = row.querySelector('code')!;
        const hidden = code.querySelector('.visually-hidden');
        return {
          kind: row.className.replace('marks-row marks-', ''),
          line: row.dataset.line ? Number(row.dataset.line) : undefined,
          top: row.getBoundingClientRect().top,
          text: [...code.childNodes]
            .filter((node) => node !== hidden)
            .map((node) => node.textContent)
            .join(''),
          spoken: hidden?.textContent ?? '',
          underlined: code.querySelector('u')?.textContent,
          sign: sign?.textContent,
          signLeft: glyph ? glyph.left - inspector.left : undefined,
          signRight: glyph ? glyph.right - inspector.left : undefined,
          signMiddle: box ? box.top + box.height / 2 : undefined,
          signColor: sign ? getComputedStyle(sign).color : undefined,
          textColor: getComputedStyle(code).color,
          codeLeft: code.getBoundingClientRect().left - inspector.left,
        };
      })
      .sort((a, b) => a.top - b.top);
  });

/** The boxes that must not move when the changes are shown. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      inspector: box('.inspector'),
      map: document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform,
      observations: box('.file-observations'),
      band: box('.inspector-scroll > .source-context'),
      actions: [...document.querySelectorAll('.inspector-identity .endpoint-actions > *')].map(
        (element) => element.getBoundingClientRect().toJSON(),
      ),
      status: box('.editor-status'),
      scroll: document.querySelector('.inspector-scroll')!.scrollTop,
    };
  });

const status = (page: Page) => page.locator('.inspector .editor-status');
const marksButton = (page: Page) => page.locator('.inspector .edit-marks');
const statusText = (page: Page) => page.locator('.inspector .editor-status .editor-status-text');

/** Opens the editor at line 7 (the missing destination selected) and types the fix. */
async function fixLine7(page: Page) {
  await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  await still(page);
  await page.keyboard.type('hostil.md');
  await still(page);
}

const measured: Record<string, unknown> = {};
test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    join('test-results', 'edit-marks-measures.json'),
    `${JSON.stringify(measured, null, 1)}\n`,
  );
});

for (const size of WINDOWS) {
  const W = size.width;
  test.describe(`${W}×${size.height}`, () => {
    test(`the numbers of the lines: the same column in both modes, in both themes ${W}`, async ({
      page,
    }) => {
      const { close } = await begin(page, size);
      for (const theme of ['dark', 'light'] as const) {
        if (theme === 'light') {
          await page.locator('.edit-close').click();
          await expect(page.locator('.editor-text')).toHaveCount(0);
          await runMoreAction(page, 'Ativar tema claro');
          await still(page);
        } else {
          await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
          await still(page);
        }
        const before = await numbers(page);
        await page.locator('.inspector .edit-button').click();
        await expect(page.locator('.editor-text')).toBeVisible();
        await still(page);
        const after = await numbers(page);
        // Each number in view, 0 px (±0.5) in its top and the right edge of its digits.
        expect(after.map((number) => number.n)).toEqual(before.map((number) => number.n));
        for (const [index, number] of after.entries()) {
          expect(Math.abs(number.top - before[index].top), `top of ${number.n}`).toBeLessThan(0.51);
          expect(Math.abs(number.right - before[index].right), `edge of ${number.n}`).toBeLessThan(
            0.51,
          );
        }
        // 11 px from the edge of the digits to the first character; the numbers of the read-only
        // text in letter and color (the line of the cursor in the color of the text).
        const geometry = await page.evaluate(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
          const inspector = document.querySelector('.inspector')!.getBoundingClientRect();
          const gutter = document.querySelector<HTMLElement>('.editor-gutter')!;
          const span = gutter.querySelector('span')!;
          return {
            text:
              textarea.getBoundingClientRect().left +
              parseFloat(getComputedStyle(textarea).paddingLeft) -
              inspector.left,
            textColor: getComputedStyle(textarea).color,
            font: `${getComputedStyle(span).fontSize} ${getComputedStyle(span).lineHeight} ${getComputedStyle(span).fontFamily}`,
            background: getComputedStyle(gutter).backgroundColor,
            border: getComputedStyle(gutter).borderRightWidth,
            hidden: gutter.getAttribute('aria-hidden'),
            select: getComputedStyle(gutter).userSelect,
            pointer: getComputedStyle(gutter).pointerEvents,
            focusable: gutter.querySelectorAll('[tabindex]').length,
          };
        });
        for (const number of after) expect(number.right).toBeCloseTo(geometry.text - 11, 0);
        expect(geometry.font).toBe('11px 19.8px ui-monospace, SFMono-Regular, Consolas, monospace');
        expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
        expect(geometry.border).toBe('0px');
        const seven = after.find((number) => number.n === 7)!;
        expect(seven.color).toBe(geometry.textColor);
        for (const number of after.filter((each) => each.n !== 7))
          expect(number.color).toBe(before.find((each) => each.n === number.n)!.color);
        // The cursor goes down a line: its number takes the color, 7 gives it back.
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(async () => (await numbers(page)).find((number) => number.n === 8)?.color)
          .toBe(geometry.textColor);
        expect((await numbers(page)).find((number) => number.n === 7)!.color).toBe(
          before.find((number) => number.n === 7)!.color,
        );
        // Line 2 wraps: its number on its first visual line, none on the second.
        const tops = await editorTops(page);
        const two = after.find((number) => number.n === 2);
        if (two) {
          expect(Math.abs(two.top - tops[1])).toBeLessThanOrEqual(TEXT);
          expect(tops[2] - tops[1]).toBeGreaterThan(30);
          expect(
            after.filter((number) => number.top > two.top && number.top < tops[2] - 1),
          ).toEqual([]);
        }
        // Out of the selection, the copy, the focus and what is read aloud; a click changes nothing.
        expect(geometry).toMatchObject({
          hidden: 'true',
          select: 'none',
          pointer: 'none',
          focusable: 0,
        });
        const first = after[0];
        await page.mouse.click(
          (await page.locator('.inspector').boundingBox())!.x + first.right - 2,
          first.top + 9,
        );
        expect((await numbers(page)).map((number) => number.n)).toEqual(
          after.map((number) => number.n),
        );
        measured[`numbers ${W} ${theme}`] = { numbers: after.length, first: after[0], seven };
      }
      await close();
    });

    test(`long files: the column grows with the largest number, the same in both modes; only the numbers in view are drawn ${W}`, async ({
      page,
    }) => {
      test.setTimeout(120000);
      const lines = Array.from({ length: 5000 }, (_, index) =>
        index === 3999
          ? '[Ausente](sumido.md)'
          : index % 7 === 0
            ? `Linha ${index + 1}: um texto mais longo, que quebra no inspetor estreito e também no largo, para medir.`
            : `Linha ${index + 1}`,
      );
      const root = editProject({ 'longo.md': `${lines.join('\n')}\n` }, 'longo');
      const { close } = await begin(page, size, { root, file: 'longo.md' });
      await page.getByRole('button', { name: 'Ir para a linha 4000' }).click();
      await still(page);
      const before = await numbers(page);
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      const after = await numbers(page);
      // Around line 4,000: every number in view in the editor (whose area ends at the state line)
      // is where the read-only text had it.
      expect(after.length).toBeGreaterThan(5);
      for (const number of after) {
        const old = before.find((each) => each.n === number.n)!;
        expect(Math.abs(number.top - old.top)).toBeLessThan(0.51);
        expect(Math.abs(number.right - old.right)).toBeLessThan(0.51);
      }
      expect(after.map((number) => number.n)).toEqual(
        before.map((number) => number.n).slice(0, after.length),
      );
      // 12 px free, the widest number (4 digits), 11 px: no number starts before 12 px.
      const digit = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.textContent = '0000000000';
        probe.style.cssText =
          'position:absolute;font:11px ui-monospace, SFMono-Regular, Consolas, monospace';
        document.body.append(probe);
        const width = probe.getBoundingClientRect().width / 10;
        probe.remove();
        return width;
      });
      const gutter = await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
        return parseFloat(getComputedStyle(textarea).paddingLeft);
      });
      expect(gutter).toBeCloseTo(Math.max(40, 12 + 4 * digit + 11), 0);
      for (const number of after) expect(number.left).toBeGreaterThanOrEqual(12 - 0.5);
      measured[`gutter ${W} 5000`] = { gutter, digit };
      // Few numbers drawn; after scrolling to lines 1, 2,500, 4,000 and 5,000 every line in view
      // has its number at its top.
      const most = W === 1536 ? 80 : 40;
      const drawn: number[] = [];
      const check = async () => {
        await still(page);
        const tops = await editorTops(page);
        const shown = await numbers(page);
        const area = (await page.locator('.inspector-scroll').boundingBox())!;
        const inView = tops
          .map((top, index) => ({ top, n: index + 1 }))
          .filter(({ top }) => top >= area.y - 1 && top + 19 <= area.y + area.height + 1);
        expect(shown.map((number) => number.n)).toEqual(inView.map((line) => line.n));
        for (const line of inView)
          expect(
            Math.abs(shown.find((number) => number.n === line.n)!.top - line.top),
          ).toBeLessThanOrEqual(TEXT);
        const count = await page.locator('.editor-gutter > span').count();
        expect(count).toBeLessThanOrEqual(most);
        drawn.push(count);
      };
      for (const line of [1, 2500, 4000, 5000]) {
        await page.evaluate((target) => {
          const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
          const area = document.querySelector<HTMLElement>('.inspector-scroll')!;
          const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight);
          // Near enough: the exact line is checked through the copy.
          const before = textarea.value.split('\n').slice(0, target - 1);
          const wraps = before.filter((text) => text.length > 40).length;
          area.scrollTop =
            textarea.getBoundingClientRect().top -
            area.getBoundingClientRect().top +
            area.scrollTop +
            (target - 1 + wraps) * lineHeight;
        }, line);
        await check();
      }
      // Typing on line 4,000: the numbers follow, the scroll does not move.
      await page.getByRole('button', { name: 'Ir para a linha 4000' }).click();
      await still(page);
      const scroll = await page.locator('.inspector-scroll').evaluate((area) => area.scrollTop);
      for (const key of ['x', 'y', 'z']) {
        await page.keyboard.press(key);
        await check();
        expect(await page.locator('.inspector-scroll').evaluate((area) => area.scrollTop)).toBe(
          scroll,
        );
      }
      measured[`drawn-numbers ${W}`] = { drawn };
      await close();
    });

    test(`five digits: 12,000 lines, the column of 56 px and no number before 12 px, in both modes ${W}`, async ({
      page,
    }) => {
      test.setTimeout(120000);
      const lines = Array.from({ length: 12000 }, (_, index) => `linha ${index + 1}`);
      const root = editProject({ 'doze.md': `${lines.join('\n')}\n` }, 'doze');
      const { close } = await begin(page, size, { root, file: 'doze.md' });
      const column = () =>
        page.evaluate(() => {
          const span = document.querySelector<HTMLElement>(
            '.inspector .source-code > [data-line] > span, .editor-gutter > span',
          )!;
          const probe = document.createElement('span');
          probe.textContent = '0000000000';
          probe.style.cssText =
            'position:absolute;font:11px ui-monospace, SFMono-Regular, Consolas, monospace';
          document.body.append(probe);
          const digit = probe.getBoundingClientRect().width / 10;
          probe.remove();
          return { width: span.getBoundingClientRect().width, digit };
        });
      const reading = await column();
      expect(reading.width).toBeCloseTo(12 + 5 * reading.digit + 11, 0);
      for (const number of await numbers(page))
        expect(number.left).toBeGreaterThanOrEqual(12 - 0.5);
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      expect((await column()).width).toBeCloseTo(reading.width, 1);
      // At the end of the file, the five-digit numbers.
      await page
        .locator('.inspector-scroll')
        .evaluate((area) => (area.scrollTop = area.scrollHeight));
      await still(page);
      const shown = await numbers(page);
      expect(shown.at(-1)!.n).toBeGreaterThanOrEqual(11990);
      for (const number of shown) expect(number.left).toBeGreaterThanOrEqual(12 - 0.5);
      measured[`gutter ${W} 12000`] = { width: reading.width, first: shown[0] };
      await close();
    });

    test(`Ver mudanças: the third box; on and off move only what the removed lines take ${W}`, async ({
      page,
    }) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      const { close } = await begin(page, size);
      await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      // In the box of Editar, unavailable with the reason while nothing changed.
      const button = marksButton(page);
      await expect(button).toHaveText('Ver mudanças');
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAttribute('title', 'Nada mudou ainda: digite ou grave antes');
      await button.click({ force: true });
      await expect(page.locator('.editor-marks')).toHaveCount(0);
      // Back to the text, the destination still selected.
      await page.locator('.editor-text').focus();
      await page.keyboard.type('hostil.md');
      await still(page);
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await still(page);
      const selection = await page
        .locator('.editor-text')
        .evaluate((area: HTMLTextAreaElement) => [area.selectionStart, area.selectionEnd]);
      const before = await boxes(page);
      const tops = await editorTops(page);
      const shownBefore = await numbers(page);
      const buttonBox = await button.boundingBox();
      await button.click();
      await expect(page.locator('.editor-marks')).toBeVisible();
      await still(page);
      // Pressed, the same name and box; nothing else moves but the text and the sentence.
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(button).toHaveText('Ver mudanças');
      expect(await button.boundingBox()).toEqual(buttonBox);
      expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const on = await boxes(page);
      expect(on).toEqual(before);
      await expect(statusText(page)).toHaveText('Não gravado · +1 −1');
      // The old line right above the new one, the part that differs underlined in both; the old
      // one muted and without number.
      const rows = await marked(page);
      const removed = rows.findIndex((row) => row.kind === 'removed');
      expect(rows[removed]).toMatchObject({
        text: '[Ausente](ausente.md)',
        underlined: 'ausente',
        sign: '−',
        spoken: 'Excluída: ',
        line: undefined,
      });
      expect(rows[removed + 1]).toMatchObject({
        kind: 'added',
        line: 7,
        text: '[Ausente](hostil.md)',
        underlined: 'hostil',
        sign: '+',
        spoken: 'Incluída: ',
      });
      const muted = rows.find((row) => row.kind === 'same')!;
      expect(rows[removed].textColor).not.toBe(muted.textColor);
      // The signs inside the first 12 px, in the middle of the first visual line; the numbers
      // in sequence and in their place, the text at the same x.
      for (const row of rows.filter((each) => each.sign)) {
        expect(row.signLeft!).toBeGreaterThanOrEqual(0);
        expect(row.signRight!).toBeLessThanOrEqual(12);
        expect(Math.abs(row.signMiddle! - (row.top + 9.9))).toBeLessThanOrEqual(TEXT);
      }
      const shownOn = await numbers(page);
      const sequence = shownOn.map((number) => number.n);
      expect(sequence).toEqual(sequence.map((_, index) => sequence[0] + index));
      for (const number of shownOn) {
        const old = shownBefore.find((each) => each.n === number.n);
        if (old) expect(Math.abs(number.right - old.right)).toBeLessThan(0.51);
      }
      const textX = await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
        return (
          textarea.getBoundingClientRect().left +
          parseFloat(getComputedStyle(textarea).paddingLeft) -
          document.querySelector('.inspector')!.getBoundingClientRect().left
        );
      });
      for (const row of rows) expect(row.codeLeft).toBeCloseTo(textX, 1);
      // The lines above the change, 0 px; from line 7 on, one removed line lower.
      const lineHeight = 19.8;
      for (const row of rows.filter((each) => each.line)) {
        const shift = row.line! >= 7 ? lineHeight : 0;
        expect(
          Math.abs(row.top - (tops[row.line! - 1] + shift)),
          `line ${row.line}`,
        ).toBeLessThanOrEqual(TEXT);
      }
      // The colors of the signs and their contrast on the text's background.
      const background = await page.evaluate(() => {
        let node: Element | null = document.querySelector('.editor-marks');
        let color = 'rgba(0, 0, 0, 0)';
        while (node && /rgba\(.*, 0\)$|transparent/.test(color)) {
          color = getComputedStyle(node).backgroundColor;
          node = node.parentElement;
        }
        return color;
      });
      const added = rows.find((row) => row.kind === 'added')!.signColor!;
      const gone = rows[removed].signColor!;
      expect([added, gone]).toEqual(['rgb(111, 211, 131)', 'rgb(217, 122, 95)']);
      expect(contrast(added, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(gone, background)).toBeGreaterThanOrEqual(4.5);
      measured[`toggle ${W} dark`] = {
        added: contrast(added, background),
        removed: contrast(gone, background),
      };
      // No typing, no cursor, no outline, the background of the read-only text.
      const reading = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('.editor-marks')!;
        const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
        return {
          background: getComputedStyle(box).backgroundColor,
          outline: getComputedStyle(box).outlineStyle,
          field: getComputedStyle(textarea).visibility,
          focused: document.activeElement === textarea,
        };
      });
      expect(reading).toEqual({
        background: 'rgba(0, 0, 0, 0)',
        outline: 'none',
        field: 'hidden',
        focused: false,
      });
      await page.keyboard.type('nada');
      await page.keyboard.press('Backspace');
      // The copy of a selection: no removed line, number nor sign.
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.marks-row')].sort(
          (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
        );
        const at = rows.findIndex((row) => row.classList.contains('marks-removed'));
        const range = document.createRange();
        range.setStartBefore(rows[at - 1]);
        range.setEndAfter(rows[at + 2]);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        document.execCommand('copy');
      });
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain('[Skill](skills/triagem/SKILL.md)');
      expect(copied).toContain('[Ausente](hostil.md)');
      expect(copied).not.toContain('ausente.md');
      expect(copied).not.toMatch(/[+−]|\b7\b|Incluída|Excluída/);
      // Esc turns it off: the draft, the selection and every line as before.
      await page.keyboard.press('Escape');
      await expect(page.locator('.editor-marks')).toHaveCount(0);
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await still(page);
      expect(await boxes(page)).toEqual(before);
      const back = await editorTops(page);
      for (const [index, top] of tops.entries())
        expect(Math.abs(back[index] - top)).toBeLessThanOrEqual(TEXT);
      expect(
        await page
          .locator('.editor-text')
          .evaluate((area: HTMLTextAreaElement) => [
            area.value.split('\n')[6],
            area.selectionStart,
            area.selectionEnd,
          ]),
      ).toEqual(['[Ausente](hostil.md)', ...selection]);
      await close();
    });

    test(`the count is that of the signs before and after saving and after Desfazer; saving moves nothing ${W}`, async ({
      page,
    }) => {
      const { close } = await begin(page, size);
      await fixLine7(page);
      // One more line, at the end of the text: +2 −1.
      await page.locator('.editor-text').press('Control+End');
      await page.keyboard.type('nota de teste\n');
      await still(page);
      await marksButton(page).click();
      await still(page);
      // First, as the switch left the area: eight lines of text in view at least, and a whole
      // state line, also in the small window.
      const room = await page.evaluate(() => {
        const area = document.querySelector('.inspector-scroll')!.getBoundingClientRect();
        const box = document.querySelector('.editor-marks')!.getBoundingClientRect();
        const line = document.querySelector<HTMLElement>('.editor-status')!;
        return {
          text: line.getBoundingClientRect().top - Math.max(area.top, box.top + 8),
          cut: [line, ...line.querySelectorAll('span, button')].some(
            (part) => part.scrollWidth > part.clientWidth + 0.5,
          ),
        };
      });
      expect(room.text).toBeGreaterThanOrEqual(158.4);
      expect(room.cut).toBe(false);
      // The rows drawn now, where they are; and every sign of the text, scrolling through it (only the
      // rows around the view are drawn).
      const drawn = async () =>
        (await marked(page)).map((row) => [
          row.kind,
          row.line,
          Math.round(row.top * 10) / 10,
          row.text,
        ]);
      const signs = async () => {
        const area = page.locator('.inspector-scroll');
        const kept = await area.evaluate((element) => element.scrollTop);
        const seen = new Map<string, { at: number; sign: string; text: string }>();
        for (let top = 0; ; top += 100) {
          const at = await area.evaluate((element, value) => {
            element.scrollTop = value;
            return element.scrollTop;
          }, top);
          await still(page);
          for (const row of await marked(page))
            if (row.sign)
              seen.set(`${Math.round(row.top + at)} ${row.text}`, {
                at: row.top + at,
                sign: row.sign,
                text: row.text,
              });
          if (at < top) break;
        }
        await area.evaluate((element, value) => (element.scrollTop = value), kept);
        await still(page);
        const all = [...seen.values()].sort((a, b) => a.at - b.at);
        const of = (sign: string) => all.filter((row) => row.sign === sign).map((row) => row.text);
        return { plus: of('+').length, minus: of('−').length, added: of('+'), removed: of('−') };
      };
      const draft = await signs();
      await expect(statusText(page)).toHaveText(`Não gravado · +${draft.plus} −${draft.minus}`);
      expect([draft.plus, draft.minus]).toEqual([2, 1]);
      // Saving with the changes in view moves no row and no sign.
      const rowsBefore = await drawn();
      await page.keyboard.press('Control+s');
      await expect(statusText(page)).toContainText('Gravado · +2 −1');
      await still(page);
      expect(await drawn()).toEqual(rowsBefore);
      expect(await signs()).toEqual(draft);
      // Desfazer: the signs turn, the count follows.
      await status(page).getByRole('button', { name: 'Desfazer' }).click();
      await expect(statusText(page)).toContainText('Gravação desfeita · +1 −2');
      await still(page);
      const undone = await signs();
      expect([undone.plus, undone.minus]).toEqual([1, 2]);
      expect(undone.added).toEqual(['[Ausente](ausente.md)']);
      expect(undone.removed).toEqual(['[Ausente](hostil.md)', 'nota de teste']);
      measured[`count-after-save ${W}`] = {
        draft: [draft.plus, draft.minus],
        undone: [undone.plus, undone.minus],
        text: room.text,
      };
      await close();
    });

    test(`with no change in view, the area slides to the nearest one ${W}`, async ({ page }) => {
      const more = Array.from({ length: 60 }, (_, index) => `Mais uma linha ${index + 1}.`);
      const root = compositionProject({
        'AGENTS.md': `${COMPOSITION_AGENTS}${more.join('\n')}\n`,
      });
      const { close } = await begin(page, size, { root });
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      // A change near the end, then back to the top.
      await page.locator('.editor-text').press('Control+End');
      await page.keyboard.type('fim do arquivo');
      await page.locator('.inspector-scroll').evaluate((area) => (area.scrollTop = 0));
      await still(page);
      await page.evaluate(() => {
        const area = document.querySelector<HTMLElement>('.inspector-scroll')!;
        const samples: [number, number][] = [];
        (window as unknown as { samples: typeof samples }).samples = samples;
        const start = performance.now();
        const step = (now: number) => {
          samples.push([now, area.scrollTop]);
          if (now - start < 1500) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      await marksButton(page).click();
      await still(page);
      const samples = await page.evaluate(
        () => (window as unknown as { samples: [number, number][] }).samples,
      );
      const end = samples.at(-1)![1];
      const moved = samples.filter(([, scroll]) => scroll !== samples[0][1]);
      const first = samples.indexOf(moved[0]);
      const last = samples.findIndex(([, scroll], index) => index >= first && scroll === end);
      const duration = samples[last][0] - samples[first - 1][0];
      expect(end).toBeGreaterThan(0);
      expect(duration).toBeGreaterThanOrEqual(140);
      expect(duration).toBeLessThanOrEqual(220);
      // The nearest change is in view.
      const inView = await page.evaluate(() => {
        const area = document.querySelector('.inspector-scroll')!.getBoundingClientRect();
        return [...document.querySelectorAll('.marks-added, .marks-removed')].some((row) => {
          const box = row.getBoundingClientRect();
          return box.top >= area.top && box.bottom <= area.bottom;
        });
      });
      expect(inView).toBe(true);
      measured[`slide-to-change ${W}`] = { scroll: end, duration: Math.round(duration) };
      await close();
    });

    test(`a long file with the changes in view draws few rows; past the budget, one block said whole ${W}`, async ({
      page,
    }) => {
      test.setTimeout(120000);
      const lines = Array.from({ length: 5000 }, (_, index) => `Linha ${index + 1}`);
      const root = editProject({ 'longo.md': `${lines.join('\n')}\n` }, 'longo');
      const { close } = await begin(page, size, { root, file: 'longo.md' });
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      const fit = async () => {
        const area = (await page.locator('.inspector-scroll').boundingBox())!;
        expect(await page.locator('.marks-row').count()).toBeLessThanOrEqual(
          3 * Math.ceil(area.height / 19.8),
        );
      };
      // A few changes: rows drawn around the view only.
      await page.locator('.editor-text').evaluate((area: HTMLTextAreaElement, text) => {
        area.focus();
        area.setSelectionRange(0, 0);
        document.execCommand('insertText', false, text);
      }, 'Nova primeira linha\n');
      await marksButton(page).click();
      await still(page);
      await fit();
      await page.locator('.inspector-scroll').evaluate((area) => (area.scrollTop = 40000));
      await still(page);
      await fit();
      await page.keyboard.press('Escape');
      // More than 1,000 lines changed: the middle is one block, and the state line says so whole.
      await page.locator('.editor-text').evaluate((area: HTMLTextAreaElement) => {
        const value = area.value
          .split('\n')
          .map((text, index) => (index > 1000 && index < 2300 ? `${text} mudada` : text))
          .join('\n');
        area.focus();
        area.select();
        document.execCommand('insertText', false, value);
      });
      await still(page);
      await marksButton(page).click();
      await still(page);
      // The first line changed too: the block starts the text.
      await page.locator('.inspector-scroll').evaluate((area) => (area.scrollTop = 0));
      await still(page);
      await expect(page.locator('.marks-block')).toHaveCount(1);
      await expect(page.locator('.marks-block')).toContainText('substituídas em bloco');
      await expect(statusText(page)).toContainText('um bloco substituído');
      expect(
        await status(page).evaluate((line) =>
          [line, ...line.querySelectorAll('span, button')].some(
            (part) => part.scrollWidth > part.clientWidth + 0.5,
          ),
        ),
      ).toBe(false);
      await fit();
      await close();
    });
  });
}

test('switching ten times moves no line and keeps the draft (and the file has no diff dialog)', async ({
  page,
}) => {
  const { close } = await begin(page, WINDOWS[0]);
  await fixLine7(page);
  const tops = await editorTops(page);
  const scroll = await page.locator('.inspector-scroll').evaluate((area) => area.scrollTop);
  for (let index = 0; index < 10; index++) {
    await marksButton(page).click();
    await expect(page.locator('.editor-marks')).toHaveCount(index % 2 ? 0 : 1);
  }
  await still(page);
  expect(await page.locator('.inspector-scroll').evaluate((area) => area.scrollTop)).toBe(scroll);
  const back = await editorTops(page);
  for (const [index, top] of tops.entries())
    expect(Math.abs(back[index] - top)).toBeLessThanOrEqual(TEXT);
  await expect(page.locator('.editor-text')).toHaveValue(
    COMPOSITION_AGENTS.replace('(ausente.md)', '(hostil.md)'),
  );
  await expect(page.locator('.status-bar [data-key="editing"]')).toContainText('1 não gravado');
  // No "Diferenças" anywhere, no dialog of differences.
  await page.keyboard.press('Control+s');
  await expect(statusText(page)).toContainText('Gravado');
  await expect(page.getByRole('button', { name: /Diferenças|Ver diferenças/ })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await close();
});

test('nothing changed: the button is unavailable and says why; a conflict from another program turns the changes off and says why', async ({
  page,
}) => {
  const { root, close } = await begin(page, WINDOWS[0]);
  await page.locator('.inspector .edit-button').dblclick();
  await expect(page.locator('.editor-text')).toBeVisible();
  // A double click on Editar does not turn the changes on.
  await expect(page.locator('.editor-marks')).toHaveCount(0);
  await expect(marksButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(marksButton(page)).toHaveAttribute(
    'title',
    'Nada mudou ainda: digite ou grave antes',
  );
  // Typed, shown, then another program writes the file and a reading finds it.
  await page.locator('.editor-text').press('Control+End');
  await page.keyboard.type('meu texto');
  await marksButton(page).click();
  await expect(page.locator('.editor-marks')).toBeVisible();
  const file = join(root, 'AGENTS.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('# Aurora', '# Aurora (outro programa)'));
  await page.locator('.app-header .reread-button').click();
  await expect(statusText(page)).toContainText('Mudou no disco desde que você abriu');
  await expect(page.locator('.editor-marks')).toHaveCount(0);
  await expect(marksButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(marksButton(page)).toHaveAttribute('title', 'Resolva o conflito antes');
  await expect(page.locator('.editor-text')).toHaveValue(/meu texto$/);
  // The conflict dialog uses the same signs and colors.
  await status(page).getByRole('button', { name: 'Resolver…' }).click();
  const dialog = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
  expect(
    await dialog
      .locator('.diff-sign.added')
      .first()
      .evaluate((sign) => getComputedStyle(sign).color),
  ).toBe('rgb(111, 211, 131)');
  await page.keyboard.press('Escape');
  await close();
});

test('the first and the last line removed, and a change of trailing space only', async ({
  page,
}) => {
  const { close } = await begin(page, WINDOWS[0]);
  await page.locator('.inspector .edit-button').click();
  await expect(page.locator('.editor-text')).toBeVisible();
  const lines = COMPOSITION_AGENTS.split('\n');
  // Without the first and the last line of text, and a space at the end of line 3 of the file.
  const changed = [...lines.slice(1, -2), lines.at(-1)!];
  changed[1] = `${changed[1]} `;
  await page.locator('.editor-text').evaluate((area: HTMLTextAreaElement, value) => {
    area.focus();
    area.select();
    document.execCommand('insertText', false, value);
  }, changed.join('\n'));
  await marksButton(page).click();
  await still(page);
  const rows = await marked(page);
  // The first row is the removed first line, without number; numbering starts at 1 below it.
  expect(rows[0]).toMatchObject({ kind: 'removed', text: lines[0], line: undefined, sign: '−' });
  expect(rows[1]).toMatchObject({ kind: 'same', line: 1 });
  // The trailing space: the old line 3 and the new line 2, the space underlined.
  const space = rows.findIndex((row) => row.kind === 'removed' && row.text === lines[2]);
  expect(rows[space + 1]).toMatchObject({
    kind: 'added',
    line: 2,
    text: `${lines[2]} `,
    underlined: ' ',
  });
  // The last line of text removed, at the end, before the empty last line.
  const last = rows.findIndex((row) => row.text === lines.at(-2));
  expect(rows[last]).toMatchObject({ kind: 'removed', line: undefined });
  await expect(statusText(page)).toHaveText('Não gravado · +1 −3');
  expect(rows.filter((row) => row.sign === '+')).toHaveLength(1);
  expect(rows.filter((row) => row.sign === '−')).toHaveLength(3);
  // In the light theme, the light-theme colors.
  await page.keyboard.press('Escape');
  await runMoreAction(page, 'Ativar tema claro');
  await marksButton(page).click();
  await still(page);
  const light = await marked(page);
  expect(light.find((row) => row.sign === '+')!.signColor).toBe('rgb(11, 107, 30)');
  expect(light.find((row) => row.sign === '−')!.signColor).toBe('rgb(163, 54, 31)');
  await close();
});
