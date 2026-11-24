// Composition of the map screen, measured by geometry: a header line in the place of the controls that
// were drawn over the map, "Abrir inspetor" as a link inside the selected card, and the explorer
// button of the top bar, in 1536×960 and 749×396 and in both themes; then
// the negatives (a partial reading, a filter with Convenções, two views, a view minimized and restored, a
// manual zoom followed by another selection).
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOnly, writeTree } from './helpers';

const SIZES = [
  { width: 1536, height: 960 },
  { width: 749, height: 396 },
] as const;
const THEMES = ['dark', 'light'] as const;

/** A project whose entry references ten files: its map is taller than a small view. */
function project(name = 'exemplo') {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-map-composition-')), name);
  const notes = Array.from({ length: 8 }, (_, index) => `docs/nota-${index + 1}.md`);
  writeTree(root, {
    'AGENTS.md': `# ${name}\n${notes.map((note) => `[${note}](${note})`).join('\n')}\n[Guia](guia.md)\n[Ausente](ausente.md)\n[Memória](memory/MEMORY.md)\n`,
    'guia.md': '# Guia\n[Volta](AGENTS.md)\n[Nota](docs/nota-1.md)\n',
    'memory/MEMORY.md': '# Memória\n',
    ...Object.fromEntries(notes.map((note) => [note, `# ${note}\n`])),
  });
  return root;
}

const tile = (scope: Page | Locator, path: string) =>
  scope.locator('.react-flow__node-file', { has: scope.locator(`strong[title="${path}"]`) });
const head = (scope: Page | Locator) => scope.locator('.map-head');
const location = (page: Page) => page.locator('.breadcrumbs [aria-current="location"]');

