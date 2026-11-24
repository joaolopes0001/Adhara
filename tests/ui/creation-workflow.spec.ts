import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjectsAction } from './more-menu';

test('creation workflow: changing a proposal during slow review cannot authorize unreviewed files', async ({
  page,
}) => {
  const parent = mkdtempSync(join(tmpdir(), 'aae-creation-workflow-'));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reviewed = false;
  await page.route('**/api/blueprint', async (route) => {
    const response = await route.fetch();
    reviewed = true;
    await pending;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await runProjectsAction(page, 'Nova arquitetura');
  await page.getByLabel('Diretório pai').fill(parent);
  await page.getByLabel('Nome do novo diretório').fill('orion-original');
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  await expect.poll(() => reviewed).toBe(true);
  await page.getByLabel('Nome do novo diretório').fill('orion-revisado');
  await page.getByLabel('Nome do nó 1', { exact: true }).fill('auditor');
  release();
  await expect(page.getByRole('alert')).toContainText('Revise');
  await expect(page.getByRole('button', { name: 'Criar e abrir' })).toHaveCount(0);
  await expect(page.getByLabel('Nome do novo diretório')).toHaveValue('orion-revisado');
  expect(readdirSync(parent)).toEqual([]);
  await page.unroute('**/api/blueprint');
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  await expect(page.locator('.blueprint')).toContainText('agent/auditor.md');
  await expect(page.locator('.blueprint')).not.toContainText('agent/assistente.md');
  await expect(page.locator('.blueprint nav button')).toHaveText([
    'agent/auditor.md',
    'memory/contexto.md',
    'policy/regras.md',
    'AGENTS.md',
    'CLAUDE.md',
  ]);
  await expect(page.locator('.modal-footer')).toContainText('5 arquivos');
  expect(readdirSync(parent)).toEqual([]);
  await page.getByRole('button', { name: 'Criar e abrir' }).click();
  await expect(page.locator('.tree-root').filter({ hasText: 'orion-revisado' })).toBeVisible();
  expect(readdirSync(parent)).toEqual(['orion-revisado']);
  expect(readdirSync(join(parent, 'orion-revisado')).sort()).toEqual([
    'AGENTS.md',
    'CLAUDE.md',
    'agent',
    'memory',
    'policy',
  ]);
  expect(readFileSync(join(parent, 'orion-revisado/AGENTS.md'), 'utf8')).toContain(
    'agent/auditor.md',
  );
  await page.screenshot({ path: test.info().outputPath('reviewed-creation.png') });
});

test('creation workflow: removing the previously previewed file keeps the next review readable', async ({
  page,
}) => {
  const parent = mkdtempSync(join(tmpdir(), 'aae-creation-revision-'));
  await page.goto('/');
  await runProjectsAction(page, 'Nova arquitetura');
  await page.getByLabel('Diretório pai').fill(parent);
  await page.getByLabel('Nome do novo diretório').fill('orion');
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  await page
    .locator('.blueprint nav')
    .getByRole('button', { name: 'policy/regras.md', exact: true })
    .click();
  await expect(page.locator('.blueprint pre')).toContainText('# regras');
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.getByRole('button', { name: 'Remover nó 3', exact: true }).click();
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  await expect(page.locator('.blueprint pre')).toContainText('# orion');
  await expect(page.locator('.blueprint nav button.active')).toHaveText('AGENTS.md');
  await expect(page.locator('.blueprint')).not.toContainText('policy/regras.md');
  expect(readdirSync(parent)).toEqual([]);
  await page.keyboard.press('Escape');
  expect(readdirSync(parent)).toEqual([]);
});

/** Opens the creation dialog from the Projects menu, in whatever language the page is in. */
async function openCreation(page: Page) {
  await page
    .locator('.app-header')
    .getByRole('button', { name: /^(Projects|Projetos)$/ })
    .click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: /^(New architecture|Nova arquitetura)$/ })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('creation workflow: the description becomes the Map line and an empty one becomes a gap', async ({
  page,
}) => {
  const parent = mkdtempSync(join(tmpdir(), 'aae-creation-description-'));
  await page.goto('/');
  await openCreation(page);
  await page.getByLabel('Diretório pai').fill(parent);
  await page.getByLabel('Nome do novo diretório').fill('orion');
  await expect(page.getByLabel('Descrição do nó 1', { exact: true })).toHaveValue(
    'o que este agente faz e o que entrega; abra ao assumir este papel.',
  );
  await expect(page.getByLabel('Descrição do nó 1', { exact: true })).toHaveAttribute(
    'placeholder',
    'Quando abrir',
  );
  // The starter proposal shows governs: the rules govern the assistant.
  await expect(page.getByLabel('Origem da relação 2').locator('option:checked')).toHaveText(
    'regras',
  );
  await expect(page.getByLabel('Tipo da relação 2')).toHaveValue('governs');
  await expect(page.getByLabel('Destino da relação 2').locator('option:checked')).toHaveText(
    'assistente',
  );
  await page
    .getByLabel('Descrição do nó 2', { exact: true })
    .fill('  decisões do projeto; leia antes de decidir de novo.  ');
  await page.getByLabel('Descrição do nó 3', { exact: true }).fill('');
  // Renaming keeps the description of its file.
  await page.getByLabel('Nome do nó 2', { exact: true }).fill('memoria');
  await expect(page.getByLabel('Descrição do nó 2', { exact: true })).toHaveValue(
    '  decisões do projeto; leia antes de decidir de novo.  ',
  );
  const request = page.waitForRequest('**/api/blueprint');
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  const body = (await request).postDataJSON();
  expect(body.language).toBe('pt');
  expect(body.primitives.map((p: { description: string }) => p.description)).toEqual([
    'o que este agente faz e o que entrega; abra ao assumir este papel.',
    '  decisões do projeto; leia antes de decidir de novo.  ',
    '',
  ]);
  await expect(page.locator('.blueprint nav button.active')).toHaveText('AGENTS.md');
  // The review shows the count alone, and does not repeat the subtitle of the form.
  await expect(page.locator('.modal-footer > span')).toHaveText('5 arquivos');
  await expect(page.getByRole('dialog')).not.toContainText('Cada nó vira um arquivo');
  const preview = page.locator('.blueprint pre');
  await expect(preview).toContainText('## Mapa');
  await expect(preview).toContainText(
    '- [memoria](memory/memoria.md): decisões do projeto; leia antes de decidir de novo.\n',
  );
  await expect(preview).toContainText(
    '- [regras](policy/regras.md): TODO: o que há neste arquivo; quando abrir.',
  );
  await expect(page.locator('.blueprint')).not.toContainText('agent-architecture.json');
  const entry = await preview.textContent();
  await page.locator('.blueprint nav').getByRole('button', { name: 'agent/assistente.md' }).click();
  await expect(preview).toContainText('- Siga [regras](../policy/regras.md).');
  await page.locator('.blueprint nav').getByRole('button', { name: 'policy/regras.md' }).click();
  await expect(preview).toContainText('# regras');
  await expect(preview).not.toContainText('](');
  expect(readdirSync(parent)).toEqual([]);
  await page.getByRole('button', { name: 'Criar e abrir' }).click();
  await expect(
    page.locator(`.tree-root[data-root-header="${join(parent, 'orion')}"]`),
  ).toBeVisible();
  expect(readFileSync(join(parent, 'orion/AGENTS.md'), 'utf8')).toBe(entry);
});

test('creation workflow: the starter text follows the interface language', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aae-lang', 'en'));
  const parent = mkdtempSync(join(tmpdir(), 'aae-creation-english-'));
  await page.goto('/');
  await openCreation(page);
  const dialog = page.getByRole('dialog', { name: 'New architecture' });
  await dialog.getByLabel('Parent folder').fill(parent);
  await expect(dialog.getByLabel('File 1 description', { exact: true })).toHaveValue(
    'what this agent does and hands back; open it when you take this role.',
  );
  await expect(dialog.getByLabel('File 3 description', { exact: true })).toHaveValue(
    'rules the work must follow; read before you finish a task.',
  );
  await expect(dialog.getByLabel('Relation 2 source').locator('option:checked')).toHaveText(
    'rules',
  );
  await expect(dialog.getByLabel('Relation 2 type')).toHaveValue('governs');
  await expect(dialog.getByLabel('Relation 2 target').locator('option:checked')).toHaveText(
    'assistant',
  );
  await expect(dialog).toContainText(
    'Each file below is created on disk; each relation becomes a Markdown link.',
  );
  // A new file starts without a description; the placeholder names the field.
  await dialog.getByRole('button', { name: 'Add file' }).click();
  await expect(dialog.getByLabel('File 4 description', { exact: true })).toHaveValue('');
  const request = page.waitForRequest('**/api/blueprint');
  await dialog.getByRole('button', { name: 'Review files' }).click();
  expect((await request).postDataJSON().language).toBe('en');
  await expect(page.locator('.modal-footer > span')).toHaveText('6 files');
  await expect(dialog).not.toContainText('Each file below');
  const preview = page.locator('.blueprint pre');
  await expect(preview).toContainText('## Map');
  await expect(preview).toContainText(
    '- [context](memory/context.md): decisions in force; read before changing what was already decided.',
  );
  await expect(preview).toContainText(
    '- [file-4](document/file-4.md): TODO: what this file holds; when to open it.',
  );
  await page.locator('.blueprint nav').getByRole('button', { name: 'agent/assistant.md' }).click();
  await expect(preview).toContainText('- Follow [rules](../policy/rules.md).');
  expect(readdirSync(parent)).toEqual([]);
});

