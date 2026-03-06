# Live Translate

Real-time speech transcription with speaker diarization and multi-language translation.

## Features

- **Real-time transcription** using Web Speech API
- **Speaker diarization** - identifies and color-codes different speakers using PyAnnote/Diart
- **Multi-language translation** via Google Translate API
- **PWA support** - installable on mobile devices
- **Apple Silicon optimized** - MPS acceleration for macOS

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    PWA Frontend                          │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │ Web Speech API  │  │   WebSocket Audio Stream     │  │
│  │ (Transcription) │  │   (Speaker Detection)        │  │
│  └────────┬────────┘  └──────────────┬───────────────┘  │
│           │                          │                   │
└───────────┼──────────────────────────┼───────────────────┘
            │                          │
            ▼                          ▼
    Google Translate API     Diarization Server (ws://8766)
                                       │
                             ┌─────────┴─────────┐
                             │  PyAnnote 3.1    │
                             │  (HuggingFace)   │
                             └──────────────────┘
```

## Installation

```bash
git clone https://github.com/RoyNativ-AI/Live-translate.git
cd Live-translate

python -m venv venv
source venv/bin/activate

pip install torch torchaudio
pip install pyannote.audio diart
pip install fastapi uvicorn websockets
pip install whisperlivekit  # Optional: for Whisper-based transcription
```

## Configuration

Set your HuggingFace token (required for PyAnnote models):

```bash
export HF_TOKEN=your_huggingface_token
```

Accept the model licenses on HuggingFace:
- https://huggingface.co/pyannote/speaker-diarization-3.1
- https://huggingface.co/pyannote/segmentation-3.0

## Usage

### Option 1: Web Speech API + PyAnnote Diarization (Recommended)

```bash
# Start the diarization server
python diarization_server.py

# Open PWA in browser
open pwa/index.html
```

### Option 2: Diart Real-time Diarization

```bash
# Start the Diart server (lower latency)
python diart_server.py
```

### Option 3: WhisperLiveKit (Full local transcription)

```bash
# Start WhisperLiveKit server
python whisper_server.py
```

## Server Options

| Server | Port | Use Case |
|--------|------|----------|
| `diarization_server.py` | 8766 | PyAnnote 3.1 - accurate speaker detection |
| `diart_server.py` | 8766 | Diart - streaming optimized, lower latency |
| `whisper_server.py` | 8765 | Full Whisper transcription + diarization |

## PWA Features

- Supports 9 target languages (Hebrew, English, Arabic, Spanish, French, German, Russian, Chinese, Japanese)
- Color-coded speakers (up to 4)
- Dark UI optimized for calls
- Mobile touch interface
- Service worker for offline caching

## Requirements

- Python 3.9+
- HuggingFace account with accepted model licenses
- Modern browser with Web Speech API support (Chrome/Edge recommended)
- Apple Silicon Mac with MPS or NVIDIA GPU with CUDA (recommended)

## License

MIT
