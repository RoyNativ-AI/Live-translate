// Offscreen document - captures tab audio with VAD-based chunking for low latency

const SAMPLE_RATE = 16000; // Whisper expects 16kHz audio

// VAD (Voice Activity Detection) configuration
const VAD_FRAME_MS = 30; // Analyze audio in 30ms frames
const VAD_FRAME_SAMPLES = Math.floor(SAMPLE_RATE * VAD_FRAME_MS / 1000);
const SPEECH_THRESHOLD = 0.015; // RMS threshold to detect speech
const SILENCE_DURATION_MS = 400; // Send chunk after 400ms of silence (speech pause)
const MIN_SPEECH_MS = 300; // Minimum speech duration to process
const MAX_CHUNK_MS = 6000; // Force-send chunk after 6 seconds max
const MIN_CHUNK_MS = 500; // Minimum chunk duration to send

let mediaStream = null;
let audioContext = null;
let processor = null;
let worker = null;
let isCapturing = false;
let isWorkerBusy = false;
let pendingChunk = null;

// VAD state
let speechBuffer = []; // Accumulated speech audio frames
let silenceFrameCount = 0; // Consecutive silent frames
let speechFrameCount = 0; // Consecutive speech frames
let isSpeaking = false; // Currently detecting speech
let chunkStartTime = 0; // When current chunk started

// Initialize the Whisper web worker
function initWorker() {
  if (worker) return;

  worker = new Worker(
    new URL('../worker/whisper-worker.js', import.meta.url),
    { type: 'module' }
  );

  worker.onmessage = (event) => {
    const { type, ...data } = event.data;

    switch (type) {
      case 'ready':
        console.log('[Offscreen] Whisper worker ready');
        break;

      case 'progress':
        chrome.runtime.sendMessage({
          type: 'model-progress',
          progress: data.progress,
          status: data.status,
          phase: data.phase,
        });
        break;

      case 'result':
        isWorkerBusy = false;
        if (data.text && data.text.trim()) {
          chrome.runtime.sendMessage({
            type: 'transcription-result',
            text: data.text.trim(),
            translatedText: data.translatedText || null,
            isTranslated: data.isTranslated || false,
            isFinal: true,
            language: data.language,
          });
        }
        // Process pending chunk if any
        if (pendingChunk) {
          const chunk = pendingChunk;
          pendingChunk = null;
          sendToWorker(chunk);
        }
        break;

      case 'partial':
        if (data.text && data.text.trim()) {
          chrome.runtime.sendMessage({
            type: 'transcription-result',
            text: data.text.trim(),
            isFinal: false,
            language: data.language,
          });
        }
        break;

      case 'error':
        isWorkerBusy = false;
        console.error('[Offscreen] Worker error:', data.message);
        // Process pending chunk if any
        if (pendingChunk) {
          const chunk = pendingChunk;
          pendingChunk = null;
          sendToWorker(chunk);
        }
        break;
    }
  };

  // Load the model with settings
  chrome.storage.local.get(
    ['model', 'language', 'translate', 'translateTarget', 'translationMethod'],
    (result) => {
      worker.postMessage({
        type: 'load',
        model: result.model || 'onnx-community/moonshine-tiny-ONNX',
        language: result.language || null,
        translate: result.translate || false,
        translateTarget: result.translateTarget || 'he',
        translationMethod: result.translationMethod || 'cloud',
      });
    }
  );
}

