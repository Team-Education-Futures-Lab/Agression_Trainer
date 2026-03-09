# AR Training Platform — Architecture Overview

A web-based de-escalation training platform for classroom use. Students respond to video scenarios while the system analyses their behaviour and provides coaching feedback at the end of each session.

---

## System Architecture

```mermaid
flowchart LR
    subgraph CLIENT["CLIENT (Browser — TypeScript)"]
        CAP["Capture\n―――――――――\nMediaPipe.js landmarks\nMeyda.js MFCCs"]
        RES["Response Handler\n―――――――――\nVideo branch switch\nFeedback overlay"]
    end

    subgraph APP["APP CONTAINER (TypeScript / Node)"]
        SM["Session Manager\n―――――――――\nLifecycle & capacity\nQueue management"]
        CO["Coordinator\n―――――――――\nAccumulates clip data\nDispatches on clip end"]
    end

    subgraph TRANS["TRANSCRIPTION CONTAINER (Python — scalable)"]
        TR["Transcription Pool\n―――――――――\nfaster-whisper + VAD\nPer-session buffers"]
    end

    subgraph EVAL["EVALUATION CONTAINER (Python — scalable)"]
        BA["Behaviour Analyser\n―――――――――\nMultimodal classifier\nLandmarks+MFCCs+Text"]
    end

    subgraph FEED["FEEDBACK CONTAINER (TypeScript / Node)"]
        FG["Feedback Generator\n―――――――――\nOllama LLM wrapper\nEnd-of-session debrief"]
    end

    subgraph OLL["OLLAMA SIDECAR"]
        OL["Ollama\n―――――――――\nLocal LLM inference\nPersisted model volume"]
    end

    CAP -->|"VideoFrame + AudioChunk\n(WebSocket)"| APP
    APP -->|"SessionUpdate\n(transcript)"| RES
    APP -->|"AudioChunk\n(WS — continuous)"| TRANS
    TRANS -->|"Transcript segments"| APP
    APP -->|"POST /evaluate/analyse\n(once per clip)"| EVAL
    APP -->|"POST /feedback/generate/stream"| FEED
    EVAL -->|"BehaviourResult"| APP
    FEED -->|"Feedback (SSE stream)"| APP
    FEED -->|"POST /api/generate"| OLL
```

---
## Data Flow

Each session follows this sequence:

1. **Capture** — The browser extracts face/hand landmarks (MediaPipe.js) and audio features (Meyda.js) from the webcam/microphone. Raw PCM, pre-computed MFCCs, and landmark frames are sent to the App container over WebSocket.

2. **Accumulate** — The Coordinator creates a `ClipSession` for each clip. Incoming frames are buffered inside it; audio chunks are forwarded immediately to the Transcription container over the `ClipSession`'s WebSocket connection. The Transcription container streams partial and final transcript segments back through the same connection, which the `ClipSession` accumulates.

3. **Evaluate** — When the client sends `ClipEnded`, the Coordinator calls `flush()` on the `ClipSession`, signalling the Transcription container to emit its final transcript segment. Once that segment arrives, the `ClipSession` resolves with a complete `AnalysisWindow` — all frames, all MFCCs, and the full transcript — which the Coordinator dispatches to the Evaluation container.

4. **Branch** — The Evaluation container returns one `BehaviourResult` with an `escalation_score`. The App container uses this score to resolve the next clip from the scenario's branch conditions and sends a `ClipReady` message to the client.

5. **Debrief** — At session end, the full `ConversationHistory` (what each video clip showed + how the student responded) is sent to the Feedback container. The LLM generates a structured debrief which streams back to the client.

---

## Key Data Types

