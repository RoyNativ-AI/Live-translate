// Popup script - controls transcription start/stop and settings

const toggleBtn = document.getElementById('toggleBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const modelSelect = document.getElementById('modelSelect');
const langSelect = document.getElementById('langSelect');
const translateToggle = document.getElementById('translateToggle');
const translateTargetSelect = document.getElementById('translateTarget');
const translateSettings = document.getElementById('translateSettings');

let isTranscribing = false;

// Load saved settings
chrome.storage.local.get(
  ['model', 'language', 'translate', 'translateTarget'],
  (result) => {
    if (result.model) modelSelect.value = result.model;
    if (result.language !== undefined) langSelect.value = result.language;
    if (result.translate !== undefined)
      translateToggle.checked = result.translate;
    if (result.translateTarget)
      translateTargetSelect.value = result.translateTarget;
    updateTranslateVisibility();
  }
);

// Save settings on change
modelSelect.addEventListener('change', () => {
  chrome.storage.local.set({ model: modelSelect.value });
});

langSelect.addEventListener('change', () => {
  chrome.storage.local.set({ language: langSelect.value });
});

translateToggle.addEventListener('change', () => {
  chrome.storage.local.set({ translate: translateToggle.checked });
  updateTranslateVisibility();
});

translateTargetSelect.addEventListener('change', () => {
  chrome.storage.local.set({ translateTarget: translateTargetSelect.value });
});

function updateTranslateVisibility() {
  if (translateToggle.checked) {
    translateSettings.classList.add('visible');
  } else {
    translateSettings.classList.remove('visible');
  }
}

// Check current status
chrome.runtime.sendMessage(
  { type: 'get-status', target: 'background' },
  (response) => {
    if (response && response.isTranscribing) {
      setActiveState();
    }
  }
);

// Toggle transcription
toggleBtn.addEventListener('click', async () => {
  if (isTranscribing) {
    stopTranscription();
  } else {
    startTranscription();
  }
});

async function startTranscription() {
  toggleBtn.disabled = true;
  setStatus('loading', 'Starting...');

  try {
    // Get the current active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab) {
      setStatus('error', 'No active tab found');
      toggleBtn.disabled = false;
      return;
    }

    // Save current settings before starting
    chrome.storage.local.set({
      model: modelSelect.value,
      language: langSelect.value,
      translate: translateToggle.checked,
      translateTarget: translateTargetSelect.value,
    });

    // Send start message to background
    chrome.runtime.sendMessage(
      {
        type: 'start-transcription',
        target: 'background',
        tab: { id: tab.id, url: tab.url },
      },
      (response) => {
        if (response && response.success) {
          setActiveState();
        } else {
          setStatus('error', response?.error || 'Failed to start');
          toggleBtn.disabled = false;
        }
      }
    );
  } catch (error) {
    setStatus('error', error.message);
    toggleBtn.disabled = false;
  }
}

function stopTranscription() {
  chrome.runtime.sendMessage(
    {
      type: 'stop-transcription',
      target: 'background',
    },
    (response) => {
      if (response && response.success) {
        setIdleState();
      }
    }
  );
}

function setActiveState() {
  isTranscribing = true;
  toggleBtn.disabled = false;
  toggleBtn.className = 'btn btn-stop';
  toggleBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2"/>
    </svg>
    Stop Transcription
  `;
  setStatus('active', 'Transcribing...');
  modelSelect.disabled = true;
  langSelect.disabled = true;
  translateToggle.disabled = true;
  translateTargetSelect.disabled = true;
}

function setIdleState() {
  isTranscribing = false;
  toggleBtn.disabled = false;
  toggleBtn.className = 'btn btn-start';
  toggleBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
      <circle cx="12" cy="12" r="4"/>
    </svg>
    Start Transcription
  `;
  setStatus('idle', 'Ready');
  progressBar.classList.remove('visible');
  modelSelect.disabled = false;
  langSelect.disabled = false;
  translateToggle.disabled = false;
  translateTargetSelect.disabled = false;
}

function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state === 'active') statusDot.classList.add('active');
  if (state === 'loading') statusDot.classList.add('loading');
  if (state === 'error') statusDot.classList.add('error');
  statusText.textContent = text;
}

// Listen for model loading progress
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'model-progress' && message.target === 'popup') {
    const { status, progress, phase } = message;

    switch (status) {
      case 'downloading': {
        progressBar.classList.add('visible');
        progressFill.style.width = `${progress}%`;
        const phaseLabel =
          phase === 'translation' ? 'translation' : 'transcription';
        setStatus(
          'loading',
          `Downloading ${phaseLabel} model... ${Math.round(progress)}%`
        );
        break;
      }

      case 'loading': {
        progressBar.classList.add('visible');
        const loadLabel =
          phase === 'translation' ? 'translation' : 'transcription';
        setStatus('loading', `Loading ${loadLabel} model...`);
        break;
      }

      case 'ready':
        progressBar.classList.remove('visible');
        setStatus('active', 'Transcribing...');
        break;
    }
  }
});
