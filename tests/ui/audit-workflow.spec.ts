import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionHeaders } from './helpers';
import { runProjectsAction } from './more-menu';

function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

async function laboratory(page: Page) {
  const base = mkdtempSync(join(tmpdir(), 'aae-round2-workflow-'));
  const root = join(base, 'agente-atlas');
  mkdirSync(root);
  const files = {
    'AGENTS.md': '# Atlas\n[Revisão](review.md)\n',
    'review.md': '# Revisão independente\n[Política](policy.md)\n',
    'policy.md': '# Política sintética\nExigir evidências e revisão humana.\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const headers = await sessionHeaders(page);
  const model = await (await page.request.get('/api/workspace', { headers })).json();
  for (const previous of model.roots)
    await page.request.post('/api/close', { headers, data: { path: previous.path } });
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  // Opening selects no file (structure first); these scenarios start from AGENTS.md, chosen here.
  await expect(page.getByRole('region', { name: 'Estrutura de agente-atlas' })).toBeVisible();
  await page.locator('.explorer').getByTitle(join(root, 'AGENTS.md'), { exact: true }).click();
  await expect(page.locator('.inspector h2')).toHaveText('AGENTS.md');
  return {
    root,
    headers,
    async select(name: string) {
      await page.locator('.explorer').getByTitle(join(root, name), { exact: true }).click();
      await expect(page.locator('.inspector h2')).toHaveText(name);
    },
    async notes(name = 'AGENTS.md') {
      await this.select(name);
      await page.getByRole('button', { name: 'Anotações', exact: true }).click();
    },
    async saved(name = 'AGENTS.md') {
      return (await (await page.request.get('/api/workspace', { headers })).json()).notes[
        join(root, name)
      ];
    },
    async verify() {
      for (const [name, text] of Object.entries(files))
        expect(readFileSync(join(root, name), 'utf8')).toBe(text);
      await page.request.post('/api/close', { headers, data: { path: root } });
    },
  };
}

test('audit workflow: failed note save is explicit, preserves drafts and recovers without changing inspected files', async ({
  page,
}) => {
  const lab = await laboratory(page);
  await lab.notes();
  await page.getByLabel('Anotação do arquivo').fill('Revisar a política antes de promover Atlas.');
  await page.route('**/api/note', (route) =>
    route.fulfill({ status: 503, json: { error: 'Servidor temporariamente indisponível' } }),
  );
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toContainText(
    'Erro: Servidor temporariamente indisponível',
  );
  await page.screenshot({ path: test.info().outputPath('save-failure-visible.png') });
  expect(await lab.saved()).toBeUndefined();
  await lab.notes('review.md');
  await page.getByLabel('Anotação do arquivo').fill('Rascunho independente da revisão.');
  await lab.notes();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Revisar a política antes de promover Atlas.',
  );
  await page.unroute('**/api/note');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
  expect(await lab.saved()).toBe('Revisar a política antes de promover Atlas.');
  expect(await lab.saved('review.md')).toBeUndefined();
  await lab.notes('review.md');
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Rascunho independente da revisão.',
  );
  await page.screenshot({ path: test.info().outputPath('draft-recovered.png') });
  await lab.verify();
});

test('audit workflow: delayed saves cannot race; edits and selection changes preserve the latest draft', async ({
  page,
}) => {
  const lab = await laboratory(page);
  await lab.notes();
  const pending = gate(),
    arrived = gate();
  let count = 0;
  await page.route('**/api/note', async (route) => {
    count++;
    if (count === 1) {
      arrived.release();
      await pending.promise;
    }
    await route.continue();
  });
  await page.getByLabel('Anotação do arquivo').fill('Primeira revisão');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await arrived.promise;
  try {
    await expect(page.locator('.save-status')).toHaveText('Salvando…');
    await page.screenshot({ path: test.info().outputPath('save-pending-visible.png') });
    await page.getByLabel('Anotação do arquivo').fill('Revisão final com ressalvas');
    await expect(page.getByRole('button', { name: 'Salvar anotação' })).toBeDisabled();
    await lab.notes('review.md');
    await page.getByLabel('Anotação do arquivo').fill('Outra revisão');
    await page.getByRole('button', { name: 'Salvar anotação' }).click();
    await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
    await lab.notes();
    await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('Revisão final com ressalvas');
    await expect(page.getByRole('button', { name: 'Salvar anotação' })).toBeDisabled();
  } finally {
    pending.release();
  }
  await expect(page.getByRole('button', { name: 'Salvar anotação' })).toBeEnabled();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('Revisão final com ressalvas');
  await expect(page.locator('.save-status')).toHaveText('Alterações não salvas');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
  expect(await lab.saved()).toBe('Revisão final com ressalvas');
  expect(await lab.saved('review.md')).toBe('Outra revisão');
  expect(count).toBe(3);
  await lab.verify();
});

