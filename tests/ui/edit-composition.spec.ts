// The composition of the editor, by geometry, in the
// large window (1536×960) and the small one (749×396). The editor takes the place of the read-only text:
// nothing above the text, no line of it, the inspector or the map moves when entering, saving or leaving.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSITION_AGENTS,
  begin,
  compositionProject,
  editProject,
  editorText,
  pickFile,
  still,
} from './edit-helpers';

const WINDOWS = [
  { width: 1536, height: 960 },
  { width: 749, height: 396 },
];
/** Tolerance of the positions of text; boxes of panels, buttons and regions are exact. */
const TEXT = 1;

type Box = { x: number; y: number; width: number; height: number };
type Geometry = {
  inspector: Box;
  map: string;
  center: Box | null;
  area: Box;
  scroll: number;
  observations: Box | null;
  row: Box | null;
  band: Box | null;
  status: Box | null;
  actions: { text: string; box: Box }[];
  /** The top of each line of the file in view (read-only rows; in the editor, through a mirror). */
  lines: Record<number, number>;
  /** The editor: its box, its scroll of its own, the top of its text and its padding. */
  editor: { box: Box; scrollHeight: number; clientHeight: number; textTop: number } | null;
};

const geometry = (page: Page) =>
  page.evaluate((): Geometry => {
    const box = (element: Element | null | undefined) => {
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const area = document.querySelector<HTMLElement>('.inspector-scroll')!;
    const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text');
    const lines: Record<number, number> = {};
    if (textarea) {
      // A copy of the textarea with the same letter and wrapping width, one block per line.
      const style = getComputedStyle(textarea);
      const mirror = document.createElement('div');
      for (const property of [
        'fontFamily',
        'fontSize',
        'fontWeight',
        'lineHeight',
        'letterSpacing',
        'wordSpacing',
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
      [...mirror.children].forEach(
        (line, index) => (lines[index + 1] = origin + line.getBoundingClientRect().top),
      );
      mirror.remove();
    } else
      for (const row of document.querySelectorAll<HTMLElement>(
        '.inspector .source-code > [data-line]',
      ))
        lines[Number(row.dataset.line)] = row.getBoundingClientRect().top;
    const motive = document.querySelector(
      '.file-observations [data-observation-key] .file-observation-row',
    );
    return {
      inspector: box(document.querySelector('.inspector'))!,
      map: document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '',
      center: box(document.querySelector('.react-flow')),
      area: box(area)!,
      scroll: area.scrollTop,
      observations: box(document.querySelector('.file-observations')),
      row: box(motive),
      band: box(document.querySelector('.inspector-scroll > .source-context')),
      status: box(document.querySelector('.editor-status')),
      actions: [...document.querySelectorAll('.inspector-identity .endpoint-actions > *')].map(
        (element) => ({ text: element.textContent ?? '', box: box(element)! }),
      ),
      lines,
      editor: textarea
        ? {
            box: box(textarea)!,
            scrollHeight: textarea.scrollHeight,
            clientHeight: textarea.clientHeight,
            textTop:
              textarea.getBoundingClientRect().top +
              parseFloat(getComputedStyle(textarea).paddingTop),
          }
        : null,
    };
  });

/** The lines in view of both readings that each has, compared top by top (±1 px). */
function sameLines(before: Geometry, after: Geometry, only?: number[]) {
  const shown = (geo: Geometry, line: number) =>
    geo.lines[line] !== undefined &&
    geo.lines[line] >= geo.area.y - 40 &&
    geo.lines[line] <= geo.area.y + geo.area.height;
  const lines = (only ?? Object.keys(before.lines).map(Number)).filter(
    (line) => shown(before, line) && after.lines[line] !== undefined,
  );
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines)
    expect(Math.abs(after.lines[line] - before.lines[line]), `line ${line}`).toBeLessThanOrEqual(
      TEXT,
    );
  return lines.length;
}

/** The height of text in view above the state line. */
const textInView = (geo: Geometry) => geo.status!.y - Math.max(geo.area.y, geo.editor!.textTop);

/** Measured values, written to test-results/. */
const measured: Record<string, unknown> = {};
const note = (key: string, value: unknown) => {
  measured[key] = value;
};
test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    join('test-results', 'edit-composition-measures.json'),
    `${JSON.stringify(measured, null, 1)}\n`,
  );
});

