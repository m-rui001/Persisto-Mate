# Contributing to Persisto Mate

## What this repository is

A public fork of [pi](https://github.com/earendil-works/pi) (MIT © Mario Zechner). The companion
itself is two directories:

- `packages/mate` — the deterministic affective kernel: emotions, mood, drives, the learned body
  clock, memory, sleep. No LLM calls, no pi imports.
- `packages/coding-agent/src/extensions/mate` — the wiring between that kernel and pi's extension
  host: tools, state injection, the judge, the heartbeat.

Everything else is upstream pi code and upstream docs. A change to `packages/ai`, `packages/tui`, or
pi's own core is a change to someone else's project: it will conflict on the next rebase, and it
belongs upstream instead. Read [COMPANION.md](COMPANION.md) and [REQUIREMENTS.md](REQUIREMENTS.md)
before proposing behaviour changes — they map each requirement to the code that satisfies it.

## Running it from source

Requires Node >= 22.19.

```bash
npm install --ignore-scripts   # lifecycle scripts are never run by default here
npm run build                  # npm run build:offline when you have no network
./pi-test.sh                   # run mate from the source tree
```

The companion's own state goes under the pi agent dir (`~/.pi/agent/mate` by default; override with
`MATE_CODING_AGENT_DIR`) and shares models.json, auth.json and sessions with a stock pi. To try
something without touching a real companion's memories, point the override at a temp directory.

## Checks and tests

```bash
npm run check    # biome, pinned/runtime deps, shrinkwrap, tsc --noEmit, browser smoke
./test.sh        # non-e2e tests across packages
```

`npm run check` must be clean before a pull request. Do not run the raw vitest suite from the root:
it includes e2e tests that activate when provider endpoint or auth env vars are present. For one
file, from its package root:

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/some.test.ts
```

Tests for the companion live in `packages/coding-agent/test/` and `packages/mate/test/`. New kernel
behaviour needs a test in `packages/mate`; new wiring needs one against the harness in
`packages/coding-agent/test/suite/harness.ts`, which uses the faux provider — no real API calls.

Code style the checks enforce: TypeScript with only erasable syntax (no parameter properties,
`enum`, `namespace`), no `any`, top-level imports only, Biome formatting. Run `npm run check` and it
will tell you.

## Opening an issue

Upstream pi issues (bash tool, MCP, providers, TUI rendering) go to
[earendil-works/pi](https://github.com/earendil-works/pi). Come here for the companion: mood, drives,
sleep and dreams, memory and recall, the body clock, the judge, the four host forms.

Include:

- `mate --version`, your OS and terminal.
- `/debug` output — every internal number the state block tiers away. Private memories are never in
  it, but skim it anyway before pasting.
- What the companion did versus what you expected, with the transcript around it. Affective
  behaviour depends on hours of prior state, so "on the third message it went quiet" is worth more
  than "it is buggy".
- Whether the same session in a stock pi behaves differently, if you have one installed.

Real, reproducible security problems in the fork's own additions: report privately through GitHub
Security Advisories on this repository. There is no separate security address.

## Releases

The fork keeps one version for every package and tags `vX.Y.Z-mate` on the bump commit. Binaries are
built locally and published as GitHub release assets; the extension hosts publish separately. Only
the latest release and one older one keep their download assets, so links to a specific old release's
files break — link to `releases/latest` instead.
