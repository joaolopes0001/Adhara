---
name: run-isolated
description: Starts the Agent Architecture Explorer in isolation (free port, temporary state and HOME) to see a change working in the browser, take screenshots or drive the interface, without touching the personal installation. Use for "run the app", "see it working" and manual interface tests.
---

# Run the app in isolation

1. Build the current frontend: `npm run build`. The server serves `dist/`, so a frontend change only shows up after a new build.
2. Start the instance: `.claude/skills/run-isolated/start.sh`, from the repository root or the worktree.
   - `--lab` creates the synthetic audit lab ([docs/audit-lab.md](../../../docs/audit-lab.md)) inside the temporary HOME.
   - `--port N` fixes the port. Without it, the system picks a free port.
   - The script prints the URL, the PID and the instance folder (HOME, state and `server.log`).
3. Open the URL in the browser, for example with Playwright and the system Chromium (`/usr/bin/chromium`). The server refuses a request marked cross-site (`Sec-Fetch-Site: cross-site`) with “Unauthorized origin.”, which is what a tab opened by a browser extension such as Claude in Chrome sends: in that case, go to the app from a page already on `127.0.0.1` (the refusal page itself will do), with `location.href = 'http://127.0.0.1:PORT/'`. The folder picker starts in the temporary HOME; create the synthetic folders you want to open there.
4. When done, run `.claude/skills/run-isolated/stop.sh FOLDER`. It stops only that instance's server, after checking the process, and deletes the folder. With `--keep`, the folder stays, for example to save evidence.

## Rules

- Do not use port 47831 (personal installation) or 47839 (Playwright). Do not use the state in `~/.local/share/agent-architecture-explorer` either.
- After a backend change, stop the instance and start it again: the Python process does not reload modules.
- Swapping HOME would change which `protected-paths.txt` is read from the default state. So the script copies the machine's file into the temporary state, with `~` expanded to the real HOME, and protection stays in force. `AAE_PROTECTED_PATHS` passes through the environment.
- Open only synthetic folders, or copies whose content you may show in screenshots. Inspection is read-only, but the content opened shows up in them.
- To develop with Vite (hot reload), follow [CONTRIBUTING.md › Desenvolver](../../../CONTRIBUTING.md#desenvolver).