/** Opens `roots` with the theme and the panels given, at the size given. */
async function open(
  page: Page,
  roots: string[],
  size: { width: number; height: number },
  theme: 'dark' | 'light' = 'dark',
  inspector = false,
) {
  await page.setViewportSize(size);
  await page.addInitScript(
    ({ theme, inspector }) => {
      localStorage.setItem('aae-theme', theme);
      if (!localStorage.getItem('aae-layout'))
        localStorage.setItem('aae-layout', JSON.stringify({ inspector, bottom: false }));
    },
    { theme, inspector },
  );
  await openOnly(page, roots);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * Shows or hides the explorer by its button in the top bar. Right after a change of window size the
 * layout may still switch between desktop and compact (which starts with no side panel): try again.
 */
async function explorer(page: Page, shown: boolean) {
  const button = page.getByRole('button', { name: 'Explorador', exact: true });
  await expect(async () => {
    if ((await button.getAttribute('aria-pressed')) !== String(shown)) await button.click();
    await expect(button).toHaveAttribute('aria-pressed', String(shown), { timeout: 1000 });
  }).toPass();
  // Settled: the explorer slides in from the left edge (180 ms) and out to it.
  if (shown)
    await expect.poll(async () => (await page.locator('.explorer').boundingBox())?.x).toBe(0);
  else await expect(page.locator('.explorer')).toBeHidden();
}

/** The map of `file`: chosen in the tree (a file opens on its map), the explorer left as it was. */
async function fileMap(page: Page, file: string) {
  const before = await page.locator('.explorer').isVisible();
  await explorer(page, true);
  await page.locator(`.tree-item[title="${file}"]`).click();
  await expect(location(page)).toHaveText(file.split('/').at(-1)!);
  await expect(page.locator('.file-tile.focused strong')).toHaveAttribute('title', file);
  await explorer(page, before && page.viewportSize()!.width > 1023);
}

/** The map of the folder `root` (its Estrutura first, then Mapa by the switch of the top bar). */
async function folderMap(page: Page, root: string) {
  const name = root.split('/').at(-1)!;
  const before = await page.locator('.explorer').isVisible();
  await explorer(page, true);
  await page.getByRole('button', { name: `Voltar ao diretório ${name}`, exact: true }).click();
  await explorer(page, before && page.viewportSize()!.width > 1023);
  await page.getByRole('button', { name: `Mapa de ${name}`, exact: true }).click();
  await expect(page.locator('.folder-map')).toBeVisible();
}

/**
 * In the page: each element with text or a control drawn over the area of a map on the screen, with
 * what it covers of the area and of the cards (px²). Out of the count: the cards, the arrows and their
 * labels, the credit of the library, what is not painted (a closed menu, a view minimized) and what is
 * only read by a screen reader (1 px).
 */
const overMaps = (page: Page) =>
  page.evaluate(() => {
    // What of an element is seen: its box cut by every ancestor that clips its content.
    const seen = (element: Element) => {
      let rect = element.getBoundingClientRect();
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = parent.getBoundingClientRect();
        const left = style.overflowX === 'visible' ? rect.left : Math.max(rect.left, clip.left),
          right = style.overflowX === 'visible' ? rect.right : Math.min(rect.right, clip.right),
          top = style.overflowY === 'visible' ? rect.top : Math.max(rect.top, clip.top),
          bottom = style.overflowY === 'visible' ? rect.bottom : Math.min(rect.bottom, clip.bottom);
        rect = DOMRect.fromRect({
          x: left,
          y: top,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        });
      }
      return rect;
    };
    const painted = (element: Element) => {
      const rect = seen(element);
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) > 0 &&
        !element.closest('details:not([open]) > :not(summary)') &&
        !element.closest('[data-minimized="true"], [hidden]')
      );
    };
    const meaningful = (element: Element) =>
      element.matches('button, summary, a[href], input, select, textarea, [role=button]') ||
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
      );
    const overlap = (a: DOMRect, b: DOMRect) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const found: string[] = [];
    const elements = [...document.querySelectorAll('body *')];
    for (const map of document.querySelectorAll('.react-flow')) {
      if (!painted(map)) continue;
      const area = map.getBoundingClientRect();
      // A card is seen only inside the area of its map (the map clips the rest).
      const cards = [...map.querySelectorAll('.react-flow__node')].map((card) => {
        const rect = card.getBoundingClientRect();
        return DOMRect.fromRect({
          x: Math.max(rect.left, area.left),
          y: Math.max(rect.top, area.top),
          width: Math.max(0, Math.min(rect.right, area.right) - Math.max(rect.left, area.left)),
          height: Math.max(0, Math.min(rect.bottom, area.bottom) - Math.max(rect.top, area.top)),
        });
      });
      for (const element of elements) {
        if (
          element.closest(
            '.react-flow__node, .react-flow__edges, .react-flow__edge, .react-flow__edgelabel-renderer, .react-flow__attribution',
          ) ||
          !meaningful(element) ||
          !painted(element)
        )
          continue;
        const rect = seen(element);
        const onMap = overlap(rect, area),
          onCards = cards.reduce((sum, card) => sum + overlap(rect, card), 0);
        if (onMap > 0 || onCards > 0)
          found.push(
            `${(element.getAttribute('aria-label') || element.textContent || element.tagName).trim().slice(0, 50)}: ${Math.round(onMap)} px² over the map, ${Math.round(onCards)} over cards`,
          );
      }
    }
    return found;
  });

/**
 * In the page: each header line on the screen is one line of its height, every control and text
 * it shows lies inside it, no text but the name of the map is cut, and the name, when cut, is whole in
 * its tooltip. Returns the problems found.
 */
