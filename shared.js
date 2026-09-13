// Shared constants and helpers for popup and content script.

const DEFAULT_SETTINGS = {
  source: 'en',
  target: 'ja',
  auto: true,
  areas: { title: true, body: true },
};

// Merges stored settings over defaults, including the nested areas object.
function normalizeSettings(stored) {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    areas: { ...DEFAULT_SETTINGS.areas, ...stored.areas },
  };
}
