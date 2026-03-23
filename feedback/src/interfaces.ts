import type { FeedbackRequest, Feedback } from "@ar-training/shared";

// ─── FeedbackGeneratorInterface ───────────────────────────────────────────────
//
// All implementations — stub or production — must satisfy this contract.
// The route layer calls generateStream() for the SSE endpoint and generate()
// for the synchronous endpoint. Both are always required.
// ─────────────────────────────────────────────────────────────────────────────

export interface FeedbackGeneratorInterface {
    /**
     * Generate a complete Feedback object for the session.
     * Used by POST /feedback/generate (testing / tooling path).
     */
    generate(req: FeedbackRequest): Promise<Feedback>;

    /**
     * Stream the generated advice token by token.
     * Used by POST /feedback/generate/stream (primary production path).
     * Each yielded string is a raw token (may be a word, punctuation, or
     * partial word — consumers must not assume word boundaries).
     */
    generateStream(req: FeedbackRequest): AsyncGenerator<string>;
}