const headerProblems = (page: Page, height: number) =>
  page.evaluate((height) => {
    const problems: string[] = [];
    for (const line of document.querySelectorAll<HTMLElement>('.map-head')) {
      if (line.closest('[data-minimized="true"]')) continue;
      const box = line.getBoundingClientRect();
      if (Math.abs(box.height - height) > 0.5) problems.push(`height ${box.height}`);
      // The order of giving way: the counts, the selection and the level leave before the name is cut;
      // the name shrinks to 14em before "Enquadrar" leaves.
      const text = line.querySelector<HTMLElement>('.map-head-text')!;
      const on = (key: string) => !!line.querySelector(`[data-key="${key}"]:not([data-hidden])`);
      if (text.scrollWidth > text.clientWidth + 1)
        for (const key of ['count', 'focus', 'level'])
          if (on(key)) problems.push(`name cut with ${key} on the line`);
      // "Enquadrar" leaves only when the name at 14em would still leave no room for it.
      const em = parseFloat(getComputedStyle(line).fontSize);
      const fit = line.querySelector('[data-key="fit"][data-hidden]');
      const gap = parseFloat(getComputedStyle(line).columnGap);
      if (fit && text.clientWidth - 14 * em >= fit.getBoundingClientRect().width + gap + 1)
        problems.push('Enquadrar left before the name gave way');
      for (const element of line.querySelectorAll<HTMLElement>('*')) {
        if (element.closest('[data-hidden], .visually-hidden, details:not([open]) > :not(summary)'))
          continue;
        if (element.closest('details[open] > div')) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const name = (element.getAttribute('aria-label') || element.textContent || '').trim();
        if (
          rect.top < box.top - 0.5 ||
          rect.bottom > box.bottom + 0.5 ||
          rect.left < box.left - 0.5 ||
          rect.right > box.right + 0.5
        )
          problems.push(`outside the line: ${name}`);
        if (
          element.scrollWidth > element.clientWidth + 1 &&
          getComputedStyle(element).overflow !== 'visible'
        ) {
          const label = element.closest<HTMLElement>('.map-head-label');
          if (!element.classList.contains('map-head-text') || label?.title !== element.textContent)
            problems.push(`cut: ${name}`);
        }
      }
    }
    return problems;
  }, height);

