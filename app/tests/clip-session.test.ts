import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClipSession } from "../src/clip-session.js";
import type { ClipMetadata, VideoFrame, AudioChunk, WordTiming } from "@ar-training/shared";
import { EventEmitter } from "events";

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

class MockWebSocket extends EventEmitter {
    readyState      = 0; // CONNECTING
    readonly sent:  string[] = [];
    terminate       = vi.fn(() => { this.readyState = 3; });
    send(data: string) { this.sent.push(data); }
    open()  { this.readyState = 1; this.emit("open"); }
    close() { this.readyState = 3; this.emit("close"); }
}

function makeWsFactory(ws: MockWebSocket) {
    return vi.fn().mockReturnValue(ws);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TRANSCRIPTION_URL = "http://transcription:8003";
const AUTH_HEADER       = "Bearer test-key";

function makeClip(clipId = "clip_01"): ClipMetadata {
    return {
        clip_id:                  clipId,
        scenario_id:              "scenario_01",
        video_url:                `/scenarios/scenario_01/${clipId}.mp4`,
        transcript:               "Test transcript",
        clip_duration_seconds:    10.0,
        notable_features:         [],
        scoring_mode:             "rubric",
        de_escalation_rubric:     [],
        escalation_rubric:        [],
        critical_failures:        [],
        score_range:              { min: -1.0, max: 1.0 },
        clip_learning_objectives: [],
        ideal_response:           null,
        response_warnings:        [],
        branch_conditions:        [{ min_score: -1.0, max_score: 1.01, next_clip: null }],
    };
}

function makeFrame(frameId: number): VideoFrame {
    return {
        type:           "video_frame",
        session_id:     "s1",
        frame_id:       frameId,
        timestamp:      frameId * 0.033,
        face_landmarks: [],
        left_hand:      [],
        right_hand:     [],
    };
}

function makeChunk(chunkId: number): AudioChunk {
    return {
        type:        "audio_chunk",
        session_id:  "s1",
        chunk_id:    chunkId,
        timestamp:   chunkId * 0.5,
        pcm:         "",
        sample_rate: 16_000,
        mfccs:       [[0.1, 0.2]],
    };
}

function emitTranscript(
    ws:      MockWebSocket,
    text:    string,
    isFinal: boolean,
    words:   WordTiming[] = [],
) {
    ws.emit("message", Buffer.from(JSON.stringify({
        type:       "transcript",
        session_id: "s1",
        text,
        window_seq: 1,
        is_final:   isFinal,
        confidence: 0.95,
        words,
    })));
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("ClipSession", () => {

    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── Construction ──────────────────────────────────────────────────────────

    describe("construction", () => {
        it("opens a WebSocket to the correct URL on construction", () => {
            const ws      = new MockWebSocket();
            const factory = makeWsFactory(ws);
            new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, factory);

            expect(factory).toHaveBeenCalledOnce();
            const [url, opts] = factory.mock.calls[0];
            expect(url).toBe("ws://transcription:8003/ws/s1");
            expect(opts.headers["Authorization"]).toBe(AUTH_HEADER);
        });

        it("converts https:// to wss:// in the WebSocket URL", () => {
            const ws      = new MockWebSocket();
            const factory = makeWsFactory(ws);
            new ClipSession("s1", makeClip(), "https://transcription:8003", AUTH_HEADER, factory);

            const [url] = factory.mock.calls[0];
            expect(url).toBe("wss://transcription:8003/ws/s1");
        });

        it("appends language query param when language is provided", () => {
            const ws      = new MockWebSocket();
            const factory = makeWsFactory(ws);
            new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, factory, 1, undefined, "nl");

            const [url] = factory.mock.calls[0];
            expect(url).toBe("ws://transcription:8003/ws/s1?language=nl");
        });

        it("omits language query param when language is empty string", () => {
            const ws      = new MockWebSocket();
            const factory = makeWsFactory(ws);
            new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, factory, 1, undefined, "");

            const [url] = factory.mock.calls[0];
            expect(url).toBe("ws://transcription:8003/ws/s1");
        });

        it("URL-encodes the language param", () => {
            const ws      = new MockWebSocket();
            const factory = makeWsFactory(ws);
            new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, factory, 1, undefined, "zh-TW");

            const [url] = factory.mock.calls[0];
            expect(url).toBe("ws://transcription:8003/ws/s1?language=zh-TW");
        });
    });

    // ── Audio forwarding ──────────────────────────────────────────────────────

    describe("audio forwarding", () => {
        it("sends audio to the WebSocket when OPEN", () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();

            session.onAudio("s1", makeChunk(1));

            expect(ws.sent).toHaveLength(1);
            expect(JSON.parse(ws.sent[0]).chunk_id).toBe(1);
        });

        it("queues audio while CONNECTING and drains in order on open", () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));

            session.onAudio("s1", makeChunk(1));
            session.onAudio("s1", makeChunk(2));
            expect(ws.sent).toHaveLength(0);

            ws.open();
            expect(ws.sent).toHaveLength(2);
            expect(JSON.parse(ws.sent[0]).chunk_id).toBe(1);
            expect(JSON.parse(ws.sent[1]).chunk_id).toBe(2);
        });

        it("drops audio when the socket is closed", () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.close();

            session.onAudio("s1", makeChunk(1));

            expect(ws.sent).toHaveLength(0);
        });
    });

    // ── Frame buffering ───────────────────────────────────────────────────────

    describe("frame buffering", () => {
        it("includes all accumulated frames in the resolved window", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();

            session.onFrame(makeFrame(1));
            session.onFrame(makeFrame(2));
            session.onFrame(makeFrame(3));

            session.flush();
            emitTranscript(ws, "tekst", true);

            const window = await session;
            expect(window.frames).toHaveLength(3);
            expect(window.frames[0].frame_id).toBe(1);
            expect(window.frames[2].frame_id).toBe(3);
        });
    });

    // ── Thenable resolution ───────────────────────────────────────────────────

    describe("thenable resolution", () => {
        it("resolves with a complete AnalysisWindow when is_final arrives after flush", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip("clip_01"), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();

            session.onFrame(makeFrame(1));
            session.onAudio("s1", makeChunk(1));
            emitTranscript(ws, "Hallo", false);
            emitTranscript(ws, "wereld", false);

            session.flush();
            emitTranscript(ws, "!", true);

            const window = await session;
            expect(window.session_id).toBe("s1");
            expect(window.clip_metadata.clip_id).toBe("clip_01");
            expect(window.frames).toHaveLength(1);
            expect(window.mfccs).toHaveLength(1);
            expect(window.transcript).toBe("Hallo wereld !");
        });

        it("accumulates transcript from partial and final segments", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            emitTranscript(ws, "eerste", false);
            emitTranscript(ws, "tweede", false);
            session.flush();
            emitTranscript(ws, "derde", true);

            const window = await session;
            expect(window.transcript).toBe("eerste tweede derde");
        });

        it("resolves immediately when is_final arrived before flush", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            emitTranscript(ws, "vroeg", true);
            session.flush();

            const window = await session;
            expect(window.transcript).toBe("vroeg");
        });

        it("uses the provided sequence number in window_id", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws), 3);
            ws.open();
            session.onFrame(makeFrame(1));

            session.flush();
            emitTranscript(ws, "tekst", true);

            const window = await session;
            expect(window.window_id).toBe("s1:3");
        });

        it("does not resolve before flush is called, even if is_final arrived", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();

            emitTranscript(ws, "tekst", true);

            let resolved = false;
            session.then(() => { resolved = true; });

            await Promise.resolve();
            expect(resolved).toBe(false);
        });

        it("resolved window contains empty words array when no timings received", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            session.flush();
            emitTranscript(ws, "tekst", true); // no words field → defaults to []

            const window = await session;
            expect(window.words).toEqual([]);
        });

        it("accumulates word timings from all received messages", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            const w1: WordTiming = { word: "hallo",  start: 0.0, end: 0.4 };
            const w2: WordTiming = { word: "wereld", start: 0.5, end: 1.0 };
            const w3: WordTiming = { word: "!",      start: 1.1, end: 1.2 };

            emitTranscript(ws, "hallo",  false, [w1]);
            emitTranscript(ws, "wereld", false, [w2]);
            session.flush();
            emitTranscript(ws, "!",      true,  [w3]);

            const window = await session;
            expect(window.words).toHaveLength(3);
            expect(window.words[0]).toMatchObject({ word: "hallo",  start: 0.0, end: 0.4 });
            expect(window.words[1]).toMatchObject({ word: "wereld", start: 0.5, end: 1.0 });
            expect(window.words[2]).toMatchObject({ word: "!",      start: 1.1, end: 1.2 });
        });

        it("words from empty-text messages are not accumulated", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            emitTranscript(ws, "", false, []); // silent window
            session.flush();
            emitTranscript(ws, "tekst", true, [{ word: "tekst", start: 1.0, end: 1.5 }]);

            const window = await session;
            expect(window.words).toHaveLength(1);
            expect(window.words[0].word).toBe("tekst");
        });
    });

    // ── flush() ───────────────────────────────────────────────────────────────

    describe("flush()", () => {
        it("POSTs to /transcription/finalise/{session_id}", () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));

            session.flush();

            expect(fetch).toHaveBeenCalledWith(
                `${TRANSCRIPTION_URL}/transcription/finalise/s1`,
                expect.objectContaining({
                    method:  "POST",
                    headers: expect.objectContaining({ "Authorization": AUTH_HEADER }),
                }),
            );
        });

        it("proceeds gracefully when the finalise POST fails", async () => {
            vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            session.flush();
            emitTranscript(ws, "tekst", true);

            await expect(session).resolves.toBeDefined();
        });
    });

    // ── close() ───────────────────────────────────────────────────────────────

    describe("close()", () => {
        it("terminates the WebSocket", () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            session.close();
            expect(ws.terminate).toHaveBeenCalled();
        });

        it("drops audio after close", () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            session.close();
            session.onAudio("s1", makeChunk(1));
            expect(ws.sent).toHaveLength(0);
        });

        it("clears the pending audio queue on close", () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));

            session.onAudio("s1", makeChunk(1));
            session.onAudio("s1", makeChunk(2));

            session.close();
            ws.open();

            expect(ws.sent).toHaveLength(0);
        });
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    describe("edge cases", () => {
        it("does not add a leading space for empty text segments", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            emitTranscript(ws, "", false);
            session.flush();
            emitTranscript(ws, "tekst", true);

            const window = await session;
            expect(window.transcript).toBe("tekst");
        });

        it("ignores malformed WebSocket messages without throwing", () => {
            const ws = new MockWebSocket();
            new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();

            expect(() => {
                ws.emit("message", Buffer.from("not json{{{"));
            }).not.toThrow();
        });

        it("ignores non-transcript WebSocket message types", () => {
            const ws = new MockWebSocket();
            new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();

            expect(() => {
                ws.emit("message", Buffer.from(JSON.stringify({ type: "unknown" })));
            }).not.toThrow();
        });

        it("handles transcript message with missing words field gracefully", async () => {
            const ws = new MockWebSocket();
            const session = new ClipSession("s1", makeClip(), TRANSCRIPTION_URL, AUTH_HEADER, makeWsFactory(ws));
            ws.open();
            session.onFrame(makeFrame(1));

            // Emit a message without the words field (old wire format compatibility)
            ws.emit("message", Buffer.from(JSON.stringify({
                type:       "transcript",
                session_id: "s1",
                text:       "tekst",
                window_seq: 1,
                is_final:   true,
                confidence: 0.9,
                // no words field
            })));
            session.flush();

            const window = await session;
            expect(window.transcript).toBe("tekst");
            expect(window.words).toEqual([]);
        });
    });
});