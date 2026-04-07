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
// format without assuming any specific professional role. Per-scenario context
// is injected through the user prompt via coaching_context, learning_objectives,
// target_audience, and the per-clip ideal_response / response_warnings fields.
// This allows the same Feedback container to serve scenarios across different
// professions without code changes.
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
     * Generic system prompt. Describes the tool's purpose and required output
     * format. Contains no role-specific language — that comes from the user
     * prompt via coaching_context, learning_objectives, and clip rubric fields.
     */
    private _systemPrompt(language: string): string {
        return (
            `You are a professional coach for a de-escalation training tool used in vocational education. ` +
            `Students practise responding to simulated conflict scenarios. ` +
            `You review the student's responses and provide structured, constructive coaching feedback. ` +
            `The student's preferred language is "${language}". Respond entirely in that language — ` +
            `including all field values in the JSON output. ` +
            `\n\n` +
            `You will receive a prompt containing the following information:\n` +
            `- Context: the professional role and situation the student is practising.\n` +
            `- Learning objectives: the de-escalation competencies this scenario trains (when available).\n` +
            `- Audience: the MBO level or professional context (when available).\n` +
            `- A series of turns, each representing one exchange in the scenario. For each turn:\n` +
            `  - The transcript of the video clip the student was responding to, and its notable behavioural features.\n` +
            `  - What an ideal student response would look like for this clip (when available).\n` +
            `  - Behaviours the student should have avoided (when available).\n` +
            `  - The student's spoken response (transcript).\n` +
            `  - Multimodal signals from the student's webcam and microphone:\n` +
            `    escalation score (-1.0 = strongly de-escalating, 1.0 = strongly escalating),\n` +
            `    dominant emotion, vocal tension (0=relaxed, 1=tense), speech pace (syllables/sec),\n` +
            `    head nod frequency (Hz), facing ratio (0=turned away, 1=facing forward),\n` +
            `    silence ratio (fraction of clip with no student speech),\n` +
            `    lexical de-escalation markers detected in the student's transcript,\n` +
            `    and overall response tone (positive/neutral/negative).\n` +
            `\n` +
            `Use all of this information together to assess how effectively the student handled ` +
            `the situation and where they can improve. ` +
            `Give weight to the full picture — what the student said, how they said it, and how ` +
            `their behaviour evolved across the session. ` +
            `When learning objectives are provided, anchor your feedback to those competencies. ` +
            `When ideal_response or response_warnings are provided for a turn, use them as the ` +
            `benchmark for that turn's assessment. ` +
            `\n\n` +
            `You must respond with a single valid JSON object — no markdown, no explanation, no preamble. ` +
            `The JSON must match this exact shape:\n` +
            `{\n` +
            `  "advice": "<structured debrief — see format below>",\n` +
            `  "severity": "<low|medium|high>",\n` +
            `  "highlights": ["<one string per turn>", ...]\n` +
            `}\n` +
            `\n` +
            `ADVICE FORMAT\n` +
            `The "advice" field must contain three clearly labelled sections, separated by blank lines:\n` +
            `\n` +
            `Section 1 — Per-turn summaries. One short paragraph per turn, in order. ` +
            `Each paragraph starts with "Beurt <N>:" (or the equivalent label in the student's language). ` +
            `Briefly describe what the actor showed, what the student did, and whether it was effective. ` +
            `Two to four sentences per turn.\n` +
            `\n` +
            `Section 2 — Overall summary. One paragraph (three to five sentences) summarising how the ` +
            `student performed across the whole session. Note any patterns — did they improve turn by turn? ` +
            `Did tension rise or fall? Were the learning objectives met?\n` +
            `\n` +
            `Section 3 — Coaching advice. One paragraph (three to five sentences) with concrete, ` +
            `actionable suggestions for what the student should practise or do differently next time. ` +
            `Anchor this to the learning objectives when they are provided.\n` +
            `\n` +
            `HIGHLIGHTS FORMAT\n` +
            `"highlights" is a list with exactly one entry per turn in the session — no more, no fewer. ` +
            `Each entry is a single sentence identifying the most notable thing (positive or negative) ` +
            `about the student's response in that turn. ` +
            `Always reference the turn number. ` +
            `Example for a three-turn session:\n` +
            `[\n` +
            `  "Beurt 1: student sprak rustig en gebruikte een open vraag — goede start.",\n` +
            `  "Beurt 2: stemspanning steeg sterk toen de acteur escaleerde; de student verloor de kalme toon.",\n` +
            `  "Beurt 3: student herstelde gedeeltelijk maar vermeed oogcontact."\n` +
            `]\n` +
            `\n` +
            `SEVERITY\n` +
            `"severity" reflects the overall escalation risk shown by the student across the session:\n` +
            `"low"    = student consistently de-escalated or maintained calm.\n` +
            `"medium" = mixed performance — some effective moments, some escalating behaviour.\n` +
            `"high"   = significant escalating behaviour observed across multiple turns.`
        );
    }

    private _buildPrompt(req: FeedbackRequest): string {
        const context = req.coaching_context?.trim() || FALLBACK_COACHING_CONTEXT;

        const lines: string[] = [
            `Context: ${context}`,
        ];

        if (req.learning_objectives?.length) {
            lines.push(`Learning objectives: ${req.learning_objectives.join(", ")}`);
        }
        if (req.target_audience) {
            lines.push(`Target audience: ${req.target_audience}`);
        }

        lines.push(
            `Scenario: ${req.scenario_id}`,
            `Session: ${req.session_id}`,
            `Turns: ${req.history.length}`,
            "",
        );

        for (const turn of req.history) {
            const ss = turn.student_response.signal_summary;

            lines.push(`--- Turn ${turn.turn_id} ---`);
            lines.push(`Video clip: ${turn.clip.clip_id}`);
            lines.push(`Clip transcript: ${turn.clip.transcript}`);
            lines.push(`Notable features in clip: ${turn.clip.notable_features.join(", ") || "none"}`);

            // Clip-level coaching context — surfaces scenario author guidance to the LLM.
            if (turn.clip.ideal_response) {
                lines.push(`Ideal response for this clip: ${turn.clip.ideal_response}`);
            }
            if (turn.clip.response_warnings?.length) {
                lines.push(`Behaviours to avoid: ${turn.clip.response_warnings.join("; ")}`);
            }
            if (turn.clip.clip_learning_objectives?.length) {
                lines.push(`Competencies tested by this clip: ${turn.clip.clip_learning_objectives.join(", ")}`);
            }

            lines.push(`Student transcript: ${turn.student_transcript || "(no speech detected)"}`);
            lines.push(`Escalation score: ${turn.student_response.escalation_score.toFixed(3)}`);
            lines.push(`Dominant emotion: ${turn.student_response.dominant_emotion}`);
            lines.push(`Vocal tension: ${ss.vocal_tension.toFixed(2)}`);
            lines.push(`Speech pace (syl/s): ${ss.speech_pace.toFixed(2)}`);
            lines.push(`Head nod frequency (Hz): ${ss.head_nod_frequency.toFixed(2)}`);
            lines.push(`Facing ratio: ${ss.facing_ratio.toFixed(2)}`);
            lines.push(`Silence ratio: ${ss.silence_ratio.toFixed(2)}`);
            lines.push(`Response tone: ${ss.response_tone}`);

            if (ss.lexical_markers.length > 0) {
                lines.push(`De-escalation markers detected: ${ss.lexical_markers.join(", ")}`);
            } else {
                lines.push(`De-escalation markers detected: none`);
            }

            if (ss.open_gesture_ratio !== null) {
                lines.push(`Open gesture ratio: ${ss.open_gesture_ratio.toFixed(2)}`);
            }

            if (ss.notable_signals.length > 0) {
                lines.push(`Notable signals: ${ss.notable_signals.join(", ")}`);
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