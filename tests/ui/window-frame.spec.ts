import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, selectFile, showMap, writeTree } from './helpers';
import { menuButton, runMoreAction } from './more-menu';

// The frame of the window: one bar on top (location, mode of a single view, Reler, Projetos, Mais) and
// one at the bottom (tools and the state of the reading). The header of a view and the strip of views
// exist only with two or more views.

/**
 * Visible height of the Estrutura list at 1536×960 with one project open and one view, measured on the
 * frame of eight bands (top bar, navigation, view header, columns, Vistas, tools, status): 696 px. The
 * frame of two bars has to give it at least 15% more.
 */
const LIST_HEIGHT_BEFORE = 696;

/** A project whose root lists more items than fit, so the Estrutura scrolls. */
function longProject() {
  const root = mkdtempSync(join(tmpdir(), 'aae-frame-'));
  const files: Record<string, string> = { 'AGENTS.md': '# Entrada\n[Um](doc-01.md)\n' };
  for (let index = 1; index <= 60; index++)
    files[`doc-${String(index).padStart(2, '0')}.md`] = `# Documento ${index}\n`;
  writeTree(root, files);
  return root;
}

/** A project with a folder that has its own AGENTS.md: selecting a file in it opens a second view. */
function nestedProject() {
  const root = mkdtempSync(join(tmpdir(), 'aae-frame-nested-'));
  writeTree(root, {
    'AGENTS.md': '# Entrada\n[Filho](filho/contexto.md)\n[Nota](nota.md)\n',
    'nota.md': '# Nota\n',
    'filho/AGENTS.md': '# Filho\n[Contexto](contexto.md)\n',
    'filho/contexto.md': '# Contexto\n',
  });
  return root;
}

const nameOf = (root: string) => root.split('/').at(-1)!;

/**
 * Resizes the window and waits for the next two frames: the bar measures its location when the layout of
 * the new width is done (ResizeObserver), so the DOM read right after `setViewportSize` can still be the
 * one of the previous width. Reading before that frame tests the timing of the browser, not the bar.
 */
async function resize(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

async function openStructure(page: Page, root: string) {
  await openOnly(page, [root]);
  await page.goto('/');
  // From Home, the list of projects, by the row of the project.
  await enterProject(page, nameOf(root));
  await expect(page.locator('.structure-view')).toBeVisible();
}

/** Visible height of the Estrutura list: the scrolling region less its sticky header of columns. */
const listHeight = (page: Page) =>
  page
    .locator('.structure-view')
    .evaluate(
      (view) =>
        view.clientHeight -
        (view.querySelector('.structure-columns')?.getBoundingClientRect().height ?? 0),
    );

/**
 * Horizontal bands of visible controls in the column of the views, outside the content (the Estrutura
 * list with the line at its foot, the map, the explorer and the inspector).
 */
const frameBands = (page: Page) =>
  page.evaluate(() => {
    const content = '.structure-view, .scope-crossing, .react-flow, .explorer, .inspector';
    const shown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width >= 1 &&
        rect.height >= 1 &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        !element.closest('details:not([open]) > :not(summary)')
      );
    };
    const controls = [
      ...document.querySelectorAll(
        'button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=menuitem]',
      ),
    ].filter(shown);
    const pane = document.querySelector('.main-pane')!.getBoundingClientRect();
    const bands: [number, number][] = [];
    for (const control of controls) {
      if (control.closest(content)) continue;
      const rect = control.getBoundingClientRect();
      const middle = rect.left + rect.width / 2;
      if (middle < pane.left || middle > pane.right) continue;
      const band = bands.find(([top, bottom]) => rect.top < bottom && rect.bottom > top);
      if (band) {
        band[0] = Math.min(band[0], rect.top);
        band[1] = Math.max(band[1], rect.bottom);
      } else bands.push([rect.top, rect.bottom]);
    }
    return bands.length;
  });

const noHorizontalScroll = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);

