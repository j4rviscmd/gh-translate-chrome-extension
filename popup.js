// BCP 47 codes supported by Chrome's Translator API (Chrome 138+).
// Reference: https://developer.chrome.com/docs/ai/translator-api
const LANGUAGES = [
  ['ar', 'Arabic'], ['bg', 'Bulgarian'], ['bn', 'Bengali'], ['cs', 'Czech'],
  ['da', 'Danish'], ['de', 'German'], ['el', 'Greek'], ['en', 'English'],
  ['es', 'Spanish'], ['fi', 'Finnish'], ['fr', 'French'], ['he', 'Hebrew'],
  ['hi', 'Hindi'], ['hr', 'Croatian'], ['hu', 'Hungarian'], ['id', 'Indonesian'],
  ['it', 'Italian'], ['ja', 'Japanese'], ['kn', 'Kannada'], ['ko', 'Korean'],
  ['lt', 'Lithuanian'], ['mr', 'Marathi'], ['nl', 'Dutch'], ['no', 'Norwegian'],
  ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sk', 'Slovak'], ['sl', 'Slovenian'], ['sv', 'Swedish'], ['ta', 'Tamil'],
  ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'], ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
];

// normalizeSettings comes from shared.js, loaded as a classic script before this file.

const $ = (id) => document.getElementById(id);

const sourceSelect = $('source-language');
const targetSelect = $('target-language');
const toggleButton = $('toggle-translate');
const autoCheckbox = $('auto-translate');
const areaCheckboxes = document.querySelectorAll('input[data-area]');
const statusEl = $('status');

function populateSelects(settings) {
  for (const select of [sourceSelect, targetSelect]) {
    select.innerHTML = '';
    for (const [code, name] of LANGUAGES) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${name} (${code})`;
      select.appendChild(option);
    }
  }
  sourceSelect.value = settings.source;
  targetSelect.value = settings.target;
}

function collectSettings() {
  const areas = {};
  for (const checkbox of areaCheckboxes) {
    areas[checkbox.dataset.area] = checkbox.checked;
  }
  return {
    source: sourceSelect.value,
    target: targetSelect.value,
    auto: autoCheckbox.checked,
    areas,
  };
}

async function saveSettings() {
  await chrome.storage.sync.set(collectSettings());
  sendMessageToTab({ type: 'settings-changed' });
}

async function sendMessageToTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Content script not injected (not a GitHub page, or page not loaded yet)
    return null;
  }
}

function setStatus(text) {
  statusEl.hidden = !text;
  statusEl.textContent = text;
}

function renderToggle(response) {
  if (!response || !response.supported) {
    toggleButton.disabled = true;
    toggleButton.textContent = 'Translate';
    setStatus('Open a GitHub issue page to translate.');
    return;
  }
  toggleButton.disabled = false;
  toggleButton.textContent = response.translated ? 'Show original' : 'Translate';
  setStatus('');
}

toggleButton.addEventListener('click', async () => {
  toggleButton.disabled = true;
  const response = await sendMessageToTab({ type: 'toggle-translate' });
  renderToggle(response);
  toggleButton.disabled = false;
});

sourceSelect.addEventListener('change', saveSettings);
targetSelect.addEventListener('change', saveSettings);
autoCheckbox.addEventListener('change', saveSettings);
for (const checkbox of areaCheckboxes) {
  checkbox.addEventListener('change', saveSettings);
}

(async () => {
  const settings = normalizeSettings(await chrome.storage.sync.get(null));
  populateSelects(settings);
  autoCheckbox.checked = settings.auto;
  for (const checkbox of areaCheckboxes) {
    checkbox.checked = settings.areas[checkbox.dataset.area];
  }

  renderToggle(await sendMessageToTab({ type: 'get-state' }));
})();
