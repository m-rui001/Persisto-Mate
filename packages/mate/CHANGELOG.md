# Changelog

## [1.5.1] - 2026-10-06

### Added

- The two awareness axes that had writers but no reader now do their documented work in the one thought that is about the user: in `daemon.generateThoughts`, felt `userPresence` halves the missing-user urge (contact that is still felt is not absent), and negative `socialPressure` — the anxious attachment system's protest under silence — amplifies it in proportion to `attachmentAnxiety`. Both multipliers are 1 at birth, so urgency is still exactly the drive value for a companion with no contact history.
- `thoughtSaturation` has a source: `self_observation` events (beat thoughts, `remember`/`ponder`, dreams) raise it by 0.2 — half a message's expression discharge — so the `(1 − saturation)` damper in `boredomOf` is no longer a constant 1.

### Fixed

- `quantum.evolveUnitary` wrote the transposed cell as neither the conjugate nor the correct phase of the rotated one (Hermiticity was only restored because `hermitise()` ran afterwards); it now writes the exact conjugate.
- The density matrix can no longer leave the positive-semidefinite cone: the diagonal-relaxation and coherence-injection steps in `transition()` could leave `|rho_ij| > sqrt(rho_ii*rho_jj)` (trace 1, but a negative eigenvalue). New `quantum.clampCoherences()` scales offending cells back onto the 2x2 principal-minor bound and runs after `hermitise()`.
- Offline catch-up applied the sleep-window phase reset at the window's START, so the window's hours were then integrated as wake time: a 24h gap woke the body with rest ≈ 0.5 after "sleeping". The reset now lands at the window's END, so the night's build-up is wiped and waking leaves rest near zero plus the hours since the window ended.
- `context.q()` rendered 0 as `.0` and 1 as `1.0`; zeros and integers now render bare (`0`, `1`, `.4` style unchanged).

## [Unreleased]

## [1.5.0] - 2026-10-06


### Breaking Changes

- **The autonomous loop is simplified; judgment moved fully to the model.** `tick()` now gates a proactive impulse ONLY on the two hard hygiene stops (unanswered-overture tolerance, hourly proactive budget) — the conviction floor, the "faint-pull" branch and `preSendReview` (with its five advisories) are gone, along with `convictionFloor()` and the `advisory` field on `ImpulseDecision`. `PreSendChecks` shrank to `{ userActive, recentProactive }`. `generateThoughts()` collapsed from six coefficient-tuned channels to three (想你 / 好奇或无聊 / 有话想说), each with urgency taken directly from its drive value quantised by the same 0.6 band the state block speaks in; `Thought.kind` shrank to `"curiosity" | "missing_user" | "observation"`. The i18n `Lines` strings for the deleted advisories (`ad*`, `impulseAdvisory`, `impulseWeigh`, `thPattern`, `thNone`) were removed. Hosts embedding the kernel (the dsh companion) migrate by passing the smaller `PreSendChecks` and reading no advisory.

### Changed

- The boredom drive line now says what it feels like and what it wants ("好无聊，想找点事情做" / "bored, looking for something to do") instead of the opaque "闲得慌" / "restless". Boredom now surfaces as an impulse whenever it crosses the 0.6 band — no formula stands between the feeling and the mind.
- Companion guidance now points at the new host-side `reminisce` tool (read past conversations by day and hour), with the corresponding `Lines` strings for the tool's index rendering in both languages.

## [1.3.0] - 2026-10-05

### Changed

- No kernel changes in this cycle; version alignment with the v1.3.0-mate plugin release. The companion's state dir now resolves under the host's agent dir (`~/.pi/agent/mate`) instead of the fork's old `~/.mate/agent/mate` — the `store.ts` API is unchanged, the move is a host-side migration.

## [1.2.1] - 2026-10-05

### Changed

- The kernel's idle-thought seed rotates on `counters.observations` (one +1 per thought actually kept) instead of `counters.transitions`, which live ticks advanced per minute and offline catch-up advanced by the hundreds — rotation unrelated to how often thoughts actually happened.

