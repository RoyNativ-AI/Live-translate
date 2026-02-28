// Web Worker - runs ASR model inference + translation off the main thread
// Supports Moonshine (ultra-low latency) and Whisper (multilingual) via Transformers.js

import { pipeline, AutoModelForAudioFrameClassification, Tensor, env } from '@huggingface/transformers';

// Configure Transformers.js for extension environment
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let translator = null;
let isLoading = false;
let modelId = 'onnx-community/moonshine-tiny-ONNX';
let language = null; // null = auto-detect
let translateEnabled = false;
let translateTarget = 'he'; // Default: translate to Hebrew
let translationMethod = 'cloud'; // 'cloud' (fast, Google Translate) or 'local' (private, OPUS-MT)

// Speaker diarization
let segmentationModel = null;
const SEGMENT_SAMPLES = 160000; // 10 seconds at 16kHz
let audioHistory = [];
let historyTotalLength = 0;

// Powerset labels for pyannote-segmentation-3.0 (max 3 speakers)
const POWERSET_LABELS = [
  [],      // 0: no speech
  [1],     // 1: speaker 1 only
  [2],     // 2: speaker 2 only
  [3],     // 3: speaker 3 only
  [1, 2],  // 4: speakers 1 & 2
  [1, 3],  // 5: speakers 1 & 3
  [2, 3],  // 6: speakers 2 & 3
];

// Translation cache (LRU, max 200 entries)
const translationCache = new Map();
const MAX_CACHE_SIZE = 200;

function getCachedTranslation(text) {
  const key = `${text}::${translateTarget}`;
  if (translationCache.has(key)) {
    const value = translationCache.get(key);
    // Move to end (most recently used)
    translationCache.delete(key);
    translationCache.set(key, value);
    return value;
  }
  return null;
}

