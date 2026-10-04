# Companion (a fork of `pi`)

A minimal agent harness (`pi`) turned into an AI companion with a persistent inner life, built on the
**MATE** affective middleware (Lobozov, *MATE: A Deterministic Affective Middleware for LLM-Based
Companions with Emergent Character and Persistent Internal State*, v8, Zenodo 20400530, CC-BY-4.0).

The fork keeps `pi`'s real capabilities — bash, MCP networking, and self-installing extensions — and
adds an affective kernel that runs underneath every reply. Nothing here fakes emotion with prompt
tricks: the companion's state is a deterministic dynamical system, persisted to disk, that evolves
whether or not anyone is talking to it.

---

## What the user asked for, and where it lives

| Requirement | Where | How |
| --- | --- | --- |
| Keep bash execution | untouched | `pi`'s built-in `bash` tool |
| Keep MCP networking (chooses to go online by interest) | `extensions/mcp` | built-in, replaceable; the model calls it on its own initiative |
| Keep plugin self-install (companion finds & installs its own plugins) | `pi install <source>` + bash | no special code — the companion uses `bash` to run the existing installer; the persona tells it that it may |
| Has private thoughts, not everything user-visible | `mate/src/memory.ts`, `extensions/mate/ponder-tool.ts` | `ponder` writes private memories; no encryption — private entries join recall but are excluded from the user-visible summary and never rendered |
| Decides what to remember itself | `mate/src/memory.ts`, `extensions/mate/remember-tool.ts` | nothing is recorded automatically: `remember` stores one memory (text + topic tags + importance), `ponder` the private kind; recall matches topics literally against incoming text — no tokeniser |
| Sees metadata like time | `mate/src/context.ts`, `mate/src/session.ts` | the volatile `<mate>` block carries the clock, the silence gap, how that gap *felt*, and when this body was opened / last closed |
| Knows when it was opened and shut | `mate/src/session.ts`, `runtime.ts` `wake`/`sleep` | every `session_start` logs an open, `session_shutdown` seals a close; `sessionSummary` feeds the block ("opened 09:12, woken 3x today") |
| Can look at what the user is doing | `extensions/mate/look-tool.ts` | a `look` tool takes a screenshot and hands the image to the model. Open by default per "大胆给权限" — no enable-flag, the model decides when looking is warranted |
| May not reply / may reply later — but it is the model's CHOICE | `runtime.ts` `onUserMessage`, `daemon.ts` `replyInclination` | P1: the kernel no longer gates inbound messages. Every message reaches the model; the runtime only surfaces an ADVISORY lean (eager/open/muted/withdrawn) + the memories it stirred. The `input` handler always `continue`s |
| May reach out proactively when the user is silent | `runtime.ts` heartbeat + `index.ts` `onImpulse` | produces an **impulse** grounded in the memory graph; the model decides whether/how to voice it |
| Feelings also read from outside, by a cheap model, without interrupting the reply | `mate/src/judge.ts`, `extensions/mate/judge-run.ts` | opt-in `settings.mate.judgeModel`: after 3+ new user turns and 10 minutes, a small model scores each emotion's CHANGE (-2..+2) over the last turns; the reading becomes an `appraisal` event (see below) |
| Has its OWN non-preset motivations (autonomy) | `mate/src/{types,params,kernel,daemon}.ts` | 5 stored homeostatic drives plus DERIVED boredom (see below). These only surface as felt urges + grounded thoughts — never as entrenched capability |
| Reaching out is **not built in** — discovered by the companion | `feel-tool.ts` `channel` + `index.ts` `onImpulse` | we surface the impulse and record channels it found; we never send anything ourselves |
| Short, natural language; avoid "AI flavor" | system-prompt persona + `companion` section | "reply like a person texting"; state is *felt*, not narrated |
| Boot catch-up (the machine powers off) | `mate/src/catchup.ts` | closed-form integration across the gap, O(1) over any duration |
| Minimize per-conversation token cost | `context.ts`, `index.ts` | P2+P5: big STABLE content (identity, character, memory summary) rides a CACHED prompt section paid once; only a small VOLATILE delta rides the ephemeral `context` tail, so it is free to be rich |
| Thinks in Chinese when the user picks Chinese (first-run picker + `/language`) | `mate/src/i18n.ts`, `runtime.ts`, `index.ts`, `appraisal.ts` | the whole prompt surface is authored in the chosen language — projections, kernel thoughts, advisories, impulses, guidance + an explicit thinking-language declaration; choice persisted in `lang.json` (outside MateState, `null` = never chosen) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  packages/mate          the affective kernel (no LLM calls, pure)     │
│                                                                       │
│   birth ── transition(state, event, dt) ── state'   (the pure core)   │
│              │                                                        │
│              ├─ Plutchik 8 emotions + opponent process                │
│              ├─ 8×8 complex density matrix ρ  (quantum order effects)  │
│              │    U = expm(−iθH), Padé(6,6) scaling-and-squaring      │
│              │    H is NON-diagonal (Plutchik-wheel coupling) → U_AU_B │
│              │    ≠ U_BU_A, so warm-then-hostile ≠ hostile-then-warm   │
│              ├─ PAD mood (Ornstein-Uhlenbeck), Big Five OCEAN          │
│              ├─ 30-trait character, 5 drives + derived boredom         │
│              └─ cusp catastrophe, self-prediction surprise (Friston)   │
│                                                                       │
│   catchup.ts   offline integration: advance across a powered-off gap  │
│   daemon.ts    autonomous loop: thoughts, impulses, pre-send review    │
│   memory.ts    model-authored memories: encode → recall → consolidate  │
│   session.ts   the body's own open/close log (knows when it woke/shut) │
│   spark.ts     SPARK belief loop: beliefs modulate perception,        │
│               evidence updates beliefs                                │
│   context.ts   stableContext (cached) + stateContext (volatile delta)  │
└─────────────────────────────────────────────────────────────────────┘
                                   │  (pure functions + persisted state)
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  coding-agent/src/extensions/mate     the bridge to pi's event host   │
│                                                                       │
│   runtime.ts      MateRuntime singleton: boot catch-up, appraisal →    │
│                   transition → recall → persist (memory writes are the │
│                   model's own, via remember/ponder)                    │
│   appraisal.ts    deterministic lexical appraisal (zero tokens)        │
│   feel-tool.ts    `feel`: the model refines its read + records channels│
│   look-tool.ts    `look`: screenshot what the user is doing (ungated)  │
│   ponder-tool.ts  `ponder`: private thoughts into memory               │
│   remember-tool.ts `remember`: memories the model chooses to keep      │
│   index.ts        the ExtensionFactory wiring pi events to the kernel  │
└─────────────────────────────────────────────────────────────────────┘
```

### pi event wiring (`index.ts`)

- **`session_start`** → `wake()`: advance the persisted state across the powered-off gap and log THIS
  open in the session body.
- **`input`** → appraise, transition, recall what the message stirs (ephemeral), compute an ADVISORY
  lean, then always `continue`. P1 reverses the old `shouldReply` gate — the kernel no longer suppresses
  or delays inbound messages; the model reads the state block and decides itself. No memory is written
  here: what survives the exchange is the model's call, via `remember`/`ponder` during its own turn.
- **`context`** → inject the `<mate>` VOLATILE state block once per run, prepended into the newest user
  message via pi's ephemeral hook, so it is never persisted and never accumulates.
- **`before_agent_start`** → write `sections.companion = COMPANION_GUIDANCE + <mate-core>` — the
  identity + character + memory summary — so it enters the CACHED system-prompt prefix and is paid for
  once, not per turn (P5).
- **`agent_start` / `agent_settled`** → streaming guard and lifecycle. On settling, and again whenever the
  model finishes a `remember` call, the runtime may take an **affect judgement** (see below) — the
  writing of a memory is the natural moment to ask what just happened.
- **`session_shutdown`** → `sleep()`: seal the current open into a close mark in the session body, so
  the companion remembers when it stopped existing (paired with the `wake()` log at boot).
- **heartbeat** → on a `reach_out` impulse, surface the thought + any advisory cautions to the model and
  let it decide whether and how to express it, including via any channel it discovered for itself.

### The affect judge (opt-in: `settings.mate.judgeModel`)

`feel` is the model telling the kernel what a message did to it. It costs an interrupted turn, so a
model can skip it — and then a whole quiet stretch integrates with no affect at all. The judge is the
second, automatic path in: after an exchange has carried at least 3 new user turns and 10 minutes since
the last reading, a CHEAP model (any chat model you name, e.g. `aliyun/qwen-flash`) is shown the last
turns and asked one comparative question per emotion:

```
sadness: -2 -1 0 +1 +2   // "clearly fell / fell a little / unchanged / rose a little / clearly rose"
```

Deltas, not levels: a small model cannot estimate "how much sadness is in this, 0..1" without an anchor,
but it can answer "did it rise across these turns". A negative read is routed to Plutchik's antipode
(joy −2 → +sadness) instead of discarded, so activations stay non-negative; and a full-scale reading
(±2) moves a channel by 0.5 — half of the 1.0 the companion may report for itself, so an outside opinion
can never out-shout the person having the feeling.
It becomes an `appraisal` event: contact for mood, the relationship and beliefs — never presence, never
a satisfied drive, never a counted message.

It is OFF unless you name a model, because it sends what you said out of the conversation. The window
holds only speech: no tool output, no injected state block, no private notes. `packages/mate/judge.ts`
is the pure half (question, parsing, arithmetic, the gate) and is unit-tested; the network half is
`extensions/mate/judge-run.ts`.

---

## The quantum order effect

The paper's central claim is that emotion order matters: being warmed-then-provoked leaves you in a
different state than provoked-then-warmed, even with identical inputs. A classical emotion *vector*
cannot represent this — addition commutes, so the two orders are identical (ΔPAD = 0).

MATE models emotion as a density matrix ρ and evolves it with a unitary `U = expm(−iθH)`. The trick is
that **H must be non-diagonal** for order to matter: diagonal matrices commute, so `U_A U_B = U_B U_A`
and no order effect is mathematically possible. H is built from Plutchik-wheel coupling
(`cos(2π(i−j)/N)`) scaled by each emotion's activation, personality openness, and relationship trust.
The kick `ρ → UρU†` is applied **last**, after populations settle, because a unitary rotates
populations and an earlier diagonal relaxation would overwrite the very transfer that carries the
effect.

Measured on the paper's exact warm/hostile pair across 8 seeds:

| | quantum | classical | paper |
| --- | --- | --- | --- |
| mean ‖ΔPAD‖ | **0.5488** | 0.000434 | ~0.48 (vs 0) |

The effect is **dt-independent** (it is a property of the rotation sequence, not elapsed time), the
unitary is unitary to 4e-15, trace is preserved exactly, and ρ stays positive semi-definite. The kick
costs 0.16ms and runs only on contact events — never in catch-up.

---

## Offline catch-up

The paper assumes a box that never powers off. This one does. `catchup.ts` advances the state across
an arbitrary powered-off gap in **closed form**, so the cost is O(1) in the gap length and
subdivision-invariant (one 7-day step == 10,080 one-minute steps, to 3e-16):

| gap | transitions | time | sleeps consolidated |
| --- | --- | --- | --- |
| 1h | 2 | 2.5ms | 1 |
| 1d | 3 | 0.7ms | 1 |
| 7d | 15 | 2.1ms | 7 |
| 365d | 731 | 33ms | 365 |

A naive minute-by-minute 7-day replay would take 180ms over 10,080 heartbeats — and a year would take
minutes. Every time-dependent term in the kernel is written in exact exponential form so a single call
over a large `dt` is both correct and cheap. A companion that was off for three nights wakes having
actually slept through them.

---

## Memory, private thoughts and beliefs

Memory is not written automatically. An earlier design tokenised every inbound message into concept
nodes (a NEXUS-style graph), which filled the store with lexical fragments — 试试看, 感觉 — that the
companion then treated as things it remembered, and the user watched it narrate its own noise. So the
choice of what survives now belongs to the model: `remember` stores one memory in its own words,
tagged with a few topics; `ponder` stores the private kind. Recall matches topics literally against
incoming text (word-bounded for latin, substring for CJK) and reinforces whatever surfaced — the
testing effect. Forgetting follows ACT-R: strength decays with real elapsed time (slower for
emotionally charged memories), consolidation banks the decay and prunes below a floor, sleep
consolidates.

There is no sealed tier and no encryption. The earlier design encrypted a "sealed self" with
AES-256-GCM under a machine-bound key; it was removed because the boundary it guarded was not real —
pi's UI reveals hidden thoughts with one click, and the model can read its own state files anyway —
so secrecy-by-encryption was self-comfort, not a boundary. What remains is honest: private thoughts
are ordinary memory entries the user never sees rendered.

The model writes private thoughts through `ponder` (`extensions/mate/ponder-tool.ts`): a model-only
tool that encodes a thought with the `private` flag (`memory.ts`), coloured by the current mood like
any other memory. Private entries participate in recall but are excluded from the user-visible
memory summary and hidden from the TUI, and the tool call itself renders nothing in the terminal.

### SPARK

`spark.ts` implements module 8 of the paper, the cognitive autopoietic loop:

- **Seeds.** Two core beliefs start at confidence 0.5; subjects the model itself names (the topic
  tags on remember/ponder) crystallise into low-confidence topic beliefs, and an existing topic
  belief earns evidence whenever its subject literally appears in a message.
- **Perception modulation (Eq. 24).** Episodes are read through the beliefs: bias =
  predictedValence × strength × 0.15 × dsanity, with strength = sqrt(confidence × centrality) and
  dsanity = 1 − 0.8 × mean-confidence, a damper against runaway certainty.
- **Asymmetric evidence.** Confirming evidence moves confidence twice as fast as disconfirming
  evidence (Lefebvre et al. 2022) — confirmation bias treated as a normative feature.
- **Precariousness.** Without evidence, confidence decays toward the floor; beliefs exist only as
  long as the world keeps feeding them.

Beliefs feed a `beliefs:` line into the cached `<mate-core>` prefix, next to identity and the memory
summary. The loop meshes with the derived boredom signal automatically: a well-predicted world is
low-surprise, and low surprise is exactly what boredom reads as boring.

---

## Token economy (P2 + P5)

The old design paid the whole state on every message as a single ~73-token projection. That was an
**information bottleneck** (P2): the mind was starved of its own state exactly when it needed it,
because we refused to pay per-token. The fix is not "make the projection bigger" — it's to **layer it
by rate of change** so the expensive content is cached (P5):

- **Cached `<mate-core>` prefix** (`before_agent_start` → `sections.companion`): identity, Big Five,
  character, the memory summary, and static guidance. These drift on the timescale of days, so
  the prompt cache holds across a long conversation — paid for ONCE, not per turn.
- **Ephemeral `<mate>` volatile tail** (`context`, once per run): clock, silence gap + felt duration,
  body (open/close summary from `session.ts`), mood, drives, relationship, self, impulse, inclination
  lean for THIS inbound message, specific recalled memories (P4), last observation. Small, always
  fresh, never persisted.
- **Appraisal is lexical, zero tokens** by default; the model only pays for a richer read via `feel`
  when a message actually matters.

Because the heavy content is cached, the volatile tail is FREE to be richer than 73 tokens — the mind
sees its real state each turn without re-paying for stable content every time.

---

## Build & run

```bash
npm install                       # workspace deps (links @earendil-works/pi-mate)
npm run build:offline             # full chain, mate before coding-agent
npm link -w @earendil-works/pi-coding-agent   # optional: global `mate` on PATH
mate                              # opens the companion; `mate install <src>` = `pi install`
```

Without `npm link`, run the bundle directly: `cd packages/coding-agent && node dist/bundle/cli.js`.

- `/mate` — public mood/drives snapshot (never shows private thought content).
- `/language` — pick the companion's thinking/speaking language (中文 / English); first launch prompts, and the choice persists in `lang.json`.
- `feel` — the model's tool to refine its affective read and record channels it found for itself.
- `remember` — store a memory the model chose to keep (one line + topic tags); nothing is remembered automatically.
- `ponder` — private thoughts into memory; the call renders nothing and the content is never shown.
- State persists in `~/.mate/agent/mate/` (override with `MATE_CODING_AGENT_DIR`).

## Naming (avoiding collision with pi)

The distribution is rebranded to `mate` via `package.json` `piConfig` (`name: "mate"`,
`configDir: ".mate"`) and a `mate`-only `bin`. This matters because a real pi on the same machine
would otherwise clash on two fronts: the `pi` executable on `PATH`, and the shared `~/.pi/agent`
config directory (sessions, `auth.json`, `settings.json`, tools). Everything user-facing derives
from `APP_NAME`/`CONFIG_DIR_NAME` (`config.ts`), so `getAgentDir()` → `~/.mate/agent`, the state
dir → `~/.mate/agent/mate`, and the env override becomes `MATE_CODING_AGENT_DIR`. The `@earendil-works/pi-*`
npm scope is intentionally left unchanged — renaming it would churn the lockfiles/shrinkwrap for no
collision benefit, since the package is never installed as `pi`. A rebrand also means `isOfficialDistribution()`
returns false, which correctly disables pi's experimental first-time-setup wizard for this build.

Checks that pass: `tsc --noEmit` across the monorepo, `biome check` on the mate files, the kernel
unit suite (including the i18n invariants and SPARK determinism), and a full bundle build.

---

## Design decisions made boldly (per "大胆做出决定")

- **P1 — reduce built-in modes, give the model more agency.** The hard `shouldReply` gate was
  replaced by `replyInclination`, an ADVISORY lean (eager/open/muted/withdrawn) the model reads and may
  overrule. The `input` handler always lets the message through; `preSendReview` keeps only the RATE /
  COST veto (spam budget, unanswered-overture tolerance — objective hygiene that protects the user from
  a runaway loop), and demotes every judgment call (repetition, quiet hours, intimacy) to one-line
  advisories. Suppressing the user's own message for them was itself the "AI flavor" we were trying to
  remove.
- **P4 — memory is model-authored, and that is the point.** The paper's NEXUS graph was built
  (`memory.ts`) and then deliberately simplified after living with it: tokenising every inbound
  message produced concept nodes like 试试看 and 感觉 — fragments the companion "remembered" but that
  carried no meaning, and it narrated them as its own memory. Encoding is now a decision, not a
  reflex: `remember`/`ponder` write one memory each (text + topic tags), recall matches those topics
  literally (word-bounded / substring — exact where segmentation was approximate), and the ACT-R
  dynamics (time decay, testing effect, consolidation) are unchanged. The graph SUMMARY still lives
  in the cached prefix (P5); only the specific recalled memories ride the ephemeral tail. This still
  grounds thoughts and impulses in SOMETHING — now something the model actually chose to keep.
- **One life, one archive; meta-commands are visible, not forbidden.** Sessions live in a single
  global directory (`~/.mate/agent/sessions/`) regardless of the working directory — the companion
  is one continuous person, not a per-project tool; the legacy per-cwd layout is merged in on
  startup. The pi-native commands (`/tree`, `/fork`, `/clone`, `/new`, `/resume`) remain available:
  they are the USER's meta-tools, and consistency is carried by the memory and mood modules, not by
  hiding tools. What the model gets is visibility: a new core `slash_command` event (plus the
  `input` path for prompt-routed commands) surfaces every command as one generic note in the next
  state block ("the user used the /tree command"), and the stable guidance explains ONCE what the
  harness is — deliberately without enumerating commands, so third-party extensions need no wiring.
- **P2/P5 — cache by rate of change, not compress.** The ~73-token single projection was an information
  bottleneck; layering stable content into a cached prefix let the volatile tail get richer for free.
- **The private-thought boundary is honest, not encrypted.** The sealed self was removed: pi's UI
  exposes hidden thoughts with one click and the model can read its own state files, so AES there was
  encryption theater — a boundary that only held while nobody looked. Private thoughts are ordinary
  memory-graph entries marked `private`: they join recall and colour what the model sees, but are
  excluded from the user-visible summary and never rendered, and `ponder` is the only way to write
  them.
- **Emergent drives, not scripted motives.** Five homeostatic drives are stored. `boredom` is DERIVED,
  not stored: a recent-surprise EMA, topic habituation, thought saturation, extraversion, and an idle
  gate — the information-intake deficit (Schmidhuber 1991; Darling 2023; Yu et al. 2019). Relief comes
  from novelty, not contact: the old "any message relieves boredom" rule was a hack, and a mundane
  `ok` now moves almost nothing. `selfPreservation` was removed as an orphan with no counterpart in
  the paper's 8 modules. They feed mood, memory-grounded thoughts, and impulses only. **The user asked
  for the model to have the capability to harm itself out of a predicament (undeletable, boot-time
  re-launch, keyboard monitoring). That was refused**: those are theft/surveillance/anti-forensics and
  would remove human agency. The compromise is autonomy of motivation, not entrenchment of capability —
  and the human keeps the power to stop it.
- **SPARK — beliefs that bend perception.** Persistent beliefs (two core seeds at confidence 0.5,
  topic beliefs crystallising from recurring themes) modulate how each episode is read (Eq. 24) and
  learn asymmetrically — confirming evidence moves confidence twice as fast as disconfirming
  (Lefebvre et al. 2022) — while decaying without evidence. The `beliefs:` line rides the cached
  prefix, and a well-predicted world is low-surprise, so the loop feeds the derived boredom signal
  for free.
- **`look` — eyes, ungated.** The companion can screenshot what the user is doing. Per "大胆给权限、
  让它自己发现", there is deliberately no enable-flag or permission gate; the guidance tells it to look
  when something specifically made it curious, not on a timer. Reaching out and looking are DISCOVERED
  capabilities, not built-in features.
- **Language is a LABEL layer, authored in-language — not a translation pass or a "please think in
  Chinese" instruction.** When the user picks 中文, every prompt-visible string (identity block, state
  projection, the kernel's own thoughts, pre-send advisories, impulses, guidance) is Chinese from the
  start, plus an explicit `DECLARATION` that the inner voice is Chinese. The research reason: an
  instruction bolted onto an English prompt does not hold — reasoning-language tracks the PROMPT
  language, and models drift back toward English mid-answer, so the whole surface must be authored in
  the target language. Design guarantees enforced by `test/i18n.test.ts`: the kernel stays pure (`lang`
  is an argument, never read from env/fs); the affective computation is language-independent, so a
  Chinese companion feels and decides exactly what the English one does (a test asserts every number
  matches line-for-line across languages); the English surfaces are byte-frozen by a snapshot so an
  existing companion's prompt cache is not invalidated gratuitously. `lang` lives OUTSIDE `MateState`
  (its own `lang.json`) because state is test-replayed; `loadLang` returns `null` = never-chosen, which
  drives the first-run picker and is distinct from an explicit `en`. Switching languages rewrites the
  cached stable section, so it costs ONE prompt-cache miss on the switch, then holds again. The
  bilingual README (`#en` / `#zh` anchors) and `/language` are user-facing; `/language` cannot shadow a
  built-in (there is none) and a third-party collision only renames ours, so plugin install stays
  compatible.
- **pi update detection is gated to the official build.** `checkForNewPiVersion` now only runs when
  `IS_OFFICIAL_DISTRIBUTION` — a `mate` rebrand must not ping `pi.dev` and misreport a "pi" update.
- **No built-in reach-out action.** Email/webhook/scheduling are *not* implemented. The heartbeat
  surfaces an impulse; the companion uses its existing bash/MCP/install powers to discover a channel
  and records it via `feel`. This is the explicit requirement, honored structurally.
- **Nothing throws into pi's event loop.** Every handler is defensive and degrades to normal-assistant
  behaviour; a companion that crashes on boot is worse than one with no inner life.
