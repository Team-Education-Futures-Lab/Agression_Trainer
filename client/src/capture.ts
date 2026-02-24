
// ─── Config ───────────────────────────────────────────────────────────────────

import {
    FaceLandmarker,
    FilesetResolver,
    HandLandmarker,
    type Landmark,
    type NormalizedLandmark
} from "@mediapipe/tasks-vision";
import Meyda from "meyda";
import type {RawAudioChunk, RawVideoFrame} from "./types.ts";

const SAMPLE_RATE       = 16000;
const AUDIO_CHUNK_MS    = 2000;
const AUDIO_CHUNK_SAMPLES = SAMPLE_RATE * (AUDIO_CHUNK_MS / 1000);
const MFCC_COEFFICIENTS = 13;
const MEYDA_BUFFER_SIZE = 512;  // must be a power of 2

// ─── Broadcast channel ────────────────────────────────────────────────────────
// A simple generic broadcast channel that allows multiple async iterators
// to consume the same stream of values independently.

class BroadcastChannel<T> {
    private subscribers = new Set<(value: T | null) => void>();

    /**
     * Push a value to all active subscribers.
     * @param value The data to broadcast
     */
    push(value: T): void {
        for (const sub of this.subscribers) {
            sub(value)
        }
    }

    /**
     * Signal all the subscribers that the stream has ended.
     */
    close(): void {
        for (const sub of this.subscribers) {
            sub(null);
        }
        this.subscribers.clear();
    }

