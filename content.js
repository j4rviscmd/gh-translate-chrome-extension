// Translates GitHub issue pages with Chrome's built-in Translator API (Chrome 138+).
// Scope: issue detail pages only for now. /pull/ support is a future task (see issue #1).

const ISSUE_DETAIL_PATTERN = /\/issues\/\d+/;

// Selectors verified against GitHub's React issue pages (2026-09).
// Old classes (.js-issue-title / .comment-body / .IssueLabel) no longer exist;
// data-testid hooks are the stable contract.
// stickyTitle: the sticky header title, mounted by React only after scrolling.
const AREA_SELECTORS = {
  title: ['[data-testid="issue-header"] h1', '[data-testid="issue-title-sticky"]'],
  body: ['.markdown-body'],
};

function activeSelectors() {
  return Object.entries(AREA_SELECTORS)
    .filter(([area]) => settings.areas[area])
    .flatMap(([, selectors]) => selectors);
}

// DEFAULT_SETTINGS and normalizeSettings come from shared.js (loaded first via manifest).

const INPUT_DEBOUNCE_MS = 600;

let settings = structuredClone(DEFAULT_SETTINGS);
let translated = false;
let translating = false;

// Original nodeValue per translated Text node. WeakMap so detached nodes are GC'd.
const originals = new WeakMap();

// Cache of Translator.create() promises, keyed "src->tgt".
const translators = new Map();

let panelButton, panel, panelTextarea, panelOutput, copyButton, statusEl;
let inputTimer;

function isIssueDetail() {
  return ISSUE_DETAIL_PATTERN.test(location.pathname);
}

async function loadSettings() {
  settings = normalizeSettings(await chrome.storage.sync.get(null));
}

async function getTranslator(source, target) {
  const key = `${source}->${target}`;
  if (!translators.has(key)) {
    // Only show download progress when the language pack is not cached yet;
    // Chrome fires downloadprogress events even for available packs.
    const availability = await Translator.availability({
      sourceLanguage: source,
      targetLanguage: target,
    });
    const showProgress = availability !== 'available';
    const created = Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          if (showProgress) {
            showStatus(`Downloading language pack… ${Math.round(e.loaded * 100)}%`);
          }
        });
      },
    });
    translators.set(key, created);
    created.catch(() => translators.delete(key));
  }
  return translators.get(key);
}

function collectTextNodes(element, out) {
  for (const child of element.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      // Code blocks and inline code are excluded from translation.
      if (child.tagName !== 'PRE' && child.tagName !== 'CODE') collectTextNodes(child, out);
    } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim()) {
      out.push(child);
    }
  }
}

function collectTargetNodes(selectors = activeSelectors()) {
  const nodes = [];
  const selector = selectors.join(',');
  if (selector) {
    for (const element of document.querySelectorAll(selector)) {
      collectTextNodes(element, nodes);
    }
  }
  return nodes;
}

async function translateNodes(nodes) {
  if (!nodes.length) return;
  const translator = await getTranslator(settings.source, settings.target);
  for (const node of nodes) {
    if (originals.has(node)) continue;
    const result = await translator.translate(node.nodeValue);
    originals.set(node, node.nodeValue);
    node.nodeValue = result;
  }
}

async function translatePage() {
  if (translating || translated) return;
  if (!('Translator' in window)) {
    showStatus('Translator API is not available in this browser.');
    return;
  }
  translating = true;
  try {
    showStatus('Translating…');
    await translateNodes(collectTargetNodes());
    translated = true;
    hideStatus();
  } catch (err) {
    console.warn('[GitHub Translate]', err);
    if (isRetryableError(err)) {
      // Translator.create() needs a user gesture until the language pack is
      // downloaded, and first-time downloads can fail transiently;
      // retry automatically on the first interaction.
      showStatus('Click or press a key to translate');
      queueTranslateOnActivation();
    } else {
      showStatus(`Translation failed: ${err.message}`);
    }
  } finally {
    translating = false;
  }
  // Why: the rerun's translatePage() reaches the drain below on its own run;
  // falling through here would interleave a second drain with it.
  if (applyRerun()) return;
  // Comments that arrived mid-run were queued; translate them now.
  if (translated && pendingComments.length) drainPendingComments();
}

function isRetryableError(err) {
  return (
    err?.name === 'NotAllowedError' ||
    err?.name === 'AbortError' ||
    /download/i.test(err?.message ?? '')
  );
}

let activationArmed = false;

