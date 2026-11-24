import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, writeTree } from './helpers';
import { menuButton, runMenuAction } from './more-menu';

// The interface language in the dialogs, the explorer and the Structure view: English from the code,
// Portuguese from the pack, switched in the More menu without reloading. Runs as a new profile, with
// nothing stored (the rest of the suite fixes Portuguese, see playwright.config.ts).
test.use({ storageState: { cookies: [], origins: [] } });

/** The Projects menu is written in the language of the top bar, which is not migrated yet. */
const projectsButton = (page: Page) =>
  page.locator('.app-header').getByRole('button', { name: /^(Projects|Projetos)$/ });
async function runProjectsItem(page: Page, name: RegExp) {
  await projectsButton(page).click();
  await page.getByRole('menu').getByRole('menuitem', { name }).click();
}

async function openProject(page: Page) {
  const root = mkdtempSync(join(tmpdir(), 'aae-language-area-'));
  writeTree(root, {
    'AGENTS.md': '# Agent\n\n[Notes](notes.md)\n',
    'notes.md': '# Notes\n',
    'docs/guide.md': '# Guide\n',
  });
  return await openOnly(page, [root]);
}

/** A `{parameter}` or `<tag>` written out on the screen, in the text or in an attribute. */
async function rawPhrases(page: Page) {
  return await page.evaluate(() => {
    const attributes = ['title', 'aria-label', 'placeholder'];
    const texts = [
      document.body.innerText,
      ...[...document.querySelectorAll('[title], [aria-label], [placeholder]')].flatMap((element) =>
        attributes.map((name) => element.getAttribute(name) ?? ''),
      ),
    ];
    return texts.flatMap((text) => text.match(/\{[A-Za-z]\w*\}|<\/?[A-Za-z]\w*>/g) ?? []);
  });
}

