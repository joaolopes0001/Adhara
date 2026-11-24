import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moreButton, runMoreAction } from './more-menu';
import { closeAllProjects, enterProject, sessionHeaders, showMap } from './helpers';

// The bottom bar keeps the tools people use with their names; the panel controls, the theme and the
// help live in the "Mais" menu of the top bar, each with icon and text. The tool panel opens tall.
async function openFixture(page: Page) {
  const root = mkdtempSync(join(tmpdir(), 'aae-dock-menu-'));
  writeFileSync(join(root, 'AGENTS.md'), '# Entrada\n[Nota](nota.md)\n');
  writeFileSync(join(root, 'nota.md'), '# Nota\n');
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  await page.request.post('/api/open', { headers, data: { path: root } });
  await page.goto('/');
  // Home lists the projects, without the explorer and with no map: the project, on its map.
  await enterProject(page);
  await showMap(page);
  return root;
}

test('dock: the bottom bar names its tools, and "Mais" (top bar) opens a menu that closes with Esc and outside', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openFixture(page);
  const dock = page.getByRole('navigation', { name: 'Ferramentas' });
  await expect(dock.getByRole('button')).toHaveText([
    'Caminho',
    'Auditoria',
    'Alterações',
    'Filtros',
  ]);
  await expect(dock.getByRole('checkbox', { name: 'Convenções' })).toBeVisible();
  const more = moreButton(page);
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // Opened by the mouse: every action with its name; the focus goes to the first one.
  await more.click();
  const menu = page.getByRole('menu', { name: 'Mais' });
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Mostrar inspetor',
    /^Recolher explorador/,
    'Recolher painéis',
    'Restaurar disposição',
    'Ativar tema claro',
    'English',
    'Ajuda',
  ]);
  await expect(menu.getByRole('menuitem', { name: 'Recolher explorador' })).toContainText('Ctrl+B');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  for (const item of await menu.getByRole('menuitem').all()) await expect(item).toBeInViewport();
  // Arrows move between the actions, wrapping around.
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Ajuda' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: 'Mostrar inspetor' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Ajuda' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Mostrar inspetor' })).toBeFocused();
  // Esc closes it and gives the focus back to the button.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // From the keyboard, the arrow opens it too; a click outside closes it.
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await page.locator('.status-bar').click();
  await expect(menu).toHaveCount(0);

  // Each action does what its old button did.
  await expect(page.locator('.explorer')).toBeVisible();
  await runMoreAction(page, 'Recolher explorador');
  await expect(page.locator('.explorer')).toBeHidden();
  await runMoreAction(page, 'Mostrar explorador');
  await expect(page.locator('.explorer')).toBeVisible();
  // The shortcut written in the menu still works.
  await page.keyboard.press('Control+b');
  await expect(page.locator('.explorer')).toBeHidden();
  await page.keyboard.press('Control+b');

  // From a map, the first click on a file shows its map; a second click on it opens the inspector.
  const note = page
    .locator('.explorer')
    .getByRole('button', { name: /nota\.md/ })
    .first();
  await note.click();
  await expect(note).toHaveAttribute('aria-current', 'true');
  await note.click();
  await expect(page.locator('.inspector')).toBeVisible();
  await runMoreAction(page, 'Recolher inspetor');
  await expect(page.locator('.inspector')).toHaveCount(0);
  await runMoreAction(page, 'Mostrar inspetor');
  await expect(page.locator('.inspector')).toBeVisible();

  // No "Mapa" in the bar: the tool closes its panel by its own button or by the panel's ×.
  const audit = dock.getByRole('button', { name: 'Auditoria', exact: true });
  const panel = page.locator('.bottom-panel');
  const close = page.getByRole('button', { name: 'Recolher painel inferior' });
  await audit.click();
  await expect(panel).toBeVisible();
  await expect(audit).toHaveAttribute('aria-expanded', 'true');
  await audit.click();
  await expect(panel).toBeHidden();
  await expect(audit).toHaveAttribute('aria-expanded', 'false');
  await audit.click();
  await close.click();
  await expect(panel).toBeHidden();
  // From the keyboard: Enter on the tool toggles it; the × gives the focus back to the tool.
  await audit.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(panel).toBeHidden();
  await expect(audit).toBeFocused();
  await page.keyboard.press('Enter');
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeHidden();
  await expect(audit).toBeFocused();

  await audit.click();
  await runMoreAction(page, 'Recolher painéis');
  await expect(page.locator('.explorer')).toBeHidden();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(page.locator('.bottom-panel')).toBeHidden();

  await runMoreAction(page, 'Restaurar disposição');
  await expect(page.locator('.explorer')).toBeVisible();

  // The theme and the help, which left the top bar as icons, are items with their names.
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(more).toBeFocused();
  await runMoreAction(page, 'Ativar tema escuro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await runMoreAction(page, 'Ajuda');
  await expect(page.getByRole('dialog', { name: 'Ajuda' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // No control collapses the bottom bar any more: it is one line already.
  await expect(page.getByRole('button', { name: /barra de ferramentas/ })).toHaveCount(0);

  // In the compact window the button and every action stay whole in view, with no horizontal scroll.
  await page.setViewportSize({ width: 749, height: 396 });
  await expect(more).toBeInViewport({ ratio: 1 });
  await more.click();
  for (const item of await menu.getByRole('menuitem').all())
    await expect(item).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('dock: without a saved size the tool panel opens 420 px tall', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('aae-layout'));
  await openFixture(page);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
  const panel = page.locator('.bottom-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('separator', { name: 'Altura do painel inferior' })).toHaveAttribute(
    'aria-valuenow',
    '420',
  );
  expect(Math.round((await panel.boundingBox())!.height)).toBe(420);
});
