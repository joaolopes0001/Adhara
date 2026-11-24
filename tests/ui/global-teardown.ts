import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Removes the run directory created by playwright.config.ts (server state and synthetic fixtures) and
 * fails the run when it cannot: a run leaves nothing of its own in the temporary directory.
 */
export default function teardown() {
  const run = process.env.AAE_UI_RUN_DIR;
  if (!run || !basename(run).startsWith('aae-ui-run-')) return;
  try {
    rmSync(run, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `A rodada não apagou o diretório temporário ${run}: ${(error as Error).message}`,
    );
  }
  if (existsSync(run)) throw new Error(`A rodada não apagou o diretório temporário ${run}.`);
}
