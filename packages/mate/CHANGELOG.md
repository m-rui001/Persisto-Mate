# Changelog

## [Unreleased]

### Added

- `seedNode(graph, now, seq)`: the idle-thought seed, rotating through the top few memories instead of always taking the strongest.
- `kernel.DRIFTING_TRAITS`: the traits `nudgeCharacter` actually moves, which the character projection reads so it only shows what experience shaped.
- `judge.ts`: the pure half of the affect judge - window selection, the "-2 fell clearly .. +2 rose clearly" question, answer parsing, delta arithmetic, opponent routing, the gain cap, and the gate. Asked for a LEVEL of sadness a small model invents a number; asked whether a feeling ROSE or FELL across the last turns it answers a comparative question it can actually answer. A fall is not thrown away: it is applied to Plutchik's antipode (joy -2 -> sadness +2), which keeps activations non-negative, and a full-scale reading is capped at 0.5 so an outside reader cannot out-shout the companion's own `feel`.

### Changed

- Human-paced emotional dynamics: mood integrates emotional shifts over ~45 minutes instead of ~6 (no message-to-message whiplash); SPARK evidence rates halved (etaConfirm 0.05, etaViolate 0.025, etaValence 0.04) with centrality tau 30 events - attitudes now shift over weeks of consistent experience, not one conversation; trust gains reduced (0.004 per message, saturating as trust rises) so an afternoon of chat moves trust a little, not to 0.75.
- The state block carries direction: the relationship line is labelled "toward the user" (对用户的感情), and the guidance states once that the whole block is internal and must never be revealed to the user. Command notes show typed arguments and follow-up choices ("the user then picked: ...").
- Store format version bumped to 4: the episode log was removed - it duplicated every memory's text one-for-one; the summary's "recent" line now derives from the nodes. The loader speaks v4 only: older files are not migrated and start fresh, with no compatibility code paths. The node's `origin` stamp is gone with the migration machinery.
- `tick()` returns `{ decision, state }` and writes the habituation trace of the thought the beat actually had, pruning entries older than six tau. Before, the trace was computed and dropped: every beat met every topic as brand new, so the same thought kept arriving at full urgency, and `kernel.topicSaturation` (the boredom input) read a store nothing ever wrote. The repetition advisory now reads that persisted record, so `PreSendChecks` lost `recentTopics`.
- Idle thoughts rotate their memory seed through the top four nodes instead of always taking the strongest one, and curiosity grounds on the next node in that window: one dominant memory used to be the companion's whole idle mental life.
- `rehearse()` no longer resets a memory's decay clock (it lost the `now` argument): a recalled memory gains bounded stickiness through `strength`/`salience`, while time forgets it at the same rate as a fresh one. Restarting the clock is what let one surfaced node keep re-surfacing forever.
- The stable prefix no longer wraps itself in `<mate-core>` (the caller supplies the tag) and no longer counts messages: that counter moved to the volatile state block, so a per-turn number cannot re-emit the cached prefix every turn.
- The character block shows only traits experience actually moves (`DRIFTING_TRAITS`); fixed parameters that nothing ever writes are no longer displayed as if life had shaped them.
- Surfaced emotion numbers are the FELT (net) values - activation minus the opponent counter-swing - in the state block, the minimal block and `publicView`, matching the vector mood is computed from. One number per feeling across every surface.
- Topic beliefs no longer store a `label` that repeats their `key` (`Belief.label` is now optional, the display layer falls back to the key), and neutral evidence crystallises no belief.
- The English relationship line reads "trust in you", so the trust channel of the relationship cannot be misread as the `trust` emotion (Chinese already split 信赖 and 信任).
- Guidance tells the model that a message carries no feeling until it reports one: the `feel` tool is the source of affect, not a refinement of a guess.
- The state shape is now exactly the fields the kernel reads or writes (`sanitiseState` picks every level key-by-key, so a `state.json` from an older build sheds the deleted fields on load instead of carrying them forever).
- `judgeDue`: the gate that decides when an outside reading of the exchange could actually say something new (a cooldown plus a minimum of new user turns).

### Breaking Changes