function queueTranslateOnActivation() {
  if (activationArmed) return;
  activationArmed = true;
  const onActivate = () => {
    activationArmed = false;
    removeEventListener('click', onActivate);
    removeEventListener('keydown', onActivate);
    // Manual toggles reach this retry path too, so settings.auto must not gate it.
    if (!translated) translatePage();
  };
  addEventListener('click', onActivate);
  addEventListener('keydown', onActivate);
}

// Lazy-loaded comments (scroll pagination) are translated automatically while active.
const pendingComments = [];

async function drainPendingComments() {
  if (!pendingComments.length) return;
  translating = true;
  try {
    showStatus('Translating…');
    while (pendingComments.length) {
      const elements = pendingComments.splice(0);
      const nodes = [];
      for (const element of elements) collectTextNodes(element, nodes);
      await translateNodes(nodes);
    }
    hideStatus();
  } catch (err) {
    showStatus(`Translation failed: ${err.message}`);
  } finally {
    translating = false;
  }
  // Why: this drain is a run that can be in flight when settings change, so
  // the rerun flag must be consumed on this path too — otherwise the pending
  // rerun never fires until some later run happens to finish.
  applyRerun();
}

// Set when settings change mid-run: once the current translation finishes,
// restore and re-translate with the new settings.
let rerunOnFinish = false;

function applyRerun() {
  if (!rerunOnFinish) return false;
  rerunOnFinish = false;
  // Why: restorePage() must run first — it resets `translated`, and
  // translatePage() early-returns while `translated` is still true, so
  // swapping the two lines would silently skip the re-translate.
  restorePage();
  translatePage();
  return true;
}

// Mutations inside our own UI (status toasts, panel) must not re-trigger this
// observer: showStatus()/panel updates are childList mutations under body and
// would otherwise start an infinite observer-drain loop that freezes the page.
// Catches elements React mounts after initial render: lazy-loaded comments
// (.markdown-body) and the sticky header title (issue-title-sticky).
const observer = new MutationObserver((mutations) => {
  handlePossibleUrlChange();
  if (!settings.areas.body && !settings.areas.title) return;
  if (!translated && !translating) return;
  const selector = activeSelectors().join(',');
  let added = false;
  for (const mutation of mutations) {
    if (mutation.target.closest?.('#ght-panel-button, #ght-panel, #ght-status')) continue;
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches(selector)) pendingComments.push(node);
      else pendingComments.push(...node.querySelectorAll(selector));
      added = true;
    }
  }
  if (added && !translating) drainPendingComments();
});

function restorePage() {
  // Walk ALL selectors, not just active areas: an area disabled mid-run
  // must still get its already-translated nodes restored (and their
  // originals entries dropped, or re-enabling later would skip them).
  const allSelectors = Object.values(AREA_SELECTORS).flat();
  for (const node of collectTargetNodes(allSelectors)) {
    const original = originals.get(node);
    if (original !== undefined) {
      node.nodeValue = original;
      originals.delete(node);
    }
  }
  translated = false;
  hideStatus();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'get-state') {
    sendResponse({ supported: isIssueDetail(), translated });
    return false;
  }
  if (message.type === 'toggle-translate') {
    if (!isIssueDetail()) {
      sendResponse({ supported: false, translated: false });
    } else if (translated) {
      restorePage();
      sendResponse({ supported: true, translated: false });
    } else {
      translatePage().then(() => sendResponse({ supported: true, translated }));
      return true; // async response
    }
    return false;
  }
  if (message.type === 'settings-changed') {
    const wasTranslated = translated;
    if (wasTranslated) restorePage();
    loadSettings().then(() => {
      if (translating) {
        // A run is in flight with the old settings; redo it when it finishes.
        rerunOnFinish = true;
        return;
      }
      // Re-translate with the new pair when the page was already translated.
      if (wasTranslated) translatePage();
    });
    return false;
  }
});

// --- Bottom-right input helper: type in your language, get translated text ---

function showStatus(text) {
  if (!statusEl) return; // turbo:load can fire before buildUI
  statusEl.textContent = text;
  statusEl.hidden = false;
}

function hideStatus() {
  if (!statusEl) return;
  statusEl.hidden = true;
}

let requestSeq = 0;

