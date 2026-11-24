import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, readable, showMap, writeTree } from './helpers';
import { runMoreAction } from './more-menu';

// Geometry, contrast and fixed text of the interface: grab area of the dividers,
// gray text and the A/B labels at 4.5:1, click targets of 24×24px, text buttons underlined, the active
// tool not told by a faint fill alone, the default tool panel height, the audit in a low window and the
// length of the help.
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-a11y-geometry-'));
  const tree: Record<string, string> = {
    'exemplo/AGENTS.md':
      '# Exemplo\nGuia: [guia](docs/guia.md).\nPerdido: [ausente](docs/ausente.md).\nOutro: [sumido](docs/sumido.md).\nMais um: [falta](docs/falta.md).\nTermos: [[glossario]].\n',
    'exemplo/docs/guia.md': '# Guia\nVolte ao [início](../AGENTS.md).\n',
    'exemplo/memory/MEMORY.md': '# Memória\n',
    'exemplo/notas/solto.md': '# Solto\n',
  };
  writeTree(base, tree);
  return join(base, 'exemplo');
}

/** Text color against the first opaque background up the tree. */
/** AGENTS.md selected (inspector on its file tab), the map showing its context. */
async function selectAgents(page: Page, root: string) {
  await page.goto('/');
  // Home is the list of projects, without the explorer: the tree is in the project.
  await enterProject(page);
  await page.locator('.explorer').getByTitle(join(root, 'AGENTS.md'), { exact: true }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  // From the Structure of the project a click keeps the list; the map of the file is one switch away.
  await showMap(page);
}

async function theme(page: Page, name: 'dark' | 'light') {
  if ((await page.locator('html').getAttribute('data-theme')) !== name)
    await runMoreAction(page, name === 'light' ? 'Ativar tema claro' : 'Ativar tema escuro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', name);
}

test.beforeEach(async ({ page }) => {
  // The inspector open; no saved tool panel height, so the default applies.
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('dividers keep a grab area of at least 7px with the pointer over them', async ({ page }) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await selectAgents(page, root);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  const handles = page.locator('.resize-handle');
  await expect(handles).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    const handle = handles.nth(index);
    const label = await handle.getAttribute('aria-label');
    const box = (await handle.boundingBox())!;
    const vertical = (await handle.getAttribute('aria-orientation')) === 'vertical';
    const center = vertical
      ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    let grabbed = 0;
    for (let offset = -4; offset <= 4; offset++) {
      const point = vertical
        ? { x: center.x + offset, y: center.y }
        : { x: center.x, y: center.y + offset };
      // Move there first: the hover state is what used to shrink the area.
      await page.mouse.move(point.x, point.y);
      const hit = await page.evaluate(
        ({ x, y, label }) =>
          document.elementFromPoint(x, y)?.closest('.resize-handle')?.getAttribute('aria-label') ===
          label,
        { ...point, label },
      );
      if (hit) grabbed++;
    }
    expect(grabbed, `${label}: px of grab area under the pointer`).toBeGreaterThanOrEqual(7);
  }
  await close();
});

test('gray text and the A/B labels reach 4.5:1 in both themes', async ({ page }) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await selectAgents(page, root);
  const selectors = [
    // The muted counts of the bottom bar (the files read are said there, not in the explorer).
    '.status-bar .status-files',
    '.status-bar .status-relations',
    '.inspector .source-code > div > span',
    '.file-tile.focused .tile-kind',
    '.file-tile.focused .tile-foot > span',
    '.endpoint-actions button > b',
  ];
  for (const name of ['dark', 'light'] as const) {
    await theme(page, name);
    for (const selector of selectors) {
      const element = page.locator(selector).first();
      await expect(element, selector).toBeVisible();
      expect(await readable(element), `${name} · ${selector}`).toBeGreaterThanOrEqual(4.5);
    }
    // A missing destination card ("Destino ausente") on its tinted background.
    const missing = page
      .locator('.file-tile', { hasText: 'ausente.md' })
      .locator('.tile-foot > span');
    await expect(missing.first()).toBeVisible();
    for (let index = 0; index < (await missing.count()); index++)
      expect(
        await readable(missing.nth(index)),
        `${name} · missing card foot ${index}`,
      ).toBeGreaterThanOrEqual(4.5);
  }
  // The A/B labels of the Caminho fields.
  await page.getByRole('button', { name: 'Caminho', exact: true }).first().click();
  for (const name of ['light', 'dark'] as const) {
    await theme(page, name);
    const label = page.locator('.trace-field > label > b').first();
    await expect(label).toBeVisible();
    expect(await readable(label), `${name} · .trace-field > label > b`).toBeGreaterThanOrEqual(4.5);
  }
  await close();
});

