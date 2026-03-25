import type { FeedbackRequest, FeedbackToken, ServerError, SessionComplete } from "@ar-training/shared";
import type { SendFn } from "./coordinator.js";
import { TextDecoder } from "node:util";
import { createParser, type EventSourceMessage } from "eventsource-parser";

// ─── FeedbackClient ───────────────────────────────────────────────────────────
//
// Sends a FeedbackRequest to the Feedback container and streams the SSE
// response back to the client via the provided SendFn.
//
// This is the only class that knows about the Feedback container's HTTP API.
// The Coordinator and ClipController call this without knowing how feedback
// is generated or streamed.
// ─────────────────────────────────────────────────────────────────────────────

export class FeedbackClient {
    private readonly feedbackUrl:     string;
    private readonly authHeader:      string;
    private readonly timeoutMs:       number;

    constructor(feedbackUrl: string, internalApiKey: string, timeoutMs: number) {
        this.feedbackUrl = feedbackUrl;
        this.authHeader  = `Bearer ${internalApiKey}`;
        this.timeoutMs   = timeoutMs;
    }

    /**
     * Streams feedback for a completed session.
     * Forwards FeedbackToken messages as they arrive, then a final
     * SessionComplete when generation finishes.
     *
     * On any failure (network error, timeout, or non-2xx response from the
     * Feedback container) sends a `feedback_unavailable` error to the client
     * via sendFn rather than throwing — a feedback failure should never crash
     * the session or leave the client waiting indefinitely.
     *
     * The entire operation is bounded by `timeoutMs`. This should be set
     * slightly above the Feedback container's OLLAMA_TIMEOUT_MS so that Ollama
     * always times out first on the generation side, leaving time for the
     * Feedback container to write the error SSE event before this side aborts.
     */
    async stream(
        sessionId: string,
        request: FeedbackRequest,
        sendFn: SendFn,
    ): Promise<void> {
        let res: Response;
        try {
            res = await fetch(`${this.feedbackUrl}/feedback/generate/stream`, {
                method:  "POST",
                headers: {
                    "Content-Type":  "application/json",
                    "Authorization": this.authHeader,
                },
                body:   JSON.stringify(request),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch {
            // Network-level failure, DNS error, connection refused, or timeout.
            sendFn(this.unavailableError(sessionId));
            return;
        }

        if (!res.ok || !res.body) {
            // Feedback container returned a non-2xx response or an empty body.
            sendFn(this.unavailableError(sessionId));
            return;
        }

        const decoder = new TextDecoder();
        const parser = createParser({
            onEvent: (event: EventSourceMessage) => {
                try {
                    const data = JSON.parse(event.data) as {
                        type:      string;
                        token?:    string;
                        feedback?: { advice: string; severity: "low" | "medium" | "high"; highlights: string[] };
                    };

                    if (data.type === "token") {
                        const msg: FeedbackToken = {
                            type:       "feedback_token",
                            session_id: sessionId,
                            token:      data.token ?? "",
                        };
                        sendFn(msg);

                    } else if (data.type === "complete" && data.feedback) {
                        const msg: SessionComplete = {
                            type:       "session_complete",
                            session_id: sessionId,
                            advice:     data.feedback.advice,
                            severity:   data.feedback.severity,
                            highlights: data.feedback.highlights,
                        };
                        sendFn(msg);

                    } else if (data.type === "error") {
                        // Feedback container signalled a generation failure mid-stream.
                        sendFn(this.unavailableError(sessionId));
                    }
                } catch {
                    // Malformed SSE event — skip and continue
                }
            }
        });

        try {
            for await (const chunk of res.body) {
                parser.feed(decoder.decode(chunk, { stream: true }));
            }
        } catch {
            // The AbortSignal fired, or the stream was cut before completing.
            // The client may already have received some tokens; send the error
            // to signal that the session_complete will not arrive.
            sendFn(this.unavailableError(sessionId));
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private unavailableError(sessionId: string): ServerError {
        return {
            type:       "error",
            session_id: sessionId,
            code:       "feedback_unavailable",
            message:    "Feedback container unavailable; session data has been saved.",
        };
    }
}