    /**
     * Returns an AsyncIterator that yields values as they are pushed.
     * The iterator completes when close() is called.
     */
    [Symbol.asyncIterator](): AsyncIterator<T> {
        const subscribers = this.subscribers;
        const queue: T[] = [];
        let resolve: ((result: IteratorResult<T>) => void) | null = null;
        let done = false;

        const subscriber = (value: T | null) => {
            if (value === null) {
                done = true;
                resolve?.({value: undefined as unknown as T, done: true});
                resolve = null;
                return;
            }
            if (resolve) {
                resolve({value, done: false});
                resolve = null;
                return;
            } else {
                queue.push(value);
            }
        }

        this.subscribers.add(subscriber);

        return {
            next(): Promise<IteratorResult<T>> {
                if (queue.length > 0) {
                    return Promise.resolve({value: queue.shift()!, done: false});
                }
                if (done) {
                    return Promise.resolve({value: undefined as unknown as T, done: true});
                }
                return new Promise(r => {resolve = r;});
            },
            return(): Promise<IteratorResult<T>> {
                subscribers.delete(subscriber)
                return Promise.resolve({value: undefined as unknown as T, done: true});
            },
        };
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toAppLandmarks(src: NormalizedLandmark[] | undefined): Landmark[] {
    if (!src) return [];
    return src.map(({x, y, z, visibility}) => ({x, y, z, visibility: visibility ?? 1}));
}

function float32ToBase64S16le(input: Float32Array): string {
    const buf = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(buf.buffer);
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
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
    // MediaPipe models — initialised once via init()
    private faceLandmarker: FaceLandmarker | null = null;
    private handLandmarker: HandLandmarker | null = null;

    // Media resources — alive only while capture is running
    private stream:          MediaStream | null = null;
    private animFrame:       number | null = null;
    private audioCtx:        AudioContext | null = null;
    private meydaAnalyser:   ReturnType<typeof Meyda.createMeydaAnalyzer> | null = null;
    private scriptProcessor: ScriptProcessorNode | null = null;

    // Counters — reset on each start()
    private frameId  = 0;
    private chunkId  = 0;
    private startedAt = 0;

    // Audio accumulation
    private pcmBuffer:      Float32Array[] = [];
    private mfccBuffer:     number[][] = [];
    private pcmSampleCount: number = 0;
    private systemRate:     number = 44100;

    // Broadcast channels — one per stream type
    private frameChannel = new BroadcastChannel<RawVideoFrame>();
    private audioChannel = new BroadcastChannel<RawAudioChunk>();

    private running = false;

    async init(): Promise<void> {
        if (this.faceLandmarker && this.handLandmarker) return;
        const vision = await FilesetResolver.forVisionTasks("/mediapipe");

        [this.faceLandmarker, this.handLandmarker] = await Promise.all([
            FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
                    delegate: "CPU",
                },
                runningMode: "VIDEO",
                numFaces: 1,
                outputFaceBlendshapes: false,
            }),
            HandLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                    delegate: "CPU",
                },
                runningMode: "VIDEO",
                numHands: 2,
            }),
        ]);
    }

    async start(videoEL: HTMLVideoElement): Promise<void> {
        if (!this.faceLandmarker || !this.handLandmarker) {
            throw new Error("CaptureSession not initialized - call init() first");
        }
        if (this.running) return;

        this.stream = await navigator.mediaDevices.getUserMedia({
            video: {width: 640, height: 480, frameRate: 30},
            audio: {channelCount: 1, echoCancellation: true},
        })

        videoEL.srcObject = this.stream;
        await videoEL.play();

        this.frameId = 0;
        this.chunkId = 0;
        this.startedAt = performance.now();
        this.running = true;

        this.startAudio();
        this.videoLoop(videoEL);
    }

    stop(): void {
        if (!this.running) return;
        if (this.animFrame !== null) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }

        this.meydaAnalyser?.stop();
        this.scriptProcessor?.disconnect();
        this.audioCtx?.close();
        this.stream?.getTracks().forEach(t => t.stop());

        this.meydaAnalyser   = null;
        this.scriptProcessor = null;
        this.audioCtx        = null;
        this.stream          = null;
        this.running         = false;

        // Signal all consumers that the streams are done
        this.frameChannel.close();
        this.audioChannel.close();

        // Fresh channels for the next start()
        this.frameChannel = new BroadcastChannel<RawVideoFrame>();
        this.audioChannel = new BroadcastChannel<RawAudioChunk>();
    }

    getStream(): MediaStream | null {
        return this.stream;
    }

    frames(): AsyncIterable<RawVideoFrame> {
        return this.frameChannel;
    }

    audio(): AsyncIterable<RawAudioChunk> {
        return this.audioChannel;
    }

    private videoLoop(videoEL: HTMLVideoElement) {
        const tick = () => {
            if (!this.running) return;

            if (videoEL.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                const now = performance.now();
                const ts = (now - this.startedAt) / 1000;

                try {
                    const faceResult = this.faceLandmarker!.detectForVideo(videoEL, now);
                    const handResult = this.handLandmarker!.detectForVideo(videoEL, now);

                    let leftHand: Landmark[] = [];
                    let rightHand: Landmark[] = [];

                    handResult.handedness.forEach((h, i) => {
                        const lm = toAppLandmarks(handResult.landmarks[i]);
                        if (h[0]?.categoryName === "Left") leftHand = lm;
                        else rightHand = lm;
                    });

                    this.frameChannel.push({
                        frame_id: this.frameId++,
                        timestamp: ts,
                        face_landmarks: toAppLandmarks(faceResult.faceLandmarks[0]),
                        left_hand: leftHand,
                        right_hand: rightHand,
                    });
                } catch (e) {
                    console.error("[capture] Frame processing error:", e);
                }
            }

            this.animFrame = requestAnimationFrame(tick);
        };

        this.animFrame = requestAnimationFrame(tick);
    }

    private startAudio(): void {
        if (!this.stream) return;

        this.audioCtx = new AudioContext();
        this.systemRate = this.audioCtx.sampleRate;
        const source = this.audioCtx.createMediaStreamSource(this.stream);

        // noinspection JSUnusedGlobalSymbols
        this.meydaAnalyser = Meyda.createMeydaAnalyzer({
            audioContext: this.audioCtx,
            source,
            bufferSize: MEYDA_BUFFER_SIZE,
            featureExtractors: ["mfcc"],
            callback: (features: {mfcc: number[] }) => {
                if (features.mfcc) {
                    this.mfccBuffer.push(features.mfcc.slice(0, MFCC_COEFFICIENTS));
                }
            },
        });

        this.scriptProcessor = this.audioCtx.createScriptProcessor(MEYDA_BUFFER_SIZE, 1, 1);
        source.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.audioCtx.destination);

        const chunkThreshold = AUDIO_CHUNK_SAMPLES * (this.systemRate / SAMPLE_RATE);

        this.scriptProcessor.onaudioprocess = (e) => {
            const samples = e.inputBuffer.getChannelData(0).slice();
            this.pcmBuffer.push(samples);
            this.pcmSampleCount += samples.length;

            if (this.pcmSampleCount >= chunkThreshold) {
                this.flushAudioChunk();
            }
        };

        this.meydaAnalyser.start();
    }

    private flushAudioChunk(): void {
        const merged = new Float32Array(this.pcmSampleCount);
        let offset = 0;
        for (const buf of this.pcmBuffer) {
            merged.set(buf, offset);
            offset += buf.length;
        }

        const resampled = resample(merged, this.systemRate, SAMPLE_RATE);

        this.audioChannel.push({
            chunk_id:    this.chunkId++,
            timestamp:   (performance.now() - this.startedAt) / 1000,
            pcm:         float32ToBase64S16le(resampled),
            sample_rate: SAMPLE_RATE,
            mfccs:       [...this.mfccBuffer],
        });

        this.pcmBuffer = [];
        this.mfccBuffer = [];
        this.pcmSampleCount = 0;
    }
}