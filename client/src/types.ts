import type { Landmark } from "@ar-training/shared";

// =============================================================================
// AR Training — Client-internal Types
// These types are produced by the capture pipeline and never cross a container
// boundary. See shared/types.ts for wire-format types.
// =============================================================================

/**
 * One frame of landmark data extracted from the webcam by MediaPipe.js.
 * Produced continuously by CaptureSession regardless of session state.
 *
 * Does not contain a session_id — that is stamped by the SessionHandler
 * when producing the wire-format VideoFrame.
 */
export interface RawVideoFrame {
    /** Monotonically increasing counter, reset to 0 when capture starts. */
    frame_id: number;
    /** Seconds elapsed since capture started. */
    timestamp: number;
    /** 478 MediaPipe face mesh landmarks in normalised image coordinates. */
    face_landmarks: Landmark[];
    /** 21 hand landmarks, or empty array if left hand is not detected. */
    left_hand: Landmark[];
    /** 21 hand landmarks, or empty array if right hand is not detected. */
    right_hand: Landmark[];
}

/**
 * One chunk of audio data from the microphone, covering approximately 2 seconds.
 * Produced continuously by CaptureSession regardless of session state.
 *
 * Does not contain a session_id — that is stamped by the SessionHandler
 * when producing the wire-format AudioChunk.
 */
export interface RawAudioChunk {
    /** Monotonically increasing counter, reset to 0 when capture starts. */
    chunk_id: number;
    /** Seconds elapsed since capture started. */
    timestamp: number;
    /** Base64-encoded raw s16le PCM bytes, resampled to `sample_rate`. */
    pcm: string;
    /** Always 16000 Hz — required by Whisper. */
    sample_rate: number;
    /** `[n_frames][13]` MFCCs pre-computed client-side via Meyda.js. */
    mfccs: number[][];
}
