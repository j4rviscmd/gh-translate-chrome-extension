// Translates GitHub issue/PR pages and repository READMEs with Chrome's
// built-in Translator API (Chrome 138+).
// Scope: issue details, PR conversation tabs, and the README rendered on the
// repository overview.

// Anchored patterns: details and list pages are distinct surfaces; PR detail
// matches the conversation tab only (/files, /commits subpaths are out of
// scope by design). The readme pattern also matches two-segment non-repo
// pages (/orgs/x etc.), which is harmless: they render no article.markdown-body.
const DETAIL_PATTERNS = {
  issue: /\/issues\/\d+\/?$/,
  pull: /\/pull\/\d+\/?$/,
  // Note: relies on GitHub's 2026-09 overview DOM, where the old #readme box
  // is gone and the README renders as the page's only article.markdown-body
  // (live-measured 2026-09) — a GitHub DOM change makes readme translation
  // silently stop or over-match.
  readme: /^\/[^/]+\/[^/]+(\/tree\/.*)?\/?$/,
};

const LIST_PATTERNS = {
  issue: /\/issues\/?$/,
  pull: /\/pulls\/?$/,
};

function currentPage() {
  for (const page of Object.keys(DETAIL_PATTERNS)) {
    if (DETAIL_PATTERNS[page].test(location.pathname)) return page;
    if (LIST_PATTERNS[page]?.test(location.pathname)) return page;
  }
  return null;
}