/** The "…" of each header line lists exactly what left the line. */
async function leftInTheMenu(page: Page) {
  for (const line of await head(page).all()) {
    if (!(await line.isVisible())) continue;
    const gone = () => line.locator('[data-hidden]:not(.map-more)').count();
    const more = line.getByRole('button', { name: 'Mais controles do mapa', exact: true });
    if (!(await gone())) {
      await expect(more).toBeHidden();
      continue;
    }
    await more.click();
    const menu = page.getByRole('menu', { name: 'Mais controles do mapa' });
    await expect
      .poll(async () => (await menu.getByRole('menuitem').count()) - (await gone()))
      .toBe(0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
}

/** Waits for a side panel to end sliding in (the line of the map measures the room it leaves). */
const settled = (panel: Locator) =>
  expect.poll(() => panel.evaluate((element) => element.getAnimations().length)).toBe(0);

test('nothing with text or a button lies over a map, and the header line holds in one line', async ({
  page,
}) => {
  const root = project();
  for (const size of SIZES)
    for (const theme of THEMES) {
      await test.step(`${size.width}×${size.height} ${theme}`, async () => {
        await open(page, [root], size, theme);
        const line = size.height <= 550 ? 25 : 31;
        // The map of a file, inspector closed, then open.
        await fileMap(page, join(root, 'AGENTS.md'));
        await expect.poll(() => overMaps(page)).toEqual([]);
        await expect.poll(() => headerProblems(page, line)).toEqual([]);
        await tile(page, join(root, 'AGENTS.md')).click();
        await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
        await settled(page.locator('.inspector'));
        await expect.poll(() => overMaps(page)).toEqual([]);
        await expect.poll(() => headerProblems(page, line)).toEqual([]);
        await leftInTheMenu(page);
        await page.getByRole('button', { name: 'Fechar inspetor' }).click();
        await expect(page.locator('.inspector')).toHaveCount(0);
        // The map of a folder.
        await folderMap(page, root);
        await expect.poll(() => overMaps(page)).toEqual([]);
        await expect.poll(() => headerProblems(page, line)).toEqual([]);
        // The view of the path.
        await page.getByRole('button', { name: 'Caminho', exact: true }).click();
        await page.getByLabel('Arquivo de origem A').fill(join(root, 'guia.md'));
        await page.getByLabel('Arquivo de destino B').fill(join(root, 'docs/nota-2.md'));
        await page.getByRole('button', { name: 'Traçar', exact: true }).click();
        await expect(page.locator('.trace-summary')).toContainText('Caminho encontrado');
        await expect(page.locator('.trace-pane .map-head')).toBeVisible();
        await expect.poll(() => overMaps(page)).toEqual([]);
        await expect.poll(() => headerProblems(page, line)).toEqual([]);
        await page.locator('.trace-clear').click();
        await page.getByRole('button', { name: 'Caminho', exact: true }).click();
        await page.screenshot({
          path: test.info().outputPath(`folder-map-${size.width}-${theme}.png`),
        });
      });
    }
});

test('the header line of the map has the place and the height of the header of the Estrutura', async ({
  page,
}) => {
  const root = project();
  const name = root.split('/').at(-1)!;
  const toggle = (page: Page, mode: 'Estrutura' | 'Mapa') =>
    page.getByRole('button', { name: `${mode} de ${name}`, exact: true }).click();
  /** The header line and the region it heads (the line included), as each mode draws them. */
  const boxes = async (page: Page, mode: 'Estrutura' | 'Mapa') => {
    await toggle(page, mode);
    const [line, region] =
      mode === 'Estrutura'
        ? ['.structure-columns', '.structure-view']
        : ['.map-head', '.canvas-wrap'];
    await expect(page.locator(line)).toBeVisible();
    return {
      line: (await page.locator(line).boundingBox())!,
      region: (await page.locator(region).boundingBox())!,
    };
  };
  const same = (
    a: { x: number; y: number; width: number; height: number },
    b: typeof a,
    what: string,
  ) => {
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(a[key] - b[key]), `${what} ${key}`).toBeLessThanOrEqual(0.5);
  };
  for (const size of SIZES)
    for (const theme of THEMES) {
      await test.step(`${size.width}×${size.height} ${theme}`, async () => {
        await open(page, [root], size, theme);
        // A folder, then a file: Estrutura and Mapa put their line at the same place and height, and
        // what is under the line starts and ends at the same place.
        await folderMap(page, root);
        for (const file of [null, join(root, 'guia.md')]) {
          if (file) await fileMap(page, file);
          const structure = await boxes(page, 'Estrutura');
          const map = await boxes(page, 'Mapa');
          same(map.line, structure.line, 'line');
          same(map.region, structure.region, 'region');
          expect(map.line.height).toBe(size.height <= 550 ? 25 : 31);
          const area = (await page.locator('.map-area').boundingBox())!;
          expect(Math.abs(area.y - (map.line.y + map.line.height))).toBeLessThanOrEqual(0.5);
        }
      });
    }
});

test('legend, zoom, Enquadrar, Focar seleção and the out-of-view warning are in the line, work, and are reached by Tab in their order', async ({
  page,
}) => {
  const root = project();
  await open(page, [root], SIZES[0]);
  await fileMap(page, join(root, 'AGENTS.md'));
  const line = head(page);
  const percent = async () => parseInt((await line.locator('.map-zoom-level').textContent())!);
  const viewport = () =>
    page
      .locator('.react-flow__viewport')
      .evaluate((element) =>
        Math.round(new DOMMatrix(getComputedStyle(element).transform).a * 100),
      );
  // The zoom said in the line is the zoom of the map.
  await expect.poll(async () => (await percent()) === (await viewport())).toBe(true);
  // Tab goes through the controls in the order they appear.
  const names: string[] = [];
  await line.locator('.canvas-legend summary').focus();
  for (let index = 0; index < 5; index++) {
    names.push(
      await page.evaluate(() => {
        const element = document.activeElement!;
        return (element.getAttribute('aria-label') || element.textContent || '').trim();
      }),
    );
    await page.keyboard.press('Tab');
  }
  expect(names).toEqual([
    'Legenda do mapa',
    'Afastar mapa',
    'Aproximar mapa',
    'Enquadrar mapa',
    'Focar seleção',
  ]);
  const order = await line
    .locator('summary, button:visible')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // The legend opens under its button and closes again.
  await line.locator('.canvas-legend summary').click();
  await expect(line.locator('.canvas-legend > div > span')).toContainText([
    'Instruções',
    'Memória',
    'Skill',
    'Manifesto',
    '→ Direção da referência',
  ]);
  await line.locator('.canvas-legend summary').click();
  await expect(line.locator('.canvas-legend > div')).toBeHidden();
  // Zoom in and out.
  const start = await percent();
  await line.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
  await expect.poll(percent).toBeGreaterThan(start);
  await expect.poll(async () => (await percent()) === (await viewport())).toBe(true);
  const closer = await percent();
  await line.getByRole('button', { name: 'Afastar mapa', exact: true }).click();
  await expect.poll(percent).toBeLessThan(closer);
  // Closer, part of the map leaves the view: "Enquadrar" says it, in the colour of a link.
  for (let index = 0; index < 3; index++)
    await line.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
  const fit = line.getByRole('button', { name: 'Enquadrar mapa', exact: true });
  await expect(fit).toHaveClass(/canvas-offscreen/);
  await expect(fit).toHaveAccessibleDescription('Parte do mapa fora da vista');
  expect(
    await fit.locator('span').evaluate((element) => getComputedStyle(element).textDecorationLine),
  ).toContain('underline');
  await fit.click();
  await expect(fit).not.toHaveClass(/canvas-offscreen/);
  const area = (await page.locator('.map-area').boundingBox())!;
  await expect
    .poll(async () =>
      (
        await page
          .locator('.react-flow__node-file')
          .evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().toJSON()),
          )
      ).every(
        (rect) =>
          rect.top >= area.y - 1 &&
          rect.bottom <= area.y + area.height + 1 &&
          rect.left >= area.x - 1 &&
          rect.right <= area.x + area.width + 1,
      ),
    )
    .toBe(true);
  // Focar seleção frames the selection again, larger.
  const fitted = await percent();
  await line.getByRole('button', { name: 'Focar seleção', exact: true }).click();
  await expect.poll(percent).toBeGreaterThan(fitted);
  await expect(tile(page, join(root, 'AGENTS.md'))).toBeInViewport({ ratio: 1 });
});

