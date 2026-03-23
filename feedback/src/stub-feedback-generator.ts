import type { FeedbackRequest, Feedback } from "@ar-training/shared";
import type { FeedbackGeneratorInterface } from "./interfaces.js";

// ─── StubFeedbackGenerator ────────────────────────────────────────────────────
//
// Development stub. Returns a canned Dutch Feedback object without calling
// Ollama. generateStream() yields tokens word by word with a small delay to
// simulate realistic streaming.
//
// Do not use in production.
// ─────────────────────────────────────────────────────────────────────────────

const STUB_ADVICE =
    "[STUB] Dit is een testfeedback. In een echte sessie zou hier een " +
    "gepersonaliseerde analyse van jouw de-escalatiegedrag staan, gegenereerd " +
    "op basis van jouw reacties op de videoscenario's.";

export class StubFeedbackGenerator implements FeedbackGeneratorInterface {
    async generate(req: FeedbackRequest): Promise<Feedback> {
        const highlights: string[] = [];
        if (req.history.length > 0) {
            highlights.push(`Turn ${req.history[0].turn_id}: [stub] eerste reactie geanalyseerd.`);
        }
        if (req.history.length > 1) {
            highlights.push(
                `Turn ${req.history[req.history.length - 1].turn_id}: [stub] laatste reactie geanalyseerd.`
            );
        }

        return {
            session_id: req.session_id,
            advice:     STUB_ADVICE,
            severity:   "medium",
            highlights,
        };
    }

    async *generateStream(req: FeedbackRequest): AsyncGenerator<string> {
        const feedback = await this.generate(req);
        for (const word of feedback.advice.split(" ")) {
            yield word + " ";
            await new Promise<void>(resolve => setTimeout(resolve, 30));
        }
    }
}