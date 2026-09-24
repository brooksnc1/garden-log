# Changelog

Every release gets an entry here, newest first. Versions match `APP_VERSION`
in `js/app.js` and `VERSION` in `sw.js`. "Data version" is `SCHEMA_VERSION`
in `js/db.js`; when it changes, the entry says what the upgrade does to
existing data.

## 1.1.1 — 2026-09-23

Data version 2 (unchanged; no data upgrade).

### Fixed
- **Share backup** failed with "access denied" on Android. Chrome only shares
  certain file types and rejected `.json`. Shared backups are now `.txt` files
  with the same contents.
- Sharing could also be refused when preparing a large backup (many photos)
  took longer than Chrome allows after a tap. Sharing is now two taps:
  **Share backup** prepares the file, then **Share** opens Android's share screen.
- If sharing is refused for any other reason, the backup is saved to
  Downloads instead, with a message saying so.
- "Last backup" now updates only after the file is actually shared or saved.

### Changed
- **Restore from file** accepts `.txt` as well as `.json` backups.
- Backup ready screen shows the file size.

## 1.1.0 — 2026-09-23

Data version 1 → 2. Upgrade: each container gets `shadeHours: 0`; the old
`sunHours` value is kept in the record, unused.

### Added
- Sun hours are calculated from each day's sunrise and sunset (from
  Open-Meteo, or computed from latitude for days without that data).
- **Shade (hours a day)** setting per container replaces the manual sun-hours
  field. 0 means full sun.
- Today screen shows sunrise and sunset.
- Container page shows today's daylight, shade, and forecast sunshine after clouds.
- The app checks for updates each time it's reopened.

### Changed
- Unshaded containers now use the full daily evaporation figure (it already
  accounts for day length and clouds); shade reduces it, with about 35% kept
  for sky light.
- Bare-soil evaporation raised (0.35 → 0.6 of the reference rate); seedling
  buckets were drying unrealistically slowly.

### Fixed
- An update could be packaged with stale copies of the previous version's
  files from the browser cache. Updates now always fetch fresh files.
- After a message popup disappeared, it still blocked taps near the bottom
  center of the screen.
- The "new version ready" notice could be missed if the update began
  downloading while the app was opening.

## 1.0.0 — 2026-09-23

Data version 1. First release.

### Added
- Containers with a per-container water-balance estimate: rain over the
  opening, evaporation from Open-Meteo weather, plant size by growth stage,
  with a watering point at 40% usable water.
- Rain-forecast note when watering can probably wait; frost and heat alerts.
- Feeding reminders per container, paused after a cold week.
- Plantings with seed-packet timing: sprouting window, thinning reminder keyed
  to the actual sprout date, harvest window with a 14-day fall allowance.
- Soil checks (dry / moist / wet) that correct and tune the water estimate.
- Journal with photos, notes, problems, harvests, filters.
- Season summary: harvest totals and packet vs. actual timing.
- Seed packet inventory with "Sow from this packet".
- Compost tab (placeholder).
- Backups with photos, safety copies before upgrades and restores, and
  numbered data migrations.
- Offline support and home-screen install.
