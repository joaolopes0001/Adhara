import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runMoreAction, runProjectsAction } from './more-menu';
import { sessionHeaders, showMap } from './helpers';

async function openFixture(page: Page) {
  const root = mkdtempSync(join(tmpdir(), 'aae-collapse-'));
  const files = {
    'AGENTS.md':
      '# Entrada\n[Contexto](context.md)\n[Alpha](alpha/context.md)\n[Beta](beta/context.md)\n',
    'context.md': '# Contexto principal\nTexto de teste da vista principal.\n',
    'alpha/AGENTS.md': '# Alpha\n[Contexto](context.md)\n',
    'alpha/context.md': '# Contexto Alpha\nTexto de teste Alpha.\n',
    'beta/CLAUDE.md': '# Beta\n[Contexto](context.md)\n',
    'beta/context.md': '# Contexto Beta\nTexto de teste Beta.\n',
  };
  for (const name of ['alpha', 'beta']) mkdirSync(join(root, name));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const item of previous.roots)
    await page.request.post('/api/close', { headers, data: { path: item.path } });
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório', exact: true }).click();
  // Opening selects no file; these scenarios start from the map of AGENTS.md, chosen in the structure
  // (which stays) and shown by the switch.
  await expect(page.locator('.structure-view')).toBeVisible();
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('AGENTS.md');
  await showMap(page);
  return { root, files };
}

// selectFile of helpers.ts searches by the full path, clicks the exact result and checks nothing.
async function selectFile(page: Page, path: string) {
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill(path);
  await page.locator(`.search-results button[title="${path}"]`).click();
}

async function noPageOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    )
    .toBe(true);
}

test('a minimized view paints no ghost nodes, also with the whole grid minimized, and restores manual canvas state in both themes and sizes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { root, files } = await openFixture(page);
  const name = root.split('/').at(-1)!;
  // A single view has no header to minimize it: a second view (alpha has its own AGENTS.md) gives both
  // views their headers. Alpha is minimized first, so the root view is the only one in the grid.
  await selectFile(page, join(root, 'alpha', 'context.md'));
  const alpha = page.locator(`[data-pane-id="scope:${root}/alpha"]`);
  await alpha.getByRole('button', { name: 'Minimizar vista alpha', exact: true }).click();
  await page.getByRole('button', { name: `Ativar vista ${name}`, exact: true }).click();
  await runMoreAction(page, 'Recolher painéis');
  const workspace = page.locator('.map-workspace');
  const pane = page.locator(`[data-pane-id="scope:${root}"]`);
  await expect(pane.locator('.scope-location')).toContainText('AGENTS.md');
  const zoom = () =>
    pane
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  const before = await zoom();
  await pane.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
  await expect.poll(zoom).toBeGreaterThan(before + 0.05);
  // Wait for the actual animation to finish before recording the manual zoom.
  await expect
    .poll(async () => {
      const first = await zoom();
      await page.waitForTimeout(100);
      return Math.abs((await zoom()) - first);
    })
    .toBeLessThan(0.001);
  const manualZoom = await zoom();
  const node = pane.locator('.react-flow__node-file').filter({ hasText: 'AGENTS.md' }).first();
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 25, { steps: 5 });
  await page.mouse.up();
  const nodeTransform = await node.evaluate((element) => (element as HTMLElement).style.transform);

  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await runMoreAction(page, 'Ativar tema claro');
    for (const size of [
      { width: 1536, height: 960 },
      { width: 749, height: 396 },
    ]) {
      await pane.getByRole('button', { name: `Minimizar vista ${name}`, exact: true }).click();
      await page.setViewportSize(size);
      await expect(workspace).toHaveAttribute('data-visible-panes', '0');
      await expect(pane).toHaveAttribute('inert', '');
      await expect(page.locator('.workspace-minimized-empty')).toBeInViewport({ ratio: 1 });
      await noPageOverflow(page);
      await expect
        .poll(() =>
          workspace.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth + 1 &&
              element.scrollHeight <= element.clientHeight + 1,
          ),
        )
        .toBe(true);
      // visibility:hidden alone is insufficient: React Flow nodes set visibility:visible.
      // Compare actual painting to a fully transparent reference, including the header
      // where fixed-position descendants could leak through the minimized frame.
      const actual = await page.screenshot({ animations: 'disabled' });
      const opacity = await pane.evaluate((element) => (element as HTMLElement).style.opacity);
      await pane.evaluate((element) => {
        (element as HTMLElement).style.opacity = '0';
      });
      const hiddenReference = await page.screenshot({ animations: 'disabled' });
      await pane.evaluate((element, value) => {
        (element as HTMLElement).style.opacity = value;
      }, opacity);
      expect(
        actual.equals(hiddenReference),
        'Minimized canvas must paint no pixels anywhere in the window',
      ).toBe(true);
      if (theme === 'dark' && size.width === 1536) {
        // Recreate the leaking style only inside this test browser and verify the
        // pixel oracle detects the original ghost nodes, then restore the fix.
        await pane.evaluate((element) => {
          (element as HTMLElement).style.opacity = '';
        });
        const originalPainting = await page.screenshot({
          path: test.info().outputPath('collapse-original-style-reproduction.png'),
          animations: 'disabled',
        });
        expect(
          originalPainting.equals(hiddenReference),
          'Pixel oracle must reject the previous visibility-only style',
        ).toBe(false);
        await pane.evaluate((element, value) => {
          (element as HTMLElement).style.opacity = value;
        }, opacity);
      }
      await page.screenshot({
        path: test.info().outputPath(`collapse-minimized-${theme}-${size.width}.png`),
      });
      const restore = page.getByRole('button', { name: `Restaurar vista ${name}`, exact: true });
      await restore.focus();
      await page.keyboard.press('Enter');
      await expect(pane).not.toHaveAttribute('inert', '');
      await expect(pane.locator('.scope-location')).toContainText('AGENTS.md');
      await expect.poll(async () => Math.abs((await zoom()) - manualZoom)).toBeLessThan(0.02);
      await expect
        .poll(() => node.evaluate((element) => (element as HTMLElement).style.transform))
        .toBe(nodeTransform);
    }
  }
  // With the whole grid minimized, an explicit action restores every view.
  await pane.getByRole('button', { name: `Minimizar vista ${name}`, exact: true }).click();
  await expect(workspace).toHaveAttribute('data-visible-panes', '0');
  await page.getByRole('button', { name: 'Restaurar vistas', exact: true }).click();
  await expect(workspace).toHaveAttribute('data-visible-panes', '2');
  // Home is the list of projects, outside the grid: no view, so nothing to minimize.
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Projetos' })).toBeVisible();
  await expect(page.locator('.workspace-pane')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Minimizar vista/ })).toHaveCount(0);
  for (const [name, body] of Object.entries(files))
    expect(readFileSync(join(root, name), 'utf8')).toBe(body);
  expect(errors).toEqual([]);
});

