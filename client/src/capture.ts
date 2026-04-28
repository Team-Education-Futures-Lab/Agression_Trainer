// =============================================================================
// CaptureSession
//
// Owns the webcam and microphone. Runs MediaPipe FaceLandmarker and
// HandLandmarker on every animation frame, and accumulates microphone audio
// via an AudioWorklet. Exposes two async-iterable streams:
//
//   frames()  — one RawVideoFrame per 30 fps tick
//   audio()   — one RawAudioChunk per ~2-second audio buffer
//
// Lifecycle: call init() once at startup (loads MediaPipe models), then
// start(videoEl) / stop() as needed. init() is safe to call before the user
// has granted camera/mic permissions.
// =============================================================================

import {
    FaceLandmarker,
    HandLandmarker,
    FilesetResolver,
    type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import Meyda from "meyda";
import { BroadcastChannel } from "./types.ts";
import type { RawVideoFrame, RawAudioChunk } from "./types.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const TARGET_SAMPLE_RATE    = 16000;
const MFCC_COEFFICIENTS     = 13;
const MEYDA_BUFFER_SIZE     = 512;   // must be a power of 2

// rAF fires at the display refresh rate (typically 60 Hz) regardless of the
// getUserMedia frameRate constraint. This interval gate throttles MediaPipe
// processing and VideoFrame emission to 30 fps — half the server's 60 fps
// rate limit — so a well-behaved client never triggers the server-side drop.
const TARGET_FPS             = 30;
const FRAME_INTERVAL_MS      = 1000 / TARGET_FPS;  // 33.33 ms

const MEDIAPIPE_WASM = "/mediapipe";
const FACE_MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toAppLandmarks(
    src: NormalizedLandmark[] | undefined,
): { x: number; y: number; z: number; visibility: number }[] {
    if (!src) return [];
    return src.map(({ x, y, z, visibility }) => ({
        x, y, z, visibility: visibility ?? 1,
    }));
}

function float32ToBase64S16le(input: Float32Array): string {
    const buf = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]!));
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(buf.buffer);
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        bin += String.fromCharCode(bytes[i]!);
    }
    return btoa(bin);
}

/** Linear interpolation resampling — better quality than nearest-neighbour for speech. */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return input;
    const ratio  = fromRate / toRate;
    const output = new Float32Array(Math.round(input.length / ratio));
    for (let i = 0; i < output.length; i++) {
        const pos  = i * ratio;
        const idx  = Math.floor(pos);
        const frac = pos - idx;
        output[i]  = (input[idx] ?? 0) + frac * ((input[idx + 1] ?? 0) - (input[idx] ?? 0));
    }
    return output;
}

// ─── CaptureSession ───────────────────────────────────────────────────────────

export class CaptureSession {
    // MediaPipe models — loaded once by init()
    private faceLandmarker: FaceLandmarker | null = null;
    private handLandmarker: HandLandmarker | null = null;

    // Media resources — alive only while running
    private stream:       MediaStream | null = null;
    private animFrame:    number | null = null;
    private audioCtx:     AudioContext | null = null;
    private workletNode:  AudioWorkletNode | null = null;
    private sourceNode:   MediaStreamAudioSourceNode | null = null;
    private meydaAnalyser: ReturnType<typeof Meyda.createMeydaAnalyzer> | null = null;

    // Counters — reset on each start()
    private frameId      = 0;
    private chunkId      = 0;
    private startedAt    = 0;
    private lastFrameTime = 0;

    // Audio accumulation — samples at the native AudioContext rate
    private pcmBuffer:      Float32Array[] = [];
    private mfccBuffer:     number[][]     = [];
    private pcmSampleCount  = 0;
    private systemRate      = 44100;

    // Broadcast channels
    private frameChannel = new BroadcastChannel<RawVideoFrame>(180);
    private audioChannel = new BroadcastChannel<RawAudioChunk>(60);

    private running = false;

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Load MediaPipe models. Safe to call before camera/mic permissions are
     * granted. Call once at app startup and await before calling start().
     */
    async init(): Promise<void> {
        if (this.faceLandmarker && this.handLandmarker) return;
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);

