# Live Transcribe

Real-time call transcription and translation Chrome extension. Runs 100% locally in your browser using [Whisper AI](https://github.com/openai/whisper) via [Transformers.js](https://huggingface.co/docs/transformers.js) — no servers, no API keys, complete privacy.

## Features

- **Live transcription** of Google Meet, Zoom, WhatsApp Web, Teams, and Webex calls
- **Real-time translation** between languages (e.g., English → Hebrew)
- **100% local** — all processing happens in your browser using WebGPU/WASM
- **No data leaves your device** — complete privacy
- **Multiple Whisper models** — choose between speed (Tiny, ~75MB) and accuracy (Small, ~466MB)
- **100+ languages supported** with auto-detection
- **Draggable subtitle overlay** on the call page
- **Translation models** powered by [OPUS-MT](https://github.com/Helsinki-NLP/Opus-MT)

## Installation

### From source

1. Clone this repo:
   ```bash
   git clone https://github.com/RoyNativ-AI/Live-translate.git
   cd Live-translate
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build:
   ```bash
   npm run build
   ```

4. Load in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked**
   - Select the `dist/` folder

## Usage

1. Open a supported call platform (Google Meet, Zoom, etc.)
2. Click the **Live Transcribe** extension icon
3. Select your model, source language, and translation target
4. Click **Start Transcription**
5. The first time will download the model (~75MB for Tiny). After that, it's cached.
6. Live subtitles appear at the bottom of the page — drag to reposition

## Models

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| Whisper Tiny | ~75MB | Fastest | Good |
| Whisper Base | ~150MB | Fast | Better |
| Whisper Small | ~466MB | Moderate | Best |

English-only variants (`.en`) are slightly more accurate for English speech.

## Requirements

- Chrome 113+ (for WebGPU support) or any modern browser with WASM
- At least 4GB RAM recommended
- GPU recommended but not required (falls back to CPU via WASM)

## Development

```bash
npm run dev    # Watch mode
npm run build  # Production build
```

## License

MIT
