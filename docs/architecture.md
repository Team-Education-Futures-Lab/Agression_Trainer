# AR Training Platform — Architecture Overview

A web-based de-escalation training platform for classroom use. Students respond to video scenarios while the system analyses their behaviour in real time and provides coaching feedback at the end of each session.

---

## System Architecture

```mermaid
flowchart LR
    subgraph CLIENT["CLIENT (Browser)"]
        CAP["Capture\n―――――――――\nMediaPipe.js landmarks\nMeyda.js MFCCs"]
        RES["Response Handler\n―――――――――\nVideo branch switch\nFeedback overlay"]
    end

    subgraph APP["APP CONTAINER"]
        SM["Session Manager\n―――――――――\nLifecycle & capacity\nQueue management"]
        CO["Coordinator\n―――――――――\nAssembles AnalysisWindows\nRoutes results"]
    end

    subgraph PROXY["PROXY CONTAINER"]
        PX["Proxy\n―――――――――\nRound-robin routing\nSession pinning"]
    end

    subgraph EVAL["EVALUATION CONTAINER  (scalable)"]
        TR["Transcription Pool\n―――――――――\nfaster-whisper + VAD\nPer-session buffers"]
        BA["Behaviour Analyser\n―――――――――\nMultimodal classifier\nLandmarks+MFCCs+Text"]
    end

    subgraph FEED["FEEDBACK CONTAINER"]
        FG["Feedback Generator\n―――――――――\nOllama LLM wrapper\nEnd-of-session debrief"]
    end

    subgraph OLL["OLLAMA SIDECAR"]
        OL["Ollama\n―――――――――\nLocal LLM inference\nPersisted model volume"]
    end

    CAP -->|"VideoFrame + AudioChunk\n(WebSocket)"| APP
    APP -->|"SessionUpdate\n(escalation_score)"| RES
    APP -->|"POST /evaluate"| PROXY
    APP -->|"POST /feedback"| PROXY
    PROXY -->|"round-robin + pinned WS"| EVAL
    PROXY -->|"POST /feedback/*"| FEED
    EVAL -->|"BehaviourResult + Transcript"| APP
    FEED -->|"Feedback (SSE stream)"| APP
    FEED -->|"POST /api/generate"| OLL
```

---

## Data Flow

Each session follows this sequence:

1. **Capture** — The browser extracts face/hand landmarks (MediaPipe.js) and audio features (Meyda.js) from the webcam/microphone. Raw PCM and pre-computed MFCCs are sent to the App container over WebSocket, stamped with a `session_id`.

2. **Coordinate** — The Coordinator assembles incoming frames, MFCCs, and transcripts into \~2s `AnalysisWindows`, each tagged with a `WindowID (session_id:sequence)` so async results can always be matched back to the correct session.

3. **Evaluate** — The Evaluation container runs two things in parallel: Whisper transcribes the raw PCM audio, and the multimodal classifier analyses the full window (landmarks + MFCCs + transcript + clip context) to produce an `escalation_score`.

4. **Branch** — The `escalation_score` is returned to the client immediately via a `SessionUpdate`. The Response Handler switches the scenario video branch if the score crosses a threshold.

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

## Interfaces

All AI components are interface-driven. Implementations can be swapped without changing any other part of the system.

| Interface                    | Container  | Responsibility                            |
|------------------------------|------------|-------------------------------------------|
| `TransportInterface`         | Client     | Abstracts WebSocket/WebRTC/HTTP transport |
| `ResponseHandlerInterface`   | Client     | Reacts to escalation scores and feedback  |
| `SessionManagerInterface`    | App        | Session lifecycle, capacity, queue        |
| `CoordinatorInterface`       | App        | Assembles streams into AnalysisWindows    |
| `TranscriptionInterface`     | Evaluation | Whisper pool, per-session VAD buffers     |
| `BehaviourAnalyserInterface` | Evaluation | Multimodal escalation classifier          |
| `FeedbackGeneratorInterface` | Feedback   | LLM debrief generation                    |

---

## Deployment

Designed for single-server classroom deployment with optional scaling for larger institutions.

```mermaid
flowchart TD
    A["docker compose up\n(default — everything on one server)"]
    B["--scale evaluation=N\n(multiple Whisper workers, same server)"]
    C["FEEDBACK_URL=http://server2:8002\n(dedicated GPU machine for Ollama)"]
    D["EVALUATION_URL=url1,url2,...\n(evaluation spread across multiple hosts)"]

    A --> B --> C --> D
```

| Scenario                | How                                               |
|-------------------------|---------------------------------------------------|
| Single server           | `docker compose up` — no config changes needed    |
| Scale evaluation        | `docker compose up --scale evaluation=N`          |
| Offload feedback/Ollama | Set `FEEDBACK_URL` in `.env` to a second server   |
| Multi-host evaluation   | Set `EVALUATION_URL` to comma-separated host list |

All configuration lives in `.env`. IT departments never need to touch application code to scale.