        // Try GPU first; fall back to CPU if the delegate is unavailable.
        let delegate: "GPU" | "CPU" = "GPU";
        try {
            [this.faceLandmarker, this.handLandmarker] = await Promise.all([
                FaceLandmarker.createFromOptions(vision, {
                    baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "GPU" },
                    runningMode: "VIDEO",
                    numFaces: 1,
                    outputFaceBlendshapes: false,
                }),
                HandLandmarker.createFromOptions(vision, {
                    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" },
                    runningMode: "VIDEO",
                    numHands: 2,
                }),
            ]);
        } catch {
            delegate = "CPU";
            console.info("[capture] GPU delegate unavailable, falling back to CPU");
            [this.faceLandmarker, this.handLandmarker] = await Promise.all([
                FaceLandmarker.createFromOptions(vision, {
                    baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "CPU" },
                    runningMode: "VIDEO",
                    numFaces: 1,
                    outputFaceBlendshapes: false,
                }),
                HandLandmarker.createFromOptions(vision, {
                    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "CPU" },
                    runningMode: "VIDEO",
                    numHands: 2,
                }),
            ]);
        }
        console.info(`[capture] MediaPipe delegate: ${delegate}`);
    }

    /**
     * Request camera and microphone, attach the feed to `videoEl`, and start
     * the frame and audio loops. Throws if init() has not been called.
     */
    async start(videoEl: HTMLVideoElement): Promise<void> {
        if (!this.faceLandmarker || !this.handLandmarker) {
            throw new Error("CaptureSession not initialised — call init() first");
        }
        if (this.running) return;

        this.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, frameRate: 30 },
            audio: { channelCount: 1, echoCancellation: true },
        });

        videoEl.srcObject = this.stream;
        await videoEl.play();

        this.frameId       = 0;
        this.chunkId       = 0;
        this.startedAt     = performance.now();
        this.lastFrameTime = 0;
        this.running       = true;

        await this._startAudio();
        this._videoLoop(videoEl);
    }

    /** Stop all capture, release resources, and close the broadcast channels. */
    stop(): void {
        if (!this.running) return;
        this.running = false;

        if (this.animFrame !== null) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }

        this.meydaAnalyser?.stop();
        this.workletNode?.disconnect();
        this.sourceNode?.disconnect();
        this.audioCtx?.close().catch(() => undefined);
        this.stream?.getTracks().forEach(t => t.stop());

        this.meydaAnalyser = null;
        this.workletNode   = null;
        this.sourceNode    = null;
        this.audioCtx      = null;
        this.stream        = null;

        this.pcmBuffer      = [];
        this.mfccBuffer     = [];
        this.pcmSampleCount = 0;

        this.frameChannel.close();
        this.audioChannel.close();

        // Fresh channels for the next start()
        this.frameChannel = new BroadcastChannel<RawVideoFrame>(180);
        this.audioChannel = new BroadcastChannel<RawAudioChunk>(60);
    }

    frames(): AsyncIterable<RawVideoFrame> { return this.frameChannel; }
    audio():  AsyncIterable<RawAudioChunk> { return this.audioChannel; }

    getStream(): MediaStream | null { return this.stream; }

    // ─── Video loop ───────────────────────────────────────────────────────────

    private _videoLoop(videoEl: HTMLVideoElement): void {
        // rAF passes its own high-resolution timestamp — use it directly rather
        // than calling performance.now() again to avoid a redundant syscall and
        // a tiny timestamp skew between the gate check and detectForVideo.
        const tick = (now: number) => {
            if (!this.running) return;

            // Throttle to TARGET_FPS. On a 60 Hz display this skips every other
            // tick; on a 120 Hz display it skips three out of four.
            if (now - this.lastFrameTime >= FRAME_INTERVAL_MS) {
                this.lastFrameTime = now;

                if (videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                    const ts = (now - this.startedAt) / 1000;

                    try {
                        const faceResult = this.faceLandmarker!.detectForVideo(videoEl, now);
                        const handResult = this.handLandmarker!.detectForVideo(videoEl, now);

                        let leftHand:  ReturnType<typeof toAppLandmarks> = [];
                        let rightHand: ReturnType<typeof toAppLandmarks> = [];

                        handResult.handedness.forEach((h, i) => {
                            const lm = toAppLandmarks(handResult.landmarks[i]);
                            if (h[0]?.categoryName === "Left")  leftHand  = lm;
                            else                                rightHand = lm;
                        });

                        this.frameChannel.push({
                            frame_id:       this.frameId++,
                            timestamp:      ts,
                            face_landmarks: toAppLandmarks(faceResult.faceLandmarks[0]),
                            left_hand:      leftHand,
                            right_hand:     rightHand,
                        });
                    } catch (e) {
                        console.error("[capture] frame error:", e);
                    }
                }
            }

            this.animFrame = requestAnimationFrame(tick);
        };

        this.animFrame = requestAnimationFrame(tick);
    }

    // ─── Audio ────────────────────────────────────────────────────────────────

    private async _startAudio(): Promise<void> {
        if (!this.stream) return;

        this.audioCtx   = new AudioContext();
        this.systemRate = this.audioCtx.sampleRate;

        const audioTrack = this.stream.getAudioTracks()[0];
        if (!audioTrack) return;

        this.sourceNode = this.audioCtx.createMediaStreamSource(
            new MediaStream([audioTrack]),
        );

        // ── Meyda: MFCC extraction in the main thread ─────────────────────
        // Meyda's analyzer API hooks into the Web Audio graph and fires the
        // callback every MEYDA_BUFFER_SIZE frames.
        this.meydaAnalyser = Meyda.createMeydaAnalyzer({
            audioContext:       this.audioCtx,
            source:             this.sourceNode,
            bufferSize:         MEYDA_BUFFER_SIZE,
            featureExtractors:  ["mfcc"],
            callback: (features: { mfcc: number[] }) => {
                if (features.mfcc) {
                    this.mfccBuffer.push(features.mfcc.slice(0, MFCC_COEFFICIENTS));
                }
            },
        });

        // ── AudioWorklet: PCM accumulation ────────────────────────────────
        // The worklet accumulates raw samples and posts them back to the main
        // thread in blocks. We reassemble them here rather than in the worklet
        // so that the chunk boundary aligns with our 2-second target.
        await this.audioCtx.audioWorklet.addModule("/worklets/pcm-processor.js");

        this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-processor");
        this.sourceNode.connect(this.workletNode);
        // No output connection — side-effect only.

        this.workletNode.port.onmessage = (
            ev: MessageEvent<{ samples: Float32Array; sampleRate: number }>,
        ) => {
            this.pcmBuffer.push(ev.data.samples);
            this.pcmSampleCount += ev.data.samples.length;

            // Threshold is 2 seconds worth of samples at the native rate.
            const threshold = TARGET_SAMPLE_RATE * 2 * (this.systemRate / TARGET_SAMPLE_RATE);
            if (this.pcmSampleCount >= threshold) {
                this._flushAudioChunk();
            }
        };

        this.meydaAnalyser.start();
    }

    private _flushAudioChunk(): void {
        // Merge accumulated native-rate buffers into one Float32Array.
        const merged = new Float32Array(this.pcmSampleCount);
        let offset = 0;
        for (const buf of this.pcmBuffer) {
            merged.set(buf, offset);
            offset += buf.length;
        }

        const resampled = resample(merged, this.systemRate, TARGET_SAMPLE_RATE);

        this.audioChannel.push({
            chunk_id:    this.chunkId++,
            timestamp:   (performance.now() - this.startedAt) / 1000,
            pcm:         float32ToBase64S16le(resampled),
            sample_rate: TARGET_SAMPLE_RATE,
            mfccs:       [...this.mfccBuffer],
        });

        this.pcmBuffer      = [];
        this.mfccBuffer     = [];
        this.pcmSampleCount = 0;
    }
}