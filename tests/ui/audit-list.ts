import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** The audit tab of a level ("Problemas", "Avisos", "Informativos", "Todas", "Sinais"). */
export const auditTab = (page: Page, name: string) =>
  page
    .getByRole('tablist', { name: 'Nível das observações' })
    .getByRole('tab', { name: new RegExp(`^${name}\\b`) });

/** One line of the audit list per observation or signal (only those of open files are rendered). */
export const auditRows = (page: Page) => page.locator('.audit-observations .file-observation');
/** The line whose short text (what is written, and the type) contains `text`; an open detail does not count. */
export const auditRow = (page: Page, text: string | RegExp) =>
  auditRows(page).filter({ has: page.locator('.file-observation-open', { hasText: text }) });
/** File groups of the audit list. */
export const auditFiles = (page: Page) => page.locator('.audit-observations .audit-file-group');

/** Opens every collapsed file of the audit list, so that every line of the shown files is rendered. */
export async function openAllAuditFiles(page: Page) {
  const closed = page.locator(
    '.audit-observations button.observation-group-head[aria-expanded="false"]',
  );
  for (let left = await closed.count(); left > 0; left = await closed.count())
    await closed.first().click();
}

/** Chooses a level and, optionally, a type inside it (a code), then opens every file of the list. */
export async function showAudit(page: Page, level: string, type = '') {
  await auditTab(page, level).click();
  await expect(auditTab(page, level)).toHaveAttribute('aria-selected', 'true');
  // With one type in the level there is no selector: the list already is that type.
  const select = page.getByLabel(/^Tipo de (observação|sinal)$/);
  if (type && (await select.count())) await select.selectOption(type);
  await openAllAuditFiles(page);
}

/** Opens the facts of one line (the same detail as the inspector) and returns the line. */
export async function openAuditDetail(row: Locator) {
  await row.getByRole('button', { name: /^Ver detalhe/ }).click();
  await expect(row.locator('.occurrence-detail')).toBeVisible();
  return row;
}
