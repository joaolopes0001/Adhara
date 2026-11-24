import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMoreAction, runProjectsAction } from './more-menu';
import { sessionHeaders, showMap } from './helpers';

async function resetWorkspace(page: Page) {
  const headers = await sessionHeaders(page);
  const previous = await (await page.request.get('/api/workspace', { headers })).json();
  for (const root of previous.roots)
    await page.request.post('/api/close', { headers, data: { path: root.path } });
  return headers;
}

async function openFixture(page: Page) {
  const root = mkdtempSync(join(tmpdir(), 'aae-workspace-redesign-'));
  const files = {
    'AGENTS.md':
      '# Entrada\n[Alpha](alpha/context.md)\n[Beta](beta/context.md)\n[Gamma](gamma/context.md)\n',
    'alpha/AGENTS.md': '# Alpha\n[Contexto](context.md)\n',
    'alpha/context.md':
      '# Contexto Alpha\nTexto exclusivo da seleção Alpha.\n\n' +
      Array.from(
        { length: 30 },
        (_, index) => `${index + 1}. Uma observação documental sobre o contexto do agente.\n`,
      ).join(''),
    'beta/CLAUDE.md': '# Beta\n[Contexto](context.md)\n',
    'beta/context.md': '# Contexto Beta\nTexto exclusivo da seleção Beta.\n',
    'gamma/AGENTS.md': '# Gamma\n[Contexto](context.md)\n',
    'gamma/context.md': '# Contexto Gamma\nTexto exclusivo da seleção Gamma.\n',
    'agent-architecture.json': JSON.stringify(
      {
        version: 1,
        relationships: [{ source: 'AGENTS.md', target: 'alpha/context.md', type: 'reads' }],
      },
      null,
      2,
    ),
  };
  for (const child of ['alpha', 'beta', 'gamma']) mkdirSync(join(root, child));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  await resetWorkspace(page);
  await page.goto('/');
  await runProjectsAction(page, 'Adicionar diretório');
  await page.getByLabel('Caminho do diretório').fill(root);
  await page.getByRole('button', { name: 'Abrir este diretório' }).click();
  return { root, files };
}

// selectFile of helpers.ts searches by the full path and clicks the exact result, without checking it.
async function selectFile(page: Page, path: string) {
  await page.keyboard.press('Control+k');
  await page.getByLabel('Buscar arquivos').fill(path);
  await page.locator(`.search-results button[title="${path}"]`).click();
  await page.getByRole('button', { name: 'Limpar busca' }).click();
}

test('workspace redesign: selection reads on the right, manifest evidence and drafts remain tied to real files', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { root, files } = await openFixture(page);
  // Opening selects no file; AGENTS.md is chosen in the structure and read on the right.
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  const listing = readdirSync(root).sort();
  const inspector = page.locator('.inspector');
  await expect(inspector.locator('.source-code')).toContainText('# Entrada');
  await expect(inspector.locator('.source-code [data-line="2"]')).toContainText(
    '[Alpha](alpha/context.md)',
  );
  await expect(page.locator('.app-footer')).toBeVisible();
  await expect(page.locator('.bottom-panel .source-code')).toHaveCount(0);

  await inspector.getByRole('button', { name: 'Anotações', exact: true }).click();
  await page
    .getByLabel('Anotação do arquivo')
    .fill('Rascunho da entrada, fora da raiz inspecionada.');
  await selectFile(page, join(root, 'alpha/context.md'));
  await expect(inspector.locator('.source-code')).toContainText(
    'Texto exclusivo da seleção Alpha.',
  );
  await selectFile(page, join(root, 'AGENTS.md'));
  await inspector.getByRole('button', { name: 'Anotações', exact: true }).click();
  await expect(page.getByLabel('Anotação do arquivo')).toHaveValue(
    'Rascunho da entrada, fora da raiz inspecionada.',
  );
  await page.getByRole('button', { name: 'Salvar anotação' }).click();
  await expect(page.locator('.save-status')).toHaveText('Salvo neste computador');

  await inspector.getByRole('button', { name: 'Evidências', exact: true }).click();
  await inspector
    .locator('.evidence-item')
    .filter({ hasText: 'Relação declarada' })
    .getByRole('button', { name: 'Ler evidência em agent-architecture.json', exact: true })
    .click();
  await expect(inspector.locator('.source-path')).toContainText(
    join(root, 'agent-architecture.json'),
  );
  await expect(inspector.locator('.highlight-line')).toHaveAttribute('data-line', '5');
  await expect(inspector.locator('.highlight-line')).toContainText('"source": "AGENTS.md"');
  await expect(inspector.locator('.source-code')).toContainText('"target": "alpha/context.md"');
  await selectFile(page, join(root, 'beta/context.md'));
  await expect(inspector.locator('.copy-path code')).toHaveText(join(root, 'beta/context.md'));
  await expect(inspector.locator('.source-path')).toHaveCount(0);
  await expect(inspector.locator('.source-code')).toContainText('Texto exclusivo da seleção Beta.');
  await expect(inspector.locator('.highlight-line')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('workspace-right-reader.png') });

  for (const [name, body] of Object.entries(files))
    expect(readFileSync(join(root, name), 'utf8')).toBe(body);
  expect(readdirSync(root).sort()).toEqual(listing);
  expect(errors).toEqual([]);
});