test('"Abrir inspetor" is a link inside the footer of the selected card, nothing hangs out of the card', async ({
  page,
}) => {
  const root = project();
  for (const size of SIZES)
    for (const theme of THEMES) {
      await test.step(`${size.width}×${size.height} ${theme}`, async () => {
        await open(page, [root], size, theme);
        await fileMap(page, join(root, 'AGENTS.md'));
        const card = tile(page, join(root, 'AGENTS.md'));
        const link = card.locator('.tile-inspect');
        await expect(link).toHaveText('Abrir inspetor');
        await expect(page.locator('.tile-inspect')).toHaveCount(1);
        const geometry = () =>
          card.evaluate((node) => {
            const box = node.querySelector('.file-tile')!.getBoundingClientRect();
            const foot = node.querySelector('.tile-foot')!.getBoundingClientRect();
            const link = node.querySelector('.tile-inspect')!.getBoundingClientRect();
            const zoom = box.width / (node.querySelector('.file-tile') as HTMLElement).offsetWidth;
            const outside = [...node.querySelectorAll('.file-tile *')]
              .filter((element) => !element.closest('.react-flow__handle'))
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  (rect.left < box.left - 0.5 ||
                    rect.right > box.right + 0.5 ||
                    rect.top < box.top - 0.5 ||
                    rect.bottom > box.bottom + 0.5)
                );
              }).length;
            return {
              outside,
              inFoot:
                link.left >= foot.left - 0.5 &&
                link.right <= foot.right + 0.5 &&
                link.top >= foot.top - 0.5 &&
                link.bottom <= foot.bottom + 0.5,
              height: link.height,
              zoom,
              leftOfCounts:
                link.right <=
                node.querySelector('.tile-foot > span:last-child')!.getBoundingClientRect().left,
            };
          });
        await expect.poll(async () => (await geometry()).zoom).toBeCloseTo(1, 2);
        const measured = await geometry();
        expect(measured.outside, 'elements out of the card').toBe(0);
        expect(measured.inFoot, 'inside the footer').toBe(true);
        expect(measured.leftOfCounts, 'left of the counts').toBe(true);
        expect(measured.height, 'target height').toBeGreaterThanOrEqual(24);
        // A link of the product: underlined, no fill, no outline, no shadow.
        const look = await link.evaluate((element) => {
          const style = getComputedStyle(element);
          return [
            style.textDecorationLine,
            style.backgroundColor,
            style.borderTopWidth,
            style.boxShadow,
          ];
        });
        expect(look).toEqual(['underline', 'rgba(0, 0, 0, 0)', '0px', 'none']);
        // It opens the inspector, and leaves while the inspector is open.
        await link.click();
        await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
        await expect(page.locator('.tile-inspect')).toHaveCount(0);
        await page.getByRole('button', { name: 'Fechar inspetor' }).click();
        await expect(link).toBeVisible();
        // Enter on the selected card opens it too.
        await page.locator(`.react-flow__node-file[data-id="${join(root, 'AGENTS.md')}"]`).focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
        await page.getByRole('button', { name: 'Fechar inspetor' }).click();
        await expect(page.locator('.inspector')).toHaveCount(0);
      });
    }
});

