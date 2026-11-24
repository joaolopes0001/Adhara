import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAllProjects, enterProject, sessionHeaders } from './helpers';

// A class filter opens, in the tree, the folders on the way to every file it keeps: with "Outros" in a
// project of 3,000 files, the whole tree is listed. Navigating the Estrutura must not render all those
// rows again: it stays about as fast as with the tree closed (it took 5 to 7 times longer).
function project() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-tree-performance-')), 'grande');
  mkdirSync(root);
  writeFileSync(join(root, 'AGENTS.md'), '# Grande\n[Primeira](pasta-0/arquivo-0.md)\n');
  for (let folder = 0; folder < 30; folder++) {
    const path = join(root, `pasta-${folder}`);
    mkdirSync(path);
    for (let file = 0; file < 100; file++)
      writeFileSync(
        join(path, `arquivo-${file}.md`),
        `# Arquivo ${file}\n[Próximo](arquivo-${(file + 1) % 100}.md)\n[Ausente](ausente-${file}.md)\n`,
      );
  }
  return root;
}

test('tree performance: with a class filter listing 3,000 files, navigating the Estrutura stays fast', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const root = project();
  const headers = await sessionHeaders(page);
  await closeAllProjects(page, headers);
  expect((await page.request.post('/api/open', { headers, data: { path: root } })).status()).toBe(
    200,
  );
  await page.goto('/');
  const explorer = page.locator('.explorer');
  // From Home, the list of projects, by the row of the project.
  await enterProject(page, 'grande');
  await expect(page.getByRole('region', { name: 'Estrutura de grande' })).toBeVisible();

  // Milliseconds from a click until the page stays still for 200 ms (renders and effects included).
  const timed = (selector: string, text: string) =>
    page.evaluate(
      async ([selector, text]) => {
        const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
          (element) => element.textContent?.trim() === text,
        )!;
        let last = 0;
        const observer = new MutationObserver(() => (last = performance.now()));
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        const start = performance.now();
        target.click();
        last = performance.now();
        while (performance.now() - last < 200) await new Promise((done) => setTimeout(done, 25));
        observer.disconnect();
        return last - start;
      },
      [selector, text],
    );
  const navigation = async () => {
    const times: number[] = [];
    for (const folder of ['pasta-3', 'pasta-4', 'pasta-5', 'pasta-3', 'pasta-4', 'pasta-5']) {
      times.push(await timed('.structure-open', folder));
      times.push(await timed('.structure-up', '..grande'));
    }
    return times.sort((a, b) => a - b)[times.length >> 1];
  };
  const rows = explorer.locator('.tree-item');

  const closed = await navigation();
  await expect(rows).toHaveCount(31);
  await explorer.getByRole('combobox', { name: 'Classe dos arquivos' }).selectOption('other');
  await expect(rows).toHaveCount(3030);
  const listed = await navigation();
  console.log(
    `Estrutura: ${closed.toFixed(0)} ms com a árvore fechada, ${listed.toFixed(0)} ms com 3.030 linhas`,
  );
  expect(listed).toBeLessThan(Math.max(2.5 * closed, 40));
  expect(errors).toEqual([]);
});
