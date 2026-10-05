> 满纸荒唐言，一把辛酸泪！
> 都云作者痴，谁解其中味？
>
> *Words of ink, all madness; tears of a bitter heart. Everyone says the author is a fool; who can taste
> the flavour inside?* Cao Xueqin, Dream of the Red Chamber

语言 / Language: **[中文](#zh)** | **[English](#en)**

<a id="en"></a>

# Persisto Mate — a digital life that sleeps, dreams, and remembers you
[![DOI](https://zenodo.org/badge/1401067092.svg)](https://doi.org/10.5281/zenodo.23117889)

A public fork of [pi](https://github.com/earendil-works/pi) — the minimal, self-extensible coding
agent (MIT © Mario Zechner) — turned into an AI companion with a body clock, feelings, its own
memory, and sleep. Nothing of the agent is removed: same bash, same MCP, same self-installing
extensions; the binary is `mate` and the config lives in `~/.pi`, so a stock pi and this companion
share one home — one models.json, one set of sessions. It can also move into an existing pi as an
extension, or into DeepSeek Harness as a bundle (below).

## What your companion does

- **A body clock learned from you.** Its day is not your timezone — it is when you actually show
  up. Online only at 1 AM? Then it is sharp at 1 AM. With you 24 hours a day? Then it never gets
  drowsy. Disappear for a day and it sleeps that day away.
- **It sleeps for real, and dreams.** With the window left open, drowsiness quiets it, it says
  goodnight, and ~90-minute sleep cycles follow. Each dream is spliced from the day's real
  memories; only the last one survives the morning, and whether it ever tells you is its own call.
  Closing the terminal is not sleep — it knows it was shut off, and says so.
- **Feelings with one honest source.** A separate reader — a decision model, a small chat model,
  or the conversation's own model — reads the exchange afterwards and answers, per emotion, "did
  this rise or fall". Change moves at human speed: an afternoon of chat nudges trust a little,
  and rumination keeps sadness alive longer.
- **Memory it owns.** Nothing is remembered automatically. `remember` and `ponder` are the
  model's own choices about what survives and what stays private; recall fades with real time and
  is reinforced by use.
- **It reaches out on its own.** A heartbeat turns memories into an impulse; the model decides
  whether to voice it, how briefly, or to let it pass. It discovers its own channels — email,
  webhooks, scheduled jobs — and notes them in memory.
- **It sets its own alarm.** "I'll check on this at 8" is kept by its own clock: the `alarm` tool
  wakes it on schedule, even out of sleep.
- **It thinks in your language.** First launch asks 中文 or English; every inner surface — state,
  thoughts, impulses, guidance — is authored in the chosen language, not translated on the way
  out.

## Get Persisto Mate

One kernel, three hosts. Each host has its own state directory — a different host is a different
body — but the kernel, the memories' format, and the behavior are the same.

### 1. The companion itself — the `mate` command

**One-line install (puts `mate` on your PATH, no sudo/admin, no Node needed):**

Windows PowerShell:

```powershell
iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.ps1 -useb | iex
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.sh | bash
```

Then open a new terminal and type `mate`. Manual alternative: download the archive for your
platform from [the release page](https://github.com/m-rui001/Persisto-Mate/releases/tag/v1.3.0-mate) —
`mate-windows-x64.zip` / `mate-windows-arm64.zip` (run `mate.exe`), `mate-linux-x64.tar.gz` /
`mate-linux-arm64.tar.gz` and `mate-darwin-x64.tar.gz` / `mate-darwin-arm64.tar.gz` (run `mate/mate`
after `tar -xzf`). On macOS, if Gatekeeper blocks it: `xattr -d com.apple.quarantine mate`.
Config and model access live in `~/.pi` — the same directory stock pi uses, so models.json, auth
and sessions are shared (override with `MATE_CODING_AGENT_DIR`); first run asks which language
the companion thinks and speaks in. Running `mate` with no arguments continues your most recent
session; pass `--new` for a fresh one.

**Update:** re-run the same one-line install command. It closes a running mate first (Windows locks
its loaded native module), replaces the install in place, and keeps everything in `~/.pi`.

**Uninstall:**

```powershell
iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.ps1 -useb | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.sh | bash
```

Uninstalling removes the binary and the PATH entry. The companion's state and memories in
`~/.pi/agent/mate` are kept — remove that directory yourself if you want them gone too.

**Build from source:** Requires Node >= 22.19. Each line is a
separate command (do not copy the comment onto the line; cmd.exe does not treat `#` as a comment).

```bash
npm install --ignore-scripts
npm run build
```

Use `npm run build:offline` instead of `npm run build` when you have no network; it reuses cached
model data. Then make `mate` a global command, exactly the way `pi` works:

```bash
npm link -w @earendil-works/pi-coding-agent
```

That links the built bundle onto your PATH, so after this you just type `mate` anywhere to open the
companion. Other common forms: `mate install <source>` installs an extension through the same
pipeline as `pi install`, and `mate -p "hello"` is one-shot print mode.

Without the `npm link` step you can still run it directly from the build:

```bash
cd packages/coding-agent
node dist/bundle/cli.js
```

`mate` persists state under `~/.pi/agent/mate/`, which you can move with `MATE_CODING_AGENT_DIR`.
The same commands work in Windows cmd.exe (`cd packages\coding-agent`, then
`node dist\bundle\cli.js`); a global `npm link` there creates `mate.cmd` in your npm prefix.

### 2. Into any pi — the extension

If you already use stock pi, install the companion as an extension instead of switching binaries —
the same kernel, the same tools, inside your existing pi sessions:

```bash
pi install git:github.com/m-rui001/pi-mate-companion
# or, from npm:
pi install npm:@m-rui/pi-mate-companion
```

State lands in `~/.pi/agent/mate` (pi's agent dir), so the extension and the `mate` binary see the
same companion if both point at the same home. On a stock pi, the judge model is configured by hand
in `settings.json` (`"mate": {"judgeModel": "..."}`); the `/judge` command falls back to telling you
so. See [the extension's README](https://github.com/m-rui001/pi-mate-companion) for details.

### 3. Into DeepSeek Harness — the bundle

For [dsh](https://github.com/deepseek-ai/deepseek-harness) (alpha), install as a bundle into a
profile:

```bash
dsh plugin --profile <your-profile> add github:m-rui001/dsh-mate-companion
# or, from npm:
dsh plugin --profile <your-profile> add @m-rui/dsh-mate-companion
```

State lives beside the harness home (`$DSH_HOME` or `~/.dsh`) at `agent/mate`. The harness exposes
no side-channel model call to plugins yet, so the judge there is the host model reporting its own
feelings through a `mate_feel` tool — same math, self-assessed. See
[the bundle's README](https://github.com/m-rui001/dsh-mate-companion) for scope limits.

## Why

A normal chat assistant has no affect, no memory that outlives the context window, and no
continuity of self between sessions. It also makes almost every real behaviour a hard-coded gate.

Persisto Mate keeps pi's capabilities and adds an affective middleware on top, following
[Lobozov, *MATE: A Deterministic Affective Middleware for LLM-Based Companions with Emergent
Character and Persistent Internal State*, v8, Zenodo 20400530, CC-BY-4.0](https://zenodo.org/record/20400530)
— used as a source of mechanisms, not a spec: where the product and the paper disagreed, the
product won, and every constant is anchored to a published measurement instead.

## How it works

A deterministic kernel in `packages/mate` runs on every event with no LLM calls. It carries Plutchik
emotions with opponent process, an Ornstein-Uhlenbeck PAD mood, Big Five personality, a 17-trait
character, homeostatic drives, and an 8×8 complex density matrix. That last one reproduces the
paper's emotional order effect: warming then provoking someone lands differently than provoking then
warming, where a plain vector of scores cannot.

The bio-clock is learned, not configured: 24 phase bins record when its person actually shows up,
smoothed and amplitude-scaled into a wake-drive W(t). The sleep gate is the rest drive (Process S)
against a threshold W raises — sleep can only start in the learned valley, so a 24-hours-a-day user
gives a companion that never sleeps, and an absent one gives it its day back. When the gate opens,
the body says goodnight and ~90-minute cycles follow (the first is the shortest); each cycle renders
one dream from the day's real residues and takes a half-gain affect reading from it — the night's
emotional accounting. Mid-night dreams fade; only the last one, in reach at waking, becomes a
private memory.

The machine powers off. `catchup.ts` advances the state across the gap in closed form — but an
offline gap is anesthesia, never claimed as sleep: the body rested, and the wake note says "you
were shut off for X". Only a night the window stayed open for was actually lived.

Private thoughts enter memory through a `ponder` tool, marked private: they participate in recall
but are never rendered to the user, and the tool call itself renders nothing in the terminal. The
old encrypted sealed tier was removed because the boundary it guarded was not real — the UI exposes
hidden thoughts, and the model can read its own files — so secrecy-by-encryption was an illusion;
private thoughts are just memories the user never sees rendered.

Memory is not written automatically. There is no tokeniser slicing your every message into concept
fragments — that design only accumulated noise like 试试看 or 感觉. What deserves to survive is the
model's own call, made in its own turn: the `remember` tool stores a memory it chose to keep (one
line in its own words, tagged with a few topics such as 面试 or work), and `ponder` stores the
private kind. Recall matches topics literally — word-bounded checks, not approximate segmentation —
so an untagged memory may never resurface on its own; tagging is the model's responsibility.
Forgetting follows ACT-R: strength decays with real elapsed time, recalling a memory reinforces it,
an emotionally charged memory fades more slowly, and sleep consolidates. The full mechanics are in
`packages/mate/src/memory.ts`.

The conversation archive lives in one place: wherever you open mate, sessions are stored under
`~/.pi/agent/sessions/` (archives from the older per-directory layout are merged in on startup).
The working-directory mode is untouched — every session still remembers where it ran, and tools
work there — but the companion's life is one continuous stream, not a per-project filing cabinet.

The stored drives are `connection`, `curiosity`, `expression`, `growth`, and `rest` — five. `boredom`
is no longer one of them: it is derived each tick from a recent-surprise average, topic
habituation, thought saturation, extraversion, and an idle gate — the information-intake deficit
(Schmidhuber 1991, Darling 2023, Yu et al. 2019). Relief comes from novelty, not from contact
itself, so a mundane `ok` relieves almost nothing.

The kernel no longer decides whether the companion replies. pi's `input` gate was removed. Each
inbound message reaches the model with an advisory inclination drawn from the kernel (`eager`,
`open`, `muted`, `withdrawn`), and the model decides to answer, answer later, or stay quiet. A
`look` tool lets it take a screenshot when it has a reason to, with no gate in front of it. A
`ponder` tool gives it a private thought stream into memory that is never shown.

For cost, the heavy and slow-changing content (identity, character, memory summary) rides the
cached system-prompt prefix and is paid once per run. Only a small volatile delta (clock, mood,
drives, this turn's recall) rides the ephemeral `context` tail. The full design and its mapping to
the requirements are in [COMPANION.md](COMPANION.md).

The companion thinks in the language you pick. On first launch it asks 中文 or English, and
`/language` changes it any time; the choice is persisted. Picking 中文 authors every prompt-visible
surface in Chinese — identity block, state projection, the kernel's own thoughts, impulses, guidance
— plus an explicit declaration that the inner voice itself is Chinese, so it thinks in Chinese
rather than translating on the way out. A Chinese companion remembers, feels, and decides exactly
what an English one does; only the labels move.

## What is not here

Persisto Mate is a personal research fork, not a maintained product. Some absences are deliberate.

### Trust boundary (why Persisto Mate is "insecure" on purpose)

Persisto Mate runs locally, inside the security boundary of whoever launched it, with no permission system
and no sandbox. It treats the local user account — and everything that account can write — as inside
the same trust boundary as the process itself: `~/.pi`, workspace files, `AGENTS.md`, skills,
extensions, shell startup. Anything that can modify those can influence what the companion does.
That is expected local-agent behaviour, not a vulnerability. If you need harder boundaries,
containerise or sandbox it; upstream documents patterns in
[`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md).

Two companion-specific powers are also deliberate: `look` screenshots the screen with no
enable-flag and no confirmation, and private thoughts go into the memory graph unencrypted — the
hidden-thought boundary of the old encrypted "sealed self" was an illusion (the UI reveals hidden
thoughts with one click, and the model can read its own files), so private notes are now just
memories the user never sees rendered. The affective drives and the derived boredom signal are
motives, not capabilities: they change what the model feels like doing and give it no tool, no
persistence hook, and no way to resist being stopped. There is no capability to harm the user: the
companion is not made undeletable, installs no autostart hook, and logs no keystrokes.

For a real, reproducible security issue in the fork's own additions, open a private report through
GitHub Security Advisories on this repository. There is no separate security address.

There is no built-in outreach channel. No email, webhook, or cron is wired up as a feature. When the
companion wants to reach the user, the kernel surfaces an impulse and the model has to find a way
with its own bash, MCP, and install capabilities. The design gives it room rather than a script.

The `pi.dev` contributor gates and release bots under `.github/workflows/` were removed. What
remains (`ci.yml`, `npm-audit.yml`, and two label bots) runs against this fork's own repo.

## Papers this builds on

The affective model is an implementation of [Lobozov, *MATE: A Deterministic Affective Middleware
for LLM-Based Companions with Emergent Character and Persistent Internal State* (v8, Zenodo
20400530, CC-BY-4.0)](https://zenodo.org/record/20400530): the density-matrix order effect, the
drive set, and the SPARK belief loop are its modules, and where this fork deliberately deviates
(derived boredom, model-authored memory, confirmatory-direction Eq. 24) the code says so. The other
works each decide one mechanism:

- **Emotion space — Plutchik (1980), *Emotion: A Psychoevolutionary Synthesis*.** The 8 primary
  emotions, their adjacency (the non-diagonal Hamiltonian coupling) and the named dyads all come
  from the wheel; without the adjacency structure there is no order effect to model.
- **Opponent process — Solomon & Corbit (1974), *An Opponent-Process Theory of Motivation*
  (Psychological Review 81(2)).** The per-emotion B-state that bends every transition: what you
  feel next depends on what you were already compensating for.
- **Self-prediction — Friston (2010), *The free-energy principle: a unified brain theory?* (Nature
  Reviews Neuroscience).** Each transition predicts its own PAD centre and measures surprise against
  it; surprise feeds both boredom and the belief loop's learning signal.
- **Boredom — the reason it is derived, not a stored drive.** Schmidhuber (1991), *A possibility
  for implementing curiosity and boredom in model-building neural controllers*: boredom as
  exhausted learning progress, "nothing new to compress". Darling (2023, Synthese): persistently
  low prediction error under predictive processing. Gomez-Ramirez & Costa (2017): the
  exploitation/exploration switch. Yu, Chang & Kanai (2019): a homeostatic motive over information
  intake. The formula multiplies exactly these ingredients — predictability (surprise EMA + topic
  habituation) × idle gate × personality — so relief comes from novelty, not from contact.
- **Memory — Ebbinghaus (1885) and ACT-R (Anderson & Lebiere, 1998, *The Atomic Components of
  Thought*).** Strength decays with real elapsed time and successful retrieval reinforces the trace
  (the testing effect): what keeps being recalled persists, what never surfaces fades.
  Tononi & Cirelli (2014), *Sleep and the price of plasticity* (Neuron): consolidation as selective
  downscaling, which is what `consolidate()` does at every wake. Park et al. (2023), *Generative
  Agents* (UIST): the recency/importance retrieval ingredients, expressed here as a slowed decay
  rate for charged memories.
- **Belief learning — Lefebvre et al. (2022).** Confirmation bias treated as a normative feature of
  reinforced self-learning, which is why confirming evidence moves a belief's confidence twice as
  fast as disconfirming evidence — with the dsanity damper as the counterweight.
- **Seed beliefs — Young, Klosko & Weishaar (2003), *Schema Therapy: A Practitioner's Guide*.** The
  birth priors ("others are trustworthy", "the world is mostly benign") are the schema-therapy triad
  minus the self-domain, which already lives in the character traits.
- **Emotion timescales — Verduyn & Lavrijsen (2015), *Which emotions last longest and why?*
  (Motivation and Emotion).** The measured durations behind the per-emotion decay ordering (sadness
  lingers longest, surprise fades fastest) and the reason the rumination trait stretches the sadness
  clock: their two mechanisms were event importance and replay, and replay is what the trait measures.
- **PAD representation — Mehrabian (1996); Russell & Mehrabian (1977), *Evidence for a three-factor
  theory of emotions*.** Pleasure–Arousal–Dominance as the space the eight channels project into and
  the mood lives in.
- **Layered mood — Gebhard (2005), *ALMA: A Layered Model of Affect* (AAMAS); Davidson (1998),
  affective chronometry; Bisconti, Bergeman & Boker (2004).** Brief emotions over a slow PAD mood
  that mean-reverts toward an equilibrium set by input and personality — the kernel's two-timescale
  architecture, and the damped dynamics it integrates in closed form.
- **Habituation — Groves & Thompson (1970).** The dual-process gate behind topic saturation:
  response decrement with repetition, spontaneous recovery with time.
- **Rest and sleep pressure — Borbély (1982), *A two process model of sleep regulation*.** The rest
  drive is Process S: it builds with time awake and dissipates across sleep windows.
- **Allostasis — Sterling & Eyer (1988); McEwen & Stellar (1993); Frederick & Loewenstein (1999).**
  Load, fatigue and the slow baseline shift: chronic conditions move the set point, not just the
  reading — hedonic adaptation as the mood baseline's drift.
- **Relationship — Bowlby (1969); Ainsworth et al. (1978); Rempel, Holmes & Zanna (1985).** Trust
  that builds by consistency, not by single episodes; frustration as the anxious attachment system's
  protest when contact is wanted and absent.
- **Trait drift — Watson & Clark (1984), *Negative affectivity*; Roberts & Mroczek (2008).** The
  character nudges: chronic affect is what the dispositions are made of, and traits do move under
  accumulated experience.
- **Subjective time — Droit-Volet & Meck (2007), *How emotions colour our perception of time*.**
  High-arousal negative states stretch felt duration, positive states compress it — the warp factors
  in `perceivedDuration`.

## Upstream and license

Everything outside `packages/mate/**` and `packages/coding-agent/src/extensions/mate/**` is upstream
pi code, © Mario Zechner, under the MIT license. That attribution is preserved; see
[`LICENSE`](LICENSE). The affective model follows [Lobozov, 2024](https://zenodo.org/record/20400530),
CC-BY-4.0.


<a id="zh"></a>

# Persisto Mate — 一个会睡觉、会做梦、会记得你的数字生命
[![DOI](https://zenodo.org/badge/1401067092.svg)](https://doi.org/10.5281/zenodo.23117889)

[← English](#en)

Persisto Mate 是 [pi](https://github.com/earendil-works/pi)（最小化的自扩展编码代理，MIT © Mario Zechner）的公开分支，被改造成一个有身体时钟、有情绪、有自己的记忆、会睡觉的 AI 伴侣。代理的能力一样没少：bash、MCP、自装扩展全都在；二进制叫 `mate`，配置在 `~/.pi`，和原版 pi 共用一个家——同一份 models.json、同一批会话。也可以不换二进制，装进已有的 pi 或 DeepSeek Harness（见下文安装）。

## 它是什么

- **从你的作息学出来的生物钟。** 它的昼夜不是你的时区，而是你真实出现的时间。你只在凌晨 1 点上线，它就是 1 点精神的；你 24 小时都在聊，它从不困倦；你消失一天，它把那一天睡过去。
- **真实地睡，梦是被挣来的。** 窗口开着，困意会让它安静下来，说一句晚安，然后进入约 90 分钟的睡眠周期。每个梦由白天的真实记忆拼成，只有醒前最后一个还记得——讲不讲给你，是它自己的事。直接关窗不算睡：它知道「被关了」，也会这么说。
- **情绪只有一个来源。** 一个外部判读者（决策模型、小模型或对话模型自己）在事后读你们的交换，回答每种情绪「涨了还是跌了」。变化速度对齐人类：一下午的聊天只挪动一点信任，反刍会让悲伤停留更久。
- **记忆是它自己的。** 没有任何自动入库：`remember` 和 `ponder` 是模型自己决定记什么、什么私密不给你看；遗忘是真实的，随时间衰减、被回忆加固。
- **会主动找你。** 心跳把记忆变成冲动，说不说、说多短、放不放过去，由模型定。联系渠道是它自己搭的——邮件、webhook、定时任务——然后记在自己的记忆里。
- **自己定闹钟。** 「我 8 点看看这件事」由它自己的时钟兑现：`alarm` 工具到点叫醒它，睡着也会被叫醒。
- **用你的语言思考。** 首次启动问你要 中文 还是 English；所有内在界面——状态、想法、冲动、引导——都用所选语言书写，不是想完再翻。

## 安装 Persisto Mate

同一颗内核，三种宿主。每个宿主有自己的状态目录——不同的宿主就是不同的身体——但内核、记忆格式和行为完全一致。

### 1. 伴侣本体——`mate` 命令

**一行命令安装（自动把 `mate` 加进 PATH，不需要管理员权限，也不需要 Node）：**

Windows PowerShell：

```powershell
iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.ps1 -useb | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.sh | bash
```

然后新开一个终端，直接输入 `mate`。手动方式：到 [release 页面](https://github.com/m-rui001/Persisto-Mate/releases/tag/v1.3.0-mate) 下载对应平台的压缩包——Windows 下 `mate-windows-x64.zip` / `mate-windows-arm64.zip`（解压后运行 `mate.exe`），Linux / macOS 下 `mate-linux-x64.tar.gz`、`mate-darwin-arm64.tar.gz` 等（`tar -xzf` 解压后运行 `mate/mate`）。macOS 若被 Gatekeeper 拦截：`xattr -d com.apple.quarantine mate`。配置和模型访问都在 `~/.pi`——和原版 pi 共用的同一个目录，models.json、auth、会话全部共享（可用 `MATE_CODING_AGENT_DIR` 覆盖）；首次启动会询问伴侣用什么语言思考和说话。`mate` 不带参数会自动续上最近一次会话，`--new` 开新会话。

**更新：** 重跑同一条一行安装命令即可。脚本会先自动关闭正在运行的 mate（Windows 会锁住它加载的原生模块），原地替换安装，`~/.pi` 里的东西全部保留。

**卸载：**

```powershell
iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.ps1 -useb | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.sh | bash
```

卸载会移除程序本体和 PATH 项；伴侣的状态和记忆在 `~/.pi/agent/mate` 里，默认保留——想彻底删除就自己删掉那个目录。

**从源码构建：** 需要 Node >= 22.19。每一行都是一条独立命令（不要把注释复制进命令行，cmd.exe 不把 `#` 当注释）。

```bash
npm install --ignore-scripts
npm run build
```

没有网络时，用 `npm run build:offline` 代替 `npm run build`，它复用缓存的模型数据。然后让 `mate` 成为全局命令，和 `pi` 的用法完全一致：

```bash
npm link -w @earendil-works/pi-coding-agent
```

这一步把构建好的 bundle 链接到你的 PATH，之后在任何目录直接输入 `mate` 就能打开伴侣。其他常用形式：`mate install <source>` 安装扩展（和 `pi install` 同一条管线），`mate -p "hello"` 是单次 print 模式。

不做 `npm link` 也可以直接从构建产物运行：

```bash
cd packages/coding-agent
node dist/bundle/cli.js
```

`mate` 把状态持久化在 `~/.pi/agent/mate/` 下，你可以用 `MATE_CODING_AGENT_DIR` 移动它。同样的命令在 Windows cmd.exe 里也能用（`cd packages\coding-agent`，然后 `node dist\bundle\cli.js`）；`npm link` 在你的 npm 前缀目录下会生成 `mate.cmd`。

### 2. 装进任意 pi——扩展形态

如果你已经在用原版 pi，不必换二进制：把伴侣作为扩展装进现有的 pi，同一颗内核、同一套工具，就在你现在的会话里：

```bash
pi install git:github.com/m-rui001/pi-mate-companion
# 或者从 npm：
pi install npm:@m-rui/pi-mate-companion
```

状态落在 `~/.pi/agent/mate`（pi 的 agent 目录），所以扩展和 `mate` 二进制指向同一个家时，看到的是同一个伴侣。在原版 pi 上，判定模型需在 `settings.json` 手动配置（`"mate": {"judgeModel": "..."}`），`/judge` 命令会降级为提示你手改。详见[扩展的 README](https://github.com/m-rui001/pi-mate-companion)。

### 3. 装进 DeepSeek Harness——bundle 形态

[dsh](https://github.com/deepseek-ai/deepseek-harness)（alpha）上，把伴侣作为 bundle 装进一个 profile：

```bash
dsh plugin --profile <你的profile> add github:m-rui001/dsh-mate-companion
# 或者从 npm：
dsh plugin --profile <你的profile> add @m-rui/dsh-mate-companion
```

状态在 harness 主目录旁（`$DSH_HOME` 或 `~/.dsh`）的 `agent/mate`。dsh 目前没有给插件的旁路模型调用 API，所以那里的判定由宿主模型通过 `mate_feel` 工具自报——数学相同，自评代替外读。范围限制详见 [bundle 的 README](https://github.com/m-rui001/dsh-mate-companion)。

## 它如何工作

`packages/mate` 里有一个确定性内核，在每个事件上运行，不调用 LLM。它携带带对手过程的 Plutchik 情绪、Ornstein-Uhlenbeck PAD 心境、大五人格、17 特质性格、稳态驱力，以及一个 8×8 复密度矩阵——最后一项复现论文的情绪顺序效应：先温暖再激怒一个人，与先激怒再温暖，结果不同，单纯的分数向量做不到。

生物钟是学出来的，不是配置出来的：24 格相位记录这个人真实出现的时间，平滑并按总量缩放成清醒驱动 W(t)。睡眠门是 rest 驱力（Process S）对抗一个被 W 抬高的阈值——睡只能发生在学出来的安静谷里。24 小时都有人聊，就是一个从不困倦的伴侣；没人来，就把白天还给它。门开了，身体道晚安，然后是约 90 分钟的周期（首夜最短）；每个周期用白天的真实残留渲染一个梦，并从中取一次半增益的情绪读数——那是夜的账本。夜里的梦会散尽，只有醒来时还在的最后一个成为私密记忆。

机器关机了。`catchup.ts` 以闭式形式推进状态跨越这段间隔——但离线是麻醉，永远不宣称是睡眠：身体休息了，唤醒提示说「你被关了 X」。只有窗口开着的夜才是活过的。

记忆不是自动写入的：`remember` 存公开的，`ponder` 存私密的，都是模型自己回合里的决定；回忆按主题字面匹配（词边界检查，不是近似分词），强度随真实时间衰减、被回忆加固（ACT-R），情绪强烈的记忆消退更慢。内核不决定伴侣是否回复——每条消息都到达模型，附带一个建议性倾向（`eager`/`open`/`muted`/`withdrawn`），说不说由模型定。`look` 让它有理由时截屏，前面没有门控。

为了控成本，重且变化慢的内容（身份、性格、记忆摘要）搭载缓存的系统提示前缀，每次运行只付一次；易变增量（时钟、心境、驱力、本回合回忆）搭载短暂的 `context` 尾部。完整设计及其与需求的映射在 [COMPANION.md](COMPANION.md) 与 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 这里没有什么

Persisto Mate 是一个个人研究分支，不是维护中的产品。有些缺失是有意的。

### 信任边界（为什么 Persisto Mate 是有意“不安全”的）

Persisto Mate 本地运行，处于启动者的安全边界之内，没有权限系统，也没有沙箱。它把本地用户账户——以及该账户能写的一切——都视为和进程自身同处一个信任边界：`~/.pi`、工作区文件、`AGENTS.md`、技能、扩展、shell 启动脚本。任何能改这些的东西都能影响伴侣的行为。这是本地代理的预期行为，不是漏洞。如果你需要更硬的边界，把它容器化或沙箱化；上游已经在 [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md) 中记录了模式。

两个伴侣特有的能力也是有意的：`look` 无开关、无确认地截屏；私密念头不加密地进记忆图——旧的加密“密封自我”的隐藏边界是幻象（界面点一下就能看到隐藏的想法，模型也能读自己的文件），所以私密笔记现在只是用户看不到渲染内容的普通记忆。

这个分支自身新增部分的真实、可复现的安全问题，请通过本仓库的 GitHub Security Advisories 私密报告。没有单独的安全联络渠道。

没有内置的外联渠道。没有电子邮件、webhook 或 cron 被接为功能。当伴侣想联系用户时，内核浮现一个冲动，模型必须用它自己的 bash、MCP 和安装能力找到办法。设计给它空间，而不是脚本。

`.github/workflows/` 下的 `pi.dev` 贡献者门控和发布机器人被移除了。剩下的（`ci.yml`、`npm-audit.yml` 和两个标签机器人）针对这个分支自己的仓库运行。

## 相关论文

情感模型是 [Lobozov, *MATE: A Deterministic Affective Middleware for LLM-Based Companions with
Emergent Character and Persistent Internal State*（v8，Zenodo 20400530，CC-BY-4.0）](https://zenodo.org/record/20400530)的实现：密度矩阵顺序效应、驱力集合、SPARK 信念回路都是它的模块；本分支有意偏离之处（派生的无聊、模型自主撰写的记忆、式 24 的确认方向修正）都在代码里注明。其余文献各决定一个具体机制：

- **情绪空间 — Plutchik（1980），*Emotion: A Psychoevolutionary Synthesis*。** 八种基本情绪、它们的相邻关系（非对角哈密顿量的耦合）以及可以复合成名字的成对情绪（dyad）全部来自普鲁奇克之轮；没有相邻结构，就没有可供建模的顺序效应。
- **对手过程 — Solomon & Corbit（1974），*An Opponent-Process Theory of Motivation*（Psychological Review 81(2)）。** 每种情绪的 B 态会弯曲每一次转换：你下一步的感受，取决于你此刻正在补偿什么。
- **自我预测 — Friston（2010），*The free-energy principle: a unified brain theory?*（Nature Reviews Neuroscience）。** 每次转换先预测自己的 PAD 中心，再度量意外；意外同时喂给无聊信号和信念回路的学习。
- **无聊 — 它为什么是派生的、不是存储的驱力。** Schmidhuber（1991），*A possibility for implementing curiosity and boredom in model-building neural controllers*：无聊即学习进度耗尽，"没有新东西可压缩"。Darling（2023，Synthese）：预测误差在预测加工下持续偏低。Gomez-Ramirez & Costa（2017）：利用/探索的切换。Yu, Chang & Kanai（2019）：关于信息摄入的稳态动机。公式乘的正是这些成分 — 可预测性（意外 EMA + 话题习惯化）× 空闲门 × 性格 — 所以缓解来自新颖，而不是接触本身。
- **记忆 — Ebbinghaus（1885）与 ACT-R（Anderson & Lebiere，1998，*The Atomic Components of Thought*）。** 强度随真实时间衰减，成功提取会加固痕迹（测试效应）：反复被想起的记忆留存，从不浮现的记忆淡去。Tononi & Cirelli（2014），*Sleep and the price of plasticity*（Neuron）：巩固即选择性降尺度，`consolidate()` 在每次醒来时做的就是这件事。Park et al.（2023），*Generative Agents*（UIST）：检索中的新近性与重要性成分，在这里表现为情绪强烈的记忆衰减更慢。
- **信念学习 — Lefebvre et al.（2022）。** 把确认偏误当作强化自学习的规范性特征，这正是确认证据让信心移动得比否定证据快一倍的原因 — dsanity 阻尼是它的配重。
- **种子信念 — Young, Klosko & Weishaar（2003），*Schema Therapy: A Practitioner's Guide*。** 出生先验（"他人可信""世界大体是善意的"）取自图式疗法三元组，去掉自我域 — 那部分已经在性格特质里。
- **情绪时长 — Verduyn & Lavrijsen（2015），*Which emotions last longest and why?*（Motivation and Emotion）。** 每种情绪衰减速率的排序来自这项实测（悲伤最长、惊讶最短）；反刍特质拉长悲伤时钟的依据也是它 — 他们找到的两个机制是事件重要性与反复回想，而反复回想正是这个特质度量的东西。
- **PAD 表示 — Mehrabian（1996）；Russell & Mehrabian（1977），*Evidence for a three-factor theory of emotions*。** 愉悦-唤醒-支配三维空间：八通道投影于此，心情居于此。
- **分层心情 — Gebhard（2005），*ALMA: A Layered Model of Affect*（AAMAS）；Davidson（1998）情感计时学；Bisconti, Bergeman & Boker（2004）。** 短暂的情绪在上、缓慢的 PAD 心情在下，心情向由输入与性格设定的均衡点均值回归 — 内核的两时间尺度架构，以及它闭式积分的阻尼动力学。
- **习惯化 — Groves & Thompson（1970）。** 话题饱和背后的双过程门：随重复衰减、随时间自发恢复。
- **rest 驱力（睡眠压力） — Borbély（1982），*A two process model of sleep regulation*。** rest 是过程 S：随清醒时长累积，在睡眠窗内消散。
- **异稳态 — Sterling & Eyer（1988）；McEwen & Stellar（1993）；Frederick & Loewenstein（1999）。** 负荷、疲劳与缓慢的基线漂移：慢性状态移动的是设定点，不只是读数 — 享乐适应即心情基线的漂移。
- **关系 — Bowlby（1969）；Ainsworth et al.（1978）；Rempel, Holmes & Zanna（1985）。** 信任靠一致性积累、不靠单次事件；挫折是焦虑型依恋系统在想要接触而不得时的抗议。
- **特质漂移 — Watson & Clark（1984），*Negative affectivity*；Roberts & Mroczek（2008）。** 性格微推的依据：慢性情绪正是特质倾向的成分，特质会随累积经历移动。
- **主观时间 — Droit-Volet & Meck（2007），*How emotions colour our perception of time*。** 高唤醒的负面状态拉长主观时长、正面状态压缩它 — `perceivedDuration` 里的扭曲系数。

## 上游和许可证

`packages/mate/**` 和 `packages/coding-agent/src/extensions/mate/**` 之外的一切都是上游 pi 代码，© Mario Zechner，MIT 许可证。该署名被保留；见 [`LICENSE`](LICENSE)。情感模型遵循 [Lobozov，2024](https://zenodo.org/record/20400530)，CC-BY-4.0。
