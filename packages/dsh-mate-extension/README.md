# @m-rui/dsh-mate-companion

Persisto Mate — the AI companion with a body clock, real sleep, its own memory and feelings — as a
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) bundle.

## Install

```sh
dsh plugin --profile <your-profile> add github:m-rui001/dsh-mate-companion
# or, from npm:
dsh plugin --profile <your-profile> add @m-rui/dsh-mate-companion
```

Then boot that profile. State lives beside the harness home (`$DSH_HOME` or `~/.dsh`) at
`agent/mate/` — separate from the pi-host companion's state, because a different host is a
different body.

## What it contributes

- **System prompt sections** — the cached identity/character/memory block and a volatile state
  block (clock, mood, drives, session log, reply lean) that re-renders on every assembly.
- **The kernel** — every inbound user message advances the affective state; offline time
  integrates in closed form and crosses real sleep windows; memory recalls, rehearses and
  consolidates; SPARK beliefs crystallise from recurring topics.
- **The affect judge** — after each user exchange the model reports, via the `mate_feel` tool, how
  the exchange moved each Plutchik feeling on a -2..+2 scale. The report goes through the same
  literature-anchored math as the pi companion's judge (rung equating, negativity asymmetry), and a
  due gate keeps it a reading of the new exchange rather than a re-read of an old one.
- **A waking heartbeat** — impulses the kernel decides are worth voicing are delivered as a queued
  follow-up message of their own turn, wrapped in a `<system-event type="mate-impulse">` envelope
  so they are never mistaken for the user's words.
- **Tools** — `mate_remember` (persistent memory), `mate_ponder` (private thought), `mate_debug`
  (full internal state).

## Known scope limits (v0.2)

- The judge reads the exchange through the host model's own self-report rather than a separate
  side-channel model, which introduces the usual self-assessment bias; the design treats that as
  acceptable until the harness documents a plugin-facing completion API.
- No live sleep mode, dreams, or alarm tool yet — offline sleep is fully simulated by the kernel's
  catch-up, and the sleeping-hours impulse suppression still applies.
- To switch the companion's prompt language, write `{"version":1,"lang":"zh"}` to
  `agent/mate/lang.json` under the harness home.

Requires Node 22.19+/24 per the harness. The harness is a developer preview; its plugin surface
may change under us.
