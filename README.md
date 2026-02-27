# Live Transcribe

Ultra-low latency call transcription and translation Chrome extension. Runs 100% locally in your browser — no servers, no API keys, no data leaves your device.

Uses [Moonshine](https://github.com/moonshine-ai/moonshine) for blazing-fast speech recognition (~50ms inference) and [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT) for real-time translation, powered by [Transformers.js](https://huggingface.co/docs/transformers.js) with WebGPU acceleration.

## Features

- **Ultra-low latency** — ~650ms end-to-end (speech → translated text)
- **Live transcription** of Google Meet, Zoom, WhatsApp Web, Teams, and Webex calls
- **Real-time translation** — English → Hebrew (and 12+ other language pairs)
- **100% local** — all processing happens in your browser using WebGPU/WASM
- **No API keys, no accounts, no costs** — completely free and private
- **VAD (Voice Activity Detection)** — smart chunking that sends audio on speech pauses
- **Draggable subtitle overlay** with RTL support for Hebrew/Arabic
- **Multiple models** — Moonshine (fastest) or Whisper (multilingual)

## How It Works

```
Tab Audio → VAD (speech pause detection) → Moonshine ASR → OPUS-MT Translation → Subtitle Overlay
  ~400ms silence detection    ~50ms inference     ~100ms translation      ~650ms total
```

## Two Ways to Use

### Option 1: Chrome Extension (Desktop)
Best for Google Meet, Zoom, and other browser-based calls. Captures audio directly from the tab.

### Option 2: PWA Web App (Phone / Any Device)
Works with **any** call app (Zoom, WhatsApp, FaceTime, regular phone calls). Put the call on speaker — the app listens through your microphone.

## Installation

### Chrome Extension

1. Clone and build:
   ```bash
   git clone https://github.com/RoyNativ-AI/Live-translate.git
   cd Live-translate
   npm install
   npm run build
   ```

2. Load in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked**
   - Select the `dist/` folder

### PWA (Phone / Tablet / Any Browser)

1. Host the `pwa/` folder on any static server (GitHub Pages, Netlify, Vercel, or local):
   ```bash
   cd pwa
   npx serve .
   ```

2. Open the URL on your phone's browser

3. Tap "Add to Home Screen" to install as an app

4. Put your call on speaker and tap **Start Listening**

## Usage

### Chrome Extension
1. Open a call on Google Meet, Zoom, WhatsApp Web, Teams, or Webex
2. Click the **Live Transcribe** extension icon
3. Click **Start Transcription**
4. First time: the model downloads automatically (~40MB). After that it's cached
5. Live subtitles appear at the bottom of the call — drag to reposition

Default config: English speech → Hebrew translation. Change in the popup settings.

## Models

### Moonshine — Ultra Fast (English)

| Model | Size | Inference | Use Case |
|-------|------|-----------|----------|
| **Moonshine Tiny** (default) | ~40MB | ~50ms | Fastest, great accuracy |
| Moonshine Base | ~80MB | ~107ms | Better accuracy |

### Whisper — Multilingual

| Model | Size | Inference | Use Case |
|-------|------|-----------|----------|
| Whisper Tiny | ~75MB | ~1000ms | Multilingual (100+ languages) |
| Whisper Base | ~150MB | ~2000ms | Better multilingual accuracy |
| Whisper Small | ~466MB | ~5000ms | Best quality, all languages |

Use Whisper if you need to transcribe non-English speech (Hebrew, Arabic, etc.).

## Translation

Translation is powered by [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT) models that also run locally in the browser. Supported language pairs:

| From | To |
|------|-----|
| English | Hebrew, Arabic, Spanish, French, German, Russian, Chinese, Japanese, Korean, Italian, Turkish, Hindi, Portuguese |
| Hebrew, Arabic, Spanish, French, German, Russian, Chinese | English |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Chrome Extension (Manifest V3)                      │
│                                                     │
│  Popup ─── Background Service Worker                │
│              │                                      │
│              ├── Tab Audio Capture (chrome.tabCapture)│
│              │                                      │
│              ├── Offscreen Document                  │
│              │    └── Audio Processing + VAD         │
│              │         └── Web Worker                │
│              │              ├── Moonshine/Whisper ASR│
│              │              └── OPUS-MT Translation  │
│              │                                      │
│              └── Content Script                     │
│                   └── Subtitle Overlay (draggable)  │
└─────────────────────────────────────────────────────┘
```

## Requirements

- Chrome 113+ (for WebGPU) or any modern Chromium browser
- 4GB RAM recommended
- GPU recommended for WebGPU acceleration (falls back to WASM/CPU)

## Development

```bash
npm run dev    # Watch mode (auto-rebuild on changes)
npm run build  # Production build
```

## License

MIT