test('creation workflow: a refused description keeps the form and creates nothing', async ({
  page,
}) => {
  const parent = mkdtempSync(join(tmpdir(), 'aae-creation-refused-'));
  await page.goto('/');
  await openCreation(page);
  await page.getByLabel('Diretório pai').fill(parent);
  await page.getByLabel('Nome do novo diretório').fill('orion');
  const refused = 'leia `memory/x.md` antes';
  await page.getByLabel('Descrição do nó 2', { exact: true }).fill(refused);
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  await expect(page.getByRole('alert')).toContainText('Descrição de contexto');
  await expect(page.getByRole('alert')).toContainText('crase');
  await expect(page.getByRole('button', { name: 'Criar e abrir' })).toHaveCount(0);
  await expect(page.getByLabel('Descrição do nó 2', { exact: true })).toHaveValue(refused);
  await expect(page.getByLabel('Nome do novo diretório')).toHaveValue('orion');
  expect(readdirSync(parent)).toEqual([]);
  // The field takes one line: a pasted line break does not reach the request.
  await page.getByLabel('Descrição do nó 2', { exact: true }).fill('');
  await page.getByLabel('Descrição do nó 2', { exact: true }).focus();
  await page.keyboard.insertText('decisões em vigor;\nleia antes de mudar.');
  await expect(page.getByLabel('Descrição do nó 2', { exact: true })).not.toHaveValue(/\n/);
  // A pasted tab becomes a space too, instead of a refusal from the server.
  await page.getByLabel('Descrição do nó 3', { exact: true }).fill('');
  await page.getByLabel('Descrição do nó 3', { exact: true }).focus();
  await page.keyboard.insertText('regras\tem vigor');
  await expect(page.getByLabel('Descrição do nó 3', { exact: true })).toHaveValue(
    'regras em vigor',
  );
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.blueprint pre')).toContainText('- [contexto](memory/contexto.md): ');
  expect(readdirSync(parent)).toEqual([]);
});

