# Privacy Policy

GitHub Translate handles text you view on github.com to translate it in your
browser. This policy explains what the extension does with data.

## What the extension stores

- **Settings only** (source/target language, auto-translate, helper
  visibility, and per-area toggles), saved in `chrome.storage.sync` so your
  preferences follow your Chrome profile.
- No browsing history, page content, credentials, or personal data is
  stored or transmitted by the extension.

## Data the extension never sends

- The extension contains no analytics, no ads, no trackers, and makes no
  network requests of its own. It does not collect or share data with any
  third party, including the developer.

## How translation works

Translation runs entirely on your device through Chrome's built-in
Translator and LanguageDetector APIs. Page text is passed to these browser
APIs locally; the extension itself never uploads text anywhere. Chrome may
download language-pack models from Google when a language pair is first
used — that download is performed by Chrome, not by this extension.

## Permissions

- `storage` — saves the settings described above.
- `https://github.com/*` (host permission) — limits all activity to GitHub
  pages; required to translate content displayed there.

## Contact

For privacy questions, open an issue at
https://github.com/j4rviscmd/gh-translate-chrome-extension/issues.
