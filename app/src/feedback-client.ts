import type {FeedbackRequest, FeedbackToken, SessionComplete} from "@ar-training/shared";
import type {SendFn} from "./coordinator.js";
import {TextDecoder} from "node:util";
import {createParser, EventSourceMessage} from "eventsource-parser";

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
    private readonly feedbackUrl: string;
    private readonly authHeader: string;

    constructor(feedbackUrl: string, internalApiKey: string) {
        this.feedbackUrl = feedbackUrl;
        this.authHeader  = `Bearer ${internalApiKey}`;
    }

    /**
     * Streams feedback for a completed session.
     * Forwards FeedbackToken messages as they arrive, then a final
     * SessionComplete when generation finishes.
     *
     * Non-throwing — errors are swallowed so a feedback failure never
     * crashes the session. Callers that need error visibility should wrap
     * in a try/catch or attach a .catch() to the returned Promise.
     */
    async stream(
        sessionId: string,
        request: FeedbackRequest,
        sendFn: SendFn,
    ): Promise<void> {
        const res = await fetch(`${this.feedbackUrl}/feedback/generate/stream`, {
            method:  "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": this.authHeader,
            },
            body: JSON.stringify(request),
        });

        if (!res.ok || !res.body) return;

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
                    }
                } catch {
                    // Malformed SSE event — skip and continue
                }
            }
        });

        for await (const chunk of res.body) {
            parser.feed(decoder.decode(chunk, { stream: true }));
        }
    }
}