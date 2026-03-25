import type { FeedbackClient } from "./feedback-client.js";
import type { ScenarioLoader } from "./scenario-loader.js";
import type { Coordinator, SendFn } from "./coordinator.js";
import type { SessionManager } from "./session-manager.js";
import type {
    BehaviourResult,
    BranchCondition,
    ClipCandidateData,
    ClipEnded,
    ConversationTurn,
} from "@ar-training/shared";

// ─── ClipController ───────────────────────────────────────────────────────────
//
// Owns the clip transition: everything that happens between one clip ending
// and the next beginning (or the session completing).
//
// Sequence:
//   1. Pause session — prevents stray frames being buffered mid-transition
//   2. Send clip_candidates immediately from branch conditions (before evaluation)
//   3. Flush: finalise transcript, dispatch single AnalysisWindow to Evaluation
//   4. Read clip score from the single BehaviourResult returned by Evaluation
//   5. Resolve next clip from branch conditions
//   6. Append a ConversationTurn to session history
//   7. Reset evaluation and transcription buffers
//   8. Send clip_selected to the client
//   9a. If terminal: trigger feedback and end the session
//   9b. If not terminal: advance coordinator and session to the next clip
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

    /**
     * Handles a clip_ended event from the client.
     *
     * `sessionId` is the authoritative session ID from the WebSocket URL path,
     * not from the message body. This prevents a malicious client from sending
     * a clip_ended message with a different session's ID to trigger that
     * session's clip transition.
     */
    async handleClipEnded(sessionId: string, msg: ClipEnded, sendFn: SendFn): Promise<void> {
        const { clip_id } = msg;
        const ctx = this.sessions.getSession(sessionId);
        if (!ctx || ctx.state !== "ACTIVE" || !ctx.scenario_id) return;

        // 1. Pause — prevents stray frames being buffered mid-transition.
        this.sessions.markPaused(sessionId);

        const currentClip = this.scenarios.getClip(ctx.scenario_id, clip_id);

        // 2. Send clip_candidates immediately so the client can begin preloading
        //    while evaluation runs. Derived purely from branch conditions — no
        //    evaluation result needed yet.
        const candidates = currentClip
            ? this.buildCandidates(ctx.scenario_id, currentClip.branch_conditions)
            : [];
        sendFn({ type: "clip_candidates", session_id: sessionId, candidates });

        // 3. Flush — finalises transcript and dispatches the full clip window.
        await this.coord.flushSession(sessionId);

        // 4. Clip score from the single BehaviourResult for this clip.
        const result    = this.coord.getLastResult(sessionId);
        const clipScore = result?.escalation_score ?? 0;

        // 5. Resolve the next clip from branch conditions.
        const nextClipId = currentClip
            ? this.resolveNextClip(currentClip.branch_conditions, clipScore)
            : null;

        // 6. Append a ConversationTurn to session history.
        if (currentClip) {
            const turn: ConversationTurn = {
                turn_id:            ctx.turn_count + 1,
                clip:               currentClip,
                student_response:   result ?? this.fallbackResult(sessionId),
                student_transcript: this.coord.getLastTranscript(sessionId) ?? "",
            };
            this.sessions.appendTurn(sessionId, turn);
        }

        // 7. Reset buffers and open a fresh ClipSession for the next clip.
        //    nextClipId may be null (terminal) — still reset evaluation buffers
        //    but no new ClipSession is needed.
        const nextClipMeta = nextClipId
            ? this.scenarios.getClip(ctx.scenario_id, nextClipId) ?? null
            : null;
        await this.coord.resetSession(sessionId, nextClipMeta);

        // 8. Notify the client which candidate was selected.
        sendFn({ type: "clip_selected", session_id: sessionId, clip_id: nextClipId, clip_score: clipScore });

        // 9. Advance or complete.
        if (nextClipId === null) {
            await this.complete(sessionId, sendFn);
        } else {
            this.advance(sessionId, nextClipId);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /**
     * Builds the candidate list from branch conditions.
     * De-duplicates next_clip values so each distinct clip appears once.
     * Null (terminal) branches are excluded — there is nothing to preload.
     */
    private buildCandidates(scenarioId: string, conditions: BranchCondition[]): ClipCandidateData[] {
        const seen = new Set<string>();
        const candidates: ClipCandidateData[] = [];
        for (const cond of conditions) {
            if (cond.next_clip === null || seen.has(cond.next_clip)) continue;
            seen.add(cond.next_clip);
            const clip = this.scenarios.getClip(scenarioId, cond.next_clip);
            if (!clip) continue;
            candidates.push({
                clip_id:           clip.clip_id,
                video_url:         clip.video_url,
                transcript:        clip.transcript,
                notable_features:  clip.notable_features,
                branch_conditions: clip.branch_conditions,
            });
        }
        return candidates;
    }

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
        this.coord.deregisterSession(sessionId);
        if (feedbackReq) {
            await this.feedback.stream(sessionId, feedbackReq, sendFn);
        }
    }

    private advance(sessionId: string, nextClipId: string): void {
        this.sessions.setCurrentClip(sessionId, nextClipId);
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