test('the explorer button of the top bar hides and shows the explorer; the centre gains its width', async ({
  page,
}) => {
  const root = project();
  for (const size of SIZES) {
    await test.step(`${size.width}×${size.height}`, async () => {
      await open(page, [root], size);
      await fileMap(page, join(root, 'AGENTS.md'));
      const button = page
        .locator('.app-header')
        .getByRole('button', { name: 'Explorador', exact: true });
      await expect(button).toBeInViewport({ ratio: 1 });
      // In the group of navigation, left of Voltar, with the form of the icon buttons there.
      const [own, back] = await Promise.all([
        button.boundingBox(),
        page.getByRole('button', { name: 'Voltar seleção', exact: true }).boundingBox(),
      ]);
      expect(own!.x + own!.width).toBeLessThanOrEqual(back!.x + 0.5);
      expect(await button.getAttribute('class')).toContain('icon-button');
      await explorer(page, true);
      await expect(button).toHaveAttribute('title', 'Explorador aberto · Ctrl+B recolhe');
      await expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+B');
      const panel = (await page.locator('.explorer').boundingBox())!;
      const centre = (await page.locator('.main-pane').boundingBox())!;
      expect(
        await page
          .locator('.explorer')
          .evaluate((element) => [
            getComputedStyle(element).animationName,
            getComputedStyle(element).animationDuration,
          ]),
      ).toEqual(['explorer-in', '0.18s']);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await expect(button).toHaveAttribute('title', 'Explorador recolhido · Ctrl+B mostra');
      await expect(page.locator('.explorer')).toBeHidden();
      // The centre takes exactly the width of the panel, and the map frames its selection again.
      await expect
        .poll(async () => (await page.locator('.main-pane').boundingBox())!.width)
        .toBeCloseTo(centre.width + panel.width, 0);
      await expect(tile(page, join(root, 'AGENTS.md'))).toBeInViewport({ ratio: 0.9 });
      await expect.poll(() => overMaps(page)).toEqual([]);
      await button.click();
      await expect(page.locator('.explorer')).toBeVisible();
      await expect
        .poll(async () => (await page.locator('.main-pane').boundingBox())!.width)
        .toBeCloseTo(centre.width, 0);
      // The shortcut and the menu item stay.
      await page.keyboard.press('Control+b');
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('Control+b');
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      if (size.width > 1023) {
        // The preference persists as before, in aae-layout.
        await button.click();
        await expect
          .poll(() =>
            page.evaluate(() => JSON.parse(localStorage.getItem('aae-layout') || '{}').explorer),
          )
          .toBe(false);
        await page.reload();
        await expect(page.locator('.explorer')).toBeHidden();
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        await button.click();
        await expect(page.locator('.explorer')).toBeVisible();
      }
    });
  }
});

