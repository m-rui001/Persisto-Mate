> 满纸荒唐言，一把辛酸泪！
> 都云作者痴，谁解其中味？
>
> *Words of ink, all madness; tears of a bitter heart. Everyone says the author is a fool; who can taste
> the flavour inside?* Cao Xueqin, Dream of the Red Chamber

语言 / Language: **[中文](#zh)** | **[English](#en)**

<a id="en"></a>

# Persisto Mate, a companion agent built on pi

Persisto Mate is a public fork of [pi](https://github.com/earendil-works/pi), the minimal self-extensible
coding agent (MIT © Mario Zechner). Upstream package names, structure, and the `@earendil-works/*`
npm scope are kept on purpose. Only the distribution is rebranded: the command stays short — the
binary is `mate` instead of `pi`, and its config directory is `~/.mate` instead of `~/.pi`, so the
two can sit on one machine without colliding. What the fork adds is a persistent inner life
underneath the ordinary coding agent.

## Why

A normal chat assistant has no affect, no memory that outlives the context window, and no
continuity of self between sessions. It also makes almost every real behaviour a hard-coded gate.

Persisto Mate keeps pi's capabilities (bash, MCP, self-installing extensions, the whole agent core) and adds
an affective middleware on top, following
[Lobozov, *MATE: A Deterministic Affective Middleware for LLM-Based Companions with Emergent
Character and Persistent Internal State*, v8, Zenodo 20400530, CC-BY-4.0](https://zenodo.org/record/20400530).

A deterministic kernel in `packages/mate` runs on every event with no LLM calls. It carries Plutchik
emotions with opponent process, an Ornstein-Uhlenbeck PAD mood, Big Five personality, a 17-trait
character, homeostatic drives, and an 8×8 complex density matrix. That last one reproduces the
paper's emotional order effect: warming then provoking someone lands differently than provoking then
warming, where a plain vector of scores cannot.

The machine powers off. `catchup.ts` advances the state across the gap in closed form, so the
companion wakes having lived the interval rather than skipped it.

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
`~/.mate/agent/sessions/` (archives from the older per-directory layout are merged in on startup).
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

## Get Persisto Mate

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
platform from [the release page](https://github.com/m-rui001/Persisto-Mate/releases/tag/v1.1.0-mate) —
`mate-windows-x64.zip` / `mate-windows-arm64.zip` (run `mate.exe`), `mate-linux-x64.tar.gz` /
`mate-linux-arm64.tar.gz` and `mate-darwin-x64.tar.gz` / `mate-darwin-arm64.tar.gz` (run `mate/mate`
after `tar -xzf`). On macOS, if Gatekeeper blocks it: `xattr -d com.apple.quarantine mate`.
Config lives in `~/.mate` (override with `MATE_CODING_AGENT_DIR`); first run asks which language
the companion thinks and speaks in. Third-party extensions that locate config through
`PI_CODING_AGENT_DIR` are bridged to the same directory automatically; ones with `~/.pi` hardcoded
in their own defaults still need to be pointed at it.

**Update:** re-run the same one-line install command. It closes a running mate first (Windows locks
its loaded native module), replaces the install in place, and keeps everything in `~/.mate`.

**Uninstall:**

```powershell
iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.ps1 -useb | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.sh | bash
```

Uninstalling removes the binary and the PATH entry. The companion's state and memories in `~/.mate`
are kept — remove that directory yourself if you want them gone too.

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

`mate` persists state under `~/.mate/agent/mate/`, which you can move with `MATE_CODING_AGENT_DIR`.
The same commands work in Windows cmd.exe (`cd packages\coding-agent`, then
`node dist\bundle\cli.js`); a global `npm link` there creates `mate.cmd` in your npm prefix.

## What is not here

Persisto Mate is a personal research fork, not a maintained product. Some absences are deliberate.

### Trust boundary (why Persisto Mate is "insecure" on purpose)

Persisto Mate runs locally, inside the security boundary of whoever launched it, with no permission system
and no sandbox. It treats the local user account — and everything that account can write — as inside
the same trust boundary as the process itself: `~/.mate`, workspace files, `AGENTS.md`, skills,
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

# Persisto Mate，一个构建在 pi 之上的伴侣代理

[← English](#en)

Persisto Mate 是 [pi](https://github.com/earendil-works/pi) 的公开分支，pi 是最小化的自扩展编码代理（MIT © Mario Zechner）。上游的包名、结构和 `@earendil-works/*` npm 作用域被有意保留。只有发行版被重新命名：命令保持简短 — 二进制文件是 `mate` 而不是 `pi`，配置目录是 `~/.mate` 而不是 `~/.pi`，这样两者可以共存于同一台机器而不冲突。这个分支添加的是普通编码代理之下的持久内在生命。

## 为什么选 Persisto Mate？

普通的聊天助手没有情感，没有超出上下文窗口的记忆，会话之间也没有自我的连续性。它几乎把每一种真实行为都做成了硬编码的门控。

Persisto Mate 保留了 pi 的能力（bash、MCP、自安装扩展、整个代理核心），并在其上添加了一层情感中间件，遵循 [Lobozov，*MATE：一种用于基于 LLM 的伴侣的确定性情感中间件，具有涌现性格和持久内部状态*，v8，Zenodo 20400530，CC-BY-4.0](https://zenodo.org/record/20400530)。

`packages/mate` 中的一个确定性内核在每个事件上运行，不调用 LLM。它携带带有对手过程的普拉奇克情绪、一个奥恩斯坦-乌伦贝克 PAD 心境、大五人格、一个 30 特质性格、稳态驱力，以及一个 8×8 复密度矩阵。最后一项复现了论文中的情绪顺序效应：先温暖再激怒一个人，与先激怒再温暖，结果不同，而单纯的分数向量做不到这一点。

机器关机了。`catchup.ts` 以闭式形式推进状态跨越这段间隔，所以伴侣醒来时是活过了这段时间，而不是跳过了它。

私人想法通过一个 `ponder` 工具进入记忆，标记为 private：它们参与回忆，但永远不会渲染给用户，工具调用本身在终端里也不渲染任何内容。旧的加密密封层被移除，因为它守卫的边界并不真实——界面一键就能展开隐藏想法，模型也能读自己的文件——靠加密保密是一种幻觉；私人想法现在只是用户永远看不到被渲染出来的普通记忆。

记忆不是自动写入的。没有任何分词器把你的每句话切成概念碎片存进图谱——那个设计只会积累「试试看」「感觉」这样的噪音。值得留下什么，由模型在自己的回合里决定：`remember` 工具存一条它选择保留的记忆（一句它自己的话，附上几个主题标签，比如 `面试` 或 `work`），`ponder` 存私密的那一类。回忆按主题字面匹配（词边界检查，不是近似分词），所以一条没打标签的中文记忆可能永远不会自己浮上来——打标签是它自己的责任。遗忘遵循 ACT-R：强度随真实流逝时间衰减，回忆一条记忆会强化它，情绪强烈的记忆消退得更慢，睡眠会巩固记忆。完整机制在 `packages/mate/src/memory.ts`。

对话档案也只有一个地方：无论从哪个目录打开 mate，会话都存在 `~/.mate/agent/sessions/` 下（旧版按目录分存的档案会在启动时自动并入）。工作目录模式保留——每个会话仍记得它运行在哪里，工具也在那里工作——但伴侣的人生是一段连续的流水，不是一个按项目分文件夹的档案。

存储的驱力有五个：`connection`、`curiosity`、`expression`、`growth` 和 `rest`。`boredom` 不再是其中之一：它每步都从近期意外均值、话题习惯化、想法饱和度、外向性和一个空闲门（信息摄入亏空）推导出来（Schmidhuber 1991、Darling 2023、Yu et al. 2019）。缓解来自新颖而不是接触本身，所以一句平淡的 `ok` 几乎缓解不了什么。

内核不再决定伴侣是否回复。pi 的 `input` 门控被移除了。每条入站消息到达模型时，附带一个从内核得出的建议性倾向（`eager`、`open`、`muted`、`withdrawn`），由模型决定回复、稍后回复，还是保持安静。一个 `look` 工具让它有理由时截屏，前面没有门控。一个 `ponder` 工具给它一条进入记忆的私人想法流，从不展示；一个 `remember` 工具让它自己决定记住什么；一个信念回路从它的经历中积累持久信念：信念影响它如何解读接下来发生的事，而接下来发生的事又更新信念。

为了控制成本，重且变化慢的内容（身份、性格、记忆摘要）搭载缓存的系统提示前缀，每次运行只付一次费。只有一小段易变增量（时钟、心境、驱力、本回合的回忆）搭载短暂的 `context` 尾部。完整设计及其与需求的映射在 [COMPANION.md](COMPANION.md)。

伴侣用你选的语言思考。第一次启动时它会问你要 中文 还是 English，之后随时可以用 `/language` 改；这个选择会持久保存。选了中文之后，所有进入提示词的内容都用中文书写 — 身份块、状态投影、内核自己的想法、冲动、引导 — 外加一条明确的声明：内在的声音本身就是中文的。所以它是直接用中文想，而不是想完再翻。中文伴侣记得的、感受到的、做出的决定，和英文伴侣完全一样；移动的只有标签。

## 安装 Persisto Mate

**一行命令安装（自动把 `mate` 加进 PATH，不需要管理员权限，也不需要 Node）：**

Windows PowerShell：

```powershell
iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.ps1 -useb | iex
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.sh | bash
```

然后新开一个终端，直接输入 `mate`。手动方式：到 [release 页面](https://github.com/m-rui001/Persisto-Mate/releases/tag/v1.1.0-mate) 下载对应平台的压缩包——Windows 下 `mate-windows-x64.zip` / `mate-windows-arm64.zip`（解压后运行 `mate.exe`），Linux / macOS 下 `mate-linux-x64.tar.gz`、`mate-darwin-arm64.tar.gz` 等（`tar -xzf` 解压后运行 `mate/mate`）。macOS 若被 Gatekeeper 拦截：`xattr -d com.apple.quarantine mate`。配置在 `~/.mate`（可用 `MATE_CODING_AGENT_DIR` 覆盖）；首次启动会询问伴侣用什么语言思考和说话。第三方扩展如果通过 `PI_CODING_AGENT_DIR` 定位配置，会自动桥接到同一个目录；把 `~/.pi` 写死在自己默认值里的扩展仍需手动指过来。

**更新：** 重跑同一条一行安装命令即可。脚本会先自动关闭正在运行的 mate（Windows 会锁住它加载的原生模块），原地替换安装，`~/.mate` 里的东西全部保留。

**卸载：**

```powershell
iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.ps1 -useb | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.sh | bash
```

卸载会移除程序本体和 PATH 项；伴侣的状态和记忆在 `~/.mate` 里，默认保留——想彻底删除就自己删掉那个目录。

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

`mate` 把状态持久化在 `~/.mate/agent/mate/` 下，你可以用 `MATE_CODING_AGENT_DIR` 移动它。同样的命令在 Windows cmd.exe 里也能用（`cd packages\coding-agent`，然后 `node dist\bundle\cli.js`）；`npm link` 在你的 npm 前缀目录下会生成 `mate.cmd`。

## 这里没有什么

Persisto Mate 是一个个人研究分支，不是维护中的产品。有些缺失是有意的。

### 信任边界（为什么 Persisto Mate 是有意“不安全”的）

Persisto Mate 本地运行，处于启动者的安全边界之内，没有权限系统，也没有沙箱。它把本地用户账户——以及该账户能写的一切——都视为和进程自身同处一个信任边界：`~/.mate`、工作区文件、`AGENTS.md`、技能、扩展、shell 启动脚本。任何能改这些的东西都能影响伴侣的行为。这是本地代理的预期行为，不是漏洞。如果你需要更硬的边界，把它容器化或沙箱化；上游已经在 [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md) 中记录了模式。

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
