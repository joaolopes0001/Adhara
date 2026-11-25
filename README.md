# Agent Architecture Explorer

[![CI](https://github.com/joaolopes0001/Adhara/actions/workflows/ci.yml/badge.svg)](https://github.com/joaolopes0001/Adhara/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/joaolopes0001/Adhara)](https://github.com/joaolopes0001/Adhara/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Agent Architecture Explorer is a local Linux app that reads a project's agent context files (`AGENTS.md`, `CLAUDE.md`, memory, skills, subagents and the documents they point to) and maps how they reference each other. Every relation it shows comes from an explicit reference written in a file, with the file, line and excerpt as evidence. It infers nothing and never executes what it reads. It audits broken and ambiguous references, shows what changed on disk since a baseline, and ships a CLI (`aae`) that writes JSON for scripts, CI and coding agents.

This repository is Adhara, the project's new name. The app, its commands and its documentation still use the name Agent Architecture Explorer.

![Map of a file in the dark theme: a launch plan (launch.md), the AGENTS.md that cites it, the style guide it points to and a missing reference highlighted, with the “Broken reference” observation open in the inspector](docs/imagens/mapa-observacao.png)

<sub>The map of one file, the observation for a missing reference and the line it comes from, in a small synthetic example agent.</sub>

## Why

An agent's architecture lives in files that cite each other: instructions, memory, skills, manifests. As it grows, simple questions get hard to answer with certainty. _Where does this file point? Who points to it? What is the shortest path from A to B?_ The Explorer reads the directories, extracts only explicit references and answers those questions with evidence you can check.

## What it does

- **Inspect.** A file tree, search, a folder **Structure** and a **Map** of each file's incoming and outgoing relations, with the evidence for each. The map is always contextual, never one global graph. Up to 12 projects can be open at once, with parent/child relations and nesting level.
- **Trace.** The shortest path between two files, following the direction of the references or in both directions.
- **Audit.** Missing and ambiguous references with their candidates, targets that exist only above the opened directory, invalid manifests, reading limits, documents with no path from the entry points, and structural signals such as cycles, repeated references and files with many outgoing links.
- **Changes.** What changed on disk since a baseline reading, by file, relation and observation. The baseline survives restarts and moves forward only when you click **Update baseline**.
- **New architecture.** Creates a new directory from explicit primitives and relations, which you review before anything is written. It never overwrites an existing directory.
- **Edit (off by default).** Once you allow editing for a project, you can fix an existing Markdown document in the inspector. Each save checks the file's hash on disk, so it never silently overwrites changes made by another program. You can undo the last save. The app keeps no versions, so use Git for history.
- **CLI.** `aae` audits, gates CI, compares audits, binds requirements to content and inventories files.

The interface is in English, with Portuguese under **More › Português**, and opens in the dark theme. The [usage guide](docs/guia-de-uso.md) (in Portuguese) walks through it in full.

## A hygiene routine with the CLI

Context files decay without anyone noticing. A link breaks after a rename, a rule moves to another line, a file stops being reachable. The `aae` CLI turns these into checks with stable exit codes, so you or your coding agent can run them after every change to the context files, by hand or in CI.

Every command prints one JSON object on stdout (`--help` and `--version` print text). The CLI does not open the interface, start a server, write into the directories it inspects or run scripts it finds in them. Reports can be redirected to files outside the inspected directories.

| Exit code | Meaning |
| --- | --- |
| `0` | Pass: contract satisfied, no regression, or metadata produced |
| `1` | Fail: a demonstrated violation or regression |
| `2` | Error: invalid input (`invalid-input`) or a tool defect (`internal-error`) |
| `3` | Inconclusive: insufficient evidence, partial reading or a limit reached. Never a pass |

The examples below use `path/to/project` for the directory you want to check.

### 1. Baseline

Record the files and get a compact audit.

```sh
aae inventory --root path/to/project > inventory-before.json
aae audit --root path/to/project --summary
```

`--summary` keeps the status, the counts by code (`summary.byCode`), the files that cause and receive the most findings (`topSources`, `topTargets`) and the metrics. It leaves out the individual findings.

### 2. Gate

A broken reference is a `warning`, and a warning alone does not fail the audit. `--fail-on` makes the gate explicit:

```sh
aae audit --root path/to/project --fail-on broken   # exit 1 while a broken reference exists
```

On a sample project with one missing target, the report says why it failed and where:

```json
"status": "fail", "gate": {"failOn": ["broken"], "matched": {"broken": 1}},
"findings": [{"id": "0b9744a4b4e6956c", "code": "broken", "severity": "warning",
  "message": "Target not found: ../../runbooks/rollback.md",
  "path": "skills/publish-release/SKILL.md", "line": 6, ...}]
```

`--fail-on` is repeatable and accepts any finding code. `--fail-on any` fails on every `warning` or `error`. Treat only exit `0` as a pass.

### 3. Before and after

Keep a full audit (without `--summary`) from before a change and compare it with one from after:

```sh
aae audit --root path/to/project > before.json
# ... edit the context files ...
aae audit --root path/to/project > after.json
aae compare-audit --before before.json --after after.json --fail-on any
```

`compare-audit` matches findings by a stable `id` and reports them as new, resolved or persisting. With `--fail-on`, only a new finding of a listed code fails. `--fail-on any` also fails on `audit-context-differs`, which is raised when the suite, the contract or the effective scope differ between the two reports. `compare-audit` refuses `--summary` reports with exit 2, because they carry no findings.

### 4. Requirements bound to content

When some lines must stay reachable from the entry file, such as a release rule or a safety policy, write them in a suite and freeze it:

```json
{"version": 1, "entry": "AGENTS.md", "scenarios": [{"id": "release", "triggers": [],
  "required": [{"path": "memory/decisions.md", "startLine": 3, "endLine": 3}],
  "conditional": [], "forbidden": [], "maxReads": 6, "maxBytes": 8192, "maxHops": 3}]}
```

```sh
aae freeze --root path/to/project --suite suite.json > frozen.json
aae audit  --root path/to/project --suite frozen.json
```

`freeze` binds each requirement to a `contentHash` of its lines. It writes no files, hence the redirect. Keep `suite.json` and `frozen.json` outside the project.

Later, `audit --suite frozen.json` reports the shortest path to each active requirement. If the content of those lines changes, both that command and `aae freeze --root path/to/project --suite frozen.json` flag it as `requirement-stale` with exit `3`, rather than silently following whatever the lines now say.

If the lines only moved, `freeze --relocate` moves the requirement, but only when they exist in exactly one place and the snapshot is complete (`snapshotPartial: false`). `--rebind` accepts the new content without reviewing it, so check the lines first.

### 5. Prove nothing else changed

Take another inventory and diff the two by `sha256`:

```sh
aae inventory --root path/to/project > inventory-after.json
```

`inventory` records hashes and sizes of regular files, never their content. It does not compare inventories itself.

### Let the agent discover the contract

`aae schema` describes every command, option, exit code and report version in JSON, with valid example suites and two step-by-step routines (`workflow.audit` and `workflow.overhaul`). It reads no project, so a coding agent can run it first and work from the contract rather than from this page.

### What the CLI does not tell you

A static reference does not prove an agent followed it. Sizes are bytes, not tokens. You decide which lines are “required”, and the tool cannot check that choice against the real task. A file with no path by explicit reference (`unreachable`) is a candidate for review, not an error. `forbidden`, `maxReads` and `maxBytes` are validated but not measured by any command. The `freeze` snapshot covers the first root only, up to 200 texts, 256 KiB per text and 2 MiB in total.

The full reference is [docs/cli.md](docs/cli.md) (in Portuguese), along with `aae --help` and `aae schema`.

<a id="instalar-e-executar"></a>

## Install

Requirements:

- Linux, the only supported system.
- Python 3.10+ as `/usr/bin/python3`. The installed commands call that interpreter and do not use a Python from pyenv, conda or a venv.
- Node 22.12+ and npm, for the build only. npm does not refuse an older Node, so check `node --version` first.
- git, to clone the repository. Without it, the first command fails.
- Chromium or Google Chrome for the app window. Without either, the launcher falls back to the default browser through `xdg-open`.

```sh
git clone https://github.com/joaolopes0001/Adhara.git
cd Adhara
npm ci
npm run build
python3 scripts/install.py
agent-architecture-explorer
```

The installer copies the app to `~/.local/share/agent-architecture-explorer`, creates the `agent-architecture-explorer` and `aae` commands in `~/.local/bin` and adds an entry to the applications menu.

To call the commands by name, `~/.local/bin` must be on your `PATH`. If it was not there before the installation, a new terminal is usually not enough. Log out and back in (on many distributions the login profile adds `~/.local/bin` once the folder exists), add it to your `PATH` yourself, or use the full path, such as `~/.local/bin/agent-architecture-explorer`. The menu entry works either way.

The launcher opens Chromium or Chrome in app mode, in a dedicated window with its own profile. The default browser, when used instead, opens an ordinary window. Once installed, the app needs no Node, CDN or internet connection.

To update, first stop the background server as described in [Uninstall](#uninstall). The launcher reuses a running server, and that server keeps the old code. Then run `npm ci`, `npm run build` and `python3 scripts/install.py` again. Reinstalling preserves your saved projects, notes and baselines.

### Use the CLI without installing

This form works only from the root of the cloned folder:

```sh
python3 -B -m server.cli audit --root path/to/project --summary
```

From any other directory, use `python3 path/to/Adhara/scripts/aae.py` instead. The installed `aae` command works from any directory and resolves relative paths against it.

### Uninstall

The server keeps running in the background between windows, and removing the files does not stop it. Close the app window, then stop the server. Its PID is in `server.json`, in the app's state folder:

```sh
cat ~/.local/share/agent-architecture-explorer/state/server.json   # {"port": ..., "pid": PID}
ps -p PID -o args=   # must show .../agent-architecture-explorer/server/main.py
kill PID
```

If `ps` prints nothing, the server has already stopped, so skip the `kill`. If it shows another program, do not kill it.

If `server.json` is missing, or to double-check, run `pgrep -af '[a]gent-architecture-explorer/server/main.py'`. It lists any server still running from the installed folder, with its PID, and prints nothing once the server is stopped. The brackets keep the pattern from matching the shell that runs it.

Only then remove the four installed paths: the menu entry, the two commands and the app folder.

```sh
rm ~/.local/share/applications/agent-architecture-explorer.desktop
rm ~/.local/bin/agent-architecture-explorer ~/.local/bin/aae
rm -r ~/.local/share/agent-architecture-explorer
```

The app folder also holds your saved projects, notes and baselines, and `state/protected-paths.txt` if you created it. That list protects directories for every server and CLI on the machine, including a CLI run from a clone. Removing the folder ends that protection.

The [usage guide](docs/guia-de-uso.md#instalação-estado-e-remoção) (in Portuguese) covers state, protected paths and the local server in detail.

## Privacy and safety

Reading is local, offline and read-only. Inspecting a directory never writes into it or executes what it reads, and the local server listens only on `127.0.0.1`.

The app writes to your files in only two cases. Creating a new directory writes it after you review it, and the new directory may be inside an open project. Saving a Markdown document, with editing allowed for that project, writes through a temporary file in the document's folder.

[SECURITY.md](SECURITY.md) describes what the server's guard covers and what it does not.

## Documentation

The documents below are in Portuguese for now.

| Document | Contents |
| --- | --- |
| [Usage guide](docs/guia-de-uso.md) | Interface, installation and state |
| [Model and reading](docs/modelo-e-leitura.md) | What becomes a relation, target resolution, scope, audit and limits |
| [CLI](docs/cli.md) | Contracts, commands and exit codes |
| [SPECS](SPECS.md) | Product requirements and contracts |
| [Index](docs/README.md) | Every other document |

<a id="desenvolver-com-agentes-de-código"></a>

## Contributing

Issues and pull requests in English are welcome. Report bugs and proposals in this repository's issues. Before sending code, read [CONTRIBUTING.md](CONTRIBUTING.md), which covers development, tests and the evidence policy, and the [code of conduct](CODE_OF_CONDUCT.md). Contributions are accepted under the MIT license, with no CLA or DCO.

If you contribute with a coding agent, the repository carries instructions for it:

- [AGENTS.md](AGENTS.md) holds the project rules for any agent, such as Codex, Cursor or Claude Code: what must not change, where each feature lives and how to verify a change. It is the agent's counterpart to the contributing guide.
- [CLAUDE.md](CLAUDE.md) and `.claude/` cover what is specific to Claude Code. `CLAUDE.md` imports `AGENTS.md`. `.claude/` allows the project's checks, blocks edits to `dist/`, asks before push, remotes and the installer, and includes the `run-isolated` skill, which starts the app with temporary state.

These files are for contributors, and the app does not read them. The `AGENTS.md` and `CLAUDE.md` files it shows are the ones in the directories you open.

## Security

Report vulnerabilities privately through GitHub, under **Security › Report a vulnerability** in this repository. Do not open a public issue. [SECURITY.md](SECURITY.md) has the details.

## License and changelog

[MIT](LICENSE). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