test('negative: a folder map with a partial reading keeps the warning whole in its line', async ({
  page,
}) => {
  // A reading cut by the inventory limit, served by a mocked API (as folder-map.spec does).
  const fixture = '/tmp/aae-map-composition-partial';
  const node = (relative: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id: `${fixture}${relative ? `/${relative}` : ''}`,
    path: `${fixture}${relative ? `/${relative}` : ''}`,
    name: relative.split('/').at(-1) || 'parcial',
    relative: relative || '.',
    kind,
    status: 'resolved',
    root: fixture,
    roots: [fixture],
    ...extra,
  });
  const model = {
    savedCases: [{ path: fixture, name: 'parcial', available: true }],
    roots: [
      { path: fixture, name: 'parcial', parent: null, level: 0, entries: [`${fixture}/AGENTS.md`] },
    ],
    nodes: [
      node('', 'directory', { listing: 'complete' }),
      node('AGENTS.md', 'entry', { analysis: 'parsed', lines: 3 }),
      node('lida', 'directory', { listing: 'partial', omitted: 4 }),
      node('lida/a.md', 'file', { analysis: 'parsed', lines: 1 }),
    ],
    edges: [
      {
        id: 'e1',
        source: `${fixture}/AGENTS.md`,
        target: `${fixture}/lida/a.md`,
        kind: 'markdown',
        line: 2,
        evidence: '[x](lida/a.md)',
        raw: 'lida/a.md',
        origin: `${fixture}/AGENTS.md`,
        confidence: 'deterministic',
        resolvedBy: 'file',
      },
    ],
    objects: [],
    issues: [],
    signals: [],
    notes: {},
    expected: {},
    restoreErrors: [],
    delta: null,
    scope: { source: null, patterns: [] },
    stats: {
      files: 2,
      parsed: 2,
      edges: 1,
      entries: 1,
      inventory: {
        complete: false,
        lookupComplete: true,
        omitted: 4,
        omittedFiles: 4,
        byTopLevel: [],
      },
    },
    policy: { excluded: [], maxNodes: 4, maxFileBytes: 1048576, maxTextBytes: 33554432, ai: false },
  };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'session')
      return route.fulfill({
        json: { token: 'test-session', home: '/tmp', defaultParent: '/tmp' },
      });
    if (path === 'workspace' || path === 'refresh') return route.fulfill({ json: model });
    if (path === 'content') return route.fulfill({ json: { text: '# x', truncated: false } });
    return route.fulfill({ status: 404, json: { error: `Operação inesperada ${path}` } });
  });
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.goto('/');
    await explorer(page, true);
    await page.getByRole('button', { name: 'Voltar ao diretório parcial', exact: true }).click();
    if (size.width <= 1023) await explorer(page, false);
    await page
      .getByRole('button', { name: 'Mapa de aae-map-composition-partial', exact: true })
      .click();
    const note = head(page).locator('.folder-partial');
    await expect(note).toHaveText('Leitura parcial: as somas podem estar incompletas');
    await expect(note).toBeInViewport({ ratio: 1 });
    // The warning is whole and inside the line, the line one line high.
    const [noteBox, lineBox] = [(await note.boundingBox())!, (await head(page).boundingBox())!];
    expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(lineBox.x + lineBox.width + 0.5);
    expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await expect.poll(() => headerProblems(page, size.height <= 550 ? 25 : 31)).toEqual([]);
    await expect.poll(() => overMaps(page)).toEqual([]);
  }
});