for (const size of WINDOWS) {
  const W = size.width;
  test.describe(`${W}×${size.height}`, () => {
    test(`entering by Editar: nothing moves; the boxes of A and B; the state line ${W}`, async ({
      page,
    }) => {
      const { close } = await begin(page, size);
      const before = await geometry(page);
      // A sampler of the area's scroll, frame by frame, to time the slide of the small window.
      await page.evaluate(() => {
        const area = document.querySelector<HTMLElement>('.inspector-scroll')!;
        const samples: [number, number][] = [];
        (window as unknown as { samples: typeof samples }).samples = samples;
        const start = performance.now();
        const step = (now: number) => {
          samples.push([now, area.scrollTop]);
          if (now - start < 2500) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      const after = await geometry(page);
      expect(after.inspector).toEqual(before.inspector);
      expect(after.center).toEqual(before.center);
      expect(after.map).toBe(before.map);
      note(`inspector-after-entering ${W}`, after.inspector);
      // Gravar in the box of A, Fechar editor in the box of B, Ver mudanças in the box
      // of Editar, unavailable while nothing changed.
      expect(after.actions.map((each) => each.text)).toEqual([
        'Gravar',
        'Fechar editor',
        'Ver mudanças',
      ]);
      await expect(page.locator('.inspector .edit-marks')).toHaveAttribute('aria-disabled', 'true');
      for (const index of [0, 1, 2])
        expect(after.actions[index].box).toEqual(before.actions[index].box);
      note(
        `action-boxes ${W}`,
        after.actions.map((each) => each.box),
      );
      expect(after.status!.height).toBe(28);
      expect(after.status!.y + 28).toBe(before.area.y + before.area.height);
      expect(after.status!.width).toBe(after.inspector.width);
      note(`state-line ${W}`, after.status);
      // The same letter, line height, first character and wrapping width.
      const metrics = await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
        const style = getComputedStyle(textarea);
        const inspector = document.querySelector('.inspector')!.getBoundingClientRect();
        return {
          font: `${style.fontSize} ${style.fontFamily}`,
          lineHeight: style.lineHeight,
          left:
            textarea.getBoundingClientRect().left + parseFloat(style.paddingLeft) - inspector.left,
          wrap:
            textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          inspector: inspector.width,
        };
      });
      expect(metrics.lineHeight).toBe('19.8px');
      expect(metrics.font.startsWith('11px')).toBe(true);
      expect(metrics.left).toBe(40);
      expect(metrics.wrap).toBeCloseTo(metrics.inspector - 52, 0);
      note(`metrics ${W}`, metrics);
      // No scroll of its own; the field reaches the state line.
      expect(after.editor!.scrollHeight).toBe(after.editor!.clientHeight);
      // No horizontal scroll in the inspector nor in the page.
      const wide = await page.evaluate(() => {
        const area = document.querySelector<HTMLElement>('.inspector-scroll')!;
        return {
          area: area.scrollWidth - area.clientWidth,
          page: document.documentElement.scrollWidth - innerWidth,
        };
      });
      expect(wide).toEqual({ area: 0, page: 0 });
      const samples = await page.evaluate(
        () => (window as unknown as { samples: [number, number][] }).samples,
      );
      if (W === 1536) {
        // The observations, the line of the observation and the 20 lines, 0 px.
        expect(after.observations).toEqual(before.observations);
        expect(after.row).toEqual(before.row);
        expect(after.scroll).toBe(before.scroll);
        expect(sameLines(before, after)).toBe(20);
        expect(after.editor!.box.y + after.editor!.box.height).toBeCloseTo(after.status!.y, 0);
        // The observation's line is in view: the state line names nothing.
        await expect(page.locator('.editor-status')).toHaveText('');
        expect(textInView(after)).toBeGreaterThanOrEqual(158.4);
        note(`observations-and-scroll ${W}`, {
          observations: after.observations,
          scroll: after.scroll,
        });
        note(`text-in-view ${W}`, textInView(after));
      } else {
        // Fewer than eight lines in view: the area slides in 180 ms (140 to 220) to 187 px, the
        // first line of text at the top of the area.
        const moved = samples.filter(([, scroll]) => scroll !== samples[0][1]);
        const first = samples.indexOf(moved[0]);
        const end = samples.findIndex(
          ([, scroll], index) => index >= first && scroll === after.scroll,
        );
        const duration = samples[end][0] - samples[first - 1][0];
        expect(after.scroll).toBeCloseTo(187, 0);
        expect(Math.abs(after.editor!.textTop - after.area.y)).toBeLessThanOrEqual(TEXT);
        expect(duration).toBeGreaterThanOrEqual(140);
        expect(duration).toBeLessThanOrEqual(220);
        note(`scroll-and-duration ${W}`, { scroll: after.scroll, duration: Math.round(duration) });
        // 8.4 lines in view.
        expect(textInView(after)).toBeCloseTo(167, 0);
        note(`text-in-view ${W}`, textInView(after));
        // Entering by Editar chooses no observation, so none is named even with the list out of view
        // (entering by a line number names one).
        await expect(page.locator('.editor-status')).toHaveText('');
      }
      await close();
    });

    test(`entering by the line number keeps the line; leaving keeps the scroll ${W}`, async ({
      page,
    }) => {
      const { close } = await begin(page, size);
      await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
      await still(page);
      const before = await geometry(page);
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      const editing = await geometry(page);
      // The line keeps its top; the 20 lines (two wrap), ±1 px.
      expect(Math.abs(editing.lines[7] - before.lines[7])).toBeLessThanOrEqual(TEXT);
      sameLines(before, editing);
      expect(editing.scroll).toBe(before.scroll);
      // What is above the text, exact: the observations and the band of the evidence.
      expect(editing.observations).toEqual(before.observations);
      expect(editing.band).toEqual(before.band);
      note(`entering-by-line ${W} 20 lines`, { before: before.lines[7], editor: editing.lines[7] });
      // The destination written is selected.
      expect(
        await editorText(page, 'AGENTS.md').evaluate((area: HTMLTextAreaElement) =>
          area.value.slice(area.selectionStart, area.selectionEnd),
        ),
      ).toBe('ausente.md');
      await page.locator('.edit-close').click();
      await expect(page.locator('.editor-text')).toHaveCount(0);
      const after = await geometry(page);
      // The scroll, the lines and the observations as they were; the line highlighted, the
      // focus on Editar.
      expect(after.scroll).toBe(before.scroll);
      expect(after.observations).toEqual(before.observations);
      sameLines(before, after);
      await expect(page.locator('.inspector .source-code .highlight-line')).toHaveAttribute(
        'data-line',
        '7',
      );
      await expect(page.locator('.inspector .edit-button')).toBeFocused();
      note(`leaving-scroll ${W} 20 lines`, { scroll: [before.scroll, after.scroll] });
      await close();
    });

    test(`a long file: line 4000 stays in place entering and leaving ${W}`, async ({ page }) => {
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
      const before = await geometry(page);
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      const editing = await geometry(page);
      expect(Math.abs(editing.lines[4000] - before.lines[4000])).toBeLessThanOrEqual(TEXT);
      // The lines around the highlighted one (some wrap).
      const around = Array.from({ length: 21 }, (_, index) => 3990 + index);
      sameLines(before, editing, around);
      await page.locator('.edit-close').click();
      await expect(page.locator('.editor-text')).toHaveCount(0);
      const after = await geometry(page);
      expect(Math.abs(after.lines[4000] - before.lines[4000])).toBeLessThanOrEqual(TEXT);
      note(`long-file ${W} 5000 lines`, {
        before: before.lines[4000],
        editor: editing.lines[4000],
        after: after.lines[4000],
      });
      await close();
    });

    test(`typing moves nothing above the cursor, and the cursor stays above the state line ${W}`, async ({
      page,
    }) => {
      const { close } = await begin(page, size);
      await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      const before = await geometry(page);
      await page.keyboard.press('End');
      await page.keyboard.type(' e mais um texto longo que faz a linha quebrar no inspetor');
      await page.keyboard.press('Enter');
      await page.keyboard.type('uma linha nova');
      await still(page);
      const after = await geometry(page);
      sameLines(before, after, [1, 2, 3, 4, 5, 6, 7]);
      expect(after.observations).toEqual(before.observations);
      // Down to the end of the file and beyond: the line of the cursor never goes under the state line.
      for (let index = 0; index < 30; index++) await page.keyboard.press('Enter');
      await page.keyboard.type('fim');
      await still(page);
      const end = await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('.editor-text')!;
        const lines = textarea.value.slice(0, textarea.selectionStart).split('\n').length;
        const style = getComputedStyle(textarea);
        const top =
          textarea.getBoundingClientRect().top +
          parseFloat(style.paddingTop) +
          (lines - 1) * parseFloat(style.lineHeight);
        return {
          bottom: top + parseFloat(style.lineHeight),
          status: document.querySelector('.editor-status')!.getBoundingClientRect().top,
        };
      });
      expect(end.bottom).toBeLessThanOrEqual(end.status + TEXT);
      note(`typing ${W}`, end);
      await close();
    });

    test(`a double click on Editar or Fechar editor ${W}`, async ({ page }) => {
      const { close } = await begin(page, size);
      await page.locator('.inspector .edit-button').dblclick();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      await expect(page.locator('.editor-text')).toBeVisible();
      await page.locator('.edit-close').dblclick();
      await expect(page.locator('.editor-text')).toHaveCount(0);
      // Neither A nor B was set: the Path tool did not open.
      await expect(page.getByPlaceholder('Destino: caminho do arquivo')).toHaveCount(0);
      await expect(page.locator('.inspector .edit-button')).toBeVisible();
      await close();
    });

    test(`saving, nothing new, a refusal and undo move nothing ${W}`, async ({ page }) => {
      const { root, close } = await begin(page, size);
      await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      const before = await geometry(page);
      const same = async (label: string, base = before) => {
        await still(page);
        const now = await geometry(page);
        expect(now.observations, label).toEqual(base.observations);
        expect(now.band, label).toEqual(base.band);
        expect(now.status, label).toEqual(base.status);
        expect(
          now.actions.map((each) => each.box),
          label,
        ).toEqual(base.actions.map((each) => each.box));
        expect(now.scroll, label).toBe(base.scroll);
        sameLines(base, now);
        return now;
      };
      // The destination is selected: typing replaces it; the save waits, to measure "Saving…".
      await page.keyboard.type('hostil.md');
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/api/edit/save', async (route) => {
        await held;
        await route.continue();
      });
      await page.keyboard.press('Control+s');
      await expect(page.locator('.editor-status')).toHaveText('Gravando…');
      await same('saving');
      release();
      await expect(page.locator('.editor-status')).toContainText('Gravado · +1 −1 · L7 resolvida');
      await page.unroute('**/api/edit/save');
      const saved = await same('saved');
      // The observation stays in its line, marked resolved; the region keeps its height.
      await expect(page.locator('.file-observation-resolved')).toHaveText('resolvida');
      expect(saved.row).toEqual(before.row);
      note(`save-outcome ${W}`, {
        observations: saved.observations,
        row: saved.row,
        scroll: saved.scroll,
      });
      await page.keyboard.press('Control+s');
      await expect(page.locator('.editor-status')).toContainText('Nada novo a gravar');
      await same('nothing new');
      // Undo (nothing typed since the save: no question).
      await page.locator('.editor-status').getByRole('button', { name: 'Desfazer' }).click();
      await expect(page.locator('.editor-status')).toContainText('Gravação desfeita');
      await expect(page.locator('.file-observation-resolved')).toHaveCount(0);
      await same('undo');
      await page.keyboard.type(' ');
      await page.route('**/api/edit/save', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'read-only', code: 'read-only-file' }),
        }),
      );
      await page.keyboard.press('Control+s');
      await expect(page.locator('.editor-status')).toContainText('Sem permissão de escrita');
      await same('refusal');
      await page.unroute('**/api/edit/save');
      await page.keyboard.press('Backspace');
      // A save that creates an observation: the region keeps its height; "1 nova" in the state
      // line, "atualizar lista" in the summary.
      // Typing at the end of the file brings the end into view (a gesture): measured from there.
      await editorText(page, 'AGENTS.md').press('Control+End');
      await page.keyboard.type('[Outro](outro-ausente.md)\n');
      await still(page);
      const typed = await geometry(page);
      await page.keyboard.press('Control+s');
      await expect(page.locator('.editor-status')).toContainText('1 nova');
      const added = await same('new observation', typed);
      await expect(page.locator('.observations-refresh')).toHaveText('atualizar lista');
      note(`observations-after-save ${W}`, added.observations);
      // "atualizar lista" is a gesture in the region: now it may change (the new one comes in).
      await page.locator('.observations-refresh').click();
      await expect(page.locator('.file-observations')).toContainText('outro-ausente.md');
      await expect(page.locator('.observations-refresh')).toHaveCount(0);
      void root;
      await close();
    });

    test(`the state line is never cut, in every state and both languages ${W}`, async ({
      page,
    }) => {
      test.setTimeout(180000);
      // Changing the language reloads the page; the text is saved by then.
      page.on('dialog', (dialog) => void dialog.accept());
      const { root, close } = await begin(page, size);
      const widths: Record<string, number> = {};
      const whole = async (label: string, actions: string[]) => {
        const line = page.locator('.editor-status');
        await expect(line).toBeVisible();
        const fit = await line.evaluate((element) => {
          const parts = [
            element,
            ...element.querySelectorAll('.editor-status-text, .editor-status-actions, button'),
          ];
          const style = getComputedStyle(element);
          const text = element.querySelector('.editor-status-text')!.getBoundingClientRect();
          const end = element.querySelector('.editor-status-actions')!.getBoundingClientRect();
          return {
            cut: parts.filter((part) => part.scrollWidth > part.clientWidth + 0.5).length,
            ellipsis: parts.some((part) => getComputedStyle(part).textOverflow === 'ellipsis'),
            // The sentence and the actions as wide as their content, with the gap between them.
            used: text.width + (end.width ? parseFloat(style.columnGap) + end.width : 0),
            room:
              element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            box: element.getBoundingClientRect().toJSON(),
          };
        });
        expect(fit.cut, label).toBe(0);
        expect(fit.ellipsis, label).toBe(false);
        expect(fit.used, label).toBeLessThanOrEqual(fit.room + 0.5);
        if (W === 749) expect(fit.used, label).toBeLessThanOrEqual(304);
        expect(fit.box.height, label).toBe(28);
        widths[label] = Math.round(fit.used);
        // The actions of the sentence are in view, not in the "…" menu.
        for (const name of actions)
          await expect(line.getByRole('button', { name, exact: true }), label).toBeVisible();
      };
      const save = async () => {
        await page.locator('.editor-text').press('Control+End');
        await page.keyboard.type('x');
        await page.keyboard.press('Control+s');
      };
      for (const language of ['pt', 'en'] as const) {
        // The language is read when the window loads; the selection is of the window.
        await page.evaluate((value) => localStorage.setItem('aae-lang', value), language);
        await page.reload();
        await pickFile(page, `${root}/AGENTS.md`);
        await still(page);
        await page.locator('.inspector .edit-button').click();
        await expect(page.locator('.editor-text')).toBeVisible();
        const pt = language === 'pt';
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        await page.route('**/api/edit/save', async (route) => {
          await held;
          await route.continue();
        });
        await save();
        await expect(page.locator('.editor-status')).toHaveText(pt ? 'Gravando…' : 'Saving…');
        await whole(`${language} saving`, []);
        release();
        await expect(page.locator('.editor-status')).toContainText(pt ? 'Gravado' : 'Saved');
        await page.unroute('**/api/edit/save');
        await whole(`${language} saved`, [pt ? 'Desfazer' : 'Undo']);
        await page.keyboard.press('Control+s');
        await expect(page.locator('.editor-status')).toContainText(
          pt ? 'Nada novo a gravar' : 'Nothing new to save',
        );
        await whole(`${language} nothing new`, [pt ? 'Desfazer' : 'Undo']);
        await page
          .locator('.editor-status')
          .getByRole('button', { name: pt ? 'Desfazer' : 'Undo' })
          .click();
        await expect(page.locator('.editor-status')).toContainText(
          pt ? 'Gravação desfeita' : 'Save undone',
        );
        await whole(`${language} undone`, []);
        // Each refusal of the server, by its code.
        for (const code of [
          'session',
          'not-in-workspace',
          'app-state',
          'protected',
          'not-editable-type',
          'not-regular',
          'hardlink',
          'other-owner',
          'other-group',
          'read-only-file',
          'binary',
          'not-utf8',
          'mixed-eol',
          'invalid-text',
          'too-large',
          'folder-changed',
          'write-failed',
          'unknown-code',
          'edit-not-granted',
          'missing',
        ]) {
          await page.route('**/api/edit/save', (route) =>
            route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ error: `The server's own long sentence for ${code}.`, code }),
            }),
          );
          await save();
          await expect(
            page.locator('.editor-status .editor-status-tone.tone-problem'),
          ).toBeVisible();
          const action =
            code === 'edit-not-granted'
              ? pt
                ? 'Permitir e gravar'
                : 'Allow and save'
              : ['not-in-workspace', 'not-regular', 'folder-changed'].includes(code)
                ? pt
                  ? 'Reler'
                  : 'Rescan'
                : pt
                  ? 'Copiar'
                  : 'Copy';
          await whole(`${language} refusal ${code}`, [action]);
          await page.unroute('**/api/edit/save');
        }
        // No answer; then, with the server back, "Try again" finds the disk without the text.
        await page.route('**/api/edit/**', (route) => route.abort());
        await save();
        await expect(page.locator('.editor-status')).toContainText(
          pt ? 'Sem resposta do servidor' : 'No answer from the server',
        );
        await whole(`${language} no answer`, pt ? ['Tentar de novo'] : ['Try again']);
        await page.unroute('**/api/edit/**');
        await page
          .locator('.editor-status')
          .getByRole('button', { name: pt ? 'Tentar de novo' : 'Try again' })
          .click();
        await expect(page.locator('.editor-status')).toContainText(
          pt ? 'Não gravado; o disco não mudou' : 'Not saved; the disk did not change',
        );
        await whole(`${language} not saved`, [pt ? 'Gravar' : 'Save']);
        // A save that goes through, then the conflict: another program changes the file.
        await page.keyboard.press('Control+s');
        await expect(page.locator('.editor-status')).toContainText(pt ? 'Gravado' : 'Saved');
        const path = await page.locator('.inspector .copy-path code').textContent();
        writeFileSync(path!, `${readFileSync(path!, 'utf8')}de outro programa\n`);
        await save();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await whole(`${language} conflict`, [pt ? 'Resolver…' : 'Resolve…']);
        await page
          .locator('.editor-status')
          .getByRole('button', { name: pt ? 'Resolver…' : 'Resolve…' })
          .click();
        await dialog
          .getByRole('button', { name: pt ? 'Descartar meu texto' : 'Discard my text' })
          .click();
        // A stale reading: the next reading of the disk takes more than a second.
        await page.route('**/api/refresh', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          await route.continue();
        });
        await save();
        await expect(page.locator('.editor-status')).toContainText(pt ? 'Gravado' : 'Saved');
        await expect(page.locator('.editor-status')).not.toContainText(
          pt ? 'relendo' : 'rescanning the',
        );
        await save();
        await expect(page.locator('.editor-status')).toContainText(
          pt ? 'leitura desatualizada' : 'stale scan',
        );
        await page.unroute('**/api/refresh');
        await whole(`${language} stale`, [pt ? 'Desfazer' : 'Undo']);
      }
      note(`state-line-widths ${W}`, widths);
      await close();
    });

    test(`the observation named in the state line brings the list into view ${W}`, async ({
      page,
    }) => {
      // Long enough to scroll in the large window too.
      const more = Array.from({ length: 40 }, (_, index) => `Mais uma linha ${index + 1}.`).join(
        '\n',
      );
      const root = compositionProject({ 'AGENTS.md': `${COMPOSITION_AGENTS}${more}\n` });
      const { close } = await begin(page, size, { root });
      // The observation chosen by its line number (entering by Editar names none).
      await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await still(page);
      // Out of view: scrolled down.
      await page
        .locator('.inspector-scroll')
        .evaluate((area) => (area.scrollTop = area.scrollHeight));
      await still(page);
      const named = page.locator('.editor-status').getByRole('button', { name: /L7 ausente\.md/ });
      await expect(named).toBeVisible();
      await named.click();
      await still(page);
      const geo = await geometry(page);
      expect(geo.row!.y).toBeGreaterThanOrEqual(geo.area.y - 0.5);
      expect(geo.row!.y + geo.row!.height).toBeLessThanOrEqual(geo.area.y + geo.area.height + 0.5);
      // In view, it is no longer named.
      await expect(named).toHaveCount(0);
      note(`observation-row ${W}`, { row: geo.row, area: geo.area });
      await close();
    });

    test(`the conflict is a dialog in the window ${W}`, async ({ page }) => {
      const { root, close } = await begin(page, size);
      await page.getByRole('button', { name: 'Ir para a linha 7' }).click();
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await page.keyboard.type('hostil.md');
      await page.keyboard.press('Control+s');
      await expect(page.locator('.editor-status')).toContainText('Gravado');
      await still(page);
      const inside = async (locator: Locator) =>
        locator.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= innerHeight &&
            rect.right <= innerWidth
          );
        });
      // A conflict found by a reading (Reler) only changes the state line.
      const file = join(root, 'AGENTS.md');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace('# Aurora', '# Aurora (outro programa)'),
      );
      await page.locator('.app-header .reread-button').click();
      await expect(page.locator('.editor-status')).toContainText(
        'Mudou no disco desde que você abriu',
      );
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // Gravar with the conflict: the wide dialog, its four ways out in the window.
      await editorText(page, 'AGENTS.md').press('Control+End');
      await page.keyboard.type('meu texto\n');
      await page.locator('.inspector .edit-save').click();
      const conflict = page.getByRole('dialog', { name: 'O arquivo mudou no disco' });
      await expect(conflict).toBeVisible();
      await still(page);
      await expect(conflict.getByRole('button', { name: 'Decidir depois' })).toBeFocused();
      for (const name of [
        'Copiar meu texto',
        'Decidir depois',
        'Descartar meu texto',
        'Manter meu texto',
      ])
        expect(await inside(conflict.getByRole('button', { name, exact: true })), name).toBe(true);
      const lists = await conflict
        .locator('.conflict-body > section')
        .evaluateAll((sections) =>
          sections.map((section) => section.getBoundingClientRect().toJSON()),
        );
      expect(lists).toHaveLength(2);
      if (W === 1536) {
        expect(lists[0].top).toBe(lists[1].top);
        expect(lists[0].right).toBeLessThan(lists[1].left);
      }
      // One element in brick red in the whole window: Descartar meu texto.
      const red = await page.evaluate(() => {
        const discard = [...document.querySelectorAll('button')].find(
          (button) => button.textContent === 'Descartar meu texto',
        )!;
        const color = getComputedStyle(discard).backgroundColor;
        return [...document.querySelectorAll('*')]
          .filter((element) => getComputedStyle(element).backgroundColor === color)
          .map((element) => element.textContent);
      });
      expect(red).toEqual(['Descartar meu texto']);
      // Esc does what Decidir depois does: the dialog closes, the conflict stays in the state line.
      await page.keyboard.press('Escape');
      await expect(conflict).toHaveCount(0);
      await expect(page.locator('.editor-status')).toContainText(
        'Mudou no disco desde que você abriu',
      );
      // Resolver… opens it again.
      await page.locator('.editor-status').getByRole('button', { name: 'Resolver…' }).click();
      await expect(conflict).toBeVisible();
      await conflict.getByRole('button', { name: 'Manter meu texto' }).click();
      await expect(conflict).toHaveCount(0);
      note(`conflict-lists ${W}`, { lists });
      await close();
    });

    test(`no box with a colored side border, no pill nor badge while editing ${W}`, async ({
      page,
    }) => {
      const { close } = await begin(page, size);
      await page.locator('.inspector .edit-button').click();
      await expect(page.locator('.editor-text')).toBeVisible();
      await page.keyboard.type('x');
      await page.keyboard.press('Control+s');
      await expect(page.locator('.editor-status')).toContainText('Gravado');
      const shapes = await page.evaluate(() => {
        const found: string[] = [];
        for (const element of document.querySelectorAll<HTMLElement>('.inspector *')) {
          const style = getComputedStyle(element);
          const side = parseFloat(style.borderLeftWidth);
          if (side >= 2 && side > parseFloat(style.borderTopWidth))
            found.push(`side border: ${element.className}`);
          const radius = parseFloat(style.borderTopLeftRadius);
          const rect = element.getBoundingClientRect();
          const filled = !/rgba\(.*, 0\)$|transparent/.test(style.backgroundColor);
          if (filled && rect.height > 0 && radius >= rect.height / 2 && element.textContent)
            found.push(`pill: ${element.className}`);
        }
        const targets = [...document.querySelectorAll<HTMLElement>('.editor-status button')].map(
          (button) => ({
            height: button.getBoundingClientRect().height,
            underline: getComputedStyle(button).textDecorationLine,
          }),
        );
        return { found, targets };
      });
      expect(shapes.found).toEqual([]);
      for (const target of shapes.targets) {
        expect(target.height).toBe(24);
        expect(target.underline).toBe('underline');
      }
      await close();
    });
  });
}
