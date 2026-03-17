// =============================================================================
// PCM Processor — AudioWorklet
//
// Runs in AudioWorkletGlobalScope. Cannot import from the main bundle.
// Accumulates Float32 samples from the microphone and posts a buffer to the
// main thread every CHUNK_FRAMES frames (approximately 2 seconds at 48 kHz).
//
// The main thread is responsible for resampling, s16le encoding, base64
// encoding, and MFCC computation — Meyda cannot run inside a worklet.
// =============================================================================

// Target chunk duration is 2 seconds. At 48 kHz (the most common browser
// sample rate) that is 96000 frames. At 44100 Hz it is 88200. We use the
// AudioContext's actual sampleRate at registration time.
const CHUNK_DURATION_S = 2;

// AudioWorklet processes in blocks of 128 frames. We accumulate until we
// have enough blocks for ~2 seconds, then flush.
class PcmProcessor extends AudioWorkletProcessor {
    private readonly chunkFrames: number;
    private buffer: Float32Array;
    private writePos = 0;

    constructor() {
        super();
        this.chunkFrames = Math.round(sampleRate * CHUNK_DURATION_S);
        this.buffer = new Float32Array(this.chunkFrames);
    }

    process(
        inputs: Float32Array[][],
        _outputs: Float32Array[][],
        _parameters: Record<string, Float32Array>,
    ): boolean {
        const input = inputs[0];
        if (!input || input.length === 0) return true;

        // Use the first channel (mono). If the mic provides stereo we only
        // need mono for Whisper — downmixing is not required here because
        // getUserMedia with channelCount: 1 will already provide mono.
        const channel = input[0];
        if (!channel) return true;

        let srcPos = 0;
        while (srcPos < channel.length) {
            const remaining  = this.chunkFrames - this.writePos;
            const available  = channel.length - srcPos;
            const toCopy     = Math.min(remaining, available);

            this.buffer.set(channel.subarray(srcPos, srcPos + toCopy), this.writePos);
            this.writePos += toCopy;
            srcPos        += toCopy;

            if (this.writePos >= this.chunkFrames) {
                // Post a copy — the worklet retains ownership of this.buffer.
                this.port.postMessage(
                    { samples: this.buffer.slice(0), sampleRate },
                );
                this.writePos = 0;
            }
        }

        return true; // keep processor alive
    }
}

registerProcessor("pcm-processor", PcmProcessor);