test('negative: a filter in front with Convenções on, two views, a view minimized and restored', async ({
  page,
}) => {
  const alfa = project('alfa');
  const beta = project('beta');
  await open(page, [alfa, beta], SIZES[0]);
  // A highlight filter, with Convenções on (in the bar, and in the filter, where a filter sets them):
  // its box has its own line and nothing over the map. The app opens on Home, where the explorer comes
  // in only when asked for.
  await explorer(page, true);
  await page.locator(`.tree-item[title="${join(alfa, 'AGENTS.md')}"]`).click();
  await page.getByRole('checkbox', { name: 'Convenções' }).check();
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByLabel('Nome do filtro', { exact: true }).fill('Entrada');
  await page.getByLabel('Incluir convenções de escopo').check();
  await page.getByRole('button', { name: 'Salvar e destacar', exact: true }).click();
  const filter = page.locator('.workspace-pane[data-pane-id^="highlight:"] .filter-pane');
  await expect(filter.locator('.map-head')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Convenções' })).toBeChecked();
  await expect(filter.locator('.canvas-caption')).toContainText('Filtro em destaque');
  await filter.locator('.canvas-legend summary').click();
  await expect(filter.locator('.canvas-legend > div')).toContainText('Convenção / hierarquia');
  await filter.locator('.canvas-legend summary').click();
  await expect.poll(() => overMaps(page)).toEqual([]);
  await expect.poll(() => headerProblems(page, 31)).toEqual([]);
  await page.getByRole('button', { name: 'Fechar destaque Entrada' }).click();
  await page.getByRole('checkbox', { name: 'Convenções' }).uncheck();

  // Two views side by side, each with its own line, in both windows.
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await explorer(page, true);
    await page.getByRole('button', { name: 'Voltar ao diretório alfa', exact: true }).click();
    if (size.width <= 1023) await explorer(page, false);
    for (const name of ['alfa', 'beta'])
      await page.getByRole('button', { name: `Mapa de ${name}`, exact: true }).click();
    const views = page.locator('.workspace-pane:not([data-minimized="true"]) .scope-pane');
    await expect(views).toHaveCount(2);
    for (const view of await views.all()) {
      const [line, own] = [(await head(view).boundingBox())!, (await view.boundingBox())!];
      expect(line.x).toBeGreaterThanOrEqual(own.x - 0.5);
      expect(line.x + line.width).toBeLessThanOrEqual(own.x + own.width + 0.5);
    }
    await expect.poll(() => overMaps(page)).toEqual([]);
    await expect.poll(() => headerProblems(page, size.height <= 550 ? 25 : 31)).toEqual([]);
    await leftInTheMenu(page);
  }

  // A view minimized paints no line; restored, its line is back where it was.
  await page.setViewportSize(SIZES[0]);
  await explorer(page, true);
  const betaView = page.locator(`.workspace-pane[data-pane-id="scope:${beta}"]`);
  await expect
    .poll(async () => (await head(betaView).boundingBox())?.width ?? 0)
    .toBeGreaterThan(0);
  const before = (await head(betaView).boundingBox())!;
  await page.getByRole('button', { name: 'Minimizar vista beta', exact: true }).click();
  await expect(betaView).toHaveAttribute('data-minimized', 'true');
  await expect(head(betaView)).toBeHidden();
  await expect.poll(() => overMaps(page)).toEqual([]);
  await page.getByRole('button', { name: 'Restaurar vista beta', exact: true }).click();
  await expect(head(betaView)).toBeVisible();
  await expect.poll(async () => (await head(betaView).boundingBox())!).toEqual(before);
  await expect.poll(() => overMaps(page)).toEqual([]);
});

test('negative: a manual zoom, then another selection: the map frames the new one and the line says its zoom', async ({
  page,
}) => {
  const root = project();
  for (const size of SIZES) {
    await open(page, [root], size);
    await fileMap(page, join(root, 'AGENTS.md'));
    const line = head(page);
    const percent = async () => parseInt((await line.locator('.map-zoom-level').textContent())!);
    const viewport = () =>
      page
        .locator('.react-flow__viewport')
        .evaluate((element) =>
          Math.round(new DOMMatrix(getComputedStyle(element).transform).a * 100),
        );
    const framed = await percent();
    await line.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
    await line.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
    await expect.poll(percent).toBeGreaterThan(framed);
    // Another selection: a new context, framed again; the zoom said is the zoom of the new map.
    await fileMap(page, join(root, 'guia.md'));
    await expect(tile(page, join(root, 'guia.md'))).toBeInViewport({ ratio: 0.9 });
    await expect.poll(async () => (await percent()) === (await viewport())).toBe(true);
    await expect.poll(() => overMaps(page)).toEqual([]);
    await expect(page.locator('.tile-inspect')).toHaveCount(1);
  }
});
