import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectFile, writeTree } from './helpers';
import { editorText, outcome, permissionDialog, startEditing } from './edit-helpers';

// Editing against a server of each test's own (`--port 0`, temporary state), so that it can be restarted
// with the same state and given a protection list: the permission survives a reload and a restart and
// goes when turned off or the project is forgotten; a restarted server (new session token) is reached
// again without losing a draft or an annotation; a protected project or folder refuses with the server's
// explanation and nothing is written; what only the server knows (a hard link, a binary file) is its
// message when Editar is clicked.

async function startServer(state: string, port = 0) {
  const child = spawn('python3', ['server/main.py', '--port', String(port), '--state-dir', state], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`O servidor não iniciou: ${output}`)), 20000);
    child.stdout!.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`O servidor terminou (${code}): ${output}`));
    });
  });
  return { child, url, port: Number(url.split(':').at(-1)) };
}
async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}
async function api(page: Page, url: string, route: string, data: unknown) {
  const { token } = await (await page.request.get(`${url}/api/session`)).json();
  return page.request.post(`${url}/api/${route}`, { headers: { 'X-AAE-Token': token }, data });
}

test.beforeEach(async ({ page }) => {
  // TRANSITIONAL, as in expected-observations.spec.ts: the suite's storageState only reaches its own server.
  await page.addInitScript(() => {
    localStorage.setItem('aae-lang', 'pt');
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: true, bottom: false, bottomHeight: 420 }),
      );
  });
});

test('edit with a server of its own: the permission survives a reload and a restart; after a restart the session is renewed and a draft and an annotation are saved; turning off and forgetting end it', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = mkdtempSync(join(tmpdir(), 'aae-edit-server-'));
  const root = join(base, 'projeto');
  const state = join(base, 'state');
  mkdirSync(state);
  writeTree(root, { 'AGENTS.md': '# Projeto\n[Doc](doc.md)\n', 'doc.md': '# Doc\n\nAntes.\n' });
  let server = await startServer(state);
  try {
    expect((await api(page, server.url, 'open', { path: root })).status()).toBe(200);
    await page.goto(server.url);
    const bar = page.locator('.status-bar');
    await selectFile(page, join(root, 'doc.md'));
    await startEditing(page, 'doc.md', { allow: true });
    await expect(bar.locator('[data-key="editing"]')).toHaveText('Edição ligada: projeto');
    // A reload: still on (the server keeps it); nothing asks for it again.
    await page.reload();
    await expect(bar.locator('[data-key="editing"]')).toHaveText('Edição ligada: projeto');
    await selectFile(page, join(root, 'doc.md'));
    await startEditing(page, 'doc.md');
    await editorText(page, 'doc.md').fill('# Doc\n\nDepois do reinício.\n');
    // An annotation typed too.
    await page.locator('.inspector').getByRole('button', { name: 'Anotações' }).click();
    await page.getByLabel('Anotação do arquivo').fill('Nota depois do reinício');

    // The server restarts on the same port with the same state: another process, another token.
    await stopServer(server.child);
    server = await startServer(state, server.port);
    // The annotation saves: the refused session is renewed and the request repeated once.
    await page.getByRole('button', { name: 'Salvar anotação' }).click();
    await expect(page.locator('.note-editor .save-status')).toHaveText('Salvo neste computador');
    // The document saves too, with the text kept.
    await page.locator('.inspector').getByRole('button', { name: 'Arquivo', exact: true }).click();
    await expect(editorText(page, 'doc.md')).toHaveValue('# Doc\n\nDepois do reinício.\n');
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Gravado · +1 −1');
    expect(readFileSync(join(root, 'doc.md'), 'utf8')).toBe('# Doc\n\nDepois do reinício.\n');
    // The report comes from the reading asked after the save, never from the new
    // server's snapshot (read when it started, before the save): no false "changed again".
    // The reading is done and says nothing else: no part of the sentence and no warning.
    await expect(outcome(page).locator('.editor-status-text')).toHaveText('Gravado · +1 −1');
    await expect(outcome(page).locator('.tone-warning')).toHaveCount(0);
    await expect(outcome(page).locator('.editor-status-more')).toHaveCount(0);
    await expect(outcome(page)).not.toContainText('mudou de novo');
    // Once more with the server killed (SIGKILL) and back: the same.
    await page.getByLabel('Texto de doc.md').fill('# Doc\n\nDepois do segundo reinício.\n');
    server.child.kill('SIGKILL');
    await new Promise((resolve) => server.child.once('exit', resolve));
    server = await startServer(state, server.port);
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page).locator('.editor-status-text')).toHaveText('Gravado · +1 −1');
    await expect(outcome(page).locator('.tone-warning')).toHaveCount(0);
    await expect(outcome(page).locator('.editor-status-more')).toHaveCount(0);
    await expect(outcome(page)).not.toContainText('mudou de novo');
    expect(readFileSync(join(root, 'doc.md'), 'utf8')).toBe(
      '# Doc\n\nDepois do segundo reinício.\n',
    );
    // The permission survived the restart, and the restarted server has the annotation.
    await expect(bar.locator('[data-key="editing"]')).toHaveText('Edição ligada: projeto');
    const { token } = await (await page.request.get(`${server.url}/api/session`)).json();
    const snapshot = await (
      await page.request.get(`${server.url}/api/workspace`, { headers: { 'X-AAE-Token': token } })
    ).json();
    expect(Object.keys(snapshot.editing)).toEqual([root]);
    expect(snapshot.notes[join(root, 'doc.md')]).toBe('Nota depois do reinício');
    // The state keeps the permission and never a document's text.
    const saved = readFileSync(join(state, 'workspace.json'), 'utf8');
    expect(saved).toContain('"editing"');
    expect(saved).not.toContain('Depois do reinício.');

    // Turned off in the bar: read-only after a reload too.
    await page.getByRole('button', { name: 'Fechar editor' }).click();
    await bar.getByRole('button', { name: 'Edição ligada: projeto' }).click();
    await page.getByRole('menuitem', { name: 'Desligar edição em projeto' }).click();
    await expect(bar.locator('[data-key="readonly"]')).toBeVisible();
    await page.reload();
    await expect(bar.locator('[data-key="readonly"]')).toBeVisible();

    // On again, then the project closed and forgotten: opened again, it is read-only.
    await selectFile(page, join(root, 'doc.md'));
    await startEditing(page, 'doc.md', { allow: true });
    expect((await api(page, server.url, 'close', { path: root })).status()).toBe(200);
    expect((await api(page, server.url, 'forget', { path: root })).status()).toBe(200);
    expect((await api(page, server.url, 'open', { path: root })).status()).toBe(200);
    await page.reload();
    await expect(bar.locator('[data-key="readonly"]')).toBeVisible();
    await expect(bar.locator('[data-key="editing"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server.child);
  }
});