test('creation workflow: tab order runs through each file, and removing a file keeps the focus', async ({
  page,
}) => {
  await page.goto('/');
  await openCreation(page);
  await page.getByLabel('Nome do nó 1', { exact: true }).focus();
  for (const label of ['Tipo do nó 1', 'Descrição do nó 1', 'Remover nó 1', 'Nome do nó 2']) {
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(label, { exact: true })).toBeFocused();
  }
  await page.getByRole('button', { name: 'Adicionar nó' }).click();
  await page.getByLabel('Descrição do nó 4', { exact: true }).fill('quarto');
  // Removing a file in the middle keeps the descriptions of the others with their files.
  await page.getByRole('button', { name: 'Remover nó 2', exact: true }).click();
  await expect(page.getByLabel('Nome do nó 2', { exact: true })).toHaveValue('regras');
  await expect(page.getByLabel('Descrição do nó 2', { exact: true })).toHaveValue(
    'regras que o trabalho deve seguir; leia antes de concluir uma tarefa.',
  );
  await expect(page.getByLabel('Descrição do nó 3', { exact: true })).toHaveValue('quarto');
  await expect(page.getByRole('button', { name: 'Remover nó 2', exact: true })).toBeFocused();
  // Removing the last one moves the focus to the button that took its place.
  await page.getByRole('button', { name: 'Remover nó 3', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remover nó 2', exact: true })).toBeFocused();
  // With one file left its button is disabled, and the focus goes to the name.
  await page.getByRole('button', { name: 'Remover nó 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remover nó 1', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Nome do nó 1', { exact: true })).toBeFocused();
});

for (const theme of ['dark', 'light'])
  test(`creation workflow: file boxes keep one height and nothing overflows (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('aae-theme', value), theme);
    for (const size of [
      { width: 1536, height: 960 },
      { width: 749, height: 396 },
    ]) {
      await page.setViewportSize(size);
      await page.goto('/');
      await openCreation(page);
      for (let n = 4; n <= 8; n++) await page.getByRole('button', { name: 'Adicionar nó' }).click();
      const facts = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll<HTMLElement>('.primitive-file'));
        const form = document.querySelector<HTMLElement>('.create-form')!;
        return {
          count: boxes.length,
          heights: new Set(boxes.map((b) => Math.round(b.getBoundingClientRect().height))).size,
          inside: boxes.every((box) => {
            const outer = box.getBoundingClientRect();
            const field = box.querySelector('.primitive-description')!.getBoundingClientRect();
            const name = box.querySelector('input')!.getBoundingClientRect();
            const type = box.querySelector('select')!.getBoundingClientRect();
            return (
              field.left >= outer.left &&
              field.right <= outer.right &&
              field.bottom <= outer.bottom &&
              Math.abs(field.left - name.left) < 1 &&
              Math.abs(field.right - type.right) < 1
            );
          }),
          fontSize: parseFloat(
            getComputedStyle(document.querySelector('.primitive-description')!).fontSize,
          ),
          formOverflow: form.scrollWidth - form.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(facts).toEqual({
        count: 8,
        heights: 1,
        inside: true,
        fontSize: facts.fontSize,
        formOverflow: 0,
        pageOverflow: 0,
      });
      expect(facts.fontSize).toBeGreaterThanOrEqual(11);
      // The buttons of the dialog stay within the window.
      await expect(page.getByRole('button', { name: 'Revisar arquivos' })).toBeInViewport({
        ratio: 1,
      });
      await expect(page.getByRole('button', { name: 'Fechar diálogo' })).toBeInViewport({
        ratio: 1,
      });
    }
  });

for (const theme of ['dark', 'light'])
  test(`creation workflow: the review keeps its buttons in a short window (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('aae-theme', value), theme);
    await page.setViewportSize({ width: 749, height: 396 });
    for (const files of [3, 8]) {
      await page.goto('/');
      await openCreation(page);
      for (let n = 4; n <= files; n++)
        await page.getByRole('button', { name: 'Adicionar nó' }).click();
      await page.getByRole('button', { name: 'Revisar arquivos' }).click();
      await expect(page.locator('.blueprint pre')).toContainText('# minha-arquitetura');
      // The review area gives up height: the dialog itself does not scroll, and the footer, with
      // the count and both buttons, is in view without scrolling; the list and the text scroll inside.
      expect(
        await page.locator('.modal').evaluate((modal) => ({
          scroll: modal.scrollHeight - modal.clientHeight,
          top: modal.scrollTop,
        })),
      ).toEqual({ scroll: 0, top: 0 });
      for (const name of ['Voltar', 'Criar e abrir'])
        await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.locator('.modal-footer > span')).toBeInViewport({ ratio: 1 });
      await expect(page.locator('.modal-footer > span')).toContainText(`${files + 2} arquivos`);
      if (files === 8)
        expect(
          await page
            .locator('.blueprint-body nav')
            .evaluate((nav) => nav.scrollHeight > nav.clientHeight),
        ).toBe(true);
    }
  });

type Body = { relationships: { source: string; target: string; type: string }[] };

/** The relations sent to the server by the next review, as "source type target". */
async function reviewedRelations(page: Page) {
  const request = page.waitForRequest('**/api/blueprint');
  const response = page.waitForResponse('**/api/blueprint');
  await page.getByRole('button', { name: 'Revisar arquivos' }).click();
  const body = (await request).postDataJSON() as Body;
  // The answer has to be on the screen before the test goes on: a review that arrived after the test
  // had gone back to the form would take the form away under the next action.
  await response;
  await expect(page.locator('.blueprint').or(page.getByRole('alert')).first()).toBeVisible();
  return body.relationships.map((r) => `${r.source} ${r.type} ${r.target}`);
}

/** Back from a review (or from its refusal) to the form. */
async function backToForm(page: Page) {
  const back = page.getByRole('button', { name: 'Voltar', exact: true });
  if (await page.locator('.blueprint').count()) await back.click();
  await expect(page.locator('.create-form')).toBeVisible();
}

test('creation workflow: renaming a file through the name of another moves no relation', async ({
  page,
}) => {
  await page.goto('/');
  await openCreation(page);
  const name = (n: number) => page.getByLabel(`Nome do nó ${n}`, { exact: true });
  const start = ['assistente reads contexto', 'regras governs assistente'];
  // Typing assistente2 over regras passes through "assistente".
  await name(3).fill('');
  await name(3).pressSequentially('assistente2');
  expect(await reviewedRelations(page)).toEqual([
    'assistente reads contexto',
    'assistente2 governs assistente',
  ]);
  await backToForm(page);
  // Renaming A to the name of B and back.
  await name(1).fill('contexto');
  await name(1).fill('assistente');
  expect(await reviewedRelations(page)).toEqual([
    'assistente reads contexto',
    'assistente2 governs assistente',
  ]);
  await backToForm(page);
  await name(3).fill('regras');
  // An empty name, then another one: the relations keep following the file.
  await name(2).fill('');
  await name(2).pressSequentially('memoria');
  expect(await reviewedRelations(page)).toEqual(['assistente reads memoria', start[1]]);
  await backToForm(page);
  await name(2).fill('contexto');
  // Two files with the same name at review are refused by the server; told apart again, each keeps
  // its relations.
  await name(2).fill('regras');
  expect(await reviewedRelations(page)).toEqual(['assistente reads regras', start[1]]);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.blueprint')).toHaveCount(0);
  await name(2).fill('contexto');
  expect(await reviewedRelations(page)).toEqual(start);
  await backToForm(page);
  // The selectors show the current names, and removing a file removes only its relations.
  await name(1).fill('guia');
  await expect(page.getByLabel('Origem da relação 1').locator('option:checked')).toHaveText('guia');
  await expect(page.getByLabel('Destino da relação 2').locator('option:checked')).toHaveText(
    'guia',
  );
  await page.getByRole('button', { name: 'Remover nó 2', exact: true }).click();
  expect(await reviewedRelations(page)).toEqual(['regras governs guia']);
});

test('creation workflow: the focus stays in the dialog through the review and back', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/blueprint', async (route) => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await openCreation(page);
  const review = page.getByRole('button', { name: /^(Revisar arquivos|Processando…)$/ });
  await review.focus();
  await page.keyboard.press('Enter');
  // While the server answers, the button keeps the focus and does not act again.
  await expect(page.getByRole('button', { name: 'Processando…' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Processando…' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
    true,
  );
  await page.keyboard.press('Shift+Tab');
  release();
  // The review opens with the focus on its open file, in the list.
  await expect(
    page.locator('.blueprint nav').getByRole('button', { name: 'AGENTS.md' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
    true,
  );
  // Back, by the keyboard: the focus goes to the first field of the form.
  await page.getByRole('button', { name: 'Voltar', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Diretório pai')).toBeFocused();
  await page.unroute('**/api/blueprint');
});

for (const files of [8, 40])
  test(`creation workflow: the open file of the review is in view in a short window (${files} files)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 749, height: 396 });
    await page.goto('/');
    await openCreation(page);
    for (let n = 4; n <= files; n++)
      await page.getByRole('button', { name: 'Adicionar nó' }).click();
    await page.getByRole('button', { name: 'Revisar arquivos' }).click();
    const nav = page.locator('.blueprint nav');
    const active = nav.locator('button.active');
    await expect(active).toHaveText('AGENTS.md');
    // Inside the list: the item is within the visible part of the list, the list has scrolled, and
    // the dialog has not.
    const facts = await nav.evaluate((list) => {
      const item = list.querySelector('.active')!.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      const modal = list.closest('.modal')!;
      return {
        inside: item.top >= box.top && item.bottom <= box.bottom,
        listScrolled: list.scrollTop > 0,
        dialogScroll: modal.scrollTop + (modal.scrollHeight - modal.clientHeight),
      };
    });
    expect(facts).toEqual({ inside: true, listScrolled: true, dialogScroll: 0 });
    await expect(active).toBeInViewport({ ratio: 1 });
    // Choosing another file keeps it in view too.
    await nav.getByRole('button', { name: 'agent/assistente.md' }).click();
    await expect(nav.getByRole('button', { name: 'agent/assistente.md' })).toBeInViewport({
      ratio: 1,
    });
  });