test('language: the dialogs of opening and creating are in English in a new profile', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const close = await openProject(page);
  await page.goto('/');

  await runProjectsItem(page, /^(Open project|Abrir projeto)$/);
  const open = page.getByRole('dialog', { name: 'Open project' });
  await expect(open).toBeVisible();
  await expect(open.getByRole('textbox', { name: 'Search saved projects' })).toHaveAttribute(
    'placeholder',
    'Name or folder path…',
  );
  await expect(open.getByLabel('Saved projects', { exact: true })).toBeVisible();
  await expect(open.getByText(/^Opened$/)).toBeVisible();
  await expect(open.getByRole('button', { name: 'Add folder' })).toBeVisible();
  await expect(open.getByRole('button', { name: 'Switch', exact: true })).toBeVisible();
  await expect(open.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  await expect(open.getByText('Switch closes the other projects.')).toBeVisible();
  await expect(open.getByRole('button', { name: 'Close dialog' })).toBeVisible();
  expect(await rawPhrases(page)).toEqual([]);

  await open.getByRole('button', { name: 'Add folder' }).click();
  const add = page.getByRole('dialog', { name: 'Add folder' });
  await expect(add.getByRole('textbox', { name: 'Folder path' })).toBeVisible();
  await expect(add.getByRole('button', { name: 'Go' })).toBeVisible();
  await expect(add.getByRole('button', { name: 'Up', exact: true })).toBeVisible();
  await expect(add.getByRole('button', { name: 'Open this folder' })).toBeVisible();
  await expect(add.getByText(/^\d+ folders?$/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toHaveCount(0);

  await runProjectsItem(page, /^(New architecture|Nova arquitetura)$/);
  const create = page.getByRole('dialog', { name: 'New architecture' });
  await expect(create).toBeVisible();
  await expect(create.getByLabel('Parent folder')).toBeVisible();
  await expect(create.getByLabel('New folder name')).toHaveValue('my-architecture');
  await expect(create.getByRole('heading', { name: 'Files' })).toBeVisible();
  await expect(create.getByRole('heading', { name: 'Relations' })).toBeVisible();
  await expect(create.getByRole('button', { name: 'Add file' })).toBeVisible();
  await expect(create.getByRole('button', { name: 'Connect files' })).toBeVisible();
  await expect(create.getByLabel('File 1 name')).toHaveValue('assistant');
  await expect(create.getByLabel('File 1 type')).toContainText('Agent');
  await expect(create.getByLabel('Relation 1 type')).toContainText('reads →');
  await expect(create.getByRole('button', { name: 'Review files' })).toBeVisible();
  await expect(create.getByLabel('File 1 description')).toHaveValue(
    'what this agent does and hands back; open it when you take this role.',
  );
  await expect(create.getByLabel('File 1 description')).toHaveAttribute(
    'placeholder',
    'When to open',
  );
  await expect(create).not.toContainText('agent-architecture.json');
  expect(await rawPhrases(page)).toEqual([]);
  expect(errors).toEqual([]);
  await close();
});

test('language: the explorer and the Structure view change language at once, without reloading', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const close = await openProject(page);
  await page.goto('/');
  // Home lists the projects, without the explorer: the tree is in the project.
  await enterProject(page);
  await page.evaluate(() => ((window as unknown as { sameDocument: boolean }).sameDocument = true));

  const explorer = page.locator('aside.explorer');
  const classes = explorer.getByRole('combobox', { name: 'File class' });
  await expect(explorer.getByRole('textbox', { name: 'Search files' })).toBeVisible();
  await expect(explorer.getByRole('button', { name: 'Files', exact: true })).toBeVisible();
  await expect(explorer.getByRole('button', { name: /^Skills and objects/ })).toBeVisible();
  await expect(classes.locator('option')).toHaveText([
    'All · 3',
    'Instructions · 1',
    'Memory · 0',
    'Skills · 0',
    'Manifests · 0',
    'Other · 2',
  ]);
  await expect(explorer.getByRole('button', { name: /^With observations/ })).toBeVisible();
  await explorer.getByRole('button', { name: /^Back to project / }).click();
  const structure = page.getByRole('region', { name: /^Structure of / });
  await expect(structure).toBeVisible();
  await expect(structure.locator('.structure-heading')).toHaveText([
    'class',
    'points to',
    'referenced by',
    'observations',
  ]);
  await expect(structure.locator('.structure-summary')).toContainText('1 folder · 2 files');
  await expect(structure.getByRole('button', { name: 'Show contents of docs' })).toBeVisible();
  expect(await rawPhrases(page)).toEqual([]);

  await runMenuAction(page, 'More', 'Português');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(explorer.getByRole('textbox', { name: 'Buscar arquivos' })).toBeVisible();
  await expect(
    explorer.getByRole('combobox', { name: 'Classe dos arquivos' }).locator('option'),
  ).toHaveText([
    'Todos · 3',
    'Instruções · 1',
    'Memória · 0',
    'Skills · 0',
    'Manifestos · 0',
    'Outros · 2',
  ]);
  await expect(
    page.getByRole('region', { name: /^Estrutura de / }).locator('.structure-heading'),
  ).toHaveText(['classe', 'aponta para', 'citado por', 'observações']);
  await expect(page.getByRole('button', { name: 'Mostrar conteúdo de docs' })).toBeVisible();
  // The same document: the change did not reload the page.
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  expect(await rawPhrases(page)).toEqual([]);

  await runMenuAction(page, 'Mais', 'English');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(classes.locator('option').first()).toHaveText('All · 3');
  await expect(structure.locator('.structure-heading').first()).toHaveText('class');
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  expect(menuButton(page, 'More')).toBeTruthy();
  expect(errors).toEqual([]);
  await close();
});

test('language: the class selector shows the classes in Portuguese for a saved Portuguese choice', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('aae-lang', 'pt'));
  const close = await openProject(page);
  await page.goto('/');
  await enterProject(page);
  const classes = page
    .locator('aside.explorer')
    .getByRole('combobox', { name: 'Classe dos arquivos' });
  await expect(classes.locator('option').nth(1)).toHaveText('Instruções · 1');
  await close();
});