test('edit with a server of its own: a protected project refuses with the explanation, a protected folder and what only the server knows refuse when Editar is clicked; nothing is written', async ({
  page,
}) => {
  const base = mkdtempSync(join(tmpdir(), 'aae-edit-protected-'));
  const guarded = join(base, 'guardado');
  const open = join(base, 'aberto');
  const state = join(base, 'state');
  mkdirSync(state);
  writeTree(guarded, { 'AGENTS.md': '# Guardado\n[Doc](doc.md)\n', 'doc.md': '# Doc\n' });
  writeTree(open, {
    'AGENTS.md': '# Aberto\n[P](privado/p.md)\n[L](ligado.md)\n[B](binario.md)\n',
    'privado/p.md': '# Privado\n',
    'ligado.md': '# Ligado\n',
    'binario.md': '# Binário\n\u0000\n',
  });
  linkSync(join(open, 'ligado.md'), join(base, 'outro-nome.md'));
  // The list of the server's state: the whole project, and a folder inside the other one.
  writeFileSync(join(state, 'protected-paths.txt'), `${guarded}\n${join(open, 'privado')}\n`);
  const server = await startServer(state);
  const before = (path: string) => readFileSync(path, 'utf8');
  try {
    for (const path of [guarded, open])
      expect((await api(page, server.url, 'open', { path })).status()).toBe(200);
    await page.goto(server.url);

    // The protected project: the permission is refused, with what taking it off the list would allow.
    await selectFile(page, join(guarded, 'doc.md'));
    await page.locator('.inspector .edit-button').click();
    const dialog = permissionDialog(page, 'guardado');
    await dialog.getByRole('button', { name: 'Permitir edição' }).click();
    await expect(dialog.getByRole('alert')).toContainText('A edição também respeita essa lista.');
    await expect(dialog.getByRole('alert')).toContainText(
      'A proteção vale também para você aqui no aplicativo.',
    );
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.locator('.file-editor')).toHaveCount(0);
    await expect(page.locator('.status-bar [data-key="readonly"]')).toBeVisible();

    // The other project allows it; its protected folder is refused file by file, when Editar is clicked.
    await selectFile(page, join(open, 'privado/p.md'));
    await page.locator('.inspector .edit-button').click();
    await permissionDialog(page, 'aberto').getByRole('button', { name: 'Permitir edição' }).click();
    // The server's refusal: a note above the text (icon in the problem tone, normal text, no box).
    const refusal = page.locator('.inspector-scroll > .edit-note[role="alert"]');
    await expect(refusal).toContainText('A edição também respeita essa lista.');
    await expect(page.locator('.file-editor')).toHaveCount(0);
    // A hard link and a binary file: the server's message, as it came.
    await selectFile(page, join(open, 'ligado.md'));
    await page.locator('.inspector .edit-button').click();
    await expect(refusal).toHaveText(
      'O arquivo tem mais de um nome (link físico); gravar separaria os nomes.',
    );
    await selectFile(page, join(open, 'binario.md'));
    await page.locator('.inspector .edit-button').click();
    await expect(refusal).toHaveText('O arquivo tem byte nulo: parece binário.');
    await expect(page.locator('.file-editor')).toHaveCount(0);
    // Nothing was written anywhere.
    expect(before(join(guarded, 'doc.md'))).toBe('# Doc\n');
    expect(before(join(open, 'privado/p.md'))).toBe('# Privado\n');
    expect(before(join(open, 'ligado.md'))).toBe('# Ligado\n');
  } finally {
    await stopServer(server.child);
  }
});

