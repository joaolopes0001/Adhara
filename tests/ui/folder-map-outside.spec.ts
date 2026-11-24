// The map of a folder without arrows between its items, and the references that reach it from outside
// (src/folderMap.ts, src/FolderMap.tsx): the items are cards, never an empty map, and the box "From
// outside this folder" lists who writes those references and what they reach. In English, a new profile.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterProject, openOnly, writeTree } from './helpers';

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * A project whose `.agents` holds one folder, `skills`, with every reference inside it; and a folder
 * `tools` with one script (not read) that two Markdown files of the project reference, one twice.
 */
function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-outside-')), 'project');
  writeTree(root, {
    'AGENTS.md': '# Project\n[Run](tools/run.py)\n',
    'docs/plan.md': '# Plan\n[Run](../tools/run.py)\n[Run again](../tools/run.py)\n',
    'tools/run.py': 'print(1)\n',
    '.agents/skills/alpha/SKILL.md': '---\nname: alpha\n---\n[Beta](../beta/SKILL.md)\n',
    '.agents/skills/beta/SKILL.md': '---\nname: beta\n---\n[Alpha](../alpha/SKILL.md)\n',
  });
  return root;
}

/** The map of the folder `name` of the project at `root`, from its row in the Structure. */
async function mapOfFolder(page: Page, root: string, name: string) {
  await page.goto('/');
  await enterProject(page, 'project');
  await page
    .locator('.structure-row .structure-open', {
      hasText: new RegExp(`^${name.replace('.', '\\.')}$`),
    })
    .first()
    .click();
  await expect(page.locator('.breadcrumbs [aria-current="location"]')).toHaveText(name);
  await page.getByRole('button', { name: 'Map of project', exact: true }).click();
  const view = page.locator(`.scope-pane[data-scope="${root}"]`);
  await expect(view.locator('.folder-map')).toBeVisible();
  return view;
}
const card = (view: Locator, path: string) =>
  view.locator('.react-flow__node-file', { has: view.page().locator(`strong[title="${path}"]`) });

test('a folder whose single child holds every reference shows that child as a card, not an empty map', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  const view = await mapOfFolder(page, root, '.agents');
  await expect(view.locator('.folder-map-empty')).toHaveCount(0);
  await expect(view.locator('.react-flow__node-file')).toHaveCount(1);
  const skills = card(view, join(root, '.agents/skills'));
  await expect(skills.locator('.item-facts')).toHaveText('2 files · 2 internal');
  // No arrow can reach it from another item: the card has no ↙ ↗, the sentence says why.
  await expect(skills.locator('.tile-foot')).not.toContainText('↙');
  await expect(view.locator('.folder-lane')).toHaveText(
    'No references between the items of this folder.',
  );
  await expect(view.locator('.folder-strip')).toHaveCount(0);
  await expect(view.locator('.react-flow__node-inbound')).toHaveCount(0);
  await expect(view.locator('.canvas-caption > span:last-child')).toHaveText(
    '1 item · 2 references (0 outside · 2 inside folders)',
  );
  await close();
});

test('a folder with one unread file referenced from outside: the box from outside lists who writes and what it reaches, and opens the references', async ({
  page,
}) => {
  const root = fixture();
  const close = await openOnly(page, [root]);
  const view = await mapOfFolder(page, root, 'tools');
  const script = card(view, join(root, 'tools/run.py'));
  await expect(script.locator('.item-facts')).toHaveText('not read');
  await expect(view.locator('.folder-lane')).toHaveText(
    'No references between the items of this folder. None of its files was read for references.',
  );
  // The count of the header: the items, then the references from outside as a figure of their own.
  await expect(view.locator('.canvas-caption > span:last-child')).toHaveText(
    '1 item · 3 from outside',
  );
  const box = view.locator('.react-flow__node-inbound');
  await expect(box.locator('.tile-name')).toHaveText('Point to this folder3');
  const group = box.locator('.inbound-group[data-kind="project"]');
  await expect(group.locator('.outside-kind')).toHaveText('Elsewhere in this project · 3');
  await expect(group.locator('.tile-path')).toHaveText(['../docs/plan.md', '../AGENTS.md']);
  await expect(group.locator('.outside-from')).toHaveText('to run.py');
  // It reads left to right: the box from outside is above the card, in the same column.
  const [above, below] = [(await box.boundingBox())!, (await script.boundingBox())!];
  expect(above.y + above.height).toBeLessThan(below.y);
  expect(Math.abs(above.x - below.x)).toBeLessThan(1);
  // No arrow to or from the box.
  await expect(view.locator('g.folder-arrow')).toHaveCount(0);
  // A click on the group lists its references, each with its file and line.
  await group.click();
  const list = view.getByRole('region', { name: 'References of the arrow' });
  await expect(list.locator('> header strong')).toHaveText(
    'Elsewhere in this project · 3 references',
  );
  await expect(list.locator('> div > button strong')).toHaveText([
    '../AGENTS.md · line 2',
    '../docs/plan.md · line 2',
    '../docs/plan.md · line 3',
  ]);
  await close();
});

test('in a short map area the cards are framed first; the box from outside joins only when there is room', async ({
  page,
}) => {
  // A folder cited as a folder and, from three files of the project, at its script: a box of two
  // groups, one of them with three sources (181 px), above the cards.
  const root = join(mkdtempSync(join(tmpdir(), 'aae-folder-outside-')), 'project');
  writeTree(root, {
    'AGENTS.md': '# Project\n[Tools](tools/)\n[Run](tools/run.py)\n',
    'docs/a.md': '# A\n[Run](../tools/run.py)\n',
    'docs/b.md': '# B\n[Run](../tools/run.py)\n',
    'tools/run.py': 'print(1)\n',
    'tools/setup.sh': 'echo\n',
  });
  const close = await openOnly(page, [root]);
  const geometry = async (view: Locator) =>
    view.evaluate((element) => {
      const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const area = rect('.map-area');
      const card = rect('.react-flow__node-file');
      const box = rect('.react-flow__node-inbound');
      return {
        area: area.height,
        cardInside: card.top >= area.top - 0.5 && card.bottom <= area.bottom + 0.5,
        cardVisible: Math.max(0, Math.min(card.bottom, area.bottom) - Math.max(card.top, area.top)),
        boxInside: box.top >= area.top - 0.5 && box.bottom <= area.bottom + 0.5,
        boxAbove: box.bottom < card.top,
      };
    });
  // A short pane: the map area about 250 px high.
  await page.setViewportSize({ width: 1280, height: 347 });
  let view = await mapOfFolder(page, root, 'tools');
  await expect(view.locator('.inbound-group')).toHaveCount(2);
  // The framing settles after the map is drawn.
  await page.waitForTimeout(800);
  const short = await geometry(view);
  console.log(`short pane: ${JSON.stringify(short)}`);
  expect(short.area).toBeLessThan(300);
  expect(short.cardInside).toBe(true);
  expect(short.boxAbove).toBe(true);
  // The box did not fit with the cards: Fit says part of the map is out of view.
  expect(short.boxInside).toBe(false);
  await expect(view.locator('.map-fit.canvas-offscreen')).toHaveCount(1);
  // A pane of normal height: the box and the cards, the box above them.
  await page.setViewportSize({ width: 1280, height: 900 });
  view = await mapOfFolder(page, root, 'tools');
  await expect
    .poll(async () => {
      const room = await geometry(view);
      return room.cardInside && room.boxInside && room.boxAbove;
    })
    .toBe(true);
  console.log(`normal pane: ${JSON.stringify(await geometry(view))}`);
  await close();
});
