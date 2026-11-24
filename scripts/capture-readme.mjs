// Generates the README screenshots from a small synthetic agent, in an isolated server.
// Usage: npm run build && node scripts/capture-readme.mjs
// Output: test-results/readme/{structure,observation,audit}-{dark,light}.png (ignored by Git).
// The fixture lives in a temporary directory with a neutral name; check the images before promoting one.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const files = {
  'AGENTS.md': `# Documentation assistant

Answers questions about the Example project and keeps the documents up to date.

## How to work

- Before writing, read the [style guide](docs/style-guide.md).
- To review a text, follow the skill \`skills/review-text/SKILL.md\`.
- The preferences of whoever asks are in [memory](memory/preferences.md).
- The launch plan is in [docs/launch.md](docs/launch.md).
- When done, record it in the [change log](docs/change-log.md).
`,
  'skills/review-text/SKILL.md': `---
name: review-text
description: Reviews a short text following the style guide.
---

# Review text

1. Read the [style guide](../../docs/style-guide.md).
2. Point out the passages that depart from it.
3. Save what you learned in [memory](../../memory/preferences.md).
`,
  'memory/preferences.md': `# Preferences

- Short texts, in plain language.
- Follows the [style guide](../docs/style-guide.md) in everything.
`,
  'docs/style-guide.md': `# Style guide

Short sentences, active voice, one subject per paragraph.

Ready-made examples are in [examples](examples.md).
`,
  'docs/launch.md': `# Launch plan

1. Review the [style guide](style-guide.md).
2. Prepare the notes in [release-notes.md](release-notes.md).
`,
};

// A fixed, neutral path (the inspector shows absolute paths); it is removed at the end.
const base = join(tmpdir(), 'aae-captura');
if (existsSync(base))
  throw new Error(`${base} already exists: delete it before generating the captures.`);
const root = join(base, 'example', 'agent');
for (const [name, text] of Object.entries(files)) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), text);
}
const state = join(base, 'state');
const out = join('test-results', 'readme');
mkdirSync(out, { recursive: true });

const executablePath =
  process.env.AAE_CHROMIUM || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const server = spawn('python3', ['server/main.py', '--port', '0', '--state-dir', state], {
  stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, HOME: join(base, 'home') },
});
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The temporary server did not start.')), 10000);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The server exited: ${code}`));
    });
    server.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  for (const [theme, toggle] of [
    ['dark', null],
    ['light', 'Switch to light theme'],
  ]) {
    const storageState = {
      cookies: [],
      origins: [
        {
          origin: url,
          localStorage: [
            // Selecting a file does not open the inspector by itself (one click changes one thing), so the
            // saved layout opens it, as a person who keeps it open would have it.
            { name: 'aae-layout', value: JSON.stringify({ inspector: true, bottom: false }) },
          ],
        },
      ],
    };
    const context = await browser.newContext({
      baseURL: url,
      viewport: { width: 1536, height: 960 },
      storageState,
    });
    const page = await context.newPage();
    await page.goto(url);
    const { token } = await (await page.request.get('/api/session')).json();
    const opened = await page.request.post('/api/open', {
      headers: { 'X-AAE-Token': token },
      data: { path: root },
    });
    if (opened.status() !== 200) throw new Error(`Opening the project failed: ${opened.status()}`);
    await page.reload();
    await expect(page.getByText('5 of 5 files read')).toBeVisible();
    if (toggle) {
      await page.locator('.app-header').getByRole('button', { name: 'More', exact: true }).click();
      await page
        .getByRole('menu', { name: 'More' })
        .getByRole('menuitem', { name: toggle, exact: true })
        .click();
    }
    const select = async (query, name, relative) => {
      await page.keyboard.press('Control+k');
      await page.getByLabel('Search files').fill(query);
      await page.locator('.search-results button', { hasText: name }).first().click();
      await expect(page.locator('.inspector .copy-path code')).toHaveText(join(root, relative));
      await page.getByLabel('Clear search').click();
      await page.waitForTimeout(800);
    };
    await select('AGENTS', 'AGENTS.md', 'AGENTS.md');
    await page.getByText('Structure', { exact: true }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `structure-${theme}.png`) });

    await select('docs/launch', 'launch.md', 'docs/launch.md');
    await page.getByText('Map', { exact: true }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `observation-${theme}.png`) });

    await page.getByRole('button', { name: 'Audit', exact: true }).first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(out, `audit-${theme}.png`) });
    await context.close();
  }
} finally {
  await browser.close();
  if (server.exitCode === null) {
    server.kill('SIGINT');
    await once(server, 'exit');
  }
  rmSync(base, { recursive: true, force: true });
}
console.log(`Captures in ${out}/`);
