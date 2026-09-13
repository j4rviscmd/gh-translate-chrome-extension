// Shared constants and helpers for popup and content script.

const DEFAULT_SETTINGS = {
  source: 'en',
  target: 'ja',
  auto: true,
  areas: {
    issue: { title: true, body: true, list: true },
    pull: { title: true, body: true, list: true },
  },
};

// Merges stored settings over defaults, including the nested areas objects.
// Migrates the pre-PR-support flat shape { title, body } to the issue bucket.
// Why: the flat shape predates PR support (only issue pages existed, commit
// 044d8ab), so it can only describe issue preferences; seeding the pull
// bucket too would invent a choice the user never made.
function normalizeSettings(stored) {
  const migrated = stored?.areas?.issue ? stored.areas : { issue: stored?.areas };
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    areas: {
      issue: { ...DEFAULT_SETTINGS.areas.issue, ...migrated.issue },
      pull: { ...DEFAULT_SETTINGS.areas.pull, ...migrated.pull },
    },
  };
}
