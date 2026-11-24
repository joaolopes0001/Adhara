import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * A menu button of the top bar: "Projetos" (open, add, create) or "Mais" (tools, panels, theme,
 * language, help), which are "Projects" and "More" in English.
 */
export type MenuName = 'Mais' | 'More' | 'Projetos' | 'Projects';
export const menuButton = (page: Page, name: MenuName) =>
  page.locator('.app-header').getByRole('button', { name, exact: true });

/** The top bar's "Mais" button, which opens the menu of less used tools, panels, theme and help. */
export const moreButton = (page: Page) => menuButton(page, 'Mais');

/** Opens a menu of the top bar and runs one of its actions, named as the menu shows it. */
export async function runMenuAction(page: Page, menuName: MenuName, name: string) {
  await menuButton(page, menuName).click();
  const menu = page.getByRole('menu', { name: menuName });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

/** Opens the "Mais" menu and runs one of its actions, named as the menu shows it. */
export const runMoreAction = (page: Page, name: string) => runMenuAction(page, 'Mais', name);

/** Opens the "Projetos" menu and runs one of its actions ("Abrir projeto", "Adicionar diretório"…). */
export const runProjectsAction = (page: Page, name: string) =>
  runMenuAction(page, 'Projetos', name);
