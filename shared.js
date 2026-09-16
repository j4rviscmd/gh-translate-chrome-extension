// Shared constants and helpers for popup and content script.

const DEFAULT_SETTINGS = {
  source: 'en',
  target: 'ja',
  auto: true,
  helper: false,
  concurrency: 8,
  areas: {
    issue: { title: true, body: true, list: true },
    pull: { title: true, body: true, list: true },
    readme: { body: true },
    projects: { title: true, body: true },
  },
};

// Merges stored settings over defaults, including the nested areas objects.
// Migrates the pre-PR-support flat shape { title, body } to the issue bucket.
// Why: the flat shape predates PR support (only issue pages existed, commit
// 044d8ab), so it can only describe issue preferences; seeding the pull
// bucket too would invent a choice the user never made.
function normalizeSettings(stored) {
  const migrated = stored?.areas?.issue ? stored.areas : { issue: stored?.areas };
  // Popup writes the raw input value (NaN when the field is emptied), and
  // old installs have no concurrency key — both fall back to the default.
  // Capped: beyond ~100 concurrent inferences the engine gets flooded
  // (observed in other projects relying on the same API), so stay under it.
  const parsed = Number.parseInt(stored?.concurrency, 10);
  const concurrency = Number.isNaN(parsed)
    ? DEFAULT_SETTINGS.concurrency
    : Math.min(96, Math.max(1, parsed));
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    concurrency,
    areas: {
      issue: { ...DEFAULT_SETTINGS.areas.issue, ...migrated.issue },
      pull: { ...DEFAULT_SETTINGS.areas.pull, ...migrated.pull },
      readme: { ...DEFAULT_SETTINGS.areas.readme, ...migrated.readme },
      projects: { ...DEFAULT_SETTINGS.areas.projects, ...migrated.projects },
    },
  };
}
