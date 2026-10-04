/**
 * Structural intake reading: what a message ASKS FOR, with no claim about how it FELT.
 *
 * This module used to be a hand-maintained ~150-entry English/Chinese keyword table (haha -> joy,
 * 难过 -> sadness) whose output was fed to the kernel as the companion's "first impression" of every
 * inbound message. That is the oldest idea in affective computing, and here it is worse than useless:
 * it manufactured a confident emotion claim about a sentence the model is about to read in full, and
 * the kernel then treated the claim as an observation — the unitary kick, the mood, the relationship
 * delta, the character nudge, and SPARK's belief evidence all inherited it. The failures are not
 * subtle: "function" fired joy because it contains "fun", a single 空 fired sadness inside 空间, and no
 * table can separate "not bad" from bad, sarcasm from sincerity, or 我没事 from 我真的没事.
 *
 * The replacement is not a small classifier either. Fine-tuned BERT-scale models land near 0.5 macro
 * F1 on 27-label emotion tasks — a coin flip on any one message — and would add a native runtime plus
 * model assets to a companion that already contains a far better reader of the same sentence. So affect
 * is REPORTED, never guessed: the only path into an event's `activations` is the affect judge
 * (judge-run.ts), which reads the exchange from outside after it happened. This module keeps the two
 * things that are genuinely cheap and genuinely non-affective — what the message is trying to get
 * (intent), and how hard it pulls for an answer (weight).
 */

/** Question / request markers. CJK needs no word boundaries; 吗 at the end is a genuine question
 *  particle, 呢 usually is not (it reads as a statement particle), so 呢 is matched only with a
 *  question mark — which the ？ rule already covers. */
const QUESTION_RE =
	/\?\s*$|？\s*$|吗[？?]?\s*$|\b(why|what|how|when|where|who|can you|could you|would you|please)\b|为什么|怎么|如何|什么|哪里|谁|能不能|可不可以|可以吗|行吗|好吗|是不是|有没有|请问|帮我|麻烦/i;

/** Work markers: the message asks for a change to something, not a conversation. */
const TASK_RE =
	/\b(fix|write|build|run|install|create|make|edit|refactor|debug|implement|code|script|deploy)\b|修复|调试|重构|部署|安装|运行一下|跑一下|写一个|写个|创建|生成|实现|改一下|改代码|脚本/i;

export interface AppraisalResult {
	intent: "chat" | "question" | "task";
	/** How much this message pulls toward answering. Feeds replyInclination, which surfaces an
	 *  advisory lean to the model — it gates nothing and drops nothing. Deliberately a structural
	 *  number: a question or a request deserves a response whether or not we know how it felt, and
	 *  an affective weight would just be the deleted keyword table under a new name. */
	weight: number;
}

/**
 * Read one inbound message. Pure, synchronous, no LLM, and no emotion inference.
 */
export function appraise(text: string): AppraisalResult {
	let intent: AppraisalResult["intent"] = "chat";
	if (QUESTION_RE.test(text)) intent = "question";
	if (TASK_RE.test(text)) intent = "task";

	// Anything that asks for something pulls a little harder than chatter; what the message did to the
	// companion's mood is the judge's reading, taken after the exchange (see judge-run.ts).
	return { intent, weight: intent === "chat" ? 0 : 0.2 };
}
