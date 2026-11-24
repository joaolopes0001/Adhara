import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enterProject, sessionHeaders } from './helpers';
import { menuButton, runMoreAction, runProjectsAction } from './more-menu';

async function expectDialogTextContrast(page: Page) {
  // The projects dialog has no subtitle: only the texts present are measured.
  await expect(page.locator('.modal-footer > span')).toBeVisible();
  for (const selector of ['.modal-head p', '.modal-footer > span']) {
    if (!(await page.locator(selector).count())) continue;
    const ratio = await page.locator(selector).evaluate((element) => {
      const luminance = (color: string) =>
        color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => value / 255)
          .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(element.closest('.modal')!).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    expect(ratio, `Contraste do texto ${selector}`).toBeGreaterThanOrEqual(4.5);
  }
}

async function api(page: Page, operation: string, data?: object) {
  const options = { headers: await sessionHeaders(page), data };
  const response = data
    ? await page.request.post(`/api/${operation}`, options)
    : await page.request.get(`/api/${operation}`, options);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function add(page: Page, path: string) {
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(path);
  await page.getByRole('button', { name: 'Abrir este diretório', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function choose(page: Page, path: string) {
  await runProjectsAction(page, 'Abrir projeto');
  await page.locator('.case-choice').filter({ hasText: path }).click();
}

test('saved cases: collapse, add, close, replace, notes, drafts and reload', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'aae-saved-cases-'));
  const a = join(directory, 'caso-a'),
    b = join(directory, 'caso-b');
  for (const path of [a, b]) {
    mkdirSync(path);
    writeFileSync(
      join(path, 'AGENTS.md'),
      `# ${path.split('/').at(-1)}\n[Documento](documento.md)\n`,
    );
    writeFileSync(join(path, 'documento.md'), '# Documento\n');
  }
  const before = readFileSync(join(a, 'AGENTS.md'), 'utf8');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const previous = await api(page, 'workspace');
    for (const root of previous.roots) await api(page, 'close', { path: root.path });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await add(page, a);
    // Opening selects no file: the note is about AGENTS.md, chosen in the structure.
    await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
    await page.getByRole('button', { name: 'Anotações', exact: true }).click();
    await page.getByLabel('Anotação do arquivo').fill('Anotação salva do caso A');
    await page.getByRole('button', { name: 'Salvar anotação' }).click();
    await expect(page.locator('.save-status')).toContainText('Salvo');
    await page.getByLabel('Anotação do arquivo').fill('Rascunho do caso A');
    const rootA = page.locator('.root-section').filter({
      has: page.getByRole('button', { name: 'Voltar ao diretório caso-a', exact: true }),
    });
    await page.getByRole('button', { name: 'Recolher projeto caso-a', exact: true }).click();
    await expect(rootA.locator('.tree-item')).toHaveCount(0);
    await expect(rootA.locator('.root-meta')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('saved-cases-collapsed.png') });
    await page.getByRole('button', { name: 'Voltar ao diretório caso-a', exact: true }).click();
    await expect(rootA.locator('.tree-item')).toHaveCount(0);
    await add(page, b);
    await expect(page.locator('.root-section')).toHaveCount(2);
    await expect(rootA.locator('.tree-item')).toHaveCount(0);
    // The tree's project action is "Remover da tela".
    await page.getByRole('button', { name: 'Remover caso-a da tela', exact: true }).click();
    await expect(page.locator('.root-section')).toHaveCount(1);
    await choose(page, a);
    await expect(page.getByRole('dialog')).toContainText('Salvo · fechado');
    await expectDialogTextContrast(page);
    await page.screenshot({ path: test.info().outputPath('saved-cases-desktop-dark.png') });
    await page.getByRole('button', { name: 'Trocar', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.root-section')).toHaveCount(1);
    await expect(rootA.locator('.tree-item')).toHaveCount(0);
    await expect(page.locator('.map-workspace')).not.toContainText(b);
    // Switching opens the project on its structure; the draft returns with AGENTS.md.
    await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
    await page.getByRole('button', { name: 'Anotações', exact: true }).click();
    await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('Rascunho do caso A');
    expect((await api(page, 'workspace')).notes[join(a, 'AGENTS.md')]).toBe(
      'Anotação salva do caso A',
    );
    await page.getByRole('button', { name: 'Salvar anotação' }).click();
    await expect(page.locator('.save-status')).toContainText('Salvo');
    await page.reload();
    // The reload opens on Home, the list of projects: the tree is in a project.
    await enterProject(page);
    await expect(
      page.getByRole('button', { name: 'Expandir projeto caso-a', exact: true }),
    ).toBeVisible();
    await expect(rootA.locator('.tree-item')).toHaveCount(0);
    await page.getByRole('button', { name: 'Expandir projeto caso-a', exact: true }).click();
    await rootA.locator('.tree-item').filter({ hasText: 'AGENTS.md' }).click();
    await page.getByRole('button', { name: 'Anotações', exact: true }).click();
    await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('Rascunho do caso A');
    await choose(page, b);
    await page.getByRole('button', { name: 'Abrir', exact: true }).click();
    await expect(page.locator('.root-section')).toHaveCount(2);
    const model = await api(page, 'workspace');
    expect(model.savedCases.map((item: { path: string }) => item.path)).toEqual(
      expect.arrayContaining([a, b]),
    );
    expect(readFileSync(join(a, 'AGENTS.md'), 'utf8')).toBe(before);
    expect(errors).toEqual([]);
  } finally {
    for (const path of [a, b]) {
      await api(page, 'close', { path });
      await api(page, 'forget', { path });
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('saved cases: unavailable directories, forget, theme and compact dialog', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'aae-case-availability-'));
  const path = join(directory, 'caso-indisponivel');
  mkdirSync(path);
  writeFileSync(join(path, 'AGENTS.md'), '# Caso\n');
  try {
    await api(page, 'open', { path, replace: true });
    await api(page, 'note', { node: join(path, 'AGENTS.md'), body: 'Preservar mesmo ao esquecer' });
    await api(page, 'close', { path });
    renameSync(path, `${path}-movido`);
    await page.goto('/');
    await runMoreAction(page, 'Ativar tema claro');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.setViewportSize({ width: 749, height: 396 });
    await expect(menuButton(page, 'Projetos')).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Control+o');
    const choice = page.locator('.case-choice').filter({ hasText: path });
    await choice.click();
    await expect(choice).toContainText('Indisponível');
    await expect(page.getByRole('button', { name: 'Abrir', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Trocar', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Adicionar diretório', exact: true }).last(),
    ).toBeInViewport();
    await expectDialogTextContrast(page);
    await page.screenshot({ path: test.info().outputPath('saved-cases-compact-light.png') });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      )
      .toBe(true);
    // Forgetting (Excluir) asks first, in the dialog of the app over this one, saying that the Alterações
    // reference is erased; the note stays unless the user chooses otherwise.
    await page
      .getByRole('button', {
        name: 'Excluir o projeto caso-indisponivel do aplicativo…',
        exact: true,
      })
      .click();
    const confirm = page.getByRole('dialog', {
      name: 'Excluir caso-indisponivel do aplicativo?',
      exact: true,
    });
    await expect(confirm).toContainText('A referência de Alterações');
    await expect(confirm).toContainText('são apagadas');
    await expect(confirm.getByRole('checkbox')).not.toBeChecked();
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await confirm.getByRole('button', { name: 'Excluir projeto', exact: true }).click();
    await expect(choice).toHaveCount(0);
    const state = await api(page, 'workspace');
    expect(state.notes[join(path, 'AGENTS.md')]).toBe('Preservar mesmo ao esquecer');
    expect(readFileSync(join(`${path}-movido`, 'AGENTS.md'), 'utf8')).toBe('# Caso\n');
    await page.getByRole('button', { name: 'Fechar diálogo', exact: true }).click();
    await runMoreAction(page, 'Ativar tema escuro');
    await page.keyboard.press('Control+o');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(10, 23, 45)');
  } finally {
    await api(page, 'close', { path });
    await api(page, 'forget', { path });
    rmSync(directory, { recursive: true, force: true });
  }
});
