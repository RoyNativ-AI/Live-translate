// Content script - displays live transcription overlay on call pages

(function () {
  'use strict';

  const OVERLAY_ID = 'live-transcribe-overlay';
  const CONTAINER_ID = 'live-transcribe-container';
  const MAX_LINES = 5;
  const FADE_TIMEOUT = 10000; // Fade old lines after 10 seconds

  let overlay = null;
  let container = null;
  let lines = [];
  let isMinimized = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  function createOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;

    // Header with controls
    const header = document.createElement('div');
    header.className = 'lt-header';

    const title = document.createElement('span');
    title.className = 'lt-title';
    title.textContent = 'Live Transcribe';

    const controls = document.createElement('div');
    controls.className = 'lt-controls';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'lt-btn';
    minimizeBtn.innerHTML = '&#x2015;';
    minimizeBtn.title = 'Minimize';
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMinimize();
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'lt-btn lt-btn-close';
    closeBtn.innerHTML = '&#x2715;';
    closeBtn.title = 'Close overlay';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeOverlay();
    });

    controls.appendChild(minimizeBtn);
    controls.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(controls);

    // Transcription container
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.className = 'lt-content';

    // Empty state
    const empty = document.createElement('div');
    empty.className = 'lt-empty';
    empty.textContent = 'Waiting for speech...';
    container.appendChild(empty);

    overlay.appendChild(header);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    // Make draggable
    setupDrag(header);
  }

  function setupDrag(handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('lt-btn')) return;
      isDragging = true;
      const rect = overlay.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      overlay.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffset.x;
      const y = e.clientY - dragOffset.y;
      overlay.style.left = x + 'px';
      overlay.style.top = y + 'px';
      overlay.style.bottom = 'auto';
      overlay.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        overlay.style.transition = '';
      }
    });
  }

  function toggleMinimize() {
    isMinimized = !isMinimized;
    if (container) {
      container.style.display = isMinimized ? 'none' : 'block';
    }
  }

  function removeOverlay() {
    if (overlay) {
      overlay.remove();
      overlay = null;
      container = null;
      lines = [];
    }
  }

  function addTranscriptionLine(text, isFinal, translatedText, isTranslated) {
    if (!container) return;

    // Remove empty state message
    const empty = container.querySelector('.lt-empty');
    if (empty) empty.remove();

    // If this is a translated update for existing line, update the translation
    if (isTranslated && lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.text === text) {
        // Add or update translation to existing line
        let transEl = lastLine.element.querySelector('.lt-translation');
        if (!transEl) {
          transEl = document.createElement('div');
          transEl.className = 'lt-translation';
          lastLine.element.appendChild(transEl);
        }
        transEl.textContent = translatedText;
        transEl.dir = isRTL(translatedText) ? 'rtl' : 'ltr';
        return;
      }
    }

    if (!isFinal && !isTranslated && lines.length > 0) {
      // Update the last partial line
      const lastLine = lines[lines.length - 1];
      if (lastLine && !lastLine.isFinal) {
        lastLine.element.querySelector('.lt-original').textContent = text;
        lastLine.text = text;
        return;
      }
    }

    // Create new line element
    const lineEl = document.createElement('div');
    lineEl.className = 'lt-line' + (isFinal ? ' lt-final' : ' lt-partial');

    // Original text
    const originalEl = document.createElement('div');
    originalEl.className = 'lt-original';
    originalEl.textContent = text;
    originalEl.dir = isRTL(text) ? 'rtl' : 'ltr';
    lineEl.appendChild(originalEl);

    // Translation (if available)
    if (translatedText) {
      const transEl = document.createElement('div');
      transEl.className = 'lt-translation';
      transEl.textContent = translatedText;
      transEl.dir = isRTL(translatedText) ? 'rtl' : 'ltr';
      lineEl.appendChild(transEl);
    }

    const lineObj = {
      element: lineEl,
      text: text,
      isFinal: isFinal,
      timestamp: Date.now(),
    };

    lines.push(lineObj);
    container.appendChild(lineEl);

    // Limit number of visible lines
    while (lines.length > MAX_LINES) {
      const old = lines.shift();
      old.element.classList.add('lt-fade-out');
      setTimeout(() => old.element.remove(), 500);
    }

    // Auto-scroll
    container.scrollTop = container.scrollHeight;

    // Set up fade for final lines
    if (isFinal) {
      setTimeout(() => {
        lineEl.classList.add('lt-fading');
      }, FADE_TIMEOUT);
    }
  }

  // Detect RTL text (Hebrew, Arabic, etc.)
  function isRTL(text) {
    // Check for RTL characters (Hebrew, Arabic, Farsi, Urdu)
    const rtlRegex = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\uFB50-\uFDFF\uFE70-\uFEFF]/;
    return rtlRegex.test(text);
  }

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'transcription-result') {
      if (!overlay) {
        createOverlay();
      }
      addTranscriptionLine(
        message.text,
        message.isFinal,
        message.translatedText,
        message.isTranslated
      );
    }
  });

  // Create overlay immediately (will show "waiting" state)
  createOverlay();
})();
