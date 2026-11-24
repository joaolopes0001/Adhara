import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALERT_ICONS, openOnly, readable, writeTree } from './helpers';
import { runMoreAction } from './more-menu';

// Type scale and alert contrast: four sizes with nothing visible below 11px in the default window (10px
// is the floor of the compact window rules), no horizontal scroll at 749×396, and the alert texts and
// icons readable in the light theme.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-visual-scale-'));
  const tree: Record<string, string> = {
    'exemplo/AGENTS.md':
      '# Exemplo\nGuia: [guia](docs/guia.md).\nPerdido: [ausente](docs/ausente.md).\nTermos: [[glossario]].\n',
    'exemplo/docs/guia.md': '# Guia\nVolte ao [início](../AGENTS.md).\n',
    'exemplo/memory/MEMORY.md': '# Memória\n',
    'exemplo/notas/solto.md': '# Solto\n',
  };
  writeTree(base, tree);
  return join(base, 'exemplo');
}

/** Text (or icon) color against the first opaque background up the tree. */
/** Visible text below `min` px: "font-size · text" of each offender (visually hidden text excluded). */
async function smallText(page: Page, min: number) {
  return page.evaluate((min) => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      if (box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight)
        return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
          return false;
        if (style.clipPath === 'inset(50%)') return false;
      }
      return true;
    };
    const offenders: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (!text.nodeValue?.trim() || !parent || ['SCRIPT', 'STYLE'].includes(parent.tagName))
        continue;
      const size = parseFloat(getComputedStyle(parent).fontSize);
      if (size < min && visible(parent))
        offenders.push(`${size}px · ${parent.className} · ${text.nodeValue.trim().slice(0, 40)}`);
    }
    return offenders;
  }, min);
}

/** A project open, AGENTS.md selected with its relations in the inspector and the audit open. */
async function openWorkspace(page: Page, root: string) {
  await page.goto('/');
  // The app opens on Home, where the explorer comes in when asked for.
  await page.getByRole('button', { name: 'Explorador', exact: true }).click();
  await page.locator('.explorer').getByTitle(join(root, 'AGENTS.md'), { exact: true }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  await page.locator('.inspector').getByRole('button', { name: 'Relações' }).click();
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(page.locator('.audit-observations .file-observation').first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('type scale: nothing visible below 11px in the default window, in both themes', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await openWorkspace(page, root);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await smallText(page, 11), 'dark theme').toEqual([]);
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await smallText(page, 11), 'light theme').toEqual([]);
  await runMoreAction(page, 'Ativar tema escuro');
  await close();
});

test('compact window 749×396: nothing visible below 10px and no horizontal scroll', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await openWorkspace(page, root);
  await page.setViewportSize({ width: 749, height: 396 });
  await page.waitForTimeout(300);
  expect(await smallText(page, 10)).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'no horizontal scroll',
  ).toBe(true);
  await close();
});

test('alerts in the light theme: banner text, “não existe” and the problem line of the audit reach 4.5:1, in colour and without an icon', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await openWorkspace(page, root);
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const missing = page.locator('.inspector .missing-dot').first();
  await expect(missing).toHaveText('· não existe');
  expect(await readable(missing), '.missing-dot').toBeGreaterThanOrEqual(4.5);
  expect(
    await readable(missing.locator('.missing-dot-text')),
    '.missing-dot-text',
  ).toBeGreaterThanOrEqual(4.5);

  const problemLine = page.locator('.audit-line.tone-problem .file-observation-target').first();
  await expect(problemLine).toBeVisible();
  expect(await readable(problemLine), 'problem line of the audit').toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('.audit-line').locator(ALERT_ICONS)).toHaveCount(0);

  // A failed reread shows the error strip: its sentence in the problem colour, no icon.
  await page.route('**/api/refresh', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Falha simulada ao reler.' }),
    }),
  );
  await page.getByRole('button', { name: /Reler/ }).first().click();
  const banner = page.locator('.error-banner');
  await expect(banner).toContainText('Falha simulada ao reler.');
  expect(
    await readable(banner.locator('.strip-text.tone-problem')),
    '.error-banner text',
  ).toBeGreaterThanOrEqual(4.5);
  await expect(banner.locator(ALERT_ICONS)).toHaveCount(0);
  await page.unroute('**/api/refresh');
  await page.getByRole('button', { name: 'Dispensar erro' }).click();
  await runMoreAction(page, 'Ativar tema escuro');
  await close();
});
