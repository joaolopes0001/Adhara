import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditRow, showAudit } from './audit-list';
import { closeAllProjects, contrast, readable, sessionHeaders, writeTree } from './helpers';
import { runMoreAction, runProjectsAction } from './more-menu';

// One click changes one thing. A click that changes what the center shows (a map that moves to the
// clicked file) leaves the inspector as it was; a click that does not (the Estrutura keeps its list, or
// the file is already the selection) opens the inspector. A new selection keeps the mode of its view.
// Panels, menus and the map move briefly (none with reduced motion), and the line of an observation or
// an evidence marks where its destination is written.
const long = Array.from({ length: 2000 }, (_, index) =>
  index === 1499 ? 'Veja [Longe](longe-ausente.md) aqui.' : `Linha ${index + 1}`,
).join('\n');
function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-one-change-')), 'aurora');
  writeTree(root, {
    'AGENTS.md': '# Aurora\nLeia o [Guia](docs/guia.md).\nE também [Ausente](ausente.md).\n',
    'docs/guia.md': '# Guia\nSiga os [Passos](passos.md).\n',
    'docs/passos.md': '# Passos\n',
    'docs/longo.md': `${long}\n`,
    'docs/html.md':
      '# HTML\n<img src=x onerror="window.__aaeInjected=1"> <mark>falso</mark> [Quebrado](quebrado.md)\n',
    'docs/duplo.md':
      '# Duplo\n[ausente-duplo.md](ausente-duplo.md) cita ausente-duplo.md\nVeja `nada-duplo.md` e `nada-duplo.md`.\n',
    'docs/mudou.md': '# Mudou\n[Sumiu](sumiu.md)\n',
  });
  return root;
}
const name = 'aurora';
const mode = (page: Page, which: 'Estrutura' | 'Mapa') =>
  page.getByRole('button', { name: `${which} de ${name}`, exact: true });
const location = (page: Page) => page.locator('.breadcrumbs [aria-current="location"]');
const inspector = (page: Page) => page.locator('.inspector');
const tile = (page: Page, path: string) =>
  page.locator('.react-flow__node-file', { has: page.locator(`strong[title="${path}"]`) });
const treeItem = (page: Page, path: string) => page.locator(`.tree-item[title="${path}"]`);
const structureRow = (page: Page, file: string) =>
  page.locator('.structure-row').filter({
    has: page.locator('.structure-open', { hasText: new RegExp(`^${file.replace('.', '\\.')}$`) }),
  });
const close = (page: Page) => page.getByRole('button', { name: 'Fechar inspetor' }).click();

/** Opens the project as a person does (it opens on the Estrutura of its folder); the inspector starts closed. */
async function start(page: Page, root: string, inspectorOpen = false) {
  await page.addInitScript((open) => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: open, bottom: false }));
  }, inspectorOpen);
  await closeAllProjects(page, await sessionHeaders(page));
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório', exact: true }).click();
  await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
  await expect(location(page)).toHaveText(name);
}
/** Shows `docs` in the tree, when it is collapsed. */
async function expandDocs(page: Page) {
  const toggle = page.getByRole('button', { name: 'Expandir pasta docs', exact: true });
  if (await toggle.count()) await toggle.click();
}
/** The map of a file: the switch, then the file in the tree unless it is already the selection. */
async function mapOf(page: Page, path: string) {
  await mode(page, 'Mapa').click();
  if ((await location(page).textContent()) !== path.split('/').at(-1)) {
    await expandDocs(page);
    await treeItem(page, path).click();
  }
  await expect(page.locator('.file-tile.focused strong')).toHaveAttribute('title', path);
}
/** Inspector open on a file, on the Arquivo tab. */
async function inspecting(page: Page, file: string) {
  await expect(inspector(page)).toBeVisible();
  await expect(page.locator('.inspector:not(.is-leaving) h2')).toHaveText(file);
  await expect(page.locator('.inspector-tabs button.active')).toHaveText('Arquivo');
}
/** The location changed to `file` and, in the same click, the inspector stayed closed. */
async function selectedWithoutInspector(page: Page, file: string) {
  await expect(location(page)).toHaveText(file);
  await expect(inspector(page)).toHaveCount(0);
}
const ms = (value: string) =>
  value.split(',').map((part) => parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000))[0];