test('frame: with one view there is no view header nor strip of views; with two, each view has its header and its own Estrutura | Mapa', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = nestedProject();
  const name = nameOf(root);
  await openStructure(page, root);
  await expect(page.locator('.scope-header')).toHaveCount(0);
  await expect(page.locator('.workspace-view-strip')).toHaveCount(0);
  await expect(page.locator('.workspace-pane .view-mode')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Minimizar vista/ })).toHaveCount(0);
  // The top bar names the view (the project in the location) and holds its mode.
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText(name);
  await expect(page.locator('.app-header .view-mode')).toHaveCount(1);

  // A file in the folder with its own AGENTS.md opens a second view beside the first.
  await selectFile(page, join(root, 'filho', 'contexto.md'));
  const parent = page.locator(`[data-pane-id="scope:${root}"]`);
  const child = page.locator(`[data-pane-id="scope:${root}/filho"]`);
  await expect(page.locator('.scope-header')).toHaveCount(2);
  await expect(page.locator('.workspace-view-strip')).toBeVisible();
  await expect(page.locator('.workspace-view-tab')).toHaveCount(2);
  await expect(page.locator('.app-header .view-mode')).toHaveCount(0);
  await expect(child.getByRole('button', { name: 'Minimizar vista filho' })).toBeVisible();
  // The new view opens in the mode of the view the file was chosen from (the Estrutura); its map is one
  // switch away.
  await expect(child.getByRole('button', { name: 'Estrutura de filho' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await child.getByRole('button', { name: 'Mapa de filho', exact: true }).click();
  // Each toggle acts on its own view.
  await expect(child.locator('.react-flow')).toBeVisible();
  await expect(parent.locator('.structure-view')).toBeVisible();
  await child.getByRole('button', { name: 'Estrutura de filho', exact: true }).click();
  await expect(child.locator('.structure-view')).toBeVisible();
  await expect(child.locator('.react-flow')).toHaveCount(0);
  await expect(parent.locator('.structure-view')).toBeVisible();
  await parent.getByRole('button', { name: `Mapa de ${name}`, exact: true }).click();
  await expect(parent.locator('.react-flow')).toBeVisible();
  await expect(child.locator('.structure-view')).toBeVisible();
  await expect(parent.getByRole('button', { name: `Mapa de ${name}` })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(child.getByRole('button', { name: 'Estrutura de filho' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(errors).toEqual([]);
});

test('frame: the Estrutura | Mapa of the top bar switches the mode of the single view', async ({
  page,
}) => {
  const root = nestedProject();
  const name = nameOf(root);
  await openStructure(page, root);
  const toggle = page.locator('.app-header').getByRole('group', { name: `Modo da vista ${name}` });
  const structure = toggle.getByRole('button', { name: `Estrutura de ${name}`, exact: true });
  const map = toggle.getByRole('button', { name: `Mapa de ${name}`, exact: true });
  await expect(structure).toHaveAttribute('aria-pressed', 'true');
  await map.click();
  await expect(map).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.workspace-pane .react-flow')).toBeVisible();
  await expect(page.locator('.structure-view')).toHaveCount(0);
  await structure.click();
  await expect(structure).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.structure-view')).toBeVisible();
  await expect(page.locator('.workspace-pane .react-flow')).toHaveCount(0);
  // A file selected in the Estrutura keeps the list: the toggle stays; its map is one switch away.
  await page.locator('.structure-open', { hasText: 'nota.md' }).click();
  await expect(structure).toHaveAttribute('aria-pressed', 'true');
  await map.click();
  await expect(map).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText('nota.md');
  // A short location is never cut: the current item shows whole.
  expect(
    await page
      .locator('.breadcrumbs [aria-current="location"]')
      .evaluate(
        (element) =>
          element.getBoundingClientRect().width >= element.scrollWidth - 1 &&
          element.parentElement!.getBoundingClientRect().right >=
            element.getBoundingClientRect().right - 1,
      ),
  ).toBe(true);
});

test('frame: the Projetos and Mais menus open, move with the arrows, close with Esc and outside, and each item does what its old button did', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = nestedProject();
  await openStructure(page, root);
  const projects = menuButton(page, 'Projetos');
  await expect(projects).toHaveAttribute('aria-haspopup', 'menu');
  await expect(projects).toHaveAttribute('aria-expanded', 'false');
  await projects.click();
  const menu = page.getByRole('menu', { name: 'Projetos' });
  await expect(projects).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Abrir projeto/,
    'Adicionar diretório',
    'Nova arquitetura',
  ]);
  // The shortcut is written next to its action.
  await expect(menu.getByRole('menuitem', { name: 'Abrir projeto' })).toContainText('Ctrl+O');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Adicionar diretório' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Nova arquitetura' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(projects).toBeFocused();
  // The arrow opens it from the keyboard; a click outside closes it without running anything.
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await page.locator('.structure-view').click({ position: { x: 600, y: 400 } });
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  for (const name of ['Abrir projeto', 'Adicionar diretório', 'Nova arquitetura']) {
    await projects.click();
    await menu.getByRole('menuitem', { name }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole('dialog', { name })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  // Ctrl+O still opens the saved projects.
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('dialog', { name: 'Abrir projeto' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Mais: the same pattern; the theme and the help are items with their names.
  const more = menuButton(page, 'Mais');
  await more.click();
  const moreMenu = page.getByRole('menu', { name: 'Mais' });
  await expect(moreMenu.getByRole('menuitem').last()).toHaveText('Ajuda');
  await page.keyboard.press('End');
  await expect(moreMenu.getByRole('menuitem', { name: 'Ajuda' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await runMoreAction(page, 'Ativar tema escuro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await runMoreAction(page, 'Ajuda');
  await expect(page.getByRole('dialog', { name: 'Ajuda' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('frame: one selector of class and "Com observações" filter the tree and the Estrutura as the chips did', async ({
  page,
}) => {
  const root = longProject();
  await openStructure(page, root);
  const filter = page
    .locator('.explorer')
    .getByRole('group', { name: 'Filtrar arquivos por classe' });
  const select = filter.getByRole('combobox', { name: 'Classe dos arquivos' });
  const observed = filter.getByRole('button', { name: /^Com observações/ });
  // One line: the selector and the button side by side.
  const [a, b] = [(await select.boundingBox())!, (await observed.boundingBox())!];
  expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(4);
  await expect(select.locator('option')).toHaveText([
    'Todos · 61',
    'Instruções · 1',
    'Memória · 0',
    'Skills · 0',
    'Manifestos · 0',
    'Outros · 60',
  ]);
  await expect(select.locator('option[value="memory"]')).toBeDisabled();
  const structureRows = page.locator('.structure-view .structure-row.is-file');
  const tree = page.locator('.explorer .project-list');
  await expect(structureRows).toHaveCount(61);
  await select.selectOption('entry');
  await expect(structureRows).toHaveCount(1);
  await expect(structureRows).toContainText('AGENTS.md');
  await expect(tree).toContainText('AGENTS.md');
  await expect(tree).not.toContainText('doc-02.md');
  await expect(page.locator('.structure-summary')).toContainText('Filtro de classe');
  // "Com observações" combines with the class (no observation in AGENTS.md), then alone.
  await expect(observed).toHaveText('Com observações · 0');
  await select.selectOption('');
  await expect(observed).toHaveText('Com observações · 59');
  await observed.click();
  await expect(observed).toHaveAttribute('aria-pressed', 'true');
  await expect(structureRows).toHaveCount(59);
  await expect(tree).not.toContainText('AGENTS.md');
  await filter.getByRole('button', { name: 'Limpar filtro de classe' }).click();
  await expect(structureRows).toHaveCount(61);
  await expect(select).toHaveValue('');
  await expect(tree).toContainText('doc-02.md');
});

test('frame: an old layout preference with the collapsed tool bar opens without error, with the bottom bar and the saved panel height', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('frame-seeded')) {
      sessionStorage.setItem('frame-seeded', '1');
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({
          explorer: true,
          inspector: false,
          bottom: false,
          toolbarCollapsed: true,
          explorerWidth: 260,
          inspectorWidth: 380,
          bottomHeight: 300,
        }),
      );
    }
  });
  const root = nestedProject();
  await openStructure(page, root);
  const footer = page.locator('.app-footer');
  await expect(footer).toBeVisible();
  await expect(
    footer.getByRole('navigation', { name: 'Ferramentas' }).getByRole('button'),
  ).toHaveText(['Caminho', 'Auditoria', 'Alterações', 'Filtros']);
  await footer.getByRole('button', { name: 'Auditoria', exact: true }).click();
  const panel = page.locator('.bottom-panel');
  await expect(panel).toBeVisible();
  expect(Math.round((await panel.boundingBox())!.height)).toBe(300);
  // The preference is written again without the key of the bar that no longer collapses.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('aae-layout') || '{}'));
  expect(saved).not.toHaveProperty('toolbarCollapsed');
  expect(saved).toMatchObject({ bottom: true, bottomHeight: 300, explorerWidth: 260 });
  expect(errors).toEqual([]);
});

test('frame: with one project and one view, two bands of controls frame the content and the Estrutura list is at least 15% taller', async ({
  page,
}) => {
  const root = longProject();
  await openStructure(page, root);
  expect(await frameBands(page)).toBe(2);
  const height = await listHeight(page);
  expect(height).toBeGreaterThanOrEqual(Math.ceil(LIST_HEIGHT_BEFORE * 1.15));
  // The top bar is one line of about 44 px and the bottom bar one of about 34 px.
  expect(Math.round((await page.locator('.app-header').boundingBox())!.height)).toBeLessThanOrEqual(
    45,
  );
  expect(Math.round((await page.locator('.app-footer').boundingBox())!.height)).toBeLessThanOrEqual(
    35,
  );
  // Nothing else between the bars and the content: the view has no header and there is no strip.
  await expect(page.locator('.scope-header, .workspace-view-strip')).toHaveCount(0);
  await resize(page, { width: 749, height: 396 });
  expect(await frameBands(page)).toBe(2);
});

test('frame: in a 749×396 window there is no horizontal scroll, and Reler, the two menus and Estrutura | Mapa are within reach', async ({
  page,
}) => {
  const root = nestedProject();
  const name = nameOf(root);
  await openStructure(page, root);
  await resize(page, { width: 749, height: 396 });
  await noHorizontalScroll(page);
  const header = page.locator('.app-header');
  for (const control of [
    header.getByRole('button', { name: 'Reler diretórios', exact: true }),
    menuButton(page, 'Projetos'),
    menuButton(page, 'Mais'),
    header.getByRole('button', { name: `Estrutura de ${name}`, exact: true }),
    header.getByRole('button', { name: `Mapa de ${name}`, exact: true }),
    header.getByRole('button', { name: 'Voltar seleção', exact: true }),
    header.getByRole('button', { name: 'Início', exact: true }),
  ])
    await expect(control).toBeInViewport({ ratio: 1 });
  // The top bar stays one line.
  expect(Math.round((await header.boundingBox())!.height)).toBeLessThanOrEqual(45);
  // Each menu opens whole inside the window.
  for (const menuName of ['Projetos', 'Mais'] as const) {
    await menuButton(page, menuName).click();
    const menu = page.getByRole('menu', { name: menuName });
    for (const item of await menu.getByRole('menuitem').all())
      await expect(item).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
  // The bottom bar keeps the four tools in view and one line, also with a file selected deep down (a
  // compact window shows one side panel at a time: the inspector takes the place of the explorer).
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill('filho/contexto');
  await page
    .locator(`.search-results button[title="${join(root, 'filho', 'contexto.md')}"]`)
    .click();
  await expect(page.locator('.inspector h2')).toHaveText('contexto.md');
  await noHorizontalScroll(page);
  const footer = page.locator('.app-footer');
  for (const tool of ['Caminho', 'Auditoria', 'Alterações', 'Filtros do mapa'])
    await expect(footer.getByRole('button', { name: tool, exact: true })).toBeInViewport({
      ratio: 1,
    });
  expect(Math.round((await footer.boundingBox())!.height)).toBeLessThanOrEqual(35);
  await page.screenshot({ path: test.info().outputPath('frame-749x396.png') });
});

/** A project with a partial reading (a text over 1 MiB), unresolved references and a few files. */
function partialProject() {
  const root = mkdtempSync(join(tmpdir(), 'aae-frame-partial-'));
  writeTree(root, {
    'AGENTS.md':
      '# Entrada\n[Grande](grande.md)\n[Nota](nota.md)\n[Falta](falta.md)\n[Some](some.md)\n',
    'nota.md': '# Nota\n',
    'grande.md': `# Grande\n${'linha sem referências\n'.repeat(60000)}`,
  });
  return root;
}

/** A project with a file ten folders down, each folder with a long name. */
function deepProject() {
  const root = mkdtempSync(
    join(tmpdir(), 'aae-frame-projeto-com-um-nome-bem-comprido-para-o-caminho-'),
  );
  const folders = Array.from(
    { length: 10 },
    (_, index) => `nivel-${String(index).padStart(2, '0')}-pasta-com-um-nome-bem-comprido`,
  );
  writeTree(root, {
    'AGENTS.md': `# Entrada\n[Fundo](${folders.join('/')}/fundo.md)\n`,
    [`${folders.join('/')}/fundo.md`]: '# Fundo\n',
  });
  return { root, folders, file: join(root, ...folders, 'fundo.md') };
}

/** Every element of the bottom bar's state shows its whole text (none ends in an ellipsis). */
const statusCut = (page: Page) =>
  page
    .locator('.status-bar')
    .evaluate((bar) =>
      [
        ...bar.querySelectorAll<HTMLElement>(
          '.status-slot:not([data-hidden]), .status-slot:not([data-hidden]) *',
        ),
      ]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent),
    );

for (const size of [
  { width: 1100, height: 700 },
  { width: 749, height: 396 },
])
  test(`frame: in ${size.width}×${size.height} with a map on screen, the state never ends in an ellipsis; what leaves the bar is in the "Estado" menu`, async ({
    page,
  }) => {
    const root = partialProject();
    await openOnly(page, [root]);
    await page.goto('/');
    await enterProject(page, nameOf(root));
    await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
    // The list stays; the map of the file is one switch away.
    await showMap(page);
    await expect(page.getByRole('checkbox', { name: 'Convenções' })).toBeVisible();
    await resize(page, size);
    const bar = page.locator('.status-bar');
    await expect.poll(() => statusCut(page)).toEqual([]);
    // The two links stay in the bar, whole; the counts and "Somente leitura" leave first.
    const partial = bar.getByRole('button', { name: /^Leitura parcial/ });
    const unresolved = bar.getByRole('button', { name: '2 citados não encontrados' });
    await expect(partial).toBeInViewport({ ratio: 1 });
    await expect(unresolved).toBeInViewport({ ratio: 1 });
    await expect(bar.locator('[data-key="readonly"]')).toHaveAttribute('data-hidden', 'true');
    // What left is reachable by keyboard, whole, in the "Estado" menu.
    const more = bar.getByRole('button', { name: 'Estado', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Estado' });
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: 'Somente leitura' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '1 diretório' })).toBeVisible();
    for (const item of await menu.getByRole('menuitem').all())
      await expect(item).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    // The links are click targets of at least 24 px.
    for (const link of [partial, unresolved])
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    // With room again, everything comes back and the menu goes.
    await resize(page, { width: 1536, height: 960 });
    await expect(bar.locator('[data-hidden]')).toHaveCount(1);
    await expect(bar.locator('.status-more')).toHaveAttribute('data-hidden', 'true');
  });

test('frame: the focus outline of the location is drawn inside, never cut by the bar', async ({
  page,
}) => {
  const root = nestedProject();
  await openStructure(page, root);
  const segment = page.locator('.breadcrumbs [aria-current="location"]');
  await segment.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(segment).toBeFocused();
  expect(await segment.evaluate((element) => getComputedStyle(element).outlineOffset)).toBe('-2px');
  const home = page.getByRole('button', { name: 'Início', exact: true });
  await home.focus();
  expect(await home.evaluate((element) => getComputedStyle(element).outlineOffset)).toBe('-2px');
});

test('frame: a location ten folders deep shows the project, one "…" with the hidden folders, the parent and the current item whole', async ({
  page,
}) => {
  const { root, folders, file } = deepProject();
  await openOnly(page, [root]);
  await page.goto('/');
  await selectFile(page, file);
  const crumbs = page.locator('.breadcrumbs .breadcrumb-segments button');
  await expect(crumbs).toHaveCount(4);
  const more = page.getByRole('button', { name: '9 pastas intermediárias' });
  await expect(more).toHaveAttribute('title', join(root, ...folders.slice(0, 9)));
  await expect(crumbs.last()).toHaveText('fundo.md');
  await expect(crumbs.nth(2)).toHaveText(folders[9]);
  for (const size of [
    { width: 1536, height: 960 },
    { width: 1100, height: 700 },
    { width: 749, height: 396 },
  ]) {
    await resize(page, size);
    // No segment is a zero-width stop for the keyboard; the current item is not cut while the project is.
    for (const crumb of await crumbs.all()) {
      // The width left to see, inside the segment and the location that may clip it.
      const seen = await crumb.evaluate((element) => {
        const boxes = [element, element.parentElement!, element.closest('.breadcrumbs')!].map(
          (item) => item.getBoundingClientRect(),
        );
        return (
          Math.min(...boxes.map((box) => box.right)) - Math.max(...boxes.map((box) => box.left))
        );
      });
      expect(seen, `${size.width}: ${await crumb.textContent()}`).toBeGreaterThanOrEqual(20);
    }
    // Whole: not cut by its own width nor by the bar that holds it.
    const current = await crumbs.last().evaluate((element) => {
      const own = element.getBoundingClientRect();
      const holders = [element.parentElement!, element.closest('.breadcrumbs')!];
      return (
        element.scrollWidth <= element.clientWidth + 1 &&
        holders.every((holder) => {
          const box = holder.getBoundingClientRect();
          return own.left >= box.left - 1 && own.right <= box.right + 1;
        })
      );
    });
    expect(current, `fundo.md whole in ${size.width}`).toBe(true);
  }
  await resize(page, { width: 1536, height: 960 });
  // The "…" opens the hidden folders, each one navigable.
  await more.click();
  const menu = page.getByRole('menu', { name: '9 pastas intermediárias' });
  await expect(menu.getByRole('menuitem')).toHaveText(folders.slice(0, 9));
  await menu.getByRole('menuitem', { name: folders[3] }).click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText(folders[3]);
});

test('frame: the notice of a project removed from the screen never covers Reler nor pushes the menus out', async ({
  page,
}) => {
  const first = nestedProject();
  const { root, file } = deepProject();
  await openOnly(page, [first, root]);
  await page.goto('/');
  await selectFile(page, file);
  await page.getByRole('button', { name: `Remover ${nameOf(first)} da tela`, exact: true }).click();
  const notice = page.locator('.removed-notice');
  await expect(notice).toContainText(`${nameOf(first)} saiu da tela`);
  for (const size of [
    { width: 1536, height: 960 },
    { width: 749, height: 396 },
  ]) {
    await resize(page, size);
    const header = page.locator('.app-header');
    const reread = header.getByRole('button', { name: 'Reler diretórios', exact: true });
    for (const control of [reread, menuButton(page, 'Projetos'), menuButton(page, 'Mais')])
      await expect(control).toBeInViewport({ ratio: 1 });
    const [a, b] = [(await notice.boundingBox())!, (await reread.boundingBox())!];
    const overlap =
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlap, `notice over Reler in ${size.width}`).toBe(false);
    await expect(notice.getByRole('button', { name: 'Reabrir' })).toBeInViewport({ ratio: 1 });
    // The notice itself is whole: its sentence is not squeezed by the bar.
    expect(
      await notice.evaluate((element) =>
        [element, ...element.querySelectorAll('*')].every(
          (part) => part.scrollWidth <= part.clientWidth + 1,
        ),
      ),
      `notice whole in ${size.width}`,
    ).toBe(true);
    expect(Math.round((await header.boundingBox())!.height)).toBeLessThanOrEqual(45);
  }
});

test('frame: "Com observações · N" stays whole with its number, pressed or not, and the summary names the filter on', async ({
  page,
}) => {
  const root = longProject();
  await openStructure(page, root);
  const filter = page
    .locator('.explorer')
    .getByRole('group', { name: 'Filtrar arquivos por classe' });
  const observed = filter.getByRole('button', { name: /^Com observações/ });
  const whole = () =>
    observed.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  await expect(observed).toHaveText('Com observações · 59');
  expect(await whole()).toBe(true);
  await expect(observed).toBeInViewport({ ratio: 1 });
  await observed.click();
  await expect(filter.getByRole('button', { name: 'Limpar filtro de classe' })).toBeVisible();
  await expect(observed).toHaveText('Com observações · 59');
  expect(await whole()).toBe(true);
  await expect(observed).toBeInViewport({ ratio: 1 });
  const summary = page.locator('.structure-summary');
  await expect(summary).toContainText('Filtro com observações: 59 arquivos');
  await expect(summary).not.toContainText('Filtro de classe');
  await filter.getByRole('combobox', { name: 'Classe dos arquivos' }).selectOption('other');
  await expect(summary).toContainText('Filtro de classe e com observações');
  await observed.click();
  await expect(summary).toContainText('Filtro de classe:');
});

test('frame: "Recolher painéis" hides the panels and the same item, now "Mostrar painéis", brings back those that were open', async ({
  page,
}) => {
  const root = nestedProject();
  await openStructure(page, root);
  await page.locator('.structure-open', { hasText: 'nota.md' }).click();
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.locator('.explorer')).toBeVisible();
  await runMoreAction(page, 'Recolher painéis');
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await menuButton(page, 'Mais').click();
  const menu = page.getByRole('menu', { name: 'Mais' });
  await expect(menu.getByRole('menuitem', { name: 'Recolher painéis' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Mostrar painéis' }).click();
  await expect(page.locator('.explorer')).toBeVisible();
  await expect(page.locator('.inspector')).toBeVisible();
  await menuButton(page, 'Mais').click();
  await expect(menu.getByRole('menuitem', { name: 'Recolher painéis' })).toBeVisible();
  await page.keyboard.press('Escape');
});

// The notices next to the strip, and the location with a long current item.

/** Serves every reading of the real server as cut by the inventory limit, so the strip shows. */
async function cutInventory(page: Page) {
  for (const operation of ['workspace', 'refresh', 'close', 'open'])
    await page.route(`**/api/${operation}`, async (route) => {
      const response = await route.fetch();
      const model = await response.json();
      model.stats.inventory = {
        complete: false,
        lookupComplete: true,
        omitted: 3,
        omittedFiles: 3,
        byTopLevel: [],
      };
      await route.fulfill({ response, json: model });
    });
}

/** The control under the middle of a locator, as the mouse would reach it. */
const reachable = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!hit && (hit === element || element.contains(hit));
  });

for (const size of [
  { width: 1536, height: 960 },
  { width: 1100, height: 700 },
  { width: 749, height: 396 },
])
  test(`frame: in ${size.width}×${size.height} the notices never cover "Ver limites" of the strip nor any control`, async ({
    page,
  }) => {
    const first = nestedProject();
    const root = longProject();
    await openOnly(page, [first, root]);
    await cutInventory(page);
    await resize(page, size);
    await page.goto('/');
    // Home lists the projects, without the tree: into the first one.
    await enterProject(page);
    const strip = page.locator('.error-banner');
    await expect(strip).toContainText('Leitura parcial');
    // Both notices: a project removed from the screen, then a file written outside the app before Reler.
    if (size.width <= 1023) await page.keyboard.press('Control+b');
    await page
      .getByRole('button', { name: `Remover ${nameOf(first)} da tela`, exact: true })
      .click();
    if (size.width <= 1023) await page.keyboard.press('Control+b');
    writeTree(root, { 'novo.md': '# Novo\n' });
    await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
    await expect(page.locator('.change-notice').first()).toContainText('Desde a referência');
    await expect(page.locator('.removed-notice')).toBeVisible();
    // Every control of the bar, of the strip and of the notices is reached by the mouse at its middle.
    const controls = [
      strip.getByRole('button', { name: 'Ver limites' }),
      page.getByRole('button', { name: 'Reler diretórios', exact: true }),
      menuButton(page, 'Projetos'),
      menuButton(page, 'Mais'),
      page.locator('.removed-notice').getByRole('button', { name: 'Reabrir' }),
      page.getByRole('button', { name: 'Dispensar aviso de alterações' }),
    ];
    for (const control of controls) {
      await expect(control).toBeInViewport({ ratio: 1 });
      expect(await reachable(control), (await control.textContent()) ?? undefined).toBe(true);
    }
    // The notices do not lie over the strip nor over the content.
    const notices = (await page.locator('.bar-notices').boundingBox())!;
    const stripBox = (await strip.boundingBox())!;
    expect(notices.y).toBeGreaterThanOrEqual(stripBox.y + stripBox.height - 1);
    const content = (await page.locator('.main-layout').boundingBox())!;
    expect(content.y).toBeGreaterThanOrEqual(notices.y + notices.height - 1);
    await strip.getByRole('button', { name: 'Ver limites' }).click();
    await expect(page.locator('.audit-content')).toBeVisible();
  });

/** A project ten folders deep whose current item has a name of 60 characters. */
function longNameProject() {
  const root = mkdtempSync(join(tmpdir(), 'aae-frame-longo-'));
  const folders = Array.from({ length: 10 }, (_, index) => `n${index}-pasta-do-caminho`);
  const name = `${'arquivo-atual-com-um-nome-bem-comprido-de-sessenta-letras'.padEnd(57, 'x')}.md`;
  writeTree(root, {
    'AGENTS.md': `# Entrada\n[Atual](${folders.join('/')}/${name})\n`,
    [`${folders.join('/')}/${name}`]: '# Atual\n',
  });
  return { root, file: join(root, ...folders, name), name };
}

test('frame: in 749×396 with a long current item, every focused part of the location is visible and the current item ends in an ellipsis', async ({
  page,
}) => {
  const { root, file, name } = longNameProject();
  expect(name).toHaveLength(60);
  await openOnly(page, [root]);
  await page.goto('/');
  await selectFile(page, file);
  await resize(page, { width: 749, height: 396 });
  // Tab through the whole top bar: every focused element is visible (no zero-width stop).
  await page.locator('.app-header .brand').click();
  await page.getByRole('button', { name: 'Voltar seleção' }).focus();
  for (let step = 0; step < 12; step++) {
    const seen = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      if (!element.closest('.app-header')) return null;
      const boxes = [element, ...ancestors(element)].map((item) => item.getBoundingClientRect());
      function ancestors(item: HTMLElement) {
        const list: HTMLElement[] = [];
        for (
          let next = item.parentElement;
          next && next.tagName !== 'HEADER';
          next = next.parentElement
        )
          list.push(next);
        return list;
      }
      return {
        text: element.getAttribute('aria-label') || element.textContent,
        width:
          Math.min(...boxes.map((box) => box.right)) - Math.max(...boxes.map((box) => box.left)),
      };
    });
    if (!seen) break;
    expect(seen.width, `${seen.text}`).toBeGreaterThanOrEqual(12);
    await page.keyboard.press('Tab');
  }
  // The current item: cut with an ellipsis (whole in the tooltip), never by the bar in mid-word.
  const current = page.locator('.breadcrumbs [aria-current="location"]');
  await expect(current).toHaveAttribute('title', file);
  const cut = await current.evaluate((element) => {
    const own = element.getBoundingClientRect();
    const holder = element.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      clippedByHolder: own.right > holder.right + 1,
      ellipsis: style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth,
    };
  });
  expect(cut.clippedByHolder).toBe(false);
  expect(cut.ellipsis).toBe(true);
});

test('frame: in 1536×960 a current item of 60 characters shows whole while the bar has room', async ({
  page,
}) => {
  const { root, file } = longNameProject();
  await openOnly(page, [root]);
  await page.goto('/');
  await selectFile(page, file);
  const current = page.locator('.breadcrumbs [aria-current="location"]');
  const whole = await current.evaluate((element) => {
    const own = element.getBoundingClientRect();
    const holders = [element.parentElement!, element.closest('.breadcrumbs')!].map((item) =>
      item.getBoundingClientRect(),
    );
    return (
      element.scrollWidth <= element.clientWidth + 1 &&
      holders.every((box) => own.right <= box.right + 1 && own.left >= box.left - 1)
    );
  });
  expect(whole).toBe(true);
});

test('frame: the location reaches the same parts at each width whatever the width before, already in the first frame after the resize', async ({
  page,
}) => {
  const { root, file } = deepProject();
  await openOnly(page, [root]);
  await page.goto('/');
  await selectFile(page, file);
  /** The parts shown, read in the first animation frame after the call (no waiting for a later one). */
  const now = () =>
    page.evaluate(
      () =>
        new Promise<string[]>((done) =>
          requestAnimationFrame(() =>
            done(
              [...document.querySelectorAll('.breadcrumbs .breadcrumb-segments button')].map(
                (button) => `${button.textContent} ${button.getBoundingClientRect().width > 0}`,
              ),
            ),
          ),
        ),
    );
  const widths = [1536, 1100, 749];
  const reached = new Map<number, string[]>();
  for (const from of widths)
    for (const to of widths) {
      if (from === to) continue;
      await resize(page, { width: from, height: from === 749 ? 396 : 900 });
      await now();
      await resize(page, { width: to, height: to === 749 ? 396 : 900 });
      const first = await now();
      await now();
      await now();
      const settled = await now();
      expect(first, `${from} → ${to}: the first frame is already the final one`).toEqual(settled);
      if (reached.has(to)) expect(first, `${from} → ${to}`).toEqual(reached.get(to));
      else reached.set(to, first);
    }
  // The three widths really differ: the narrow one sends the parent into the "…".
  expect(reached.get(1536)).toHaveLength(4);
  expect(reached.get(749)).toHaveLength(3);
});
