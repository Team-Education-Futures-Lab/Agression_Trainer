import type { FeedbackClient } from "./feedback-client.js";
import type { ScenarioLoader } from "./scenario-loader.js";
import type { Coordinator, SendFn } from "./coordinator.js";
import type { SessionManager } from "./session-manager.js";
import type {
    BehaviourResult,
    BranchCondition,
    ClipCandidateData,
    ClipEnded,
    ClipMetadata,
    ClipMetadataForFeedback,
    ConversationTurn,
    DebugEval,
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
//      (with X-Debug: true for admin sessions)
//   4. Read clip score from the single BehaviourResult returned by Evaluation
//   5. Resolve next clip from branch conditions
//   6. Append a ConversationTurn (with stripped ClipMetadataForFeedback) to history
//   7. Reset evaluation and transcription buffers
//   8. Send clip_selected to the client
//   9. For admin sessions: send debug_eval immediately after clip_selected
//   10a. If terminal: trigger feedback and end the session
//   10b. If not terminal: advance coordinator and session to the next clip
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
        //    Pass is_admin so the coordinator adds X-Debug: true for admin sessions.
        const evalStart = Date.now();
        await this.coord.flushSession(sessionId, ctx.is_admin);
        const evalLatencyMs = Date.now() - evalStart;

        // 4. Clip score from the single BehaviourResult for this clip.
        const result    = this.coord.getLastResult(sessionId);
        const clipScore = result?.escalation_score ?? 0;

        // 5. Resolve the next clip from branch conditions.
        const nextClipId = currentClip
            ? this.resolveNextClip(currentClip.branch_conditions, clipScore)
            : null;

        // 6. Append a ConversationTurn to session history.
        //    The clip field is stripped to ClipMetadataForFeedback — evaluation-only
        //    rubric fields are not forwarded to the Feedback container.
        if (currentClip) {
            const turn: ConversationTurn = {
                turn_id:            ctx.turn_count + 1,
                clip:               this.toFeedbackClip(currentClip),
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

        // 9. For admin sessions, send debug_eval immediately after clip_selected.
        //    Non-admin sessions never receive this message.
        if (ctx.is_admin) {
            this.sendDebugEval(sessionId, result, evalLatencyMs, sendFn);
        }

        // 10. Advance or complete.
        if (nextClipId === null) {
            await this.complete(sessionId, sendFn);
        } else {
            this.advance(sessionId, nextClipId);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /**
     * Builds and sends a debug_eval message for an admin session.
     * All capture statistics are read from the coordinator state at call time.
     * If debug data is unavailable (eval fallback), stages is null.
     */
    private sendDebugEval(
        sessionId:      string,
        result:         BehaviourResult | null,
        evalLatencyMs:  number,
        sendFn:         SendFn,
    ): void {
        const debugPayload = this.coord.getLastDebug(sessionId);
        const evalFallback = result === null;
        const finalResult  = result ?? this.fallbackResult(sessionId);
        const lastTranscript = this.coord.getLastTranscript(sessionId) ?? "";

        // Capture statistics are taken from the BehaviourResult's accumulated
        // window data. frame_count and audio_chunk_count are not directly
        // stored in the coordinator after flush — the window carries the counts
        // implicitly via frames.length and mfccs.length. We surface them from
        // the result's window_id context and signal_summary instead.
        // word_timing_count is available from the result's transcript words,
        // but since we don't re-expose the raw window post-flush, we derive
        // what we can and note eval_fallback for the rest.
        const msg: DebugEval = {
            type:       "debug_eval",
            session_id: sessionId,
            window_id:  finalResult.window_id,
            capture: {
                frame_count:       0,   // not available post-flush; set to 0
                audio_chunk_count: 0,   // not available post-flush; set to 0
                word_timing_count: 0,   // not available post-flush; set to 0
                eval_fallback: evalFallback,
                eval_latency_ms:   evalLatencyMs,
            },
            transcript: {
                final_text: lastTranscript,
                words:      [],  // word timings are not retained post-flush
            },
            result:      finalResult,
            analyser_id: debugPayload?.analyser_id ?? "unknown",
            stages:      debugPayload?.stages ?? null,
        };

        sendFn(msg);
    }

    /**
     * Strips a full ClipMetadata down to the subset forwarded to the Feedback
     * container. Evaluation-only fields (rubric, scoring_mode, score_range,
     * critical_failures, clip_duration_seconds) are removed.
     */
    private toFeedbackClip(clip: ClipMetadata): ClipMetadataForFeedback {
        return {
            clip_id:                  clip.clip_id,
            scenario_id:              clip.scenario_id,
            transcript:               clip.transcript,
            notable_features:         clip.notable_features,
            clip_learning_objectives: clip.clip_learning_objectives,
            ideal_response:           clip.ideal_response,
            response_warnings:        clip.response_warnings,
        };
    }

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
                vocal_tension:      0,
                speech_pace:        0,
                gesture_activity:   0,
                open_gesture_ratio: null,
                head_nod_frequency: 0,
                facing_ratio:       0,
                silence_ratio:      0,
                lexical_markers:    [],
                response_tone:      "neutral",
                notable_signals:    ["no_data"],
            },
        };
    }
}