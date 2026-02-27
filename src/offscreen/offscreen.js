// Offscreen document - captures tab audio and processes it into chunks for Whisper

const SAMPLE_RATE = 16000; // Whisper expects 16kHz audio
const CHUNK_DURATION = 5; // Process 5-second chunks
const CHUNK_OVERLAP = 0.5; // 0.5 second overlap between chunks
const SILENCE_THRESHOLD = 0.01; // RMS threshold for silence detection
const MIN_AUDIO_DURATION = 1.0; // Minimum seconds of non-silent audio to process

let mediaStream = null;
let audioContext = null;
let processor = null;
let worker = null;
let audioBuffer = [];
let isCapturing = false;
let processingTimer = null;

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
        console.error('[Offscreen] Worker error:', data.message);
        break;
    }
  };

  // Load the model with settings
  chrome.storage.local.get(
    ['model', 'language', 'translate', 'translateTarget'],
    (result) => {
      worker.postMessage({
        type: 'load',
        model: result.model || 'onnx-community/whisper-tiny',
        language: result.language || null,
        translate: result.translate || false,
        translateTarget: result.translateTarget || 'he',
      });
    }
  );
}

// Calculate RMS (root mean square) of audio data for silence detection
function calculateRMS(audioData) {
  let sum = 0;
  for (let i = 0; i < audioData.length; i++) {
    sum += audioData[i] * audioData[i];
  }
  return Math.sqrt(sum / audioData.length);
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
    // (AudioWorklet would be better but adds complexity for extensions)
    const bufferSize = 4096;
    processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!isCapturing) return;

      const channelData = e.inputBuffer.getChannelData(0);
      // Copy the data (it gets reused)
      audioBuffer.push(new Float32Array(channelData));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    isCapturing = true;
    audioBuffer = [];

    // Process audio in regular intervals
    processingTimer = setInterval(processAudioChunk, CHUNK_DURATION * 1000);

    console.log('[Offscreen] Audio capture started');
  } catch (error) {
    console.error('[Offscreen] Failed to start capture:', error);
  }
}

// Process accumulated audio buffer
function processAudioChunk() {
  if (!isCapturing || audioBuffer.length === 0 || !worker) return;

  // Concatenate all buffered audio
  const totalLength = audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const buf of audioBuffer) {
    combined.set(buf, offset);
    offset += buf.length;
  }

  // Keep overlap for next chunk
  const overlapSamples = Math.floor(CHUNK_OVERLAP * SAMPLE_RATE);
  if (combined.length > overlapSamples) {
    audioBuffer = [combined.slice(combined.length - overlapSamples)];
  } else {
    audioBuffer = [];
  }

  // Check if there's enough non-silent audio
  const rms = calculateRMS(combined);
  if (rms < SILENCE_THRESHOLD) {
    return; // Skip silent chunks
  }

  const minSamples = MIN_AUDIO_DURATION * SAMPLE_RATE;
  if (combined.length < minSamples) {
    return; // Too short to transcribe
  }

  // Send to worker for transcription
  worker.postMessage(
    {
      type: 'transcribe',
      audio: combined.buffer,
    },
    [combined.buffer]
  );
}

// Stop capturing
function stopCapture() {
  isCapturing = false;

  if (processingTimer) {
    clearInterval(processingTimer);
    processingTimer = null;
  }

  // Process any remaining audio
  processAudioChunk();

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

  audioBuffer = [];
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