// Calculate RMS energy for a frame of audio
function frameEnergy(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

// Process a single audio frame through VAD
function processVADFrame(frame) {
  const energy = frameEnergy(frame);
  const isSpeechFrame = energy > SPEECH_THRESHOLD;

  if (isSpeechFrame) {
    silenceFrameCount = 0;
    speechFrameCount++;

    if (!isSpeaking && speechFrameCount >= 3) {
      // Speech started (need 3 consecutive frames ~90ms to confirm)
      isSpeaking = true;
      chunkStartTime = Date.now();
    }
  } else {
    speechFrameCount = 0;
    if (isSpeaking) {
      silenceFrameCount++;
    }
  }

  // Accumulate audio while speaking (or about to speak)
  if (isSpeaking || speechFrameCount > 0) {
    speechBuffer.push(new Float32Array(frame));
  }

  const now = Date.now();
  const chunkDuration = now - chunkStartTime;
  const silenceDuration = silenceFrameCount * VAD_FRAME_MS;

  // Decide when to send a chunk
  if (isSpeaking) {
    // Send when: speech pause detected OR max duration reached
    if (silenceDuration >= SILENCE_DURATION_MS && chunkDuration >= MIN_CHUNK_MS) {
      // Speaker paused - send chunk now
      flushSpeechBuffer();
    } else if (chunkDuration >= MAX_CHUNK_MS) {
      // Hit max duration - force send
      flushSpeechBuffer();
    }
  }
}

// Flush the speech buffer and send to worker
function flushSpeechBuffer() {
  if (speechBuffer.length === 0) return;

  // Concatenate all speech frames
  const totalLength = speechBuffer.reduce((sum, buf) => sum + buf.length, 0);
  const totalDurationMs = (totalLength / SAMPLE_RATE) * 1000;

  // Skip if too short
  if (totalDurationMs < MIN_SPEECH_MS) {
    resetVADState();
    return;
  }

  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const buf of speechBuffer) {
    combined.set(buf, offset);
    offset += buf.length;
  }

  console.log(
    `[Offscreen] Sending ${Math.round(totalDurationMs)}ms of speech to Whisper`
  );

  sendToWorker(combined);
  resetVADState();
}

// Send audio to worker (with queue if busy)
function sendToWorker(audioData) {
  if (!worker) return;

  if (isWorkerBusy) {
    // Worker is busy - queue this chunk (replace any previous pending)
    pendingChunk = audioData;
    return;
  }

  isWorkerBusy = true;
  worker.postMessage(
    {
      type: 'transcribe',
      audio: audioData.buffer,
    },
    [audioData.buffer]
  );
}

// Reset VAD state for next utterance
function resetVADState() {
  speechBuffer = [];
  silenceFrameCount = 0;
  speechFrameCount = 0;
  isSpeaking = false;
  chunkStartTime = 0;
}

// Start capturing audio from the tab
async function startCapture(streamId) {
  if (isCapturing) return;

  try {
    initWorker();

    // Get the media stream using the stream ID from tabCapture
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    // Create audio context and processor
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);

    // Use ScriptProcessorNode for capturing raw audio
    // Buffer size matches VAD frame for low-latency processing
    const bufferSize = 4096;
    processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!isCapturing) return;

      const channelData = e.inputBuffer.getChannelData(0);
      const data = new Float32Array(channelData);

      // Process through VAD in frames
      for (let i = 0; i < data.length; i += VAD_FRAME_SAMPLES) {
        const end = Math.min(i + VAD_FRAME_SAMPLES, data.length);
        const frame = data.slice(i, end);
        if (frame.length >= VAD_FRAME_SAMPLES * 0.5) {
          processVADFrame(frame);
        }
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    isCapturing = true;
    resetVADState();

    console.log('[Offscreen] Audio capture started with VAD');
  } catch (error) {
    console.error('[Offscreen] Failed to start capture:', error);
  }
}

// Stop capturing
function stopCapture() {
  isCapturing = false;

  // Flush any remaining speech
  flushSpeechBuffer();

  if (processor) {
    processor.disconnect();
    processor = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (worker) {
    worker.terminate();
    worker = null;
  }

  resetVADState();
  pendingChunk = null;
  isWorkerBusy = false;
  console.log('[Offscreen] Audio capture stopped');
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'start-capture':
      startCapture(message.streamId);
      break;

    case 'stop-capture':
      stopCapture();
      break;
  }
});