test('workspace redesign: welcome and tool dock remain aligned in both themes and compact windows', async ({
  page,
}) => {
  const headers = await resetWorkspace(page);
  // A project saved and closed, whatever other tests left: Home is the list of projects, under its actions.
  const closed = mkdtempSync(join(tmpdir(), 'aae-workspace-redesign-saved-'));
  writeFileSync(join(closed, 'AGENTS.md'), '# Salvo\n');
  for (const operation of ['open', 'close'])
    expect(
      (await page.request.post(`/api/${operation}`, { headers, data: { path: closed } })).status(),
    ).toBe(200);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const home = page.locator('.home');
  await expect(home).toBeVisible();
  await expect(page.locator(`.home-row[data-project="${closed}"]`)).toBeVisible();
  for (const size of [
    { width: 1536, height: 960 },
    { width: 749, height: 396 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      )
      .toBe(true);
    // Home lists the saved projects (this one, and those other tests left) below its actions; the main
    // actions stay entirely in view, and in a low window the list scrolls inside Home, each row reachable.
    const actions = page.locator('.welcome-actions').getByRole('button');
    for (const button of await actions.all()) await expect(button).toBeInViewport({ ratio: 1 });
    const saved = page.locator('.home-row').getByRole('button');
    for (const button of (await saved.all()).slice(0, 4)) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: test.info().outputPath(`workspace-welcome-${size.width}.png`) });
  }
  await runMoreAction(page, 'Ativar tema claro');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(home).toBeVisible();
  await runProjectsAction(page, 'Nova arquitetura');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await runMoreAction(page, 'Ativar tema escuro');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('workspace redesign: a delayed file read never replaces the newer right-hand selection', async ({
  page,
}) => {
  const { root } = await openFixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = false;
  await page.route(
    `**/api/content?path=${encodeURIComponent(join(root, 'alpha/context.md'))}`,
    async (route) => {
      const response = await route.fetch();
      reading = true;
      await pending;
      await route.fulfill({ response });
    },
  );
  await selectFile(page, join(root, 'alpha/context.md'));
  await expect.poll(() => reading).toBe(true);
  await selectFile(page, join(root, 'beta/context.md'));
  await expect(page.locator('.inspector .source-code')).toContainText(
    'Texto exclusivo da seleção Beta.',
  );
  const staleResponse = page.waitForResponse((response) =>
    response.url().includes(encodeURIComponent(join(root, 'alpha/context.md'))),
  );
  release();
  await staleResponse;
  await expect(page.locator('.inspector .copy-path code')).toHaveText(
    join(root, 'beta/context.md'),
  );
  await expect(page.locator('.inspector .source-code')).not.toContainText(
    'Texto exclusivo da seleção Alpha.',
  );
});

test('workspace redesign: four quadrants move in every direction and minimized views preserve context', async ({
  page,
}) => {
  const { root } = await openFixture(page);
  for (const child of ['alpha', 'beta', 'gamma'])
    await selectFile(page, join(root, child, 'context.md'));
  await runMoreAction(page, 'Recolher painéis');
  const workspace = page.locator('.map-workspace');
  const visible = workspace.locator('.workspace-pane:not([aria-hidden="true"])');
  await expect(visible).toHaveCount(4);
  await expect(workspace).toHaveAttribute('data-columns', '2');
  const frame = (name: string) =>
    workspace.locator(`[data-pane-id="scope:${name ? join(root, name) : root}"]`);
  const boxes = await Promise.all(
    ['', 'alpha', 'beta', 'gamma'].map((name) => frame(name).boundingBox()),
  );
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
  expect(Math.abs(boxes[2]!.y - boxes[3]!.y)).toBeLessThan(2);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width - 2);
  expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 2);
  expect(Math.abs(boxes[0]!.x - boxes[2]!.x)).toBeLessThan(2);
  for (const pane of await visible.all()) await expect(pane).toBeInViewport({ ratio: 0.99 });
  await page.screenshot({ path: test.info().outputPath('workspace-four-quadrants.png') });

  const gamma = frame('gamma');
  for (const [direction, coordinate, sign] of [
    ['esquerda', 'x', -1],
    ['cima', 'y', -1],
    ['direita', 'x', 1],
    ['baixo', 'y', 1],
  ] as const) {
    const before = (await gamma.boundingBox())!;
    await gamma.getByLabel('Organizar vista gamma', { exact: true }).click();
    await gamma.getByRole('button', { name: `Mover gamma para ${direction}`, exact: true }).click();
    await expect
      .poll(async () => ((await gamma.boundingBox())![coordinate] - before[coordinate]) * sign)
      .toBeGreaterThan(20);
    await expect(gamma.locator('.scope-location')).toContainText('context.md');
  }
  // The files were chosen from the Estrutura, so each new view opened on it; gamma shows its map.
  await gamma.getByRole('button', { name: 'Mapa de gamma', exact: true }).click();
  const zoom = () =>
    gamma
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  const beforeZoom = await zoom();
  await gamma.getByRole('button', { name: 'Aproximar mapa', exact: true }).click();
  await expect.poll(zoom).toBeGreaterThan(beforeZoom + 0.05);
  const manualZoom = await zoom();
  await gamma.getByRole('button', { name: 'Minimizar vista gamma', exact: true }).click();
  await expect(visible).toHaveCount(3);
  await expect(gamma).toBeHidden();
  const restore = page.getByRole('button', { name: 'Restaurar vista gamma', exact: true });
  await expect(restore).toBeInViewport({ ratio: 1 });
  await expect(restore).toContainText('Minimizada');
  await restore.click();
  await expect(visible).toHaveCount(4);
  await expect(gamma.locator('.scope-location')).toContainText('context.md');
  await expect(gamma.locator('.file-tile.focused .tile-name strong')).toHaveAttribute(
    'title',
    join(root, 'gamma/context.md'),
  );
  await expect.poll(async () => Math.abs((await zoom()) - manualZoom)).toBeLessThan(0.02);
  // Minimized canvases remain mounted, but do not receive keyboard focus.
  for (let index = 0; index < 4; index++)
    await visible
      .first()
      .getByRole('button', { name: /^Minimizar vista / })
      .click();
  await expect(visible).toHaveCount(0);
  await expect(page.locator('.workspace-minimized-empty')).toContainText(
    'Todas as vistas estão minimizadas',
  );
  await expect(page.locator('.workspace-pane[inert]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Restaurar vistas', exact: true }).click();
  await expect(visible).toHaveCount(4);

  // A filter joins the same layout and can also move, minimize and restore.
  // A child folder view closes by "Fechar vista".
  await gamma.getByRole('button', { name: 'Fechar vista gamma', exact: true }).click();
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByLabel('Nome do filtro', { exact: true }).fill('Contexto filtrado');
  await page.getByRole('button', { name: 'Salvar e abrir vista', exact: true }).click();
  await expect(visible).toHaveCount(4);
  const filtered = page.getByRole('region', {
    name: 'Vista do filtro Contexto filtrado',
    exact: true,
  });
  await filtered
    .getByRole('button', { name: 'Minimizar vista Contexto filtrado', exact: true })
    .click();
  await expect(visible).toHaveCount(3);
  await page
    .getByRole('button', { name: 'Restaurar vista Contexto filtrado', exact: true })
    .click();
  await expect(filtered).toBeVisible();
  await expect(visible).toHaveCount(4);
  await page.setViewportSize({ width: 749, height: 396 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    )
    .toBe(true);
  await expect(page.locator('.app-footer')).toBeInViewport({ ratio: 0.99 });
  await page.getByRole('button', { name: 'Ativar vista Contexto filtrado', exact: true }).click();
  await expect(filtered).toBeInViewport({ ratio: 0.6 });
  await page.screenshot({ path: test.info().outputPath('workspace-quadrants-compact.png') });
});