test('click targets of at least 24×24px and text buttons underlined in both themes', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await selectAgents(page, root);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(page.locator('.audit-observations .file-observation').first()).toBeVisible();
  const targets = [
    '.inspector button.file-observation-line',
    '.audit-observations button.file-observation-line',
    '.explorer button.observation-marker',
    'button.audit-level',
    '.explorer .class-filter :is(select, button)',
    '.inspector button.observations-toggle',
  ];
  for (const selector of targets) {
    const all = page.locator(selector);
    await expect(all.first(), selector).toBeVisible();
    for (let index = 0; index < (await all.count()); index++) {
      const box = (await all.nth(index).boundingBox())!;
      expect(box.width, `${selector} #${index} width`).toBeGreaterThanOrEqual(24);
      expect(box.height, `${selector} #${index} height`).toBeGreaterThanOrEqual(24);
    }
  }
  // The letter did not grow with the target.
  expect(
    await page
      .locator('.inspector button.file-observation-line')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe('11px');

  await page.locator('.inspector .file-observation-open').first().click();
  for (const name of ['dark', 'light'] as const) {
    await theme(page, name);
    for (const selector of [
      '.inspector button.expected-button',
      '.inspector button.diagnosis-link',
      '.inspector button.observations-toggle',
      '.inspector button.file-observation-line',
    ]) {
      const element = page.locator(selector).first();
      await expect(element, selector).toBeVisible();
      expect(
        await element.evaluate((node) => getComputedStyle(node).textDecorationLine),
        `${name} · ${selector}`,
      ).toContain('underline');
    }
  }
  await close();
});

test('bottom bar: the active tool is bold and underlined; pressed differs from hover', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await selectAgents(page, root);
  const dock = page.locator('.dock-tools');
  // No "Mapa" in the bar: an open tool is the active one.
  await dock.getByRole('button', { name: 'Auditoria', exact: true }).click();
  const style = (locator: Locator) =>
    locator.evaluate((node) => {
      const css = getComputedStyle(node);
      return {
        weight: Number(css.fontWeight),
        line: css.textDecorationLine,
        background: css.backgroundColor,
      };
    });
  for (const name of ['dark', 'light'] as const) {
    await theme(page, name);
    const active = await style(dock.locator('button.active').first());
    const idle = dock.getByRole('button', { name: 'Caminho', exact: true });
    const rest = await style(idle);
    expect(active.weight, `${name}: active weight`).toBeGreaterThanOrEqual(600);
    expect(active.line, `${name}: active underline`).toContain('underline');
    expect(rest.weight).toBeLessThan(600);
    expect(rest.line).not.toContain('underline');
    const box = (await idle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const hover = await style(idle);
    await page.mouse.down();
    const pressed = await style(idle);
    // Release outside, so nothing is clicked.
    await page.mouse.move(5, 5);
    await page.mouse.up();
    expect(hover.background, `${name}: hover has a plate`).not.toBe(rest.background);
    expect(pressed.background, `${name}: pressed differs from hover`).not.toBe(hover.background);
  }
  await close();
});

test('the tool panel opens at most 45% of a 1100×700 window', async ({ page }) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await page.setViewportSize({ width: 1100, height: 700 });
  await selectAgents(page, root);
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  const panel = page.locator('.app-shell .bottom-panel');
  await expect(panel).toBeVisible();
  const height = (await panel.boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(700 * 0.45 + 1);
  expect(height).toBeGreaterThan(200);
  await close();
});

test('compact window 749×396: the audit shows at least two observation rows when it opens', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  await page.setViewportSize({ width: 749, height: 396 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  await expect(page.locator('.audit-observations .file-observation-row').first()).toBeAttached();
  await page.waitForTimeout(200);
  const visible = await page.evaluate(() => {
    const box = document
      .querySelector('.app-shell .bottom-panel .bottom-content')!
      .getBoundingClientRect();
    return [...document.querySelectorAll('.audit-observations .file-observation-row')].filter(
      (row) => {
        const rect = row.getBoundingClientRect();
        return rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom + 0.5;
      },
    ).length;
  });
  expect(visible).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: test.info().outputPath('audit-749x396.png') });
  await close();
});

test('help: topics collapsed, at most 600 words, nothing the screen no longer has', async ({
  page,
}) => {
  await page.goto('/');
  await runMoreAction(page, 'Ajuda');
  const help = page.getByRole('dialog', { name: 'Ajuda' });
  await expect(help).toBeVisible();
  const topics = help.locator('.help-content details');
  expect(await topics.count()).toBeGreaterThanOrEqual(10);
  for (let index = 0; index < (await topics.count()); index++)
    await expect(topics.nth(index)).not.toHaveAttribute('open', '');
  const text = (await help.textContent()) ?? '';
  const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  expect(words.length, 'words in the help dialog').toBeLessThanOrEqual(600);
  for (const stale of ['Explicar', 'chips', 'chip', 'Rastreie', 'comentários', 'por que importa'])
    expect(text, stale).not.toContain(stale);
  // A topic opens with a click and the focus stays inside the dialog.
  await help.getByText('Auditoria', { exact: true }).click();
  await expect(topics.filter({ hasText: 'Marcar como esperada' })).toHaveAttribute('open', '');
});
