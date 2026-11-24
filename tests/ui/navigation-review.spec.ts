import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionHeaders, showMap } from './helpers';
import { runProjectsAction } from './more-menu';

async function fixture(page: Page, dense = false) {
  const root = mkdtempSync(join(tmpdir(), 'aae-navigation-review-'));
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, 'beta'));
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# Parent\n[Alpha](alpha/AGENTS.md)\n[Beta](beta/CLAUDE.md)\n' +
      (dense ? Array.from({ length: 30 }, (_, i) => `[File ${i}](file-${i}.md)\n`).join('') : ''),
  );
  writeFileSync(join(root, 'alpha/AGENTS.md'), '# Alpha\n');
  writeFileSync(join(root, 'beta/CLAUDE.md'), '# Beta\n');
  if (dense)
    for (let i = 0; i < 30; i++) writeFileSync(join(root, `file-${i}.md`), `# File ${i}\n`);
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const opened of previous.roots)
    await page.request.post('/api/close', { headers, data: { path: opened.path } });
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(1);
  const parent = page.locator(`.scope-pane[data-scope="${root}"]`);
  // Opening selects no file; these scenarios start from the map of AGENTS.md, chosen in the structure
  // (which stays) and shown by the switch.
  await expect(parent.locator('.structure-view')).toBeVisible();
  await parent.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await showMap(page);
  await expect(parent.locator('.file-tile.focused')).toContainText('AGENTS.md');
  return { root, parent };
}

/** A folder chosen in the tree, as its name in the details of the view did: it opens the folder. */
async function openFolder(page: Page, path: string) {
  await page.locator('.explorer').getByTitle(path, { exact: true }).click();
  await expect(page.locator(`.scope-pane[data-scope="${path}"]`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('navigation review: closing inactive pane preserves active selection', async ({ page }) => {
  const { root, parent } = await fixture(page);
  await openFolder(page, `${root}/alpha`);
  await openFolder(page, `${root}/beta`);
  await parent.locator('.scope-location button').click();
  await expect(parent).toHaveAttribute('data-active', 'true');
  // A child folder view closes by "Fechar vista".
  await page.getByRole('button', { name: 'Fechar vista alpha', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  await expect(parent).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.copy-path code')).toHaveText(join(root, 'AGENTS.md'));
});

test('navigation review: returning to Mapa restores parallel directory context after trace', async ({
  page,
}) => {
  const { root, parent } = await fixture(page);
  await openFolder(page, `${root}/alpha`);
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await page.getByLabel('Arquivo de origem A').fill(join(root, 'AGENTS.md'));
  await page.getByLabel('Arquivo de destino B').fill(join(root, 'alpha/AGENTS.md'));
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('.trace-summary')).toContainText('1 passo');
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await expect(page.locator('.scope-pane')).toHaveCount(2);
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await expect(page.locator('.trace-summary')).toContainText('1 passo');
});

test('navigation review: dense parallel canvas discloses omitted relations', async ({ page }) => {
  const { root, parent } = await fixture(page, true);
  await expect
    .poll(() =>
      parent
        .locator('.file-tile.focused')
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThanOrEqual(180);
  await expect(parent.locator('.file-tile.focused')).toBeInViewport({ ratio: 0.9 });
  await openFolder(page, `${root}/alpha`);
  const counter = parent.locator('.canvas-caption > span:last-child');
  await expect(counter).toContainText('no inspetor');
  // Two views leave no room for the counts in the header line of the map: they leave it whole for
  // its "…" menu, which shows them, the omission included.
  await expect(counter).toHaveAttribute('data-hidden', '');
  await parent
    .locator('.map-head')
    .getByRole('button', { name: 'Mais controles do mapa', exact: true })
    .click();
  await expect(
    page
      .getByRole('menu', { name: 'Mais controles do mapa' })
      .getByRole('menuitem', { name: /\+9 no inspetor/ }),
  ).toBeVisible();
});
