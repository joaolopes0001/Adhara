import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTab, openAllAuditFiles, showAudit } from './audit-list';
import { enterProject, inBothThemes, selectFile, writeTree } from './helpers';

// "Marcar como esperada", end to end on a server of its own (port chosen by the system, temporary state),
// so the server can be restarted with the same state: mark with a reason (the item leaves the active counts
// and goes to "Esperadas"), lines inserted above and Reler keep the mark, a new observation already marked
// is "esperada" in Alterações, a new written destination brings it back as active and leaves the old mark
// orphan, undo, and the mark survives a restart. The declared-scope snippet is offered for a missing
// destination and never for an ambiguity.
const files: Record<string, string> = {
  'CLAUDE.md':
    '# Loja\n[Guia](docs/guia.md)\n[Relatório](out/relatorio.md) e [Falta](docs/falta.md)\n',
  'docs/guia.md': '# Guia\n[c](c.md)\n',
  'notas/c.md': '# c\n',
  'outros/c.md': '# c\n',
  'notas/solto.md': '# Solto\n',
};

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'aae-expected-'));
  const root = join(base, 'loja');
  writeTree(root, files);
  const state = join(base, 'state');
  mkdirSync(state);
  return { base, root, state };
}

/** A server of this test only: `--port 0`, the URL printed at start, request logs discarded. */
async function startServer(state: string) {
  const child = spawn('python3', ['server/main.py', '--port', '0', '--state-dir', state], {
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
  return { child, url };
}
async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

/** Text color against the first opaque background up the tree. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('aae-layout'))
      localStorage.setItem(
        'aae-layout',
        JSON.stringify({ inspector: false, bottom: false, bottomHeight: 520 }),
      );
  });
});

test('mark as expected: out of the active counts into "Esperadas", survives lines above and a restart, comes back when the destination changes, undo, and the scope snippet', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { base, root, state } = fixture();
  const claude = join(root, 'CLAUDE.md');
  // TRANSITIONAL, as the storageState of playwright.config.ts, which only reaches the suite's server:
  // the server of this test has another origin.
  await page.addInitScript(() => localStorage.setItem('aae-lang', 'pt'));
  let server = await startServer(state);
  try {
    const { token } = await (await page.request.get(`${server.url}/api/session`)).json();
    expect(
      (
        await page.request.post(`${server.url}/api/open`, {
          headers: { 'X-AAE-Token': token },
          data: { path: root },
        })
      ).status(),
    ).toBe(200);
    await page.goto(server.url);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Home lists the projects, without the explorer: the tree is in the project.
    await enterProject(page);
    const explorer = page.locator('.explorer');
    const treeRow = (path: string) =>
      explorer.locator('.tree-file-row', { has: page.getByTitle(path, { exact: true }) });
    const chips = explorer.getByRole('group', { name: 'Filtrar arquivos por classe' });
    const footer = page.locator('.status-bar .status-link');
    const audit = page.locator('.audit-content');
    const summary = audit.locator('.audit-summary');
    const total = auditTab(page, 'Todas');
    /** Opens the line of the audit whose accessible name starts with `subject` (one line open at a time). */
    const openLine = async (subject: string) => {
      await openAllAuditFiles(page);
      const escaped = subject.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      const line = audit.getByRole('button', {
        name: new RegExp(`^(Ver|Fechar) detalhe: ${escaped}`),
      });
      if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click();
    };
    const expectedSection = audit.locator('details.audit-expected:not(.audit-orphans)');
    const orphans = audit.locator('details.audit-orphans');
    const reread = async () => {
      const reading = page.waitForResponse((response) => response.url().endsWith('/api/refresh'));
      await page.getByRole('button', { name: 'Reler diretórios', exact: true }).click();
      expect((await reading).status()).toBe(200);
    };

    // Before: 6 observations in 5 files, 2 unresolved destinations, CLAUDE.md with 2.
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await showAudit(page, 'Todas');
    await expect(total).toHaveText('Todas 6');
    await expect(summary).not.toContainText('esperada');
    await expect(treeRow(claude).locator('.observation-marker')).toHaveText('2');
    await expect(chips.getByRole('button', { name: /^Com observações/ })).toHaveText(
      'Com observações · 5',
    );
    await expect(footer).toHaveText('2 citados não encontrados');
    await expect(expectedSection).toHaveCount(0);

    // Two references on the same line: the accessible name of each line says code and destination; the
    // action lives in the open line, and says the same.
    await expect(
      audit.getByRole('button', {
        name: 'Ver detalhe: Referência ausente (docs/falta.md) em CLAUDE.md:3',
      }),
    ).toBeVisible();
    await expect(audit.locator('.expected-button')).toHaveCount(0);
    await openLine('Referência ausente (out/relatorio.md) em CLAUDE.md:3');
    const markRelatorio = audit.getByRole('button', {
      name: 'Marcar como esperada: Referência ausente (out/relatorio.md) em CLAUDE.md:3',
    });
    // Escape cancels the inline form without marking anything.
    await markRelatorio.click();
    const form = audit.getByRole('form', {
      name: 'Marcar como esperada: Referência ausente (out/relatorio.md) em CLAUDE.md:3',
    });
    await expect(form.getByLabel('Motivo (opcional)')).toBeFocused();
    // 500 characters counted as the server counts them (code points): an emoji is one.
    await form.getByLabel('Motivo (opcional)').fill('😀'.repeat(501));
    await expect(form).toContainText('500/500');
    await expect(form.getByLabel('Motivo (opcional)')).toHaveValue('😀'.repeat(500));
    // One sentence: where the mark holds.
    await expect(form.locator('p')).toHaveText(['Só neste aplicativo; a CLI continua relatando.']);
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    // Cancelled, the focus goes back to the button that opened the form.
    await expect(markRelatorio).toBeFocused();
    await expect(total).toHaveText('Todas 6');

    // 1. Mark with a reason: out of the main list and the counts, into "Esperadas" (collapsed).
    await markRelatorio.click();
    await expect(form.getByLabel('Motivo (opcional)')).toHaveValue('');
    await form.getByLabel('Motivo (opcional)').fill('Criado pelo agente durante a execução');
    await expect(form).toContainText('37/500');
    await inBothThemes(
      page,
      ['.expected-form label', '.expected-form > p', '.expected-form-field small'],
      'expected-form',
    );
    await form.getByRole('button', { name: 'Marcar como esperada', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(audit.locator('.audit-expected-status')).toHaveText(
      'Marcada como esperada: Referência ausente (out/relatorio.md) em CLAUDE.md:3.',
    );
    await expect(total).toHaveText('Todas 5');
    await expect(summary).toContainText('1 esperada');
    await expect(summary).not.toContainText('sem observação correspondente');
    await expect(markRelatorio).toHaveCount(0);
    await expect(treeRow(claude).locator('.observation-marker')).toHaveText('1');
    await expect(footer).toHaveText('1 citado não encontrado (+1 esperado)');
    await expect(footer).toHaveAttribute('title', /todas marcadas como esperadas/);
    // The CLI still reports it: the note says so.
    await expect(audit.locator('.audit-cli-note')).toContainText(
      'conta 6: estas 5 observações e 1 marcada como esperada neste app',
    );
    // The footer link opens the unresolved references; its note says why the count went down.
    await footer.click();
    const note = audit.locator('.unresolved-note');
    await expect(note).toContainText('Rodapé: 1 destino distinto');
    await expect(note).toContainText(
      '1 destino cujas referências foram todas marcadas como esperadas fica fora da contagem',
    );
    await expect(page.getByLabel('Tipo de observação')).toHaveValue('unresolved-targets');
    await page.getByLabel('Tipo de observação').selectOption('');
    await expect(total).toHaveText('Todas 5');
    await expect(expectedSection.locator('summary')).toContainText('Esperadas (1)');
    await expect(expectedSection).not.toHaveAttribute('open', /.*/);
    await expectedSection.locator('summary').click();
    const marked = expectedSection.locator('.audit-expected-item');
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText('Referência ausente · out/relatorio.md');
    await expect(marked.locator('.expected-note')).toHaveText(
      /^Marcada como esperada em \d{2}\/\d{2}\/\d{4}: “?Criado pelo agente durante a execução”?Desmarcar$/,
    );
    // Marked, it is still explained, with "Declarar no projeto".
    await marked
      .getByRole('button', {
        name: 'Ver detalhe: Referência ausente (out/relatorio.md) em CLAUDE.md:3',
      })
      .click();
    // The declaration is closed until clicked, as in the open line.
    await expect(marked.locator('.diagnosis-scope')).toHaveCount(0);
    await marked.getByRole('button', { name: 'Declarar no projeto…' }).click();
    await expect(marked.locator('.diagnosis-scope .scope-choice')).toBeVisible();
    await marked.getByRole('button', { name: /^Ocultar detalhe/ }).click();
    // The reason goes to the app state only.
    expect(readFileSync(claude, 'utf8')).toBe(files['CLAUDE.md']);

    // From the inspector, by keyboard: the only observation of notas/solto.md (informative, so its group
    // starts collapsed, and the file has no marker); marked, it leaves its group.
    const solto = join(root, 'notas/solto.md');
    await explorer.getByRole('button', { name: 'Expandir pasta notas' }).click();
    await expect(treeRow(solto)).toBeVisible();
    await expect(treeRow(solto).locator('.observation-marker')).toHaveCount(0);
    await selectFile(page, solto);
    const block = page.locator('.inspector .file-observations');
    const group = block.locator('.observation-group', {
      has: page.locator('strong', { hasText: 'Sem caminho por referência explícita' }),
    });
    await expect(group.locator('.observation-group-head')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await group.locator('.observation-group-head').click();
    await group
      .getByRole('button', {
        name: 'Ver detalhe: Sem caminho por referência explícita em notas/solto.md',
      })
      .click();
    const inspectorMark = block.getByRole('button', {
      name: 'Marcar como esperada: Sem caminho por referência explícita em notas/solto.md',
      exact: true,
    });
    await inspectorMark.focus();
    await page.keyboard.press('Enter');
    await expect(block.getByLabel('Motivo (opcional)')).toBeFocused();
    // No v1 pattern says "not for the agent": no link to a declaration in the form.
    await expect(block.locator('.expected-scope-link')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(block.locator('.observations-count')).toHaveText(['1 marcada como esperada']);
    await expect(group).toHaveCount(0);
    // The marked group opens on the occurrence just marked, with the undo.
    const markedGroup = block.locator('.observation-group.expected');
    await expect(markedGroup.locator('.observation-group-head')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(block.locator('.file-observation.expected .expected-note')).toHaveText(
      /^Marcada como esperada em \d{2}\/\d{2}\/\d{4} \(sem motivo\)Desmarcar$/,
    );
    // Still explained after marking; for a plain file the declaration, opened on click, says why none fits.
    await expect(block.locator('.diagnosis-scope')).toHaveCount(0);
    await block.getByRole('button', { name: 'Declarar no projeto…' }).click();
    await expect(block.locator('.file-observation.expected .diagnosis-scope')).toContainText(
      'não tem como dizer que um arquivo não é para o agente',
    );
    await expect(treeRow(solto).locator('.observation-marker')).toHaveCount(0);
    await expect(chips.getByRole('button', { name: /^Com observações/ })).toHaveText(
      'Com observações · 4',
    );
    await expect(total).toHaveText('Todas 4');
    await expect(summary).toContainText('2 esperadas');

    // 2. Lines inserted above on disk, then Reler: still marked (the key has no line).
    writeFileSync(
      claude,
      readFileSync(claude, 'utf8').replace('# Loja\n', '# Loja\n\nUma linha nova.\nOutra.\n'),
    );
    await reread();
    await expect(total).toHaveText('Todas 4');
    await expect(expectedSection.locator('summary')).toContainText('Esperadas (2)');
    await expect(expectedSection.locator('.audit-expected-item').first()).toContainText(
      'CLAUDE.md:6',
    );
    await expect(orphans).toHaveCount(0);
    await expect(footer).toHaveText('1 citado não encontrado (+1 esperado)');

    // A new observation marked as expected is "esperada" in Alterações, in the neutral tone.
    writeFileSync(claude, readFileSync(claude, 'utf8') + '[Novo](out/novo.md)\n');
    await reread();
    await openLine('Referência ausente (out/novo.md) em CLAUDE.md:7');
    await audit
      .getByRole('button', {
        name: 'Marcar como esperada: Referência ausente (out/novo.md) em CLAUDE.md:7',
      })
      .click();
    await audit.getByLabel('Motivo (opcional)').fill('Saída do agente');
    await audit.getByLabel('Motivo (opcional)').press('Enter');
    await expect(expectedSection.locator('summary')).toContainText('Esperadas (3)');
    await page.getByRole('button', { name: 'Alterações', exact: true }).click();
    const changes = page.locator('.changes-section[aria-label="Observações"]');
    const novo = changes.locator('.change-row', { hasText: 'out/novo.md' });
    await expect(novo.locator('.change-tag')).toHaveText('esperada');
    await expect(novo.locator('.change-tag')).toHaveClass(/expected/);
    await expect(novo).toContainText('marcada como esperada em');
    await expect(novo).toContainText('Saída do agente');
    await expect(changes.locator('h3')).toContainText('0 novas · 1 esperada');
    const fileSection = page.locator('.changes-section[aria-label="Arquivos"]');
    const color = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).color);
    expect(await color(novo.locator('.change-tag'))).not.toBe(
      await color(fileSection.locator('.change-tag').first()),
    );
    await inBothThemes(page, ['.change-tag.expected'], 'expected-changes');
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();

    // 3. The written destination changes: active again, and the old mark has no observation.
    writeFileSync(
      claude,
      readFileSync(claude, 'utf8').replace('out/relatorio.md', 'out/relatorio-final.md'),
    );
    await reread();
    await openAllAuditFiles(page);
    await expect(
      audit.getByRole('button', {
        name: 'Ver detalhe: Referência ausente (out/relatorio-final.md) em CLAUDE.md:6',
      }),
    ).toBeVisible();
    await expect(expectedSection.locator('summary')).toContainText('Esperadas (2)');
    await expect(orphans.locator('summary')).toContainText('Marcações sem observação (1)');
    // Reopened after visiting Alterações: the sections start collapsed again; the counts in the header
    // (expected apart from the marks without observation) open them and scroll to them.
    await expect(orphans).not.toHaveAttribute('open', /.*/);
    await expect(expectedSection).not.toHaveAttribute('open', /.*/);
    await expect(summary).toContainText('2 esperadas · 1 sem observação correspondente');
    await summary.getByRole('button', { name: '1 sem observação correspondente' }).click();
    await expect(orphans).toHaveAttribute('open', '');
    await expect(orphans.locator('summary')).toBeInViewport();
    await summary.getByRole('button', { name: '2 esperadas' }).click();
    await expect(expectedSection).toHaveAttribute('open', '');
    await expect(expectedSection.locator('summary')).toBeInViewport();
    await expect(orphans.locator('.audit-orphan')).toContainText('CLAUDE.md → out/relatorio.md');
    await expect(footer).toHaveText('2 citados não encontrados (+1 esperado)');
    await inBothThemes(
      page,
      [
        '.audit-expected > summary',
        '.audit-expected-item .audit-row small',
        '.expected-note',
        '.expected-note q',
        '.audit-orphan small',
        '.expected-chip',
      ],
      'expected-sections',
    );

    // 4. Undo: back to active; the orphan mark is removed only on request.
    await expectedSection
      .getByRole('button', {
        name: 'Desmarcar: Referência ausente (out/novo.md) em CLAUDE.md:7',
      })
      .click();
    await openAllAuditFiles(page);
    await expect(
      audit.getByRole('button', {
        name: 'Ver detalhe: Referência ausente (out/novo.md) em CLAUDE.md:7',
      }),
    ).toBeVisible();
    await expect(expectedSection.locator('summary')).toContainText('Esperadas (1)');
    // Marking again in this session brings back the reason of the undone mark.
    await openLine('Referência ausente (out/novo.md) em CLAUDE.md:7');
    await audit
      .getByRole('button', {
        name: 'Marcar como esperada: Referência ausente (out/novo.md) em CLAUDE.md:7',
      })
      .click();
    await expect(audit.getByLabel('Motivo (opcional)')).toHaveValue('Saída do agente');
    await page.keyboard.press('Escape');
    await orphans.getByRole('button', { name: /^Remover marcação: Referência ausente/ }).click();
    await expect(orphans).toHaveCount(0);
    await expect(summary).toContainText('1 esperada');
    await expect(summary).not.toContainText('sem observação correspondente');
    await expect(footer).toHaveText('3 citados não encontrados');
    // The confirmation speaks of this reading: an edit on disk and a new reading clear it.
    await expect(audit.locator('.audit-expected-status')).toContainText('Marcação removida');
    writeFileSync(join(root, 'notas/nova.md'), '# Nova\n');
    await reread();
    await expect(audit.locator('.audit-expected-status')).toHaveCount(0);

    // 5. Restart the server with the same state: the mark is still there.
    await stopServer(server.child);
    server = await startServer(state);
    await page.goto(server.url);
    await enterProject(page);
    await page.getByRole('button', { name: 'Auditoria', exact: true }).click();
    await expect(summary).toContainText('1 esperada');
    await showAudit(page, 'Todas');
    await expectedSection.locator('summary').click();
    await expect(expectedSection.locator('.audit-expected-item')).toHaveCount(1);
    await expect(expectedSection.locator('.audit-expected-item')).toContainText('notas/solto.md');
    await expect(expectedSection.locator('.expected-note')).toContainText('(sem motivo)');
    await expect(treeRow(solto).locator('.observation-marker')).toHaveCount(0);

    // The declared-scope snippet: for a missing destination, never for an ambiguity.
    await openLine('Nome com vários arquivos possíveis (c.md)');
    await expect(audit.locator('.audit-observations .diagnosis')).toHaveCount(1);
    await expect(audit.getByRole('button', { name: 'Declarar no projeto…' })).toHaveCount(0);
    await expect(audit.locator('.diagnosis-scope')).toHaveCount(0);
    await openLine('Referência ausente (out/relatorio-final.md)');
    await expect(audit.locator('.audit-observations .diagnosis')).toHaveCount(1);
    // The declaration starts closed, under its action.
    await expect(audit.locator('.diagnosis-scope')).toHaveCount(0);
    await audit.getByRole('button', { name: 'Declarar no projeto…' }).click();
    const scope = audit.locator('.diagnosis-scope');
    await expect(scope).toHaveCount(1);
    // Two readings of a missing destination, chosen explicitly; the snippet follows the choice.
    // Before the choice, only the options: no snippet and no sentence.
    await expect(scope.locator('.scope-place')).toHaveCount(0);
    await expect(scope.locator('pre')).toHaveCount(0);
    await scope.getByLabel(/^Gerado na execução/).check();
    const snippet = '{\n  "scope": {\n    "version": 1,\n    "runtimeWorkspace": ["out/"]\n  }\n}';
    expect(JSON.parse(await scope.locator('pre code').innerText())).toEqual(JSON.parse(snippet));
    await expect(scope.locator('pre code')).toHaveText(snippet);
    // One sentence: where the snippet goes, under the project's name. What a declaration changes and
    // proves is in the usage guide, not here.
    await expect(scope.locator('.scope-place > p')).toHaveText(
      'No projeto loja: Crie agent-architecture.json na raiz de loja com este conteúdo:',
    );
    for (const gone of [
      'O app não grava no projeto',
      'vale para quem abrir loja como raiz',
      'Declarado fora do pacote',
      'A declaração não comprova',
    ])
      await expect(scope).not.toContainText(gone);
    await expect(scope.locator('ul')).toHaveCount(0);
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url });
    const copy = scope.getByRole('button', {
      name: 'Copiar o trecho da declaração de escopo para loja',
    });
    await copy.click();
    await expect(scope.getByRole('status')).toHaveText('Trecho copiado.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(snippet);
    await scope.getByLabel(/^Arquivo local/).check();
    const local = snippet.replace('runtimeWorkspace', 'localFiles');
    await expect(scope.locator('pre code')).toHaveText(local);
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(local);
    // The snippet wraps: nothing hidden behind a horizontal scroll.
    const code = scope.locator('pre code');
    expect(await code.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
    expect(
      await scope
        .locator('pre')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await inBothThemes(
      page,
      ['.diagnosis-scope pre code', '.scope-place > p', '.scope-choice label'],
      'scope',
    );

    // With agent-architecture.json already declaring another list, the edit says where the pattern goes.
    writeFileSync(
      join(root, 'agent-architecture.json'),
      JSON.stringify({ scope: { version: 1, localFiles: ['config/*.local.json'] } }),
    );
    await reread();
    if (!(await audit.locator('.diagnosis-scope').count())) {
      await openLine('Referência ausente (out/relatorio-final.md)');
      await audit.getByRole('button', { name: 'Declarar no projeto…' }).click();
    }
    await scope.getByLabel(/^Gerado na execução/).check();
    await expect(scope).toContainText(
      'A chave scope do agent-architecture.json de loja existe, sem a lista runtimeWorkspace: acrescente este trecho dentro dela',
    );
    await expect(scope.locator('pre code')).toHaveText('"runtimeWorkspace": ["out/"]');
    await scope.getByLabel(/^Arquivo local/).check();
    await expect(scope).toContainText(
      'Acrescente este padrão à lista localFiles da chave scope do agent-architecture.json de loja.',
    );
    await expect(scope.locator('pre code')).toHaveText('"out/"');

    // The interface never wrote into the inspected root: only the edits made by this test.
    expect(readFileSync(join(root, 'docs/guia.md'), 'utf8')).toBe(files['docs/guia.md']);
    expect(readFileSync(solto, 'utf8')).toBe(files['notas/solto.md']);
    // The mark lives in the app state: one entry of this project, by its stable key.
    const saved = JSON.parse(readFileSync(join(state, 'workspace.json'), 'utf8')).expected;
    expect(Object.keys(saved)).toEqual([root]);
    expect(Object.values(saved[root])).toEqual([
      expect.objectContaining({ code: 'unreachable', path: 'notas/solto.md', reason: '' }),
    ]);
    expect(Object.keys(saved[root])[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(errors).toEqual([]);
  } finally {
    await stopServer(server.child);
    rmSync(base, { recursive: true, force: true });
  }
});