function setCachedTranslation(text, translation) {
  const key = `${text}::${translateTarget}`;
  if (translationCache.size >= MAX_CACHE_SIZE) {
    // Delete oldest entry
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(key, translation);
}

// Cloud translation using Google Translate API (fast, no model loading)
async function cloudTranslate(text, sourceLang, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Translation API error: ${response.status}`);

  const data = await response.json();

  // Google Translate returns nested arrays: [[["translated","original",...],...],...,"en"]
  if (data && data[0]) {
    let translated = '';
    for (const segment of data[0]) {
      if (segment[0]) translated += segment[0];
    }
    return translated;
  }

  throw new Error('Invalid translation response');
}

// Models that support language parameter (Whisper family)
const WHISPER_MODELS = new Set([
  'onnx-community/whisper-tiny',
  'onnx-community/whisper-tiny.en',
  'onnx-community/whisper-base',
  'onnx-community/whisper-base.en',
  'onnx-community/whisper-small',
  'onnx-community/whisper-small.en',
]);

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
  'en-pt': 'Xenova/opus-mt-en-roa',
  'en-it': 'Xenova/opus-mt-en-it',
  'en-tr': 'Xenova/opus-mt-en-trk',
  'en-hi': 'Xenova/opus-mt-en-hi',
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

function isWhisperModel(id) {
  return WHISPER_MODELS.has(id);
}

// Add audio to sliding window buffer for consistent speaker labels
function addToAudioHistory(audio) {
  audioHistory.push(new Float32Array(audio));
  historyTotalLength += audio.length;

  // Keep only last 10 seconds
  while (audioHistory.length > 1 && historyTotalLength - audioHistory[0].length >= SEGMENT_SAMPLES) {
    historyTotalLength -= audioHistory[0].length;
    audioHistory.shift();
  }
}

// Build a 10-second audio window from history (right-justified, zero-padded)
function getAudioWindow() {
  const result = new Float32Array(SEGMENT_SAMPLES);
  const totalLen = Math.min(historyTotalLength, SEGMENT_SAMPLES);
  const offset = SEGMENT_SAMPLES - totalLen;

  let skipSamples = Math.max(0, historyTotalLength - SEGMENT_SAMPLES);
  let writePos = offset;

  for (const chunk of audioHistory) {
    if (skipSamples >= chunk.length) {
      skipSamples -= chunk.length;
      continue;
    }
    const startIdx = skipSamples;
    skipSamples = 0;
    const copyLen = Math.min(chunk.length - startIdx, SEGMENT_SAMPLES - writePos);
    result.set(chunk.subarray(startIdx, startIdx + copyLen), writePos);
    writePos += copyLen;
  }

  return result;
}

// Load the speaker segmentation model
async function loadSegmentationModel() {
  try {
    self.postMessage({
      type: 'progress',
      status: 'loading',
      phase: 'diarization',
      progress: 0,
    });

    const device = await detectDevice();
    segmentationModel = await AutoModelForAudioFrameClassification.from_pretrained(
      'onnx-community/pyannote-segmentation-3.0',
      {
        device,
        dtype: device === 'webgpu' ? 'fp32' : 'q8',
        progress_callback: makeProgressCallback('diarization'),
      }
    );

    console.log('[Worker] Speaker diarization model loaded');
  } catch (error) {
    console.warn('[Worker] Failed to load diarization model:', error);
    segmentationModel = null;
  }
}

// Run speaker diarization on an audio chunk using a sliding window
async function runDiarization(audioData) {
  if (!segmentationModel) return null;

  try {
    // Add chunk to sliding window for cross-chunk label consistency
    addToAudioHistory(audioData);
    const audioWindow = getAudioWindow();

    // Create input tensor [batch=1, samples=160000]
    const input = new Tensor('float32', audioWindow, [1, SEGMENT_SAMPLES]);
    const output = await segmentationModel({ input_values: input });

    const logits = output.logits;
    const numFrames = logits.dims[1];
    const numClasses = logits.dims[2];

    // Current chunk occupies the last audioData.length samples of the window
    const chunkStartSample = SEGMENT_SAMPLES - audioData.length;
    const startFrame = Math.max(0, Math.floor(chunkStartSample * numFrames / SEGMENT_SAMPLES));
    const endFrame = numFrames;

    // Count how many frames each speaker is active
    const speakerCounts = [0, 0, 0]; // speakers 1, 2, 3

    if (numClasses === 7) {
      // Powerset approach (pyannote-segmentation-3.0)
      for (let f = startFrame; f < endFrame; f++) {
        let maxLogit = -Infinity;
        let maxClass = 0;
        for (let c = 0; c < numClasses; c++) {
          const val = logits.data[f * numClasses + c];
          if (val > maxLogit) {
            maxLogit = val;
            maxClass = c;
          }
        }
        const speakers = POWERSET_LABELS[maxClass];
        for (const spk of speakers) {
          speakerCounts[spk - 1]++;
        }
      }
    } else {
      // Multi-label fallback (sigmoid per speaker)
      for (let f = startFrame; f < endFrame; f++) {
        for (let c = 0; c < Math.min(numClasses, 3); c++) {
          if (logits.data[f * numClasses + c] > 0) {
            speakerCounts[c]++;
          }
        }
      }
    }

    // Find dominant speaker
    let dominantSpeaker = 0;
    let maxCount = 0;
    for (let i = 0; i < 3; i++) {
      if (speakerCounts[i] > maxCount) {
        maxCount = speakerCounts[i];
        dominantSpeaker = i + 1;
      }
    }

    if (maxCount === 0) return null;

    console.log(`[Worker] Diarization: Speaker ${dominantSpeaker} (counts: ${speakerCounts.join(', ')})`);
    return dominantSpeaker;
  } catch (error) {
    console.warn('[Worker] Diarization error:', error);
    return null;
  }
}

// Load the ASR model (Moonshine or Whisper) and optionally translation model
async function loadModel(settings) {
  if (isLoading) return;
  isLoading = true;

  modelId = settings.model || modelId;
  language = settings.language || null;
  translateEnabled = settings.translate || false;
  translateTarget = settings.translateTarget || 'he';
  translationMethod = settings.translationMethod || 'cloud';

  self.postMessage({
    type: 'progress',
    status: 'loading',
    phase: 'transcription',
    progress: 0,
  });

  try {
    const device = await detectDevice();
    console.log(`[Worker] Using device: ${device}`);
    console.log(`[Worker] Loading model: ${modelId}`);

    // Load ASR model
    transcriber = await pipeline(
      'automatic-speech-recognition',
      modelId,
      {
        device,
        dtype: device === 'webgpu' ? 'fp32' : 'q8',
        progress_callback: makeProgressCallback('transcription'),
      }
    );

    console.log('[Worker] ASR model loaded');

    // Load speaker diarization model
    await loadSegmentationModel();

    // Load translation model if enabled and using local method
    if (translateEnabled && translationMethod === 'local') {
      await loadTranslationModel();
    } else if (translateEnabled && translationMethod === 'cloud') {
      console.log('[Worker] Using cloud translation (Google Translate) - no model to load');
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
async function loadTranslationModel() {
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
    const transDevice = await detectDevice();
    console.log(`[Worker] Translation model using device: ${transDevice}`);
    translator = await pipeline(
      'translation',
      translationModelId,
      {
        device: transDevice,
        dtype: transDevice === 'webgpu' ? 'fp32' : 'q8',
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
    const startTime = performance.now();

    // Build options based on model type
    const options = {
      return_timestamps: false,
    };

    // Whisper-specific options
    if (isWhisperModel(modelId)) {
      options.chunk_length_s = 30;
      options.stride_length_s = 5;
      if (language) {
        options.language = language;
      }
    }
    // Moonshine doesn't need chunk_length_s — it handles variable-length audio natively

    // Run diarization and transcription in parallel — diarization doesn't block ASR
    const [speaker, result] = await Promise.all([
      runDiarization(audioData),
      transcriber(audioData, options),
    ]);
    const inferenceMs = Math.round(performance.now() - startTime);

    if (!result || !result.text || !result.text.trim()) return;

    const originalText = result.text.trim();

    console.log(`[Worker] Transcribed in ${inferenceMs}ms: "${originalText.substring(0, 50)}..."`);

    // Send original transcription
    self.postMessage({
      type: 'result',
      text: originalText,
      translatedText: null,
      language: result.language || language || 'en',
      isTranslated: false,
      inferenceMs,
      speaker,
    });

    // Translate if enabled
    if (translateEnabled && originalText) {
      // Check cache first
      const cached = getCachedTranslation(originalText);
      if (cached) {
        console.log('[Worker] Translation cache hit');
        self.postMessage({
          type: 'result',
          text: originalText,
          translatedText: cached,
          language: result.language || language || 'en',
          isTranslated: true,
          inferenceMs,
          speaker,
        });
      } else if (translationMethod === 'cloud') {
        // Cloud translation (Google Translate) - fast, no local model needed
        try {
          const transStart = performance.now();
          const sourceLang = result.language || language || 'en';
          const translatedText = await cloudTranslate(originalText, sourceLang, translateTarget);
          const transMs = Math.round(performance.now() - transStart);

          if (translatedText && translatedText.trim()) {
            const trimmed = translatedText.trim();
            setCachedTranslation(originalText, trimmed);
            console.log(`[Worker] Cloud translated in ${transMs}ms`);
            self.postMessage({
              type: 'result',
              text: originalText,
              translatedText: trimmed,
              language: sourceLang,
              isTranslated: true,
              inferenceMs: inferenceMs + transMs,
              speaker,
            });
          }
        } catch (transError) {
          console.error('[Worker] Cloud translation error:', transError);
        }
      } else if (translator) {
        // Local translation (OPUS-MT) - private, no network needed
        try {
          const transStart = performance.now();
          const translation = await translator(originalText, {
            max_length: 200,
          });

          const translatedText =
            translation && translation[0]
              ? translation[0].translation_text
              : null;

          const transMs = Math.round(performance.now() - transStart);

          if (translatedText && translatedText.trim()) {
            const trimmed = translatedText.trim();
            setCachedTranslation(originalText, trimmed);
            console.log(`[Worker] Local translated in ${transMs}ms`);
            self.postMessage({
              type: 'result',
              text: originalText,
              translatedText: trimmed,
              language: result.language || language || 'en',
              isTranslated: true,
              inferenceMs: inferenceMs + transMs,
              speaker,
            });
          }
        } catch (transError) {
          console.error('[Worker] Local translation error:', transError);
        }
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

// Handle messages
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
