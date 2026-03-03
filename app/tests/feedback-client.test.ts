import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FeedbackClient } from "../src/feedback-client.js";
import type { FeedbackRequest, FeedbackToken, SessionComplete } from "@ar-training/shared";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FEEDBACK_URL = "http://feedback:8002";
const API_KEY      = "test-key";

function makeClient(): FeedbackClient {
    return new FeedbackClient(FEEDBACK_URL, API_KEY);
}

function makeRequest(): FeedbackRequest {
    return {
        session_id:  "session-abc",
        scenario_id: "scenario_01",
        language:    "nl",
        history:     [],
    };
}

// Builds a minimal SSE response body from a sequence of data lines.
function makeSseStream(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const text    = lines.map(l => `data: ${l}\n\n`).join("");
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
}

function makeTokenEvent(token: string): string {
    return JSON.stringify({ type: "token", token });
}

function makeCompleteEvent(advice = "Test advice"): string {
    return JSON.stringify({
        type:     "complete",
        feedback: { advice, severity: "medium", highlights: ["Turn 1: good"] },
    });
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("FeedbackClient", () => {

    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── Request shape ─────────────────────────────────────────────────────────

    describe("request", () => {
        it("calls the correct endpoint", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: makeSseStream([]),
            }));

            await makeClient().stream("session-abc", makeRequest(), vi.fn());

            expect(fetch).toHaveBeenCalledWith(
                `${FEEDBACK_URL}/feedback/generate/stream`,
                expect.objectContaining({ method: "POST" }),
            );
        });

        it("sends the Authorization header", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: makeSseStream([]),
            }));

            await makeClient().stream("session-abc", makeRequest(), vi.fn());

            const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
            expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
        });

        it("serialises the FeedbackRequest as JSON", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: makeSseStream([]),
            }));

            const req = makeRequest();
            await makeClient().stream("session-abc", req, vi.fn());

            const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
            expect(body.session_id).toBe("session-abc");
            expect(body.scenario_id).toBe("scenario_01");
        });
    });

    // ── SSE token streaming ───────────────────────────────────────────────────

    describe("SSE streaming", () => {
        it("forwards each token event as a FeedbackToken message", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: makeSseStream([
                    makeTokenEvent("Goed"),
                    makeTokenEvent("gedaan"),
                    makeCompleteEvent(),
                ]),
            }));

            const sendFn = vi.fn();
            await makeClient().stream("session-abc", makeRequest(), sendFn);

            const tokens = sendFn.mock.calls
                .map((c: [unknown]) => c[0] as FeedbackToken)
                .filter(m => m.type === "feedback_token");

            expect(tokens).toHaveLength(2);
            expect(tokens[0].token).toBe("Goed");
            expect(tokens[1].token).toBe("gedaan");
        });

        it("forwards the complete event as a SessionComplete message", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: makeSseStream([makeCompleteEvent("Uitstekend werk!")]),
            }));

            const sendFn = vi.fn();
            await makeClient().stream("session-abc", makeRequest(), sendFn);

            const complete = sendFn.mock.calls
                .map((c: [unknown]) => c[0] as SessionComplete)
                .find(m => m.type === "session_complete");

            expect(complete).toBeDefined();
            expect(complete!.advice).toBe("Uitstekend werk!");
            expect(complete!.severity).toBe("medium");
            expect(complete!.highlights).toEqual(["Turn 1: good"]);
            expect(complete!.session_id).toBe("session-abc");
        });

        it("tokens arrive before the complete message", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: makeSseStream([
                    makeTokenEvent("token-1"),
                    makeCompleteEvent(),
                ]),
            }));

            const sendFn  = vi.fn();
            await makeClient().stream("session-abc", makeRequest(), sendFn);
            const types = sendFn.mock.calls.map((c: [unknown]) => (c[0] as { type: string }).type);

            expect(types.indexOf("feedback_token")).toBeLessThan(types.indexOf("session_complete"));
        });

        it("skips malformed SSE events without throwing", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: makeSseStream([
                    "{ not valid json",
                    makeCompleteEvent(),
                ]),
            }));

            const sendFn = vi.fn();
            await expect(
                makeClient().stream("session-abc", makeRequest(), sendFn)
            ).resolves.not.toThrow();
        });
    });

    // ── Failure handling ──────────────────────────────────────────────────────

    describe("failure handling", () => {
        it("returns without calling sendFn when the response is not ok", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:     false,
                status: 503,
                body:   null,
            }));

            const sendFn = vi.fn();
            await makeClient().stream("session-abc", makeRequest(), sendFn);
            expect(sendFn).not.toHaveBeenCalled();
        });

        it("returns without calling sendFn when the response body is null", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok:   true,
                body: null,
            }));

            const sendFn = vi.fn();
            await makeClient().stream("session-abc", makeRequest(), sendFn);
            expect(sendFn).not.toHaveBeenCalled();
        });
    });
});