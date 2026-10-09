---
name: Companion feature
about: A behaviour, tool, or host form you want the companion to have
labels: ["enhancement"]
---

<!--
The companion is the kernel in `packages/mate` plus its wiring in
`packages/coding-agent/src/extensions/mate`. If the request is really about pi's agent core,
providers, or the terminal UI, it belongs at https://github.com/earendil-works/pi.

Read the design rules first: COMPANION.md maps each requirement to the code that satisfies it, and
REQUIREMENTS.md states why each mechanism exists. Proposals that clash with those need an argument
about the design, not just a wanted behaviour.
-->

**The behaviour you want, in one paragraph**

**What a user would see or type**

**Which part of the state it should move** (mood, an emotion, a drive, trust, memory, the body
clock) and why that is the honest place for it

**What it costs** — does it need extra model calls? The companion already spends calls on readings,
thoughts and dreams; anything else should say what it buys.
