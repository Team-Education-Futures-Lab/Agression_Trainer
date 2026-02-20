import type { VideoFrame, AudioChunk, Landmark } from "@ar-training/shared";
import {FaceLandmarker, FilesetResolver, HandLandmarker, type NormalizedLandmark} from "@mediapipe/tasks-vision";
import Meyda from "meyda";

// ─── Config ───────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 16000;
const AUDIO_CHUNK_MS = 2000;
const AUDIO_CHUNK_SAMPLES = SAMPLE_RATE * (AUDIO_CHUNK_MS / 1000);
const MFCC_COEFFICIENTS = 13;
const MEYDA_BUFFER_SIZE = 512;       // must be a power of 2

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CaptureConfig {
    sessionId: string;
    videoEl: HTMLVideoElement;
    onFrame: (frame: VideoFrame) => void;
    onAudio: (chunk: AudioChunk) => void;
    onError: (err: Error) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toAppLandmarks(src: NormalizedLandmark[] | undefined): Landmark[] {
    if (!src) return [];

    return src.map(({x, y, z, visibility}) => ({
        x, y, z,
        visibility: visibility ?? 1,
    }));
}

function float32ToBase64S16le(input: Float32Array): string {
    const buf = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(buf.buffer);
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// ─── CaptureSession ───────────────────────────────────────────────────────────

export class CaptureSession {
    private faceLandmarker: FaceLandmarker | null = null;
    private handLandmarker: HandLandmarker | null = null;
    private stream: MediaStream | null = null;
    private animFrame: number | null = null;
    private audioCtx: AudioContext | null = null;
    private meydaAnalyser: ReturnType<typeof Meyda.createMeydaAnalyzer> | null = null;
    private scriptProcessor: ScriptProcessorNode | null = null;

    private frameId = 0;
    private chunkId = 0;
    private sessionStart = 0;

    private pcmBuffer: Float32Array[] = [];
    private mfccBuffer: number[][] = [];
    private pcmSampleCount = 0;

    private cfg: CaptureConfig | null = null;

    // ── Init ────────────────────────────────────────────────────────────────────
    // Call once at app startup — downloads MediaPipe WASM + models (~10MB total).
    // Safe to call before a session exists.

    async init(): Promise<void> {
        const vision = await FilesetResolver.forVisionTasks("/mediapipe");

        [this.faceLandmarker, this.handLandmarker] = await Promise.all([
            FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
                    delegate: "GPU"
                },
                runningMode: "VIDEO",
                numFaces: 1,
                outputFaceBlendshapes: false,
            }),
            HandLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                    delegate: "GPU"
                },
                runningMode: "VIDEO",
                numHands: 2
            })
        ])
    }

    // ── Start ───────────────────────────────────────────────────────────────────

    async start(cfg: CaptureConfig): Promise<void> {
        if (!this.faceLandmarker || !this.handLandmarker) {
            throw new Error("CaptureSession not initialized - call init() first")
        }
        if (this.cfg) {
            throw new Error("CaptureSession already running - call stop() first")
        }

        this.cfg = cfg;
        this.sessionStart = performance.now();
        this.frameId = 0;
        this.chunkId = 0;
        this.pcmBuffer = [];
        this.mfccBuffer = [];
        this.pcmSampleCount = 0;

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480, frameRate: 30},
                audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true },
            });
        } catch (e) {
            this.cfg = null;
            throw new Error(`Media access denied: ${e}`);
        }

        cfg.videoEl.srcObject = this.stream;
        await cfg.videoEl.play();
        this.startAudio();
        this.videoLoop();
    }

    // ── Stop ────────────────────────────────────────────────────────────────────

    stop(): void {
        if (this.animFrame !== null) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }

        this.meydaAnalyser?.stop();
        this.meydaAnalyser = null;

        // Disconnect script processor before closing context to avoid browser warnings
        this.scriptProcessor?.disconnect();
        this.scriptProcessor = null;

        this.audioCtx?.close();
        this.audioCtx = null;

        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;

        this.cfg = null;
    }

    // ── Video loop ──────────────────────────────────────────────────────────────

    private videoLoop(): void {
        const tick = () => {
            if (!this.cfg) return;
            const { videoEl, sessionId, onFrame, onError } = this.cfg;

            if (videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                const now = performance.now();
                const ts = (now - this.sessionStart) / 1000;

                try {
                    const faceResult = this.faceLandmarker!.detectForVideo(videoEl, now);
                    const handResult = this.handLandmarker!.detectForVideo(videoEl, now);

                    let leftHand: Landmark[] = [];
                    let rightHand: Landmark[] = [];
                    handResult.handedness.forEach((h, i) => {
                        const label = h[0]?.categoryName;
                        const lm = toAppLandmarks(handResult.landmarks[i]);
                        if (label === "Left") leftHand = lm;
                        else rightHand = lm;
                    });

                    const frame: VideoFrame = {
                        type: "video_frame",
                        session_id: sessionId,
                        frame_id: this.frameId++,
                        timestamp: ts,
                        face_landmarks: toAppLandmarks(faceResult.faceLandmarks[0]),
                        left_hand: leftHand,
                        right_hand: rightHand,
                    };

                    onFrame(frame);
                } catch (e) {
                    onError(e instanceof Error ? e : new Error(String(e)));
                }
            }

            this.animFrame = requestAnimationFrame(tick);
        };

        this.animFrame = requestAnimationFrame(tick);
    }

    // ── Audio pipeline ──────────────────────────────────────────────────────────

    private startAudio(): void {
        if (!this.cfg || !this.stream) return;
        const {sessionId, onAudio} = this.cfg;

        this.audioCtx = new AudioContext({sampleRate: SAMPLE_RATE});
        const source = this.audioCtx.createMediaStreamSource(this.stream);

        this.meydaAnalyser = Meyda.createMeydaAnalyzer({
            audioContext: this.audioCtx,
            source,
            bufferSize: MEYDA_BUFFER_SIZE,
            featureExtractors: ["mfcc"],
            callback: (features: {mfcc: number[]}) => {
                if (!features.mfcc) return;
                this.mfccBuffer.push(features.mfcc.slice(0, MFCC_COEFFICIENTS));
            },
        });

        // ScriptProcessorNode captures raw PCM for Whisper.
        // Deprecated but avoids needing a separate AudioWorklet file for now.
        // TODO: migrate to AudioWorkletNode before production.
        this.scriptProcessor = this.audioCtx.createScriptProcessor(MEYDA_BUFFER_SIZE, 1, 1);
        source.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.audioCtx.destination);

        this.scriptProcessor.onaudioprocess = (e) => {
            const samples = e.inputBuffer.getChannelData(0).slice();
            this.pcmBuffer.push(samples);
            this.pcmSampleCount += samples.length;

            if (this.pcmSampleCount >= AUDIO_CHUNK_SAMPLES) {
                this.flushAudioChunk(sessionId, onAudio);
            }
        };

        this.meydaAnalyser.start();
    }

    private flushAudioChunk(sessionId: string, onAudio: (chunk: AudioChunk) => void): void {
        const merged = new Float32Array(this.pcmSampleCount);
        let offset = 0;
        for (const buf of this.pcmBuffer) {
            merged.set(buf, offset);
            offset += buf.length;
        }

        const chunk: AudioChunk = {
            type: "audio_chunk",
            session_id: sessionId,
            chunk_id: this.chunkId++,
            timestamp: (performance.now() - this.sessionStart) / 1000,
            pcm: float32ToBase64S16le(merged),
            sample_rate: SAMPLE_RATE,
            mfccs: [...this.mfccBuffer],
        };

        onAudio(chunk);

        this.pcmBuffer = [];
        this.mfccBuffer = [];
        this.pcmSampleCount = 0;
    }
}