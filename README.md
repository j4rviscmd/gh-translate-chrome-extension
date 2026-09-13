# gh-translate-chrome-extension

Chrome extension that translates GitHub issue content in-page using Chrome's
built-in Translator API. No external services, no API keys.

## Requirements

- Chrome 138+ (desktop). The Translator API is not available on mobile or
  other browsers.

## Install (local, unpacked)

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" and select this repository's directory

## Usage

- **Toolbar popup**: toggle page translation, pick the language pair
  (from → to), turn auto-translate on page load on/off, and choose which
  areas to translate (title / body & comments / list titles) separately
  for issues and pull requests.
- **Bottom-right button on issue/PR pages**: opens an input box. Type in
  your language, get the translated text (reverse direction), copy it into
  the comment box.

Language packs are downloaded by Chrome on first use of a language pair;
download progress is shown near the bottom-right button. Text already in the
output language is detected (Chrome's LanguageDetector, extra model download
on first use) and left untranslated.

## Scope

Issue details and issue lists, PR conversation tabs and PR lists. Other
PR tabs (files, commits) are out of scope by design.