- `MateEvent.intensity` is gone. Intensity was already derived (`intensityOf(activations)` is the only thing `transition()` reads for "how hard did this land"), so the explicit field was a second dial for the same quantity - and every caller left it at 0 or repeated the vector, meaning a message the model reported as overwhelming could still be flagged as merely loud by a field nobody maintained.
- `Character` is 17 traits instead of 30: 13 were initialised at birth and never read or written by anything (`humor`, `independence`, `ambition`, `frugality`, `spirituality`, `playfulness`, ...). The kernel only ever nudges what `DRIFTING_TRAITS` lists.
- `MateState.counters` keeps `messages`, `transitions`, `sleepCycles`, `observations`. `proactiveSent`, `proactiveBlocked` and `dreams` were only ever initialised, so the numbers in `state.json` were statistics the companion was reporting about itself that could never change.
- `MateState.perceivedGap` is gone: the subjective duration of the silence is computed from the clock whenever a render needs it (`context.ts`), and the stored copy was a write the next render overwrote.
- `Awareness` is three axes instead of five. `conversationWarmth` was bumped and decayed on every event but read by nothing, and `temporalPhase` was written only by `learnTemporalPhase`, which had no caller - so the field sat at its birth value of 0.5 in `state.json` forever, a circadian phase that was never learned and never consulted. Both, and `dreamFragments` (an equation from the model description with no call site), are removed.

## [1.0.3] - 2026-10-03

### Breaking Changes

- Memory identity is the content hash alone: the store's JSON keys no longer embed the memory text (the old `text:hash` format stored every memory three times), `MemoryNode` lost its `key` field, and episodes lost their `keys` array. Loading a v1/v2 `memory.json` migrated it in place - nodes were re-keyed from their text, so identical text still reinforced the same memory.

## [1.0.2] - 2026-10-03

### Breaking Changes

- Memory is model-authored now. `encode()` stores one memory per call (text, optional topic tags, optional importance) instead of tokenising text into concept fragments; `recall()` takes `{ query, now, limit }` and matches topics/words literally instead of spreading from seed keys; `RecallHit` lost `hop`; the `MemoryEdge` type and the edges array are gone.
- Legacy auto-extracted fragment nodes are dropped on load: `sanitiseMemory` keeps only model-authored memories (plus legacy private notes, which the model chose to write).

### Added

- Added `topicMatchesText()`: literal topic matching (substring for CJK with a 2-char floor, word-bounded and case-insensitive for latin with a 3-char floor), used by recall and by SPARK evidence matching.
- Added topic tags on memories and `MateEvent.topics`; `importance` on encode scales initial strength.

### Changed

- SPARK topic beliefs crystallise from model-named topics (remember/ponder events) instead of auto-extracted message tokens; on contact events, existing topic beliefs earn evidence when their subject appears in the message text. Seed beliefs learn exactly as before.
- The memory store is a flat set of authored memories: co-occurrence edges and spreading-activation hops were removed (a single-node episode has nothing to co-occur with); consolidation, decay and the testing effect are unchanged.

### Removed

- Removed the tokeniser (unigrams, bigrams, the segmentit CJK segmenter) and its dependency; node keys are hashes of the authored text.

## [1.0.1] - 2026-10-03

### Added

- Added SPARK, the cognitive autopoietic loop (paper section 3.9): a bounded belief store seeded with two core beliefs, Eq. 24 perception modulation (`valence x strength x 0.15 x dsanity`), asymmetric evidence learning (confirmation bias per Lefebvre et al. 2022), a rigidity damper against runaways, and closed-form confidence decay so beliefs are precarious without evidence. Beliefs surface as a cached `beliefs:` prompt line.
- Added derived boredom: `boredomOf()` computes `predictability x (1 - thoughtSaturation) x (0.4 + 0.6 * extraversion) x idleGate` from a surprise EMA and topic-habituation saturation (Schmidhuber 1991, Darling 2023, Yu et al. 2019) instead of storing boredom as a drive.
- Added private-thought encoding: memory-graph nodes and episodes can be flagged `private`; they participate in recall but are excluded from the user-visible summary.
- Added dictionary-based Chinese word segmentation (`segmentit`, the jieba algorithm) so CJK memory nodes are real words like 你好/世界 instead of per-character unigrams; grammatical particles are dropped, cross-language bigrams kept.

### Changed

- The perception modulation is applied in the confirmatory direction (evidence agreeing with a belief is amplified, conflicting evidence dampened) rather than the paper's literal multiplication, which amplified disconfirming evidence.

### Removed

- Removed the `boredom` and `selfPreservation` fields from `Drives`; boredom is derived, self-preservation was dropped as an orphan with no counterpart in the paper's 8 modules.
- Removed the encrypted sealed self (`secret.ts`, `sealed.json`, machine-bound keys). Private thoughts are ordinary private-flagged memories.

### Fixed

- Fixed `updateDrives` state migration spreading stale drive keys from old `state.json` files back into new states; drives are now picked key-by-key on load.
- Fixed belief confidence caging: updates clamp into `[0.05, 0.95]` instead of rescaling, which had silently capped confidence at 0.76.
- Fixed i18n test snapshots being timezone-dependent; the suite pins UTC.