async function translatePanelInput() {
  const text = panelTextarea.value.trim();
  const seq = ++requestSeq;
  if (!text) {
    panelOutput.textContent = '';
    return;
  }
  panelOutput.textContent = '…';
  try {
    // Reverse direction: user language -> page language.
    const translator = await getTranslator(settings.target, settings.source);
    // Translator.translate() collapses newlines, so translate line by line.
    const lines = [];
    for (const line of text.split('\n')) {
      lines.push(line.trim() ? await translator.translate(line) : line);
    }
    if (seq !== requestSeq) return; // a newer input superseded this request
    panelOutput.textContent = lines.join('\n');
  } catch (err) {
    if (seq !== requestSeq) return;
    panelOutput.textContent = `Translation failed: ${err.message}`;
  }
}

function buildUI() {
  panelButton = document.createElement('button');
  panelButton.id = 'ght-panel-button';
  panelButton.type = 'button';
  panelButton.title = 'Translation input';
  panelButton.textContent = '🌐';

  panel = document.createElement('div');
  panel.id = 'ght-panel';

  panelTextarea = document.createElement('textarea');
  panelTextarea.rows = 8;
  panelTextarea.placeholder = 'Type in your language…';

  panelOutput = document.createElement('div');
  panelOutput.id = 'ght-panel-output';

  copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'Copy';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.id = 'ght-panel-close';
  closeButton.textContent = '×';

  panel.append(panelTextarea, panelOutput, copyButton, closeButton);
  document.body.append(panelButton, panel);

  statusEl = document.createElement('div');
  statusEl.id = 'ght-status';
  statusEl.hidden = true;
  document.body.append(statusEl);

  panelButton.addEventListener('click', () => panel.classList.toggle('open'));
  closeButton.addEventListener('click', () => panel.classList.remove('open'));
  panelTextarea.addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(translatePanelInput, INPUT_DEBOUNCE_MS);
  });
  copyButton.addEventListener('click', async () => {
    const text = panelOutput.textContent;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    copyButton.textContent = 'Copied!';
    setTimeout(() => {
      copyButton.textContent = 'Copy';
    }, 1500);
  });
}

// --- Page lifecycle ---

// Translating while GitHub's React is still hydrating breaks the page render
// (content never loads), so auto-translate waits for the DOM to settle:
// START after SETTLE_QUIET_MS with no mutations, or SETTLE_MAX_MS at worst.
const SETTLE_QUIET_MS = 800;
const SETTLE_MAX_MS = 5000;
let autoTimer;

const settleObserver = new MutationObserver(() => {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(tryAutoTranslate, SETTLE_QUIET_MS);
});

function tryAutoTranslate() {
  settleObserver.disconnect();
  clearTimeout(autoTimer);
  if (settings.auto && !translated && isIssueDetail()) translatePage();
}

function scheduleAutoTranslate() {
  settleObserver.disconnect();
  clearTimeout(autoTimer);
  settleObserver.observe(document.body, { childList: true, subtree: true });
  autoTimer = setTimeout(tryAutoTranslate, SETTLE_QUIET_MS);
  setTimeout(tryAutoTranslate, SETTLE_MAX_MS); // hard cap
}

function onPageChange() {
  const issuePage = isIssueDetail();
  document.body.classList.toggle('ght-issue-page', issuePage);
  if (!issuePage) {
    panel?.classList.remove('open');
    hideStatus();
  }
  // New DOM after navigation: old Text nodes (and their originals) are gone.
  translated = false;
  if (issuePage) scheduleAutoTranslate();
}

// GitHub's React issue UI no longer fires turbo:load on soft navigation,
// so URL changes are detected via the Navigation API and, as a fallback,
// at the top of the MutationObserver callback.
// Compare pathname+search only: same-document hash jumps (e.g. permalinks
// like #issuecomment-...) must not reset the translation state.
function currentPath() {
  return location.pathname + location.search;
}

let lastPath = currentPath();

function handlePossibleUrlChange() {
  const current = currentPath();
  if (current !== lastPath) {
    lastPath = current;
    onPageChange();
  }
}

if ('navigation' in window) {
  navigation.addEventListener('navigatesuccess', handlePossibleUrlChange);
}

document.addEventListener('turbo:load', () => {
  lastPath = currentPath();
  onPageChange();
});

// Turbo caches the DOM snapshot on navigation; restore originals so a cached
// translated page cannot come back without its WeakMap originals.
document.addEventListener('turbo:before-cache', () => {
  if (translated) restorePage();
});

loadSettings().then(() => {
  buildUI();
  observer.observe(document.body, { childList: true, subtree: true });
  onPageChange();
});
