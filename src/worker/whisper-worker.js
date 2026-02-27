// Web Worker - runs Whisper model inference + translation off the main thread
// Uses Transformers.js with WebGPU acceleration (falls back to WASM)

import { pipeline, env } from '@huggingface/transformers';

// Configure Transformers.js for extension environment
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let translator = null;
let isLoading = false;
let modelId = 'onnx-community/whisper-tiny';
let language = null; // null = auto-detect
let translateEnabled = false;
let translateTarget = 'he'; // Default: translate to Hebrew

// Translation model mapping (source -> target)
const TRANSLATION_MODELS = {
  'en-he': 'Xenova/opus-mt-en-he',
  'en-ar': 'Xenova/opus-mt-en-ar',
  'en-es': 'Xenova/opus-mt-en-es',
  'en-fr': 'Xenova/opus-mt-en-fr',
  'en-de': 'Xenova/opus-mt-en-de',
  'en-ru': 'Xenova/opus-mt-en-ru',
  'en-zh': 'Xenova/opus-mt-en-zh',
  'en-ja': 'Xenova/opus-mt-en-jap',
  'en-ko': 'Xenova/opus-mt-tc-big-en-ko',
  'en-pt': 'Xenova/opus-mt-en-roa', // Romance languages
  'en-it': 'Xenova/opus-mt-en-it',
  'en-tr': 'Xenova/opus-mt-en-trk', // Turkic languages
  'en-hi': 'Xenova/opus-mt-en-hi',
  // Reverse direction (to English)
  'he-en': 'Xenova/opus-mt-he-en',
  'ar-en': 'Xenova/opus-mt-ar-en',
  'es-en': 'Xenova/opus-mt-es-en',
  'fr-en': 'Xenova/opus-mt-fr-en',
  'de-en': 'Xenova/opus-mt-de-en',
  'ru-en': 'Xenova/opus-mt-ru-en',
  'zh-en': 'Xenova/opus-mt-zh-en',
};

// Detect the best device for inference
async function detectDevice() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {
    // WebGPU not available
  }
  return 'wasm';
}

// Progress callback factory
function makeProgressCallback(phase) {
  return (progress) => {
    if (progress.status === 'progress') {
      self.postMessage({
        type: 'progress',
        status: 'downloading',
        phase,
        progress: progress.progress || 0,
      });
    } else if (progress.status === 'done') {
      self.postMessage({
        type: 'progress',
        status: 'loaded',
        phase,
        progress: 100,
      });
    }
  };
}

// Load the Whisper transcription model (and optionally translation model)
async function loadModel(settings) {
  if (isLoading) return;
  isLoading = true;

  modelId = settings.model || modelId;
  language = settings.language || null;
  translateEnabled = settings.translate || false;
  translateTarget = settings.translateTarget || 'he';

  self.postMessage({
    type: 'progress',
    status: 'loading',
    phase: 'transcription',
    progress: 0,
  });

  try {
    const device = await detectDevice();
    console.log(`[Worker] Using device: ${device}`);

    // 1. Load Whisper model for speech-to-text
    console.log(`[Worker] Loading transcription model: ${modelId}`);
    transcriber = await pipeline(
      'automatic-speech-recognition',
      modelId,
      {
        device,
        dtype: device === 'webgpu' ? 'fp32' : 'q8',
        progress_callback: makeProgressCallback('transcription'),
      }
    );

    console.log('[Worker] Transcription model loaded');

    // 2. Load translation model if enabled
    if (translateEnabled) {
      await loadTranslationModel(device);
    }

    isLoading = false;

    self.postMessage({
      type: 'progress',
      status: 'ready',
      progress: 100,
    });

    self.postMessage({ type: 'ready' });
  } catch (error) {
    isLoading = false;
    console.error('[Worker] Failed to load model:', error);
    self.postMessage({
      type: 'error',
      message: `Failed to load model: ${error.message}`,
    });
  }
}

// Load translation model
async function loadTranslationModel(device) {
  // Determine source language for translation
  const sourceLang = language || 'en';
  const modelKey = `${sourceLang}-${translateTarget}`;
  const translationModelId = TRANSLATION_MODELS[modelKey];

  if (!translationModelId) {
    console.warn(`[Worker] No translation model found for ${modelKey}`);
    self.postMessage({
      type: 'error',
      message: `No translation model available for ${sourceLang} -> ${translateTarget}`,
    });
    return;
  }

  console.log(`[Worker] Loading translation model: ${translationModelId}`);

  self.postMessage({
    type: 'progress',
    status: 'loading',
    phase: 'translation',
    progress: 0,
  });

  try {
    translator = await pipeline(
      'translation',
      translationModelId,
      {
        device: 'wasm', // Translation models work best on WASM
        dtype: 'q8',
        progress_callback: makeProgressCallback('translation'),
      }
    );

    console.log('[Worker] Translation model loaded');
  } catch (error) {
    console.warn('[Worker] Translation model failed to load:', error);
    translator = null;
    self.postMessage({
      type: 'error',
      message: `Translation model failed: ${error.message}. Transcription will continue without translation.`,
    });
  }
}

// Transcribe an audio chunk (and optionally translate)
async function transcribe(audioBuffer) {
  if (!transcriber) {
    self.postMessage({
      type: 'error',
      message: 'Model not loaded yet',
    });
    return;
  }

  try {
    const audioData = new Float32Array(audioBuffer);

    const options = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    };

    // Set source language if specified
    if (language) {
      options.language = language;
    }

    const result = await transcriber(audioData, options);

    if (!result || !result.text || !result.text.trim()) return;

    const originalText = result.text.trim();

    // Send original transcription
    self.postMessage({
      type: 'result',
      text: originalText,
      translatedText: null,
      language: result.language || language || 'auto',
      isTranslated: false,
    });

    // Translate if enabled and translator is loaded
    if (translateEnabled && translator && originalText) {
      try {
        const translation = await translator(originalText, {
          max_length: 512,
        });

        const translatedText =
          translation && translation[0]
            ? translation[0].translation_text
            : null;

        if (translatedText && translatedText.trim()) {
          self.postMessage({
            type: 'result',
            text: originalText,
            translatedText: translatedText.trim(),
            language: result.language || language || 'auto',
            isTranslated: true,
          });
        }
      } catch (transError) {
        console.error('[Worker] Translation error:', transError);
      }
    }
  } catch (error) {
    console.error('[Worker] Transcription error:', error);
    self.postMessage({
      type: 'error',
      message: `Transcription failed: ${error.message}`,
    });
  }
}

// Handle messages from the offscreen document
self.onmessage = (event) => {
  const { type, ...data } = event.data;

  switch (type) {
    case 'load':
      loadModel(data);
      break;

    case 'transcribe':
      transcribe(data.audio);
      break;
  }
};
