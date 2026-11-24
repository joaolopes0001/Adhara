import { defineConfig } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLanguage } from './src/i18n';

// TRANSITIONAL: the counterpart, on the Node side, of the `storageState` below. A few specs read a
// dictionary of `src/` in this process and compare it with the screen, which starts in Portuguese;
// workers load this file again, so they read the same language. Remove it together with that one.
setLanguage('pt');

// The specs assert dates and times as the screen shows them, and were written for this time zone.
// Pinning it gives the same result on any machine: a CI runner is in UTC. The variable reaches this
// process, the workers and the test backend; `timezoneId` below reaches every page.
const timeZone = 'America/Sao_Paulo';
process.env.TZ = timeZone;

// One temporary directory per run holds the server state and every synthetic fixture: TMPDIR points
// to it, so os.tmpdir() in the specs and tempfile in the Python processes create theirs inside, and
// the global teardown removes it. Workers load this file again and inherit the same directory.
if (process.env.TEST_WORKER_INDEX === undefined)
  process.env.AAE_UI_RUN_DIR = mkdtempSync(join(tmpdir(), 'aae-ui-run-'));
const run = process.env.AAE_UI_RUN_DIR!;
process.env.TMPDIR = run;
const state = join(run, 'state');
// The test backend runs with a HOME of its own inside the run directory: the folder dialogs start there
// and list only what the specs put in it, never the personal folders of whoever runs the suite. With
// HOME swapped, the server would not find the protected-paths.txt of the default state, so the
// machine's list is copied into the state of the run, with `~` written as the real home, and the
// protection stays in force (as .claude/skills/run-isolated/start.sh does).
const home = join(run, 'home');
if (process.env.TEST_WORKER_INDEX === undefined) {
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  const machine = join(
    homedir(),
    '.local/share/agent-architecture-explorer/state/protected-paths.txt',
  );
  if (existsSync(machine))
    writeFileSync(
      join(state, 'protected-paths.txt'),
      readFileSync(machine, 'utf8')
        .split('\n')
        .map((line) =>
          line.trim() === '~' || line.trim().startsWith('~/')
            ? homedir() + line.trim().slice(1)
            : line,
        )
        .join('\n'),
    );
}
const executablePath =
  process.env.AAE_CHROMIUM || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
// Quote the generated paths for the shell used by Playwright's web server.
const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";
// The port of the test backend. AAE_UI_PORT lets two checkouts run the suite at the same time.
const port = Number(process.env.AAE_UI_PORT) || 47839;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/ui',
  timeout: 60000,
  workers: 1,
  // A shared CI runner is slower and less steady than a desk machine: a failed test runs again there.
  // Locally a failure stays a failure.
  retries: process.env.CI ? 2 : 0,
  outputDir: './test-results',
  globalTeardown: './tests/ui/global-teardown.ts',
  use: {
    baseURL,
    // TRANSITIONAL: the specs written before English became the default assert Portuguese text, so
    // every page of the suite starts in Portuguese. Remove this once their assertions are in English;
    // tests/ui/language.spec.ts already runs without it. It only reaches this origin: a spec with a
    // server of its own sets the language itself (expected-observations.spec.ts).
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            { name: 'aae-lang', value: 'pt' },
            // The line under the map of a folder starts folded; the specs that assert what it lists
            // read it open. tests/ui/folder-strip-fold.spec.ts removes this and checks the default.
            { name: 'aae-folder-strip', value: 'open' },
          ],
        },
      ],
    },
    timezoneId: timeZone,
    viewport: { width: 1536, height: 960 },
    launchOptions: { executablePath, args: ['--no-sandbox'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `HOME=${quote(home)} python3 server/main.py --port ${port} --state-dir ${quote(state)}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
