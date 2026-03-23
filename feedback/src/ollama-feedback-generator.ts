import type { FeedbackRequest, Feedback } from "@ar-training/shared";
import type { FeedbackGeneratorInterface } from "./interfaces.js";
import type { FeedbackConfig } from "./config.js";

// ─── OllamaFeedbackGenerator ─────────────────────────────────────────────────
//
// Production implementation. Formats the full session history into a prompt,
// calls Ollama's streaming generate endpoint, and assembles a Feedback object
// from the complete generated text.
//
// The LLM is asked to produce a JSON object matching the Feedback shape so
// the response can be parsed deterministically.
//
// The system prompt is generic — it describes the tool's purpose and output
// format without assuming any specific professional role. The scenario's
// coaching_context field provides the role-specific framing and is injected
// at the top of the user prompt. This allows the same Feedback container to
// serve scenarios across different professions without code changes.
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_COACHING_CONTEXT =
    "De student oefent het de-escaleren van een agressieve of boze persoon in een professionele context.";

interface OllamaRequest {
    model:  string;
    prompt: string;
    stream: boolean;
    system: string;
}

interface OllamaStreamChunk {
    response: string;
    done:     boolean;
}

export class OllamaFeedbackGenerator implements FeedbackGeneratorInterface {
    private readonly ollamaHost: string;
    private readonly model:      string;
    private readonly timeoutMs:  number;

    constructor(cfg: FeedbackConfig) {
        this.ollamaHost = cfg.ollamaHost;
        this.model      = cfg.ollamaModel;
        this.timeoutMs  = cfg.ollamaTimeoutMs;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async generate(req: FeedbackRequest): Promise<Feedback> {
        const tokens: string[] = [];
        for await (const token of this.generateStream(req)) {
            tokens.push(token);
        }
        return this._parseFeedback(req.session_id, tokens.join(""));
    }

    async *generateStream(req: FeedbackRequest): AsyncGenerator<string> {
        const body: OllamaRequest = {
            model:  this.model,
            prompt: this._buildPrompt(req),
            stream: true,
            system: this._systemPrompt(req.language),
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let res: Response;
        try {
            res = await fetch(`${this.ollamaHost}/api/generate`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify(body),
                signal:  controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok || !res.body) {
            throw new Error(`Ollama returned ${res.status}`);
        }

        const decoder = new TextDecoder();
        let buf = "";

        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += decoder.decode(chunk, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const parsed = JSON.parse(trimmed) as OllamaStreamChunk;
                    if (parsed.response) yield parsed.response;
                    if (parsed.done) return;
                } catch {
                    // Malformed chunk — skip
                }
            }
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Generic system prompt. Describes the tool's purpose and the required
     * output format. Deliberately contains no role-specific language —
     * that comes from coaching_context in the user prompt.
     */
    private _systemPrompt(language: string): string {
        return (
            `You are a professional coach for a de-escalation training tool used in vocational education. ` +
            `Students practise responding to simulated conflict scenarios. ` +
            `You review the student's responses and provide structured, constructive coaching feedback. ` +
            `The student's preferred language is "${language}". Respond in that language. ` +
            `\n\n` +
            `You will receive a prompt containing the following information:\n` +
            `- Context: a description of the professional role and situation the student is practising.\n` +
            `- Scenario and session identifiers.\n` +
            `- A series of turns, each representing one exchange in the scenario. For each turn you receive:\n` +
            `  - The transcript of the video clip the student was responding to, and its notable behavioural features.\n` +
            `  - The student's spoken response (transcript).\n` +
            `  - Multimodal analysis signals derived from the student's webcam and microphone: an escalation score (-1.0 = strongly de-escalating, 1.0 = strongly escalating), dominant emotion, voice tension, speech pace, and gaze stability.\n` +
            `\n` +
            `Use all of this information together to assess how effectively the student handled the situation and where they can improve. ` +
            `Give weight to the full picture — what the student said, how they said it, and how their body language and voice signals evolved across the session. ` +
            `\n\n` +
            `You must respond with a single valid JSON object — no markdown, no explanation, no preamble. ` +
            `The JSON must match this exact shape:\n` +
            `{\n` +
            `  "advice": "<full debrief paragraph>",\n` +
            `  "severity": "<low|medium|high>",\n` +
            `  "highlights": ["<notable moment 1>", "<notable moment 2>"]\n` +
            `}\n` +
            `"severity" reflects the overall escalation risk shown by the student: ` +
            `"low" means the student de-escalated effectively, "high" means significant escalating behaviour was observed. ` +
            `"highlights" should reference specific turns by number, e.g. "Turn 2: voice tension spiked when the other person pushed back."`
        );
    }

    private _buildPrompt(req: FeedbackRequest): string {
        const context = req.coaching_context?.trim() || FALLBACK_COACHING_CONTEXT;

        const lines: string[] = [
            `Context: ${context}`,
            `Scenario: ${req.scenario_id}`,
            `Session: ${req.session_id}`,
            `Turns: ${req.history.length}`,
            "",
        ];

        for (const turn of req.history) {
            lines.push(`--- Turn ${turn.turn_id} ---`);
            lines.push(`Video clip: ${turn.clip.clip_id}`);
            lines.push(`Clip transcript: ${turn.clip.transcript}`);
            lines.push(`Notable features in clip: ${turn.clip.notable_features.join(", ")}`);
            lines.push(`Student transcript: ${turn.student_transcript}`);
            lines.push(`Escalation score: ${turn.student_response.escalation_score.toFixed(3)}`);
            lines.push(`Dominant emotion: ${turn.student_response.dominant_emotion}`);
            lines.push(`Voice tension: ${turn.student_response.signal_summary.voice_tension.toFixed(2)}`);
            lines.push(`Speech pace (syl/s): ${turn.student_response.signal_summary.speech_pace.toFixed(2)}`);
            lines.push(`Gaze stability: ${turn.student_response.signal_summary.gaze_stability.toFixed(2)}`);
            if (turn.student_response.signal_summary.notable_signals.length > 0) {
                lines.push(`Notable signals: ${turn.student_response.signal_summary.notable_signals.join(", ")}`);
            }
            lines.push("");
        }

        lines.push("Provide coaching feedback as a JSON object.");
        return lines.join("\n");
    }

    private _parseFeedback(sessionId: string, raw: string): Feedback {
        const cleaned = raw.replace(/```json|```/g, "").trim();
        try {
            const parsed = JSON.parse(cleaned) as {
                advice?:     string;
                severity?:   "low" | "medium" | "high";
                highlights?: string[];
            };
            return {
                session_id: sessionId,
                advice:     parsed.advice     ?? "",
                severity:   parsed.severity   ?? "medium",
                highlights: parsed.highlights ?? [],
            };
        } catch {
            return {
                session_id: sessionId,
                advice:     raw.trim(),
                severity:   "medium",
                highlights: [],
            };
        }
    }
}