// Composer pages (new issue, new PR) have no translation targets, but the
// bottom-right input helper is shown there for drafting text.
// Why: /compare/ is anchored to owner/repo scope so code-view paths that
// merely contain a "compare" directory don't show the helper button.
const COMPOSER_PATTERNS = [/\/issues\/new(\/choose)?\/?$/, /^\/[^/]+\/[^/]+\/compare\//];

// The helper is for drafting comments, so readme pages (no comment box)
// only get the status toast, not the button/panel. settings.helper hides
// the button everywhere.
function hasHelperUI() {
  if (!settings.helper) return false;
  const page = currentPage();
  return (page !== null && page !== 'readme') || COMPOSER_PATTERNS.some((p) => p.test(location.pathname));
}

// Selectors verified against GitHub's React issue/PR pages (2026-09).
// main h1: the single page title on both detail surfaces, scoped to <main>
// so Primer dialog titles (also rendered as h1) are never picked up;
// .markdown-title: the sticky header title mounted after scrolling
// (bdi on issues, span on PRs); .markdown-body: issue/PR descriptions and
// comments. Diff tables on the PR files tab live outside these selectors,
// so code is naturally excluded.
const AREA_SELECTORS = {
  title: ['main h1', '.markdown-title'],
  body: ['.markdown-body'],
};

// On list pages only the row title links are translated; the h1 ("All
// issues" etc.) is UI chrome and stays untranslated.
const LIST_SELECTORS = {
  issue: 'a[data-hovercard-type="issue"]',
  pull: 'a[data-hovercard-type="pull_request"]',
};

function activeSelectors() {
  const page = currentPage();
  if (!page) return [];
  if (LIST_PATTERNS[page]?.test(location.pathname)) {
    return settings.areas[page].list ? [LIST_SELECTORS[page]] : [];
  }
  return Object.entries(AREA_SELECTORS)
    .filter(([area]) => settings.areas[page][area])
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

// LanguageDetector (Chrome 138+, same gate as Translator) skips text that is
// already in the output language: feeding Japanese content through an
// en->ja Translator mangles it.
let detectorPromise = null;

async function getDetector() {
  if (!('LanguageDetector' in window)) return null;
  if (!detectorPromise) {
    detectorPromise = LanguageDetector.create();
    // Why: a rejected promise must not stay cached — translatePage's
    // activation-retry path re-enters here after a click, and needs a fresh
    // create() (same pattern as the translators cache above).
    detectorPromise.catch(() => (detectorPromise = null));
  }
  return detectorPromise;
}

// Detection needs a few characters to be reliable; shorter text goes to the
// translator as-is. Primary-subtag match: a 'zh' detection satisfies a
// 'zh-Hant' target, so Simplified text skips too — Hans->Hant conversion is
// out of scope.
// Script heuristic used when the detection model is unavailable
// (LanguageDetector.availability() === 'unavailable' happens on real Chrome
// installs; create() then rejects with NotSupportedError). Only languages
// whose script is self-identifying are covered — Latin-script pairs fall
// through to translation there.
// ponytail: CJK han ranges are shared, so zh text against a ja target (or a
// kana-free ja node) can be mis-skipped; acceptable until a real complaint,
// the detector path disambiguates when the model exists.
const SCRIPT_RANGES = {
  ar: /[\u0600-\u06FF]/,
  bg: /[\u0400-\u04FF]/,
  el: /[\u0370-\u03FF]/,
  he: /[\u0590-\u05FF]/,
  hi: /[\u0900-\u097F]/,
  mr: /[\u0900-\u097F]/,
  ja: /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/,
  kn: /[\u0C80-\u0CFF]/,
  ko: /[\uAC00-\uD7AF]/,
  ru: /[\u0400-\u04FF]/,
  ta: /[\u0B80-\u0BFF]/,
  te: /[\u0C00-\u0C7F]/,
  th: /[\u0E00-\u0E7F]/,
  uk: /[\u0400-\u04FF]/,
  zh: /[\u3400-\u4DBF\u4E00-\u9FFF]/,
};

function hasScript(text, lang) {
  return SCRIPT_RANGES[primarySubtag(lang)]?.test(text) ?? false;
}

// ponytail: DETECT_MIN_CHARS=4 skips detection on very short nodes; lower it
// if mistranslated 2-3 char CJK nodes become a real complaint.
const DETECT_MIN_CHARS = 4;
const DETECT_CONFIDENCE = 0.5;

function primarySubtag(code) {
  return code.split('-')[0].toLowerCase();
}

// True when text is confidently `lang` and must not be re-translated.
// A missing detector falls back to the script heuristic; retryable errors
// bubble up so translatePage's activation-retry path can download the
// detection model; any other failure returns false (translate as-is).
async function isLanguage(text, lang, detector) {
  if (!detector) return hasScript(text, lang);
  if (text.trim().length < DETECT_MIN_CHARS) return false;
  try {
    const [top] = await detector.detect(text);
    if (!top) return false;
    return (
      primarySubtag(top.detectedLanguage) === primarySubtag(lang) &&
      top.confidence >= DETECT_CONFIDENCE
    );
  } catch (err) {
    if (isRetryableError(err)) throw err;
    console.warn('[GitHub Translate] language detection failed', err);
    return false;
  }
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
  // Retryable creation errors bubble to translatePage's activation-retry
  // path; anything else degrades to translating without language skips.
  const detector = await getDetector().catch((err) => {
    if (isRetryableError(err)) throw err;
    console.warn('[GitHub Translate] LanguageDetector unavailable', err);
    return null;
  });
  for (const node of nodes) {
    if (originals.has(node)) continue;
    if (await isLanguage(node.nodeValue, settings.target, detector)) continue;
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
// (.markdown-body) and the sticky header title (.markdown-title).
const observer = new MutationObserver((mutations) => {
  handlePossibleUrlChange();
  if (!translated && !translating) return;
  const selector = activeSelectors().join(',');
  if (!selector) return; // no active area for the current page type
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
  // List selectors are included for the same reason; on detail pages they
  // simply match nothing translated and no-op.
  const allSelectors = [
    ...Object.values(AREA_SELECTORS).flat(),
    ...Object.values(LIST_SELECTORS),
  ];
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
    sendResponse({ supported: currentPage() !== null, translated });
    return false;
  }
  if (message.type === 'toggle-translate') {
    if (!currentPage()) {
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
      updateBodyClasses();
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
    // Typing is a user gesture, so detector creation cannot fail for lack of
    // activation; any other failure just translates every line.
    const detector = await getDetector().catch(() => null);
    // Translator.translate() collapses newlines, so translate line by line.
    // Lines already in the page language (source) pass through untouched.
    const lines = [];
    for (const line of text.split('\n')) {
      const passthrough = !line.trim() || (await isLanguage(line, settings.source, detector));
      lines.push(passthrough ? line : await translator.translate(line));
    }
    if (seq !== requestSeq) return; // a newer input superseded this request
    panelOutput.textContent = lines.join('\n');
  } catch (err) {
    if (seq !== requestSeq) return;
    panelOutput.textContent = `Translation failed: ${err.message}`;
  }
}

function buildUI() {
  // Idempotent: skip when UI is already live (init may run after an early
  // turbo:load already built it, or the previous build is still attached).
  if (panelButton?.isConnected) return;
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
  if (settings.auto && !translated && currentPage()) translatePage();
}

function scheduleAutoTranslate() {
  settleObserver.disconnect();
  clearTimeout(autoTimer);
  settleObserver.observe(document.body, { childList: true, subtree: true });
  autoTimer = setTimeout(tryAutoTranslate, SETTLE_QUIET_MS);
  setTimeout(tryAutoTranslate, SETTLE_MAX_MS); // hard cap
}

// Two gates: helper surfaces get the button/panel, every translatable
// page (readme included) and composers (panel pack downloads) get the
// status toast. Shared by navigation and settings changes so the helper
// toggle applies without a reload.
function updateBodyClasses() {
  const page = currentPage();
  const helper = hasHelperUI();
  document.body.classList.toggle('ght-translate-page', helper);
  document.body.classList.toggle('ght-status-page', page !== null || helper);
  // Why: helper-off only drops the visibility class (see #ght-panel.open rule
  // in content.css); the panel element itself stays in the DOM, so without
  // this reset re-enabling the helper via settings-changed (no reload) would
  // resurface it stuck open.
  if (!helper) panel?.classList.remove('open');
}

function onPageChange() {
  // GitHub's soft navigation re-renders body children, wiping our appended
  // UI (button/panel/status); buildUI() no-ops while still attached.
  buildUI();
  updateBodyClasses();
  const page = currentPage();
  if (!page) hideStatus();
  // New DOM after navigation: old Text nodes (and their originals) are gone.
  translated = false;
  if (page) scheduleAutoTranslate();
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