## [1.2.0] - 2026-10-05

### Added

- Drive satisfaction paths for the two drives that had none, so every drive can now actually fall (a drive that only rises is a leak, not a drive): `curiosity` is discharged by the measured surprise of an appraisal and by consolidating a thought with a subject (Loewenstein 1994's information-gap theory — a gap is closed by acquiring the missing information), and `growth` by task exchanges (White 1959 effectance; Deci & Ryan 2000 competence) and by `sleepTransition` directly (the old `sleep` event that carried its discharge was never emitted by any code, so the branch was dead). Every discharge magnitude reuses the existing discharge scale; no new constants.
- `kernel.convictionFloor()`, and `tick()` now returns `think_only` ("faint-pull") when a proactive impulse's urgency sits below it: a faint pull stays inner life instead of firing a turn. The same formula `preSendReview` already surfaced as an advisory — no new threshold.
- `context.debugView(state, now)`: the developer view behind `/debug` — every number the model-facing block tiers away, plus habituation traces, awareness, allostasis and counters.
- The volatile `<mate>` state block opens with a one-line attribution ("your inner state, not the user's words"), because the block rides the newest message and that is the point of misreading.

### Changed

- The affect judge's magnitude mapping is now anchored to published results instead of a bare gain (see judge.ts header note 4): the -2..+2 ladder is read as equal-interval rungs (Likert 1932; Thurstone 1927's comparative judgment), a fall weighs twice a rise (Baumeister et al. 2001's "bad is stronger than good"; Rozin & Royzman 2001 place the ratio near 2:1 — `JUDGE_NEGATIVITY_BIAS`, the negative cap stays `JUDGE_GAIN`), and a classifier channel's activation is attenuated by its confidence (Spearman 1904's attenuation logic). `judgeActivations()` takes an optional confidence map; `classifyReading` supplies it.
- Both judge question forms now force the reader's perspective: a feeling the USER expressed moves the companion's channel only if the transcript shows the companion itself was moved — the mirroring failure (user's frustration read as the companion's anger) is the one contamination an outside reader exists to prevent.
- The model-facing state block is tiered (name-don't-number, as its own header always claimed): drives appear only past their band and as short prose clauses (band line 0.6, the urge threshold `generateThoughts` already gates with; rest tiers on `drowsinessOf`), emotions render as bare names in magnitude order, and the mood PAD triple, the impulse-line floats and the inclination value moved to `/debug`. Frustration becomes a word past its tiers (0.2 display floor, 0.5 cold-ending gate). The relationship and self anchors keep their numbers.
- An impulse that gets voiced saturates its topic's habituation trace (Groves & Thompson 1970: a habituated stimulus does not immediately re-elicit), so a voiced thought stops feeding straight back as the next impulse; the next thought call's hints also exclude the just-voiced text.
- `openSession(log, t, sealUnclosedAt?)`: an unclean exit's open mark is sealed at the state's last-alive time (bounded to the entry's lifetime) instead of the next boot — sealing a whole night's absence against the next open's clock is what recorded a full night as a seconds-long phantom session.
- The `sleep`/`wake` event kinds are removed from `MateEvent`: nothing emitted them, and sleep reaches the kernel through `sleepTransition()`.

## [1.1.1] - 2026-10-04

### Added

- The learned bio-clock (`MateState.circadian`): 24 bins of user-contact local hours, updated on every user message with a slow pull toward uniform, read as the wake-drive W(t) (smoothed, amplitude scaled by contact mass, weak local-night prior until the shape is learned) — and `drowsinessOf()`, the sleep gate where the rest drive crosses a threshold W raises. The kernel knows nothing about wall-clock bedtimes: the clock is the user's behaviour, and sleep duration is whatever the two processes produce.
- `sleepTransition(state, t, {lived})`: the `lived` flag separates a LIVE night (counted in `sleepCycles`, dream-capable) from the anesthesia of a powered-off gap (physiology only). Catch-up rest windows are no longer nights.

### Changed

- The i18n boot note is `shutGap` ("you were shut off for X") — an offline gap is never claimed as sleep.

## [1.1.0] - 2026-10-04

### Added

- `seedNode(graph, now, seq)`: the idle-thought seed, rotating through the top few memories instead of always taking the strongest.
- `kernel.DRIFTING_TRAITS`: the traits `nudgeCharacter` actually moves, which the character projection reads so it only shows what experience shaped.
- `judgeQuestions()` / `judgeDeltasFromScores()`: the same ladder expressed as one System One `score` question per emotion, so a decision model answers it without generating text. The answer is a probability-weighted rung index, read against the ladder's centre rather than against zero, and a channel whose distribution was near-flat is dropped: five rungs at total indifference put the top rung at 0.2, so a low-confidence answer is the keyword table's coin flip again, only confident. Both readers produce identical `Partial<Record<Emotion, number>>` deltas, so nothing downstream knows which one looked.
- `judge.ts`: the pure half of the affect judge - window selection, the "-2 fell clearly .. +2 rose clearly" question, answer parsing, delta arithmetic, opponent routing, the gain cap, and the gate. Asked for a LEVEL of sadness a small model invents a number; asked whether a feeling ROSE or FELL across the last turns it answers a comparative question it can actually answer. A fall is not thrown away: it is applied to Plutchik's antipode (joy -2 -> sadness +2), which keeps activations non-negative, and a full-scale reading is capped at 0.5 so an outside reader cannot out-shout the state it reads. A named decision model can also be handed the reasoning behind each reply: `JudgeTurn.thinking` rides in the window (capped by `JUDGE_THINKING_CHARS`), and the due gate takes a separate, ten-times-larger token budget for that tier (`JUDGE_MIN_CLASSIFIER_TOKENS`) because the two readers are charged differently.
- The opponent process now produces Solomon & Corbit's hedonic aftereffect: whatever the B-process subtracts below zero re-enters as the channel's wheel antipode instead of being clamped away. Sustained joy attenuates (tolerance) and then leaves a low-grade sadness when it ends (the come-down); sustained grief leaves relief. Before, the subtraction modelled tolerance only and the removed feeling vanished.
- Sadness now decays slower the more the character ruminates (`character.rumination` has a reader for the first time). Verduyn & Lavrijsen (2015) measured sadness as the longest-lasting emotion - sustained by replaying the event - and this is that mechanism: the same sad event lingers longer for a ruminating companion.
- Every rate constant in `params.ts` is now documented with the measurement or model that anchors it (Verduyn & Lavrijsen 2015; Russell & Mehrabian 1977; Gebhard 2005; Davidson 1998; Bisconti et al. 2004; Solomon & Corbit 1974; Groves & Thompson 1970; Borbély 1982; Sterling & Eyer 1988; McEwen & Stellar 1993; Frederick & Loewenstein 1999; Bowlby 1969; Ainsworth 1978; Rempel et al. 1985; Watson & Clark 1984; Roberts & Mroczek 2008; Droit-Volet & Meck 2007).

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
- Guidance no longer tells the model to report its feelings with a tool: how a message felt is the judge's reading, taken after the exchange. The capability-guidance line points at `remember` for keeping what the model builds for itself.
- `judgeDue`: the gate that decides when an outside reading of the exchange could actually say something new - a volume gate measured in the companion's own reply tokens (a stretch of silence contains nothing to read, and a user's message length is not predictable), plus a minimum of new user turns so an overlapping window is not read twice.
- The state shape is now exactly the fields the kernel reads or writes (`sanitiseState` picks every level key-by-key, so a `state.json` from an older build sheds the deleted fields on load instead of carrying them forever).

### Breaking Changes

- The `Lines` i18n record: `feelAck` is renamed `toolAck` (one minimal acknowledgement shared by the inner-life tools), and `feelChannel` / `channelsYouSet` are gone with the feel tool and the host channel registry.
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