```mermaid
classDiagram
    class VideoFrame {
        session_id: str
        frame_id: int
        timestamp: float
        face_landmarks: Landmark[478]
        left_hand: Landmark[21]
        right_hand: Landmark[21]
    }

    class AudioChunk {
        session_id: str
        chunk_id: int
        pcm: bytes
        sample_rate: int
        mfccs: float[][]
    }

    class AnalysisWindow {
        window_id: WindowID
        session_id: str
        frames: VideoFrame[]
        mfccs: float[][]
        transcript: str
        clip_metadata: ClipMetadata
    }

    class BehaviourResult {
        window_id: WindowID
        session_id: str
        escalation_score: float
        dominant_emotion: str
        confidence: float
        signal_summary: SignalSummary
    }

    class ConversationTurn {
        turn_id: int
        clip: ClipMetadata
        student_response: BehaviourResult
        student_transcript: str
    }

    class ClipMetadata {
        clip_id: str
        scenario_id: str
        transcript: str
        notable_features: str[]
        branch_conditions: dict
    }

    class Feedback {
        session_id: str
        advice: str
        severity: low|medium|high
        highlights: str[]
    }

    AnalysisWindow --> ClipMetadata
    AnalysisWindow --> VideoFrame
    BehaviourResult --> AnalysisWindow
    ConversationTurn --> ClipMetadata
    ConversationTurn --> BehaviourResult
```

---

## Language Choices

| Container     | Language          | Reason                                                    |
|---------------|-------------------|-----------------------------------------------------------|
| Client        | TypeScript        | Frontend                                                  |
| App           | TypeScript / Node | I/O heavy, WebSocket native, shares types with frontend   |
| Transcription | Python            | faster-whisper requires the Python ML ecosystem           |
| Evaluation    | Python            | Multimodal classifier requires the Python ML ecosystem    |
| Feedback      | TypeScript / Node | Pure I/O — formats prompt, streams Ollama response        |
| Ollama        | —                 | Existing Docker image                                     |

Python is used exclusively where the ML ecosystem requires it. All other containers use TypeScript/Node for better WebSocket concurrency and consistency with the frontend.

---

## Interfaces

All AI components are interface-driven. Implementations can be swapped without changing any other part of the system.

| Interface                    | Container     | Language   | Responsibility                            |
|------------------------------|---------------|------------|-------------------------------------------|
| `TransportInterface`         | Client        | TypeScript | Abstracts WebSocket/WebRTC/HTTP transport |
| `ResponseHandlerInterface`   | Client        | TypeScript | Reacts to transcript updates and feedback |
| `SessionManagerInterface`    | App           | TypeScript | Session lifecycle, capacity, queue        |
| `CoordinatorInterface`       | App           | TypeScript | Accumulates clip data, dispatches windows |
| `TranscriptionInterface`     | Transcription | Python     | Whisper pool, per-session VAD buffers     |
| `BehaviourAnalyserInterface` | Evaluation    | Python     | Multimodal escalation classifier          |
| `FeedbackGeneratorInterface` | Feedback      | TypeScript | LLM debrief generation                    |

---

## Deployment

Designed for single-server classroom deployment with optional scaling for larger institutions.

The App container routes requests to AI services directly using URLs read from environment variables. There is no proxy container — adding or moving AI service instances is a one-line `.env` change, and no application code needs to be touched.

```mermaid
flowchart TD
    A["docker compose up\n(default — everything on one server)"]
    B["--scale transcription=N or --scale evaluation=N\n(multiple workers, same server)\nApp pins sessions via hash"]
    C["FEEDBACK_URL=http://server2:8002\n(dedicated GPU machine for Ollama)"]
    D["EVALUATION_URL=url1,url2,...\nTRANSCRIPTION_URL=url1,url2,...\n(services spread across multiple hosts)"]

    A --> B --> C --> D
```

| Scenario                   | How                                                                                       |
|----------------------------|-------------------------------------------------------------------------------------------|
| Single server              | `docker compose up` — no config changes needed                                            |
| Scale transcription        | `docker compose up --scale transcription=N` — App pins sessions via hash                  |
| Scale evaluation           | `docker compose up --scale evaluation=N` — App pins sessions via hash                     |
| Offload feedback/Ollama    | Set `FEEDBACK_URL` in `.env` to point at a second server                                  |
| Multi-host AI services     | Set `EVALUATION_URL` and/or `TRANSCRIPTION_URL` to comma-separated lists of host URLs     |

All routing configuration lives in `.env`. IT departments never need to touch application code to scale.

### TLS in multi-server deployments

When AI services run on separate machines, connections cross the public internet and must be encrypted. TLS termination should be handled at the infrastructure layer on each remote machine (e.g. Caddy or the institution's existing reverse proxy) rather than inside the containers. The App container then points its service URLs at `https://` addresses. No certificate management is required inside this stack.