test('the bottom bar is one line that keeps view tabs, restoration and the tools reachable in both themes and sizes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { root } = await openFixture(page);
  for (const name of ['alpha', 'beta']) await selectFile(page, join(root, name, 'context.md'));
  await runMoreAction(page, 'Recolher painéis');
  const footer = page.locator('.app-footer');
  const beta = page.locator(`[data-pane-id="scope:${root}/beta"]`);
  const alpha = page.locator(`[data-pane-id="scope:${root}/alpha"]`);
  await beta.getByRole('button', { name: 'Minimizar vista beta', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await runMoreAction(page, 'Ativar tema claro');
    for (const size of [
      { width: 1536, height: 960 },
      { width: 749, height: 396 },
    ]) {
      await page.setViewportSize(size);
      // One line, whole in view, with the four tools; no control collapses it.
      expect((await footer.boundingBox())!.height).toBeLessThanOrEqual(36);
      await expect(footer).toBeInViewport({ ratio: 1 });
      await expect(
        footer.getByRole('navigation', { name: 'Ferramentas' }).getByRole('button'),
      ).toHaveText(['Caminho', 'Auditoria', 'Alterações', 'Filtros']);
      await expect(page.getByRole('button', { name: /barra de ferramentas/ })).toHaveCount(0);
      await noPageOverflow(page);
      const activateAlpha = page.getByRole('button', { name: 'Ativar vista alpha', exact: true });
      await activateAlpha.focus();
      await page.keyboard.press('Enter');
      await expect(activateAlpha).toHaveAttribute('aria-pressed', 'true');
      await expect(alpha).toBeInViewport({ ratio: 0.6 });
      const restoreBeta = page.getByRole('button', { name: 'Restaurar vista beta', exact: true });
      await restoreBeta.focus();
      await page.keyboard.press('Enter');
      await expect(beta).toBeInViewport({ ratio: 0.6 });
      await expect(beta.locator('.scope-location')).toContainText('context.md');
      const closeInspector = page.getByRole('button', { name: 'Fechar inspetor', exact: true });
      if (await closeInspector.isVisible()) await closeInspector.click();
      await page.screenshot({
        path: test.info().outputPath(`bottom-bar-${theme}-${size.width}.png`),
      });
      await beta.getByRole('button', { name: 'Minimizar vista beta', exact: true }).click();
    }
  }
  // A tool opened through the inspector shows its panel above the bar. The first click on the search
  // result shows the map of the file; a second one on it opens the inspector.
  await selectFile(page, join(root, 'AGENTS.md'));
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('AGENTS.md');
  await selectFile(page, join(root, 'AGENTS.md'));
  // Visible without opening "Detalhes".
  const setA = page.getByRole('button', { name: 'Definir como A', exact: true });
  await expect(page.locator('.file-details')).toHaveCount(0);
  await expect(setA).toBeVisible();
  await setA.click();
  await expect(page.getByLabel('Arquivo de origem A')).toHaveValue(`${basename(root)}/AGENTS.md`);
  await expect(page.locator('.bottom-panel')).toBeVisible();
  await expect(footer.getByRole('button', { name: 'Caminho', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(errors).toEqual([]);
});