test('workspace redesign: two views can switch from side by side to top and bottom', async ({
  page,
}) => {
  const { root } = await openFixture(page);
  await selectFile(page, join(root, 'alpha/context.md'));
  await runMoreAction(page, 'Recolher painéis');
  const parent = page.locator(`[data-pane-id="scope:${root}"]`);
  const alpha = page.locator(`[data-pane-id="scope:${root}/alpha"]`);
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-visible-panes', '2');
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '2');
  await alpha.getByLabel('Organizar vista alpha', { exact: true }).click();
  await alpha.getByRole('button', { name: 'Mover alpha para cima', exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '1');
  expect((await alpha.boundingBox())!.y).toBeLessThan((await parent.boundingBox())!.y);
  await alpha.getByLabel('Organizar vista alpha', { exact: true }).click();
  await alpha.getByRole('button', { name: 'Mover alpha para direita', exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-columns', '2');
  expect((await alpha.boundingBox())!.x).toBeGreaterThan((await parent.boundingBox())!.x);
  await expect(alpha.locator('.scope-location')).toContainText('context.md');
});

test('workspace redesign: a complete trace temporarily takes priority over an active highlight', async ({
  page,
}) => {
  const { root } = await openFixture(page);
  await selectFile(page, join(root, 'alpha/context.md'));
  await page.getByRole('button', { name: 'Filtros do mapa', exact: true }).click();
  await page.getByLabel('Nome do filtro', { exact: true }).fill('Só Alpha');
  await page.getByRole('button', { name: 'Salvar e destacar', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Vista do filtro Só Alpha', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await page.getByLabel('Arquivo de origem A').fill(join(root, 'AGENTS.md'));
  await page.getByLabel('Arquivo de destino B').fill(join(root, 'gamma/context.md'));
  await page.getByRole('button', { name: 'Traçar', exact: true }).click();
  await expect(page.locator('.trace-summary')).toContainText('1 passo');
  const trace = page.locator('.workspace-pane[data-pane-id="trace"]');
  await expect(trace).toBeVisible();
  await expect(
    trace.locator('.file-tile .tile-name strong[title="' + join(root, 'gamma/context.md') + '"]'),
  ).toHaveCount(1);
  await expect(trace.locator('.trace-bundle')).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Vista do filtro Só Alpha', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Caminho', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Vista do filtro Só Alpha', exact: true }),
  ).toBeVisible();
});

test('workspace redesign: long source remains readable beside two scopes with compact tools and light dialogs', async ({
  page,
}) => {
  const { root } = await openFixture(page);
  await page.setViewportSize({ width: 1512, height: 806 });
  await selectFile(page, join(root, 'alpha/context.md'));
  await expect(page.locator('.inspector .source-code')).toContainText(
    '30. Uma observação documental',
  );
  // Chosen from the Estrutura, the file opened its view on the Estrutura; its map is one switch away.
  await page.getByRole('button', { name: 'Mapa de alpha', exact: true }).click();
  await expect(page.locator('.map-workspace')).toHaveAttribute('data-visible-panes', '2');
  await page.screenshot({ path: test.info().outputPath('workspace-reader-desktop.png') });
  await page.setViewportSize({ width: 749, height: 396 });
  await runMoreAction(page, 'Mostrar inspetor');
  await expect(page.locator('.inspector .source-code')).toBeVisible();
  await expect(page.locator('.inspector-scroll')).toBeInViewport({ ratio: 0.99 });
  await page.locator('.source-code [data-line="33"]').scrollIntoViewIfNeeded();
  await expect(page.locator('.source-code [data-line="33"]')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.app-footer')).toBeInViewport({ ratio: 0.99 });
  await page.screenshot({ path: test.info().outputPath('workspace-reader-compact.png') });
  await runMoreAction(page, 'Ativar tema claro');
  await expect(page.locator('.react-flow').first()).toHaveClass(/light/);
  await runProjectsAction(page, 'Nova arquitetura');
  await expect(page.getByRole('dialog')).toBeInViewport({ ratio: 0.99 });
  await page.screenshot({ path: test.info().outputPath('workspace-dialog-light.png') });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('workspace redesign: minimizing a large canvas never creates invisible overflow after a window resize', async ({
  page,
}) => {
  const { root } = await openFixture(page);
  // Opening selects no file; the large canvas is the map of AGENTS.md (chosen in the structure, which
  // stays, and shown by the switch). A second view (alpha) gives the views their headers; both are
  // minimized, so the whole grid is.
  await page.locator('.structure-open', { hasText: 'AGENTS.md' }).click();
  await showMap(page);
  await selectFile(page, join(root, 'alpha/context.md'));
  const name = root.split('/').at(-1)!;
  await page.getByRole('button', { name: `Ativar vista ${name}`, exact: true }).click();
  await runMoreAction(page, 'Recolher painéis');
  await page.getByRole('button', { name: 'Minimizar vista alpha', exact: true }).click();
  await page.getByRole('button', { name: `Minimizar vista ${name}`, exact: true }).click();
  await page.setViewportSize({ width: 749, height: 396 });
  await expect(page.locator('.workspace-minimized-empty')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.map-workspace').evaluate((element) => ({
        horizontal: element.scrollWidth > element.clientWidth + 1,
        vertical: element.scrollHeight > element.clientHeight + 1,
      })),
    )
    .toEqual({ horizontal: false, vertical: false });
  await page.getByRole('button', { name: `Restaurar vista ${name}`, exact: true }).click();
  await expect(page.locator(`[data-pane-id="scope:${root}"] .scope-location`)).toContainText(
    'AGENTS.md',
  );
  // Restoring the view changes what the center shows, not the panels: the inspector, collapsed with
  // the panels, reads the selection again once shown.
  await runMoreAction(page, 'Mostrar inspetor');
  await expect(page.locator('.inspector .source-code')).toContainText('# Entrada');
});
