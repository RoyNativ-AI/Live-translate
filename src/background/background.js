// Background service worker - manages tab capture and offscreen document

let isTranscribing = false;
let currentTabId = null;

// Supported call platforms
const SUPPORTED_URLS = [
  'meet.google.com',
  'zoom.us',
  'web.whatsapp.com',
  'webex.com',
  'teams.microsoft.com',
];

function isSupportedUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return SUPPORTED_URLS.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

// Create offscreen document for audio processing
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for live transcription',
  });
}

async function removeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// Start transcription for the active tab
async function startTranscription(tab) {
  if (isTranscribing) {
    return { success: false, error: 'Already transcribing' };
  }

  try {
    // Get the media stream ID for the tab
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tab.id },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        }
      );
    });

    // Create offscreen document
    await ensureOffscreenDocument();

    // Send the stream ID to the offscreen document
    chrome.runtime.sendMessage({
      type: 'start-capture',
      target: 'offscreen',
      streamId: streamId,
      tabId: tab.id,
    });

    isTranscribing = true;
    currentTabId = tab.id;

    // Update icon to show active state
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Stop transcription
async function stopTranscription() {
  if (!isTranscribing) {
    return { success: false, error: 'Not transcribing' };
  }

  try {
    // Tell offscreen document to stop
    chrome.runtime.sendMessage({
      type: 'stop-capture',
      target: 'offscreen',
    });

    // Clean up offscreen document
    await removeOffscreenDocument();

    isTranscribing = false;
    currentTabId = null;

    // Update icon
    chrome.action.setBadgeText({ text: '' });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    switch (message.type) {
      case 'start-transcription':
        startTranscription(message.tab).then(sendResponse);
        return true; // Async response

      case 'stop-transcription':
        stopTranscription().then(sendResponse);
        return true;

      case 'get-status':
        sendResponse({
          isTranscribing,
          currentTabId,
        });
        return false;
    }
  }

  // Forward transcription results to the content script
  if (message.type === 'transcription-result' && currentTabId) {
    chrome.tabs.sendMessage(currentTabId, {
      type: 'transcription-result',
      text: message.text,
      translatedText: message.translatedText || null,
      isTranslated: message.isTranslated || false,
      isFinal: message.isFinal,
      language: message.language,
      speaker: message.speaker || null,
    });
  }

  // Forward model loading progress to popup
  if (message.type === 'model-progress') {
    // Broadcast to all extension views
    chrome.runtime.sendMessage({
      type: 'model-progress',
      target: 'popup',
      progress: message.progress,
      status: message.status,
    }).catch(() => {});
  }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId) {
    stopTranscription();
  }
});