test('edit with a server of its own: the server stopped when Gravar is clicked; the screen never says saved, the text stays, and when the server is back the window checks the disk by itself', async ({
  page,
}) => {
  test.setTimeout(90000);
  const base = mkdtempSync(join(tmpdir(), 'aae-edit-down-'));
  const root = join(base, 'projeto');
  const state = join(base, 'state');
  mkdirSync(state);
  writeTree(root, { 'AGENTS.md': '# Projeto\n[Doc](doc.md)\n', 'doc.md': '# Doc\n\nAntes.\n' });
  let server = await startServer(state);
  try {
    expect((await api(page, server.url, 'open', { path: root })).status()).toBe(200);
    expect((await api(page, server.url, 'edit/enable', { root })).status()).toBe(200);
    await page.goto(server.url);
    await selectFile(page, join(root, 'doc.md'));
    await startEditing(page, 'doc.md');
    await editorText(page, 'doc.md').fill('# Doc\n\nCom o servidor parado.\n');
    // Really stopped: the save gets no answer, and neither does the read that checks it.
    await stopServer(server.child);
    await page.getByRole('button', { name: 'Gravar', exact: true }).click();
    await expect(outcome(page)).toContainText('Sem resposta do servidor');
    await expect(outcome(page).locator('.editor-status-text')).toHaveAttribute(
      'title',
      'Sem resposta do servidor. Seu texto continua nesta janela.',
    );
    await expect(outcome(page)).not.toContainText('Gravado');
    await expect(editorText(page, 'doc.md')).toHaveValue('# Doc\n\nCom o servidor parado.\n');
    expect(readFileSync(join(root, 'doc.md'), 'utf8')).toBe('# Doc\n\nAntes.\n');
    // Back on the same port (a new token): the window reads the file by itself, renews the session and
    // says what the disk has.
    server = await startServer(state, server.port);
    await expect(outcome(page)).toContainText('Não gravado; o disco não mudou', {
      timeout: 15000,
    });
    await outcome(page).getByRole('button', { name: 'Gravar' }).click();
    await expect(outcome(page)).toContainText('Gravado · +1 −1');
    expect(readFileSync(join(root, 'doc.md'), 'utf8')).toBe('# Doc\n\nCom o servidor parado.\n');
  } finally {
    await stopServer(server.child);
  }
});
