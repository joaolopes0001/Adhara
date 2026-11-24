import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, readable, sessionHeaders, toneColor } from './helpers';
import { runMoreAction } from './more-menu';

// Complete "Alterações" flow: files created, altered and deleted outside the interface; the panel says
// the app does not reread by itself; "Reler agora" inside the panel reads the disk; the three file changes
// and their consequences (one observation resolved, one new) appear; adopting the reading empties the delta.
const files: Record<string, string> = {
  'AGENTS.md': '# Pacote\n[Contrato](contrato.md)\n[Novo](novo.md)\n[Apagar](apagar.md)\n',
  'contrato.md': '# Contrato\n',
  'apagar.md': '# Apagar\n',
};

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-changes-flow-')), 'pacote');
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

// openOnly of helpers.ts for one root, without returning the function that closes it.
async function openOnly(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
}

/** Text color against the first opaque background up the tree. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: false, bottom: false, bottomHeight: 470 }),
      );
  });
});

test('changes flow: edits outside, the panel asks for a reading, "Reler agora" shows the three file changes and their observations, adopting empties it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = fixture();
  try {
    await openOnly(page, root);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // The top button has a visible label and a tooltip saying the app does not reread by itself.
    const top = page.getByRole('button', { name: 'Reler diretórios', exact: true });
    await expect(top).toContainText('Reler');
    await expect(top).toHaveAttribute('title', /não relê sozinho/);

    // Edits made in another program: one file altered, one created, one deleted.
    writeFileSync(join(root, 'contrato.md'), '# Contrato\nNova cláusula.\n');
    writeFileSync(join(root, 'novo.md'), '# Novo\n');
    rmSync(join(root, 'apagar.md'));

    // Nothing was reread yet: the panel says only that; the times are in its header, next to the button.
    await page.getByRole('button', { name: 'Alterações', exact: true }).click();
    const empty = page.locator('.changes-empty');
    await expect(empty).toHaveText('Nenhuma alteração.');
    // A state is said by its words: no "i" before them.
    await expect(empty.locator('svg')).toHaveCount(0);
    await expect(page.locator('.changes-times')).toContainText('Leitura atual:');
    const reread = page.locator('.tool-panel').getByRole('button', { name: 'Reler agora' });
    await expect(reread).toBeVisible();
    await expect(reread).not.toHaveAttribute('title', /.*/);
    // No fixed method note on the panel: what the comparison is and the technical identity
    // (compare-audit) are in a collapsed detail.
    await expect(page.locator('.changes-content > .audit-note')).toHaveCount(0);
    const about = page.locator('.changes-about');
    await expect(about).not.toHaveAttribute('open', /.*/);
    await expect(about).toContainText(
      'Compara a leitura de referência com a última leitura do disco; não indica quem alterou nem por quê.',
    );
    await expect(about.locator('code')).toBeHidden();
    await expect(about).toContainText('aae compare-audit');
    for (const [theme, next] of [
      ['dark', 'claro'],
      ['light', 'escuro'],
    ]) {
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const selector of [
        '.changes-reread',
        '.changes-empty span',
        '.changes-about summary',
        '.reread-button',
      ])
        expect(
          await readable(page.locator(selector).first()),
          `${selector} (${theme})`,
        ).toBeGreaterThanOrEqual(4.5);
      await page
        .locator('.tool-panel')
        .screenshot({ path: test.info().outputPath(`changes-needs-reading-${theme}.png`) });
      await runMoreAction(page, `Ativar tema ${next}`);
    }

    // "Reler agora" is the same reading as the top button; with the tool open no extra notice is needed.
    const reading = page.waitForResponse((response) => response.url().endsWith('/api/refresh'));
    await reread.click();
    expect((await reading).status()).toBe(200);
    await expect(reread).toBeEnabled();
    await expect(page.locator('.change-notice')).toHaveCount(0);
    await expect(empty).toHaveCount(0);

    const changed = page.locator('.changes-section[aria-label="Arquivos"] .change-row');
    await expect(changed).toHaveText([
      /alterado.*contrato\.md/,
      /adicionado.*novo\.md/,
      /removido.*apagar\.md/,
    ]);
    await expect(page.locator('.changes-section[aria-label="Arquivos"] h3')).toContainText(
      '1 alterado · 1 adicionado · 1 removido',
    );
    // Consequences: the link to the created file is resolved, the one to the deleted file is new.
    const observations = page.locator('.changes-section[aria-label="Observações"] .change-row');
    await expect(observations).toHaveCount(2);
    const fresh = observations.filter({ has: page.locator('.change-tag.added') });
    const resolved = observations.filter({ has: page.locator('.change-tag.removed') });
    // The short line of the audit: the destination as written, not the reader message.
    await expect(fresh).toContainText('apagar.md');
    await expect(fresh).not.toContainText('Destino não encontrado');
    await expect(resolved).toContainText('novo.md');
    // A new observation and a removed file are said by their words, in the colour of the text: the
    // warning tone is for warnings only. A resolved one takes the calm tone of an added file.
    const color = (locator: import('@playwright/test').Locator) =>
      locator.first().evaluate((element) => getComputedStyle(element).color);
    const fileSection = page.locator('.changes-section[aria-label="Arquivos"]');
    const text = await page.evaluate(() => getComputedStyle(document.body).color);
    for (const word of [fresh.locator('.change-tag'), fileSection.locator('.change-tag.removed')]) {
      expect(await color(word)).toBe(text);
      expect(await color(word)).not.toBe(await toneColor(page, 'warning'));
    }
    expect(await color(resolved.locator('.change-tag'))).toBe(
      await color(fileSection.locator('.change-tag.added')),
    );
    // The observation code is named in Portuguese; the code itself only in the tooltip.
    await expect(fresh.locator('.change-code')).toHaveText('Referência ausente');
    await expect(fresh.locator('.change-code')).toHaveAttribute('title', /broken/);
    await expect(page.locator('.changes-section[aria-label="Observações"]')).not.toContainText(
      'broken',
    );
    await expect(page.locator('.dock-tools .dock-count')).toHaveText('5');
    // A non-empty delta can always become the reference. Whether this reading shares the second of the
    // reference depends on timing here; changes-reference.spec.ts forces the same second deterministically.
    await expect(page.getByRole('button', { name: 'Atualizar referência' })).toBeEnabled();
    for (const [theme, next] of [
      ['dark', 'claro'],
      ['light', 'escuro'],
    ]) {
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(
        await readable(page.locator('.change-code').first()),
        `.change-code (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
      await page
        .locator('.tool-panel')
        .screenshot({ path: test.info().outputPath(`changes-flow-${theme}.png`) });
      await runMoreAction(page, `Ativar tema ${next}`);
    }

    // The new observation opens the file at the line of the reference to the deleted file.
    await fresh.click();
    await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
    await expect(page.locator('.highlight-line')).toContainText('[Apagar](apagar.md)');

    // Adopting the current reading empties the delta and the dock count.
    await page.getByRole('button', { name: 'Atualizar referência' }).click();
    await expect(page.locator('.changes-confirmation')).toContainText(
      'Referência atualizada: leitura de',
    );
    await expect(empty).toHaveText('Nenhuma alteração.');
    await expect(page.locator('.changes-section')).toHaveCount(0);
    await expect(page.locator('.dock-tools .dock-count')).toHaveCount(0);
    // The interface never wrote into the inspected root.
    expect(readFileSync(join(root, 'contrato.md'), 'utf8')).toBe('# Contrato\nNova cláusula.\n');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(files['AGENTS.md']);
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/close', {
      headers: await sessionHeaders(page),
      data: { path: root },
    });
  }
});