test('audit workflow: stale reads and failed refresh do not replace selection or discard drafts', async ({
  page,
}) => {
  const lab = await laboratory(page);
  await lab.notes();
  await page
    .getByLabel('Anotação do arquivo')
    .fill('Rascunho preservado durante indisponibilidade');
  const pending = gate(),
    arrived = gate();
  await page.route('**/api/content?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('path') === join(lab.root, 'review.md')) {
      arrived.release();
      await pending.promise;
      await route.fulfill({ status: 503, json: { error: 'Leitura antiga falhou' } });
    } else await route.continue();
  });
  await lab.select('review.md');
  await arrived.promise;
  await lab.select('policy.md');
  await expect(page.locator('.source-code')).toContainText('Exigir evidências');
  pending.release();
  await page.route('**/api/refresh', (route) =>
    route.fulfill({ status: 503, json: { error: 'Releitura indisponível' } }),
  );
  await page.getByRole('button', { name: 'Reler diretórios' }).click();
  await expect(page.getByText('Releitura indisponível', { exact: true })).toBeVisible();
  await expect(page.locator('.inspector h2')).toHaveText('policy.md');
  await expect(page.locator('.source-code')).toContainText('Exigir evidências');
  await expect(page.getByText('Leitura antiga falhou', { exact: true })).toHaveCount(0);
  await lab.notes();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Rascunho preservado durante indisponibilidade',
  );
  await page.unroute('**/api/refresh');
  await page.getByRole('button', { name: 'Reler diretórios' }).click();
  await expect(page.getByRole('button', { name: 'Reler diretórios' })).toBeEnabled();
  await expect(page.getByText('Releitura indisponível', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Rascunho preservado durante indisponibilidade',
  );
  await lab.verify();
});

test('audit workflow: late arrival must never overwrite the last persisted revision', async ({
  page,
}) => {
  const lab = await laboratory(page);
  await lab.notes();
  const pending = gate(),
    arrived = gate();
  let requests = 0;
  await page.route('**/api/note', async (route) => {
    if (++requests === 1) {
      arrived.release();
      await pending.promise;
    }
    await route.continue();
  });
  await page.getByLabel('Anotação do arquivo').fill('Revisão anterior');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await arrived.promise;
  await page.getByLabel('Anotação do arquivo').fill('Última revisão aprovada');
  const save = page.getByRole('button', { name: 'Salvar anotação' });
  try {
    // The old UI accepts an overlapping save. Exercise the real persisted result,
    // so a fix that only hides the stale acknowledgement cannot pass this test.
    if (await save.isEnabled()) {
      await save.click();
      await expect.poll(() => lab.saved()).toBe('Última revisão aprovada');
      pending.release();
      await expect.poll(() => lab.saved()).toBe('Revisão anterior');
    } else {
      pending.release();
      await expect(save).toBeEnabled();
      await save.click();
    }
    await expect.poll(() => lab.saved()).toBe('Última revisão aprovada');
    await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('Última revisão aprovada');
  } finally {
    pending.release();
  }
  await lab.verify();
});

test('audit workflow: late failure stays with its file, preserves newer edits and allows clearing a saved note', async ({
  page,
}) => {
  const lab = await laboratory(page);
  await lab.notes();
  await page.getByLabel('Anotação do arquivo').fill('Anotação inicial persistida');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
  const pending = gate(),
    arrived = gate(),
    completed = gate();
  await page.route('**/api/note', async (route) => {
    arrived.release();
    await pending.promise;
    await route.fulfill({ status: 503, json: { error: 'Gravação recusada no teste' } });
    completed.release();
  });
  await page.getByLabel('Anotação do arquivo').fill('Versão enviada que falhará');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await arrived.promise;
  await page.getByLabel('Anotação do arquivo').fill('Rascunho posterior à requisição');
  await lab.notes('policy.md');
  pending.release();
  await completed.promise;
  await expect(page.locator('.save-status')).toHaveText('');
  await lab.notes();
  await expect(page.locator('.save-status')).toContainText('Erro: Gravação recusada no teste');
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Rascunho posterior à requisição',
  );
  expect(await lab.saved()).toBe('Anotação inicial persistida');
  expect(await lab.saved('policy.md')).toBeUndefined();
  await page.unroute('**/api/note');
  await page.getByLabel('Anotação do arquivo').fill('');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
  expect(await lab.saved()).toBe('');
  await lab.notes('policy.md');
  await lab.notes();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue('');
  await lab.verify();
});

test('audit workflow: refresh snapshot captured before save cannot erase a confirmed note', async ({
  page,
}) => {
  const lab = await laboratory(page);
  await lab.notes();
  const pending = gate(),
    captured = gate(),
    delivered = gate();
  await page.route('**/api/refresh', async (route) => {
    const snapshot = await route.fetch();
    captured.release();
    await pending.promise;
    await route.fulfill({ response: snapshot });
    delivered.release();
  });
  await page.getByRole('button', { name: 'Reler diretórios' }).click();
  await captured.promise;
  await page.getByLabel('Anotação do arquivo').fill('Salva depois do snapshot de releitura');
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
  expect(await lab.saved()).toBe('Salva depois do snapshot de releitura');
  pending.release();
  await delivered.promise;
  await expect(page.getByRole('button', { name: 'Reler diretórios' })).toBeEnabled();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Salva depois do snapshot de releitura',
  );
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');
  await page.unroute('**/api/refresh');
  await page.request.post('/api/note', {
    headers: lab.headers,
    data: { node: join(lab.root, 'AGENTS.md'), body: 'Alteração legítima externa posterior' },
  });
  await page.getByRole('button', { name: 'Reler diretórios' }).click();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Alteração legítima externa posterior',
  );
  await lab.verify();
});