/** Records the transform of the map's viewport on every frame until it stays put for 10 frames. */
function recordViewport(pane: Locator) {
  return pane.evaluate(
    (element) =>
      new Promise<{ at: number; transform: string }[]>((resolve) => {
        const frames: { at: number; transform: string }[] = [];
        let still = 0;
        const started = performance.now();
        const step = () => {
          const transform =
            element.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? '';
          if (frames.at(-1)?.transform === transform) still++;
          else {
            still = 0;
            frames.push({ at: performance.now(), transform });
          }
          if ((still >= 10 && frames.length > 1) || performance.now() - started > 3000)
            resolve(frames);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
}
/** Zooms the map out by the wheel, so the next framing has somewhere to come from. */
async function zoomOut(page: Page) {
  const zoom = () =>
    page
      .locator('.react-flow__viewport')
      .first()
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  const before = await zoom();
  const box = (await page.locator('.react-flow__pane').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(zoom).toBeLessThan(before - 0.1);
}

/**
 * Waits in the page until the viewport of the map holding the selected tile stays put for 10 frames
 * (at most 3 s), then says whether that tile lies whole inside the visible area of its map: "inside",
 * or the boxes. The geometry is read once the map has stopped moving, never in the middle of a glide.
 */
function selectedInView(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const tile = () =>
          [...document.querySelectorAll<HTMLElement>('.react-flow__node-file')].filter((node) =>
            node.querySelector('.file-tile.focused'),
          );
        let last = '';
        let still = 0;
        const started = performance.now();
        const step = () => {
          const found = tile();
          const map = found[0]?.closest<HTMLElement>('.react-flow');
          const now = `${found.length}|${map?.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform}|${map?.getBoundingClientRect().width}`;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still < 10 && performance.now() - started < 3000) return requestAnimationFrame(step);
          if (found.length !== 1 || !map) return resolve(`selected tiles: ${found.length}`);
          const box = found[0].getBoundingClientRect(),
            area = map.getBoundingClientRect();
          const inside =
            box.left >= area.left - 1 &&
            box.right <= area.right + 1 &&
            box.top >= area.top - 1 &&
            box.bottom <= area.bottom + 1;
          resolve(
            inside
              ? 'inside'
              : JSON.stringify({ tile: box, map: area, viewport: last.split('|')[1] }),
          );
        };
        requestAnimationFrame(step);
      }),
  );
}
/** The selected tile ends whole in view (polled: the map may still be moving). */
async function framed(page: Page, after: string) {
  await expect.poll(() => selectedInView(page), { message: after }).toBe('inside');
}
/**
 * A tile of the map other than the selection, the one most in view, and the middle of its visible part
 * (away from the caption, the controls and the corner buttons): where a person would click it.
 */
async function neighbor(page: Page, prefer = '') {
  type Spot = { id: string; x: number; y: number; visible: number };
  const look = () =>
    page.evaluate((prefer) => {
      const map = document
        .querySelector('.file-tile.focused')
        ?.closest<HTMLElement>('.react-flow')
        ?.getBoundingClientRect();
      if (!map) return null;
      const area = {
        left: map.left + 60,
        right: map.right - 20,
        top: map.top + 40,
        bottom: map.bottom - 60,
      };
      let best: { id: string; x: number; y: number; visible: number } | null = null;
      for (const node of document.querySelectorAll<HTMLElement>('.react-flow__node-file')) {
        if (node.querySelector('.file-tile.focused') || node.closest('[inert]')) continue;
        // A tile of a new map stays hidden until React Flow measures it.
        if (getComputedStyle(node).visibility === 'hidden') continue;
        const box = node.getBoundingClientRect();
        const left = Math.max(box.left, area.left),
          right = Math.min(box.right, area.right),
          top = Math.max(box.top, area.top),
          bottom = Math.min(box.bottom, area.bottom);
        const visible = Math.max(0, right - left) * Math.max(0, bottom - top);
        const spot = {
          id: node.dataset.id!,
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          visible,
        };
        if (prefer && spot.id === prefer) return visible > 400 ? spot : null;
        if (visible > (best?.visible ?? 400)) best = spot;
      }
      return prefer ? null : best;
    }, prefer);
  let found: Spot | null = null;
  await expect
    .poll(async () => (found = await look()) !== null, {
      message: 'a tile to click besides the selection',
    })
    .toBe(true);
  return found! as Spot;
}
/** The location says the file of `id`. */
const at = (page: Page, id: string) => expect(location(page)).toHaveText(id.split('/').at(-1)!);
/** Closes the inspector when it is open, and waits until it has left. */
async function closeIfOpen(page: Page) {
  const button = page.getByRole('button', { name: 'Fechar inspetor' });
  if (await button.count()) await button.click();
  await expect(inspector(page)).toHaveCount(0);
}

test.describe('one change per click', () => {
  let root = '';
  let errors: string[] = [];
  test.beforeEach(async ({ page }) => {
    root = fixture();
    errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      // Selecting a missing destination (ausente.md) asks for a text that does not exist: the server says
      // 400, as it already did before this change; any other console error counts.
      const missingText =
        message.text().startsWith('Failed to load resource') &&
        /\/api\/content\?path=.*ausente/.test(message.location().url);
      if (message.type() === 'error' && !missingText) errors.push(message.text());
    });
  });
  test.afterEach(async ({ page }) => {
    expect(errors).toEqual([]);
    await closeAllProjects(page, await sessionHeaders(page));
  });

  test('the Estrutura stays on a file click and opens the inspector; the map comes only from its switch', async ({
    page,
  }) => {
    const agents = join(root, 'AGENTS.md');
    await start(page, root);
    await expect(inspector(page)).toHaveCount(0);
    // A file of the list.
    await page.locator('.structure-open', { hasText: /^AGENTS\.md$/ }).click();
    await inspecting(page, 'AGENTS.md');
    await expect(location(page)).toHaveText('AGENTS.md');
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    await expect(mode(page, 'Mapa')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.structure-view')).toHaveAttribute(
      'aria-label',
      `Estrutura de ${name}`,
    );
    await expect(structureRow(page, 'AGENTS.md')).toHaveClass(/is-selected/);
    await expect(page.locator('.react-flow__node-file')).toHaveCount(0);
    // The map of that file only through the switch, and back.
    await mode(page, 'Mapa').click();
    await expect(page.locator('.file-tile.focused strong')).toHaveAttribute('title', agents);
    await mode(page, 'Estrutura').click();
    await expect(structureRow(page, 'AGENTS.md')).toHaveClass(/is-selected/);
    await expect(location(page)).toHaveText('AGENTS.md');
    // A folder of the list keeps the Estrutura, listing it.
    await close(page);
    await page.locator('.structure-open', { hasText: /^docs$/ }).click();
    await expect(location(page)).toHaveText('docs');
    await expect(page.locator('.structure-view')).toHaveAttribute(
      'aria-label',
      'Estrutura de docs',
    );
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector(page)).toHaveCount(0);
    // A file of the tree in another folder: the Estrutura of its folder, its line marked.
    await page.locator('.structure-up').click();
    await expect(location(page)).toHaveText(name);
    await expandDocs(page);
    await treeItem(page, join(root, 'docs/passos.md')).click();
    await inspecting(page, 'passos.md');
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.structure-view')).toHaveAttribute(
      'aria-label',
      'Estrutura de docs',
    );
    await expect(structureRow(page, 'passos.md')).toHaveClass(/is-selected/);
    await expect(structureRow(page, 'passos.md').locator('.structure-open')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('in a map the first click selects, the click on the selection opens the inspector', async ({
    page,
  }) => {
    const agents = join(root, 'AGENTS.md');
    const guia = join(root, 'docs/guia.md');
    const passos = join(root, 'docs/passos.md');
    await start(page, root);
    await mode(page, 'Mapa').click();
    // The tree, first click selects and moves the map; the same item again opens the inspector.
    await treeItem(page, agents).click();
    await selectedWithoutInspector(page, 'AGENTS.md');
    await expect(page.locator('.file-tile.focused strong')).toHaveAttribute('title', agents);
    await expect(mode(page, 'Mapa')).toHaveAttribute('aria-pressed', 'true');
    await treeItem(page, agents).click();
    await inspecting(page, 'AGENTS.md');
    await close(page);
    await expect(inspector(page)).toHaveCount(0);
    // The selected tile offers the inspector, in words, while it is closed.
    const offer = tile(page, agents).locator('.tile-inspect');
    await expect(offer).toBeVisible();
    await expect(offer).toHaveText('Abrir inspetor');
    expect((await offer.innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(3);
    await expect(page.locator('.tile-inspect')).toHaveCount(1);
    // Readable in both themes (the capture shows it hung from the selected tile).
    for (const next of ['claro', 'escuro']) {
      expect(await readable(offer)).toBeGreaterThanOrEqual(4.5);
      await page
        .locator('.workspace-pane')
        .first()
        .screenshot({
          path: test.info().outputPath(`tile-inspect-${next === 'claro' ? 'escuro' : 'claro'}.png`),
        });
      await runMoreAction(page, `Ativar tema ${next}`);
    }
    // Another tile becomes the selection; the inspector stays closed.
    await tile(page, guia).click();
    await selectedWithoutInspector(page, 'guia.md');
    await expect(page.locator('.file-tile.focused strong')).toHaveAttribute('title', guia);
    await expect(tile(page, guia).locator('.tile-inspect')).toBeVisible();
    // The selected tile opens the inspector on Arquivo.
    await tile(page, guia).click();
    await inspecting(page, 'guia.md');
    await expect(page.locator('.tile-inspect')).toHaveCount(0);
    // With the inspector open, another tile or a tree item keeps it open on the new file.
    await tile(page, passos).click();
    await expect(location(page)).toHaveText('passos.md');
    await inspecting(page, 'passos.md');
    await treeItem(page, agents).click();
    await expect(location(page)).toHaveText('AGENTS.md');
    await inspecting(page, 'AGENTS.md');
    // The control opens it.
    await close(page);
    await tile(page, agents).locator('.tile-inspect').click();
    await inspecting(page, 'AGENTS.md');
    // Enter on the selected tile opens it; on another tile it selects (the focus stays on it).
    await close(page);
    await page.locator(`.react-flow__node-file[data-id="${agents}"]`).focus();
    await page.keyboard.press('Enter');
    await inspecting(page, 'AGENTS.md');
    await close(page);
    await page.locator(`.react-flow__node-file[data-id="${guia}"]`).focus();
    await page.keyboard.press('Enter');
    await selectedWithoutInspector(page, 'guia.md');
    await expect(page.locator(`.react-flow__node-file[data-id="${guia}"]`)).toBeFocused();
    await page.keyboard.press('Enter');
    await inspecting(page, 'guia.md');
    // Enter on the selected item of the tree.
    await close(page);
    await treeItem(page, guia).focus();
    await page.keyboard.press('Enter');
    await inspecting(page, 'guia.md');
  });

  test('a double click on a tile selects it and opens the inspector wherever the tile went; on the selection it never closes it', async ({
    page,
  }) => {
    const agents = join(root, 'AGENTS.md');
    const guia = join(root, 'docs/guia.md');
    await start(page, root);
    await mapOf(page, agents);
    await expect(inspector(page)).toHaveCount(0);
    const before = (await tile(page, guia).boundingBox())!;
    await tile(page, guia).dblclick();
    await expect(location(page)).toHaveText('guia.md');
    await inspecting(page, 'guia.md');
    // The map ends framed on it, whole in view.
    await framed(page, 'clique duplo');
    // The tile did move on the first click: the second one landed elsewhere.
    const after = (await tile(page, guia).boundingBox())!;
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(20);
    // On the selected tile, with the inspector open.
    await tile(page, guia).dblclick();
    await expect(page.locator('.inspector.is-leaving')).toHaveCount(0);
    await inspecting(page, 'guia.md');
    await expect(location(page)).toHaveText('guia.md');
    await framed(page, 'clique duplo no selecionado');
    // A tile whose map leaves the place of the second click empty (two tiles only).
    await tile(page, agents).click();
    await expect(location(page)).toHaveText('AGENTS.md');
    await close(page);
    await tile(page, join(root, 'ausente.md')).dblclick();
    await expect(location(page)).toHaveText('ausente.md');
    await expect(inspector(page)).toBeVisible();
    await framed(page, 'clique duplo em ausente.md');
  });

  test('a request for detail opens the inspector in one click (markers, badge, audit, changes, path)', async ({
    page,
  }) => {
    const agents = join(root, 'AGENTS.md');
    const guia = join(root, 'docs/guia.md');
    const passos = join(root, 'docs/passos.md');
    await start(page, root);
    // The marker of the Estrutura.
    await structureRow(page, 'AGENTS.md')
      .locator('[data-slot="marker"] .observation-marker')
      .click();
    await inspecting(page, 'AGENTS.md');
    await expect(page.locator('.inspector .file-observations')).toBeVisible();
    // The marker of the tree, in a map, on a file that is not the selection.
    await mapOf(page, guia);
    await close(page);
    await page
      .locator('.tree-file-row', { has: treeItem(page, agents) })
      .locator('.observation-marker')
      .click();
    await inspecting(page, 'AGENTS.md');
    await expect(page.locator('.inspector .file-observations')).toBeVisible();
    // The badge of a tile that is not the selection.
    await treeItem(page, guia).click();
    await expect(location(page)).toHaveText('guia.md');
    await close(page);
    await tile(page, agents).locator('button.tile-observations').click();
    await inspecting(page, 'AGENTS.md');
    await expect(page.locator('.inspector .file-observations')).toBeVisible();
    // A line of the Auditoria.
    await treeItem(page, guia).click();
    await close(page);
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Problemas');
    await auditRow(page, /^ausente\.md/)
      .locator('.file-observation-line')
      .click();
    await inspecting(page, 'AGENTS.md');
    await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', '3');
    // The evidence of a result of Caminho.
    await close(page);
    await page.getByRole('button', { name: 'Caminho', exact: true }).click();
    await page.getByLabel('Arquivo de origem A').fill(agents);
    await page.getByLabel('Arquivo de destino B').fill(passos);
    await page.getByRole('button', { name: 'Traçar', exact: true }).click();
    await expect(page.locator('.trace-summary')).toContainText('Caminho encontrado');
    await page.locator('.step-evidence').first().click();
    await expect(inspector(page)).toBeVisible();
    await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
    await page.locator('.trace-clear').click();
    // An item of Alterações (a new observation), at its line with the destination marked.
    await close(page);
    writeFileSync(passos, '# Passos\nAgora [Novo](novo-ausente.md).\n');
    await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
    await page.getByRole('button', { name: 'Alterações', exact: true }).click();
    await page
      .locator('.changes-section[aria-label="Observações"] .change-row', {
        hasText: 'novo-ausente.md',
      })
      .click();
    await inspecting(page, 'passos.md');
    await expect(page.locator('.highlight-line')).toHaveAttribute('data-line', '2');
    await expect(page.locator('.highlight-line mark.line-target')).toHaveText('novo-ausente.md');
  });

  test('a new selection keeps the mode of its view, back and forward return each mode, a reading keeps it', async ({
    page,
  }) => {
    const agents = join(root, 'AGENTS.md');
    const guia = join(root, 'docs/guia.md');
    await start(page, root);
    // In the map of a folder, the tile of a folder shows the map of that folder.
    await mode(page, 'Mapa').click();
    await expect(page.locator('.canvas-caption')).toContainText(
      `Referências somadas entre os itens de ${name}`,
    );
    await tile(page, join(root, 'docs')).click();
    await expect(location(page)).toHaveText('docs');
    await expect(mode(page, 'Mapa')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.canvas-caption')).toContainText(
      'Referências somadas entre os itens de docs',
    );
    await expect(tile(page, guia)).toBeVisible();
    // From a file in the map to another; then the Estrutura, chosen by its switch.
    await treeItem(page, agents).click();
    await expect(location(page)).toHaveText('AGENTS.md');
    await expect(mode(page, 'Mapa')).toHaveAttribute('aria-pressed', 'true');
    await tile(page, guia).click();
    await expect(location(page)).toHaveText('guia.md');
    await expect(mode(page, 'Mapa')).toHaveAttribute('aria-pressed', 'true');
    await mode(page, 'Estrutura').click();
    await expect(structureRow(page, 'guia.md')).toHaveClass(/is-selected/);
    await structureRow(page, 'passos.md').locator('.structure-open').click();
    await expect(location(page)).toHaveText('passos.md');
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    // Back and forward: each entry in the mode it was left in.
    const back = page.getByRole('button', { name: 'Voltar seleção' });
    const forward = page.getByRole('button', { name: 'Avançar seleção' });
    await back.click();
    await expect(location(page)).toHaveText('guia.md');
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    await back.click();
    await expect(location(page)).toHaveText('AGENTS.md');
    await expect(mode(page, 'Mapa')).toHaveAttribute('aria-pressed', 'true');
    await forward.click();
    await forward.click();
    await expect(location(page)).toHaveText('passos.md');
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    // A reading keeps it.
    await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reler diretórios', exact: true })).toBeEnabled();
    await expect(location(page)).toHaveText('passos.md');
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    await expect(structureRow(page, 'passos.md')).toHaveClass(/is-selected/);
  });

  test('the inspector slides in and out, menus and dialogs fade in, the map glides to a new selection, and nothing waits for them', async ({
    page,
  }) => {
    const agents = join(root, 'AGENTS.md');
    const guia = join(root, 'docs/guia.md');
    const passos = join(root, 'docs/passos.md');
    await start(page, root);
    await page.locator('.structure-open', { hasText: /^AGENTS\.md$/ }).click();
    const panel = inspector(page);
    await expect(panel).toBeVisible();
    // The inspector takes input while it slides in (no waiting for it to stop).
    await page.getByRole('button', { name: 'Relações', exact: true }).dispatchEvent('click');
    await expect(page.locator('.inspector-tabs button.active')).toHaveText('Relações');
    const enter = await panel.evaluate((element) => getComputedStyle(element));
    expect(enter.animationName).toBe('inspector-in');
    expect(ms(enter.animationDuration)).toBeGreaterThanOrEqual(120);
    expect(ms(enter.animationDuration)).toBeLessThanOrEqual(220);
    await close(page);
    const leaving = page.locator('.inspector.is-leaving');
    await expect(leaving).toHaveCount(1);
    const exit = await leaving.evaluate((element) => ({
      name: getComputedStyle(element).animationName,
      duration: getComputedStyle(element).animationDuration,
      inert: (element as HTMLElement).inert,
    }));
    expect(exit.name).toBe('inspector-out');
    expect(ms(exit.duration)).toBeGreaterThanOrEqual(120);
    expect(ms(exit.duration)).toBeLessThanOrEqual(220);
    expect(exit.inert).toBe(true);
    await expect(panel).toHaveCount(0);
    // Menus and dialogs fade in, briefly.
    await page.locator('#more-menu-button').click();
    const menu = await page
      .locator('.dock-menu')
      .evaluate((element) => [
        getComputedStyle(element).animationName,
        getComputedStyle(element).animationDuration,
      ]);
    expect(menu[0]).toBe('fade-in');
    expect(ms(menu[1])).toBeGreaterThan(0);
    expect(ms(menu[1])).toBeLessThanOrEqual(160);
    await page.getByRole('menuitem', { name: 'Ajuda' }).click();
    const shade = await page
      .locator('.modal-shade')
      .evaluate((element) => [
        getComputedStyle(element).animationName,
        getComputedStyle(element).animationDuration,
      ]);
    expect(shade[0]).toBe('fade-in');
    expect(ms(shade[1])).toBeLessThanOrEqual(160);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-shade')).toHaveCount(0);
    // The map glides from where it was to the framing of the new selection, within 300 ms.
    await mapOf(page, agents);
    await zoomOut(page);
    const pane = page.locator('.workspace-pane').first();
    const frames = recordViewport(pane);
    await tile(page, guia).click();
    // Several intermediate frames, from the first change to the last within 300 ms (one frame of margin).
    const glide = await frames;
    const span = glide.at(-1)!.at - glide[1].at;
    expect(glide.length, JSON.stringify(glide)).toBeGreaterThanOrEqual(4);
    expect(span, JSON.stringify(glide)).toBeGreaterThanOrEqual(100);
    expect(span, JSON.stringify(glide)).toBeLessThanOrEqual(300 + 20);
    // The moving map takes a click at once.
    await tile(page, passos).click();
    await tile(page, guia).dispatchEvent('click');
    await expect(location(page)).toHaveText('guia.md');
  });

  test('with reduced motion every duration is zero and nothing glides', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const agents = join(root, 'AGENTS.md');
    const guia = join(root, 'docs/guia.md');
    await start(page, root);
    await page.locator('.structure-open', { hasText: /^AGENTS\.md$/ }).click();
    await expect(inspector(page)).toBeVisible();
    expect(
      await inspector(page).evaluate((element) => getComputedStyle(element).animationDuration),
    ).toBe('0s');
    // It leaves at once: never marked as leaving.
    await page.evaluate(() => {
      const flag = window as unknown as { leftSlowly: boolean };
      flag.leftSlowly = false;
      new MutationObserver(() => {
        if (document.querySelector('.inspector.is-leaving')) flag.leftSlowly = true;
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    await close(page);
    await expect(inspector(page)).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { leftSlowly: boolean }).leftSlowly),
    ).toBe(false);
    await page.locator('#more-menu-button').click();
    expect(
      await page
        .locator('.dock-menu')
        .evaluate((element) => getComputedStyle(element).animationDuration),
    ).toBe('0s');
    await page.keyboard.press('Escape');
    await mapOf(page, agents);
    await zoomOut(page);
    const frames = recordViewport(page.locator('.workspace-pane').first());
    await tile(page, guia).click();
    // The zoomed out viewport, then the new framing at once: whatever changes, changes within two frames,
    // never in a glide.
    const jump = await frames;
    expect(jump.at(-1)!.at - (jump[1] ?? jump[0]).at, JSON.stringify(jump)).toBeLessThanOrEqual(40);
    expect(
      await page
        .locator('.react-flow__viewport')
        .first()
        .evaluate((element) => getComputedStyle(element).animationDuration),
    ).toBe('0s');
  });

  test('the line of an observation or an evidence marks the destination as written, in both themes, until cleared', async ({
    page,
  }) => {
    await start(page, root);
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Problemas');
    await auditRow(page, /^ausente\.md/)
      .locator('.file-observation-line')
      .click();
    const line = page.locator('.highlight-line');
    await expect(line).toHaveAttribute('data-line', '3');
    await expect(line).toContainText('E também [Ausente](ausente.md).');
    const mark = line.locator('mark.line-target');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText('ausente.md');
    // The occurrence of the reference: the destination of the link, after "](".
    expect(
      await mark.evaluate((element) => element.previousSibling?.textContent?.endsWith('](')),
    ).toBe(true);
    // Weight, underline and outline, at least 3:1 against the highlighted line, in both themes.
    for (const next of ['claro', 'escuro']) {
      const style = await mark.evaluate((element) => {
        const own = getComputedStyle(element);
        return {
          decoration: own.textDecorationLine,
          decorationColor: own.textDecorationColor,
          outline: own.outlineStyle,
          outlineColor: own.outlineColor,
          weight: Number(own.fontWeight),
          line: getComputedStyle(element.closest('.highlight-line')!).backgroundColor,
        };
      });
      expect(style.decoration).toContain('underline');
      expect(style.outline).toBe('solid');
      expect(style.weight).toBeGreaterThanOrEqual(600);
      expect(contrast(style.outlineColor, style.line)).toBeGreaterThanOrEqual(3);
      expect(contrast(style.decorationColor, style.line)).toBeGreaterThanOrEqual(3);
      // The text keeps its own contrast inside the mark.
      expect(await readable(mark)).toBeGreaterThanOrEqual(4.5);
      await line.screenshot({
        path: test.info().outputPath(`line-target-${next === 'claro' ? 'escuro' : 'claro'}.png`),
      });
      await runMoreAction(page, `Ativar tema ${next}`);
    }
    // "Limpar destaque" takes the line and the mark away.
    await page.locator('.inspector').getByRole('button', { name: 'Limpar destaque' }).click();
    await expect(page.locator('.highlight-line')).toHaveCount(0);
    await expect(page.locator('mark.line-target')).toHaveCount(0);
    // The evidence of a relation, read from the inspector.
    await page.getByRole('button', { name: 'Relações', exact: true }).click();
    await page.getByRole('button', { name: 'Evidência: Link Markdown na linha 2' }).click();
    await page.getByRole('button', { name: 'Ler evidência em AGENTS.md' }).click();
    await expect(line).toHaveAttribute('data-line', '2');
    await expect(mark).toHaveText('docs/guia.md');
    await page.locator('.inspector').getByRole('button', { name: 'Limpar destaque' }).click();
    await expect(page.locator('.highlight-line')).toHaveCount(0);
    await expect(page.locator('mark.line-target')).toHaveCount(0);
  });

  test('a changed line, markup in the text, a destination written twice and a far line', async ({
    page,
  }) => {
    await start(page, root);
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    // Every level: the name without a folder (`nada-duplo.md`) is informative.
    await showAudit(page, 'Todas');
    const line = page.locator('.highlight-line');
    // The file changed on disk after the reading; its line no longer has the destination.
    writeFileSync(join(root, 'docs/mudou.md'), '# Mudou\nOutro texto, sem a referência.\n');
    await auditRow(page, /^sumiu\.md/)
      .locator('.file-observation-line')
      .click();
    await expect(line).toHaveAttribute('data-line', '2');
    await expect(line).toContainText('Outro texto, sem a referência.');
    await expect(page.locator('mark.line-target')).toHaveCount(0);
    // What looks like markup is text; no element comes from the file.
    await auditRow(page, /^quebrado\.md/)
      .locator('.file-observation-line')
      .click();
    await expect(line).toHaveAttribute('data-line', '2');
    await expect(line.locator('code')).toContainText(
      '<img src=x onerror="window.__aaeInjected=1"> <mark>falso</mark> [Quebrado](quebrado.md)',
    );
    await expect(line.locator('img')).toHaveCount(0);
    await expect(line.locator('mark')).toHaveCount(1);
    await expect(line.locator('mark')).toHaveText('quebrado.md');
    expect(await page.evaluate(() => 'aaeInjected' in window || '__aaeInjected' in window)).toBe(
      false,
    );
    // The syntax singles out the destination of the link; a written path twice marks both.
    await auditRow(page, /^ausente-duplo\.md/)
      .locator('.file-observation-line')
      .click();
    await expect(line).toHaveAttribute('data-line', '2');
    await expect(line.locator('mark.line-target')).toHaveCount(1);
    expect(
      await line
        .locator('mark.line-target')
        .evaluate((element) => element.previousSibling?.textContent),
    ).toBe('[ausente-duplo.md](');
    await auditRow(page, /^nada-duplo\.md/)
      .locator('.file-observation-line')
      .click();
    await expect(line).toHaveAttribute('data-line', '3');
    await expect(line.locator('mark.line-target')).toHaveText(['nada-duplo.md', 'nada-duplo.md']);
    // Line 1,500 of 2,000, beyond the lines mounted first.
    await auditRow(page, /^longe-ausente\.md/)
      .locator('.file-observation-line')
      .click();
    await expect(line).toHaveAttribute('data-line', '1500');
    await expect(line).toBeInViewport();
    await expect(line.locator('mark.line-target')).toHaveText('longe-ausente.md');
  });

  test('in a window of 749×396 the same rules hold, and the explorer and the inspector open one at a time', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 749, height: 396 });
    const guia = join(root, 'docs/guia.md');
    const passos = join(root, 'docs/passos.md');
    await start(page, root);
    await expect(page.locator('.explorer')).toBeHidden();
    // The Estrutura stays and the inspector opens.
    await page.locator('.structure-open', { hasText: /^AGENTS\.md$/ }).click();
    await inspecting(page, 'AGENTS.md');
    await expect(mode(page, 'Estrutura')).toHaveAttribute('aria-pressed', 'true');
    // The same in the map.
    await close(page);
    await mode(page, 'Mapa').click();
    await tile(page, guia).click();
    await selectedWithoutInspector(page, 'guia.md');
    await tile(page, guia).click();
    await inspecting(page, 'guia.md');
    // One at a time: the explorer closes the inspector.
    await runMoreAction(page, 'Mostrar explorador');
    await expect(page.locator('.explorer')).toBeVisible();
    await expect(inspector(page)).toHaveCount(0);
    // The tree, first click selects, the same item opens the inspector (and the explorer leaves).
    await treeItem(page, passos).click();
    await selectedWithoutInspector(page, 'passos.md');
    await expect(page.locator('.explorer')).toBeVisible();
    await treeItem(page, passos).click();
    await inspecting(page, 'passos.md');
    await expect(page.locator('.explorer')).toBeHidden();
    // A double click.
    await close(page);
    await tile(page, guia).dblclick();
    await inspecting(page, 'guia.md');
  });
  for (const size of [
    { width: 1536, height: 960 },
    { width: 749, height: 396 },
  ])
    for (const motion of ['no-preference', 'reduce'] as const)
      test(`the map ends framed on the selection after quick sequences, ${size.width}×${size.height}, motion ${motion}`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ reducedMotion: motion });
        await start(page, root);
        await page.locator('.structure-open', { hasText: /^AGENTS\.md$/ }).click();
        await closeIfOpen(page);
        await mode(page, 'Mapa').click();
        await framed(page, 'mapa de AGENTS.md');
        // Each second action has to come before the 240 ms of the map gliding to the first one. How
        // long two actions take is a fact about the machine, not about the application: a sequence
        // that was too slow runs again, and after three slow runs it is recorded as not exercised.
        // The map has to end framed in every run, quick or not.
        const quickly = async (what: string, run: () => Promise<number>) => {
          const slow: number[] = [];
          while (slow.length < 3) {
            const elapsed = await run();
            if (elapsed < 240) return;
            slow.push(elapsed);
          }
          test.info().annotations.push({
            type: 'not exercised',
            description: `${what}: the second action never came within the 240 ms glide (${slow.join(', ')} ms)`,
          });
        };

        // A double click on a tile that is not the selection, whose map leaves the place of the second
        // click empty (ausente.md: its map has two tiles), and on another one.
        let next = await neighbor(page, join(root, 'ausente.md'));
        await page.mouse.dblclick(next.x, next.y);
        await at(page, next.id);
        await expect(inspector(page)).toBeVisible();
        await framed(page, 'clique duplo em ausente.md');
        await closeIfOpen(page);
        next = await neighbor(page);
        await page.mouse.dblclick(next.x, next.y);
        await at(page, next.id);
        await expect(inspector(page)).toBeVisible();
        await framed(page, 'clique duplo');

        // A click on a tile, then "Abrir inspetor" on it.
        await quickly('Abrir inspetor', async () => {
          await closeIfOpen(page);
          await framed(page, 'inspetor fechado');
          const target = await neighbor(page);
          const started = Date.now();
          await page.mouse.click(target.x, target.y);
          await expect(page.locator('.tile-inspect')).toBeVisible();
          const offer = (await page.locator('.tile-inspect').boundingBox())!;
          await page.mouse.click(offer.x + offer.width / 2, offer.y + offer.height / 2);
          const elapsed = Date.now() - started;
          await at(page, target.id);
          await expect(inspector(page)).toBeVisible();
          await framed(page, 'clique e Abrir inspetor');
          return elapsed;
        });

        // A click on tile A, then on tile B.
        await quickly('cartão B', async () => {
          await closeIfOpen(page);
          await framed(page, 'inspetor fechado');
          const first = await neighbor(page);
          const started = Date.now();
          await page.mouse.click(first.x, first.y);
          const second = await neighbor(page);
          await page.mouse.click(second.x, second.y);
          const elapsed = Date.now() - started;
          await at(page, second.id);
          await framed(page, 'cartão A e cartão B');
          return elapsed;
        });

        // A click on a tile, then the explorer (Ctrl+B), which changes the room of the map.
        await quickly('Ctrl+B', async () => {
          const target = await neighbor(page);
          const started = Date.now();
          await page.mouse.click(target.x, target.y);
          await page.keyboard.press('Control+b');
          const elapsed = Date.now() - started;
          await at(page, target.id);
          await framed(page, 'cartão e Ctrl+B');
          await page.keyboard.press('Control+b');
          await framed(page, 'Ctrl+B de novo');
          return elapsed;
        });

        // A click on a tile, then Estrutura and back to Mapa.
        await quickly('Estrutura → Mapa', async () => {
          const target = await neighbor(page);
          const started = Date.now();
          await page.mouse.click(target.x, target.y);
          await mode(page, 'Estrutura').click();
          await mode(page, 'Mapa').click();
          const elapsed = Date.now() - started;
          await at(page, target.id);
          await framed(page, 'cartão e Estrutura → Mapa');
          return elapsed;
        });

        // Back and forward in a quick sequence.
        const back = page.getByRole('button', { name: 'Voltar seleção' });
        const forward = page.getByRole('button', { name: 'Avançar seleção' });
        await back.click();
        await back.click();
        await forward.click();
        await back.click();
        await framed(page, 'voltar e avançar');
        await forward.click();
        await framed(page, 'avançar');
      });
});
