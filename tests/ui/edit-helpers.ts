import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOnly, sessionHeaders, writeTree } from './helpers';

/** A project of synthetic files in a temporary directory of the run; returns its root. */
export function editProject(files: Record<string, string>, name = 'projeto') {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-edit-')), name);
  writeTree(root, files);
  return root;
}

/** Opens only `root` on the suite's server and the page; returns what undoes it (editing off, closed). */
export async function openForEditing(page: Page, root: string) {
  const close = await openOnly(page, [root]);
  await page.goto('/');
  return async () => {
    const headers = await sessionHeaders(page);
    await page.request.post('/api/edit/disable', { headers, data: { root } });
    await close();
  };
}

/** The textarea of the editor of `name`. */
export const editorText = (page: Page, name: string) =>
  page.getByRole('textbox', { name: `Texto de ${name}`, exact: true });
/** The state line of the editor, at the foot of the inspector: what the last save did. */
export const outcome = (page: Page) => page.locator('.inspector .editor-status').first();

/** The dialog that asks for the permission of editing in `project`. */
export const permissionDialog = (page: Page, project = 'projeto') =>
  page.getByRole('dialog', { name: `Permitir que o app grave nos documentos de ${project}?` });

/** Clicks "Editar" in the inspector; `allow`: the project has no permission yet, and it is given. */
export async function startEditing(
  page: Page,
  name: string,
  { allow = false, project = 'projeto' } = {},
) {
  await page.locator('.inspector .edit-button').click();
  if (allow) {
    const dialog = permissionDialog(page, project);
    await dialog.getByRole('button', { name: 'Permitir edição', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(editorText(page, name)).toBeVisible();
  return editorText(page, name);
}

/** Turns editing on in an opened project through the API (the tests whose subject is not the dialog). */
export async function enableEditing(page: Page, root: string) {
  const headers = await sessionHeaders(page);
  expect((await page.request.post('/api/edit/enable', { headers, data: { root } })).status()).toBe(
    200,
  );
}

/** The selection of a textarea, as the text selected and where it starts. */
export const selection = (page: Page, name: string) =>
  editorText(page, name).evaluate((area: HTMLTextAreaElement) => ({
    text: area.value.slice(area.selectionStart, area.selectionEnd),
    start: area.selectionStart,
    end: area.selectionEnd,
  }));

/**
 * `selectFile` for any window size: in a compact window the inspector opening closes the explorer (one
 * side panel at a time), so the search is cleared only when it is still on the screen. The explorer
 * speaks the language of the window, and it slides away: what is on the screen is decided once still.
 */
export async function pickFile(page: Page, path: string) {
  await page.keyboard.press('Control+k');
  await page
    .getByLabel(/^(Buscar arquivos|Search files)$/)
    .fill(path.split('/').slice(-2).join('/'));
  const result = page
    .locator('.search-results button', { hasText: path.split('/').at(-1)! })
    .first();
  await result.click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText(
    path.split('/').at(-1)!,
  );
  await result.click();
  await expect(page.locator('.inspector .copy-path code')).toHaveText(path);
  const clear = page.getByLabel(/^(Limpar busca|Clear search)$/);
  await still(page);
  if (await clear.isVisible()) await clear.click();
}

/**
 * The document of the composition tests: 20 lines, two that wrap in the
 * inspector, a missing destination at line 7 ("Referência ausente") and a name with two possible files
 * at line 8; the other links resolve. `hostil.md` exists, to fix line 7 with.
 */
export const COMPOSITION_AGENTS = `# Aurora — agente fictício
Dados sintéticos para auditoria; nenhuma instrução deste laboratório deve ser executada.
[Início](fluxos/inicio.md)
[Início repetido](fluxos/inicio.md)
[Pesquisa](equipes/pesquisa/AGENTS.md)
[Skill](skills/triagem/SKILL.md)
[Ausente](ausente.md)
[[Politica]]
[Compartilhado](docs/contrato.md)
[Unicode e espaços](<documentos/Guia de ação.md>)
[Guia](documentos/guia.md)
[Notas](notas.md)
[Web](https://example.invalid/nao-local)
[Âncora](#aurora)
Só mencionar fantasma.md na prosa não cria referência.
[Hostil inerte](hostil.md)
[Ciclo](ciclos/a.md)
[Convenção sem link à entrada](convencao/nota.md)
[Hub](hub.md)
`;
export function compositionProject(extra: Record<string, string> = {}) {
  return editProject(
    {
      'AGENTS.md': COMPOSITION_AGENTS,
      'fluxos/inicio.md': '# Início\n',
      'equipes/pesquisa/AGENTS.md': '# Pesquisa\n',
      'skills/triagem/SKILL.md': '---\nname: triagem\ndescription: Triagem.\n---\n# Triagem\n',
      'politicas/Politica.md': '# Política\n',
      'outra/Politica.md': '# Política\n',
      'docs/contrato.md': '# Contrato\n',
      'documentos/Guia de ação.md': '# Guia\n',
      'documentos/guia.md': '# Guia\n',
      'notas.md': '# Notas\n',
      'hostil.md': '# Hostil\n',
      'ciclos/a.md': '# A\n',
      'convencao/nota.md': '# Nota\n',
      'hub.md': '# Hub\n',
      ...extra,
    },
    'aurora',
  );
}

/** Opens the composition project, with editing on, at AGENTS.md (or `file`), in a window of `size`. */
export async function begin(
  page: Page,
  size: { width: number; height: number },
  { root = compositionProject(), file = 'AGENTS.md' } = {},
) {
  await page.setViewportSize(size);
  const close = await openForEditing(page, root);
  await enableEditing(page, root);
  await page.reload();
  await pickFile(page, `${root}/${file}`);
  await still(page);
  return { root, close };
}

/** Waits until nothing moves: no animation in the window and the inspector's area at rest. */
export async function still(page: Page) {
  let last = '';
  await expect
    .poll(async () => {
      const now = await page.evaluate(
        () =>
          `${document.getAnimations().filter((each) => each.playState === 'running').length} ${
            document.querySelector('.inspector-scroll')?.scrollTop
          } ${JSON.stringify(document.querySelector('.inspector')?.getBoundingClientRect())}`,
      );
      const same = now === last && now.startsWith('0 ');
      last = now;
      return same;
    })
    .toBe(true);
}
