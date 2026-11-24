import { test, expect } from '@playwright/test';
import { auditRow, auditTab, openAllAuditFiles, showAudit } from './audit-list';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contrast, sessionHeaders } from './helpers';
import { menuButton, runMenuAction, runMoreAction, runProjectsAction } from './more-menu';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem('aae-layout', JSON.stringify({ inspector: true, bottom: false }));
  });
});

test('Paleta da marca, temas persistentes e evidência estrutural da auditoria', async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'aae-brand-audit-'));
  writeFileSync(join(root, 'AGENTS.md'), '[A](a.md)\n[A again](a.md)\n');
  writeFileSync(join(root, 'a.md'), '[Entry](AGENTS.md)\n');
  writeFileSync(
    join(root, 'agent-architecture.json'),
    JSON.stringify(
      { version: 1, relationships: [{ source: 'a.md', target: 'missing.md', type: 'reads' }] },
      null,
      2,
    ),
  );
  const headers = await sessionHeaders(page);
  const old = await (await page.request.get('/api/workspace', { headers })).json();
  for (const r of old.roots)
    await page.request.post('/api/close', { headers, data: { path: r.path } });
  await page.request.post('/api/open', { headers, data: { path: root } });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('html').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(0, 8, 27)',
  );
  // The menus of the top bar are quiet buttons: no fill, like the other bar actions.
  for (const name of ['Projetos', 'Mais'] as const)
    expect(
      await menuButton(page, name).evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: 'Auditoria', exact: true }).first().click();
  // Structural signals stay consultable in their own group, outside the observation total.
  await expect(auditTab(page, 'Todas')).toHaveText('Todas 1');
  await expect(auditTab(page, 'Sinais')).toHaveText('Sinais 2');
  await showAudit(page, 'Sinais', 'repeated-reference');
  await expect(page.locator('.audit-line.signal')).toHaveCount(1);
  await expect(page.getByLabel('Tipo de sinal')).toContainText('Todos os sinais (2)');
  await page.getByLabel('Tipo de sinal').selectOption('cycle');
  await openAllAuditFiles(page);
  await expect(page.locator('.audit-line.signal')).toHaveCount(1);
  await showAudit(page, 'Todas', 'broken');
  await auditRow(page, 'missing.md').locator('.file-observation-line').click();
  await expect(page.locator('.inspector .copy-path code')).toContainText('agent-architecture.json');
  await expect(page.locator('.highlight-line')).toContainText('missing.md');
  for (const theme of ['claro', 'escuro']) {
    await runMoreAction(page, `Ativar tema ${theme}`);
    await page.screenshot({ path: test.info().outputPath(`paleta-${theme}.png`) });
    await runProjectsAction(page, 'Nova arquitetura');
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    const colors = await modal.evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(contrast(colors.background, colors.color)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: test.info().outputPath(`paleta-dialogo-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      theme === 'claro' ? 'light' : 'dark',
    );
  }
});

test('dark fallback survives unavailable local storage', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('unavailable');
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Without storage the language is English too: the suite's transitional Portuguese is stored.
  await runMenuAction(page, 'More', 'Switch to light theme');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
