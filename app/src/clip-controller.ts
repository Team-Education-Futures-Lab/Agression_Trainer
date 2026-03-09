import type { FeedbackClient } from "./feedback-client.js";
import type { ScenarioLoader } from "./scenario-loader.js";
import type { Coordinator, SendFn } from "./coordinator.js";
import type { SessionManager } from "./session-manager.js";
import type {
    BehaviourResult,
    BranchCondition,
    ClipEnded,
    ClipReady,
    ConversationTurn,
} from "@ar-training/shared";

// ─── ClipController ───────────────────────────────────────────────────────────
//
// Owns the clip transition: everything that happens between one clip ending
// and the next beginning (or the session completing).
//
// Sequence:
//   1. Pause session — prevents stray frames being buffered mid-transition
//   2. Flush: finalise transcript, dispatch single AnalysisWindow to Evaluation
//   3. Read clip score from the single BehaviourResult returned by Evaluation
//   4. Resolve next clip from branch conditions
//   5. Append a ConversationTurn to session history
//   6. Reset evaluation audio buffer and transcription VAD state
//   7. Notify the client (ClipReady)
//   8a. If terminal: trigger feedback and end the session
//   8b. If not terminal: advance coordinator and session to the next clip
// ─────────────────────────────────────────────────────────────────────────────

export class ClipController {
    private readonly sessions:  SessionManager;
    private readonly coord:     Coordinator;
    private readonly scenarios: ScenarioLoader;
    private readonly feedback:  FeedbackClient;

    constructor(
        sessions:  SessionManager,
        coord:     Coordinator,
        scenarios: ScenarioLoader,
        feedback:  FeedbackClient,
    ) {
        this.sessions  = sessions;
        this.coord     = coord;
        this.scenarios = scenarios;
        this.feedback  = feedback;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async handleClipEnded(msg: ClipEnded, sendFn: SendFn): Promise<void> {
        const { session_id, clip_id } = msg;
        const ctx = this.sessions.getSession(session_id);
        if (!ctx || ctx.state !== "ACTIVE") return;

        // 1. Pause — prevents stray frames being buffered mid-transition.
        this.sessions.markPaused(session_id);

        // 2. Flush — finalises transcript and dispatches the full clip window.
        await this.coord.flushSession(session_id);

        // 3. Clip score comes from the single BehaviourResult for this clip.
        const result   = this.coord.getLastResult(session_id);
        const clipScore = result?.escalation_score ?? 0;

        // 4. Resolve the next clip from branch conditions.
        const currentClip = this.scenarios.getClip(ctx.scenario_id, clip_id);
        const nextClipId  = currentClip
            ? this.resolveNextClip(currentClip.branch_conditions, clipScore)
            : null;

        // 5. Append a ConversationTurn to session history.
        if (currentClip) {
            const turn: ConversationTurn = {
                turn_id:            ctx.turn_count + 1,
                clip:               currentClip,
                student_response:   result ?? this.fallbackResult(session_id),
                student_transcript: this.coord.getLastTranscript(session_id) ?? "",
            };
            this.sessions.appendTurn(session_id, turn);
        }

        // 6. Reset buffers and open a fresh ClipSession for the next clip.
        //    nextClipId may be null (terminal) — in that case we still reset
        //    evaluation buffers but do not need a ClipSession for transcription.
        const nextClipMeta = nextClipId
            ? this.scenarios.getClip(ctx.scenario_id, nextClipId) ?? null
            : null;
        await this.coord.resetSession(session_id, nextClipMeta);

        // 7. Notify the client.
        const reply: ClipReady = {
            type:         "clip_ready",
            session_id,
            next_clip_id: nextClipId,
            clip_score:   clipScore,
        };
        sendFn(reply);

        // 8. Advance or complete.
        if (nextClipId === null) {
            await this.complete(session_id, sendFn);
        } else {
            this.advance(session_id, ctx.scenario_id, nextClipId);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private resolveNextClip(conditions: BranchCondition[], score: number): string | null {
        for (const cond of conditions) {
            if (score >= cond.min_score && score < cond.max_score) {
                return cond.next_clip;
            }
        }
        // No condition matched (malformed scenario) — treat as terminal.
        return null;
    }

    private async complete(sessionId: string, sendFn: SendFn): Promise<void> {
        const feedbackReq = this.sessions.buildFeedbackRequest(sessionId);
        this.sessions.endSession(sessionId);
        if (feedbackReq) {
            await this.feedback.stream(sessionId, feedbackReq, sendFn);
        }
    }

    private advance(sessionId: string, scenarioId: string, nextClipId: string): void {
        const nextClip = this.scenarios.getClip(scenarioId, nextClipId);
        if (nextClip) {
            this.sessions.setCurrentClip(sessionId, nextClipId);
        }
        this.sessions.markActive(sessionId);
    }

    private fallbackResult(sessionId: string): BehaviourResult {
        return {
            window_id:        `${sessionId}:fallback`,
            session_id:       sessionId,
            escalation_score: 0,
            dominant_emotion: "neutral",
            confidence:       0,
            signal_summary: {
                voice_tension:   0,
                speech_pace:     0,
                hand_velocity:   0,
                gaze_stability:  0,
                open_palm_ratio: 0,
                notable_signals: ["no_data"],
            },
        };
    }
}
