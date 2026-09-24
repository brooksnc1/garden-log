# Garden Log

A phone-first tracker for container vegetables: watering estimates from real
rain and evaporation, feeding reminders, seed-packet timing windows, photos,
harvests, and a season summary. It runs entirely in the browser: no account,
no server, and your data stays on your phone.

## Put it online (GitHub Pages, about 5 minutes)

1. Create a new GitHub repository, for example `garden-log`. It can be public:
   the repo holds only the app's code, never your garden data.
2. Upload everything in this folder to the repo root, keeping the folder
   structure (`index.html`, `sw.js`, `manifest.webmanifest`, `css/`, `js/`, `icons/`).
3. In the repo go to **Settings → Pages**. Under *Build and deployment*, choose
   **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the site is live at `https://<your-username>.github.io/garden-log/`.

## Install it on your Android phone

1. Open that address in **Chrome**.
2. Tap the ⋮ menu and choose **Add to Home screen**, then **Install**.
3. Open Garden Log from the home screen. It now runs full-screen and works
   offline; weather refreshes whenever you're online.

First run:
- **Settings → Use my location** (or enter coordinates). This is used only to
  request weather from Open-Meteo.
- **Add a 5-gallon bucket**. Set hours of shade only if something shades it (0 = full sun).
- **Add planting** for each crop. Enter packet numbers under *Numbers from the
  seed packet*, or add the packet under **Seeds** first and use
  *Sow from this packet*.

## Keep your data safe

- Your data lives in the browser's storage on this phone. Settings shows whether
  Chrome has marked it **protected** from automatic cleanup; installing the app to
  the home screen normally grants this.
- **Settings → Save backup file** (or *Share backup* to Google Drive) writes one
  file with everything, photos included. Shared backups end in `.txt` because
  Chrome only shares certain file types; the contents are the same, and
  *Restore from file* accepts either. The app reminds you every 30 days.
- **Restore from file** replaces the app's data with a backup. Your current data
  is saved as a safety copy first.
- Uninstalling the app or clearing Chrome's site data deletes everything that
  isn't in a backup file.

## How the watering estimate works

Each container tracks *usable water*: roughly 22% of the potting-mix volume
(about 1 gallon in a 5-gallon bucket).

- **Rain in:** rain depth × the container's opening area. One inch on a
  12-inch bucket adds about half a gallon; the rest runs off or drains.
- **Water out:** daily reference evapotranspiration from Open-Meteo, scaled by
  how big the plants are (grows from seedling to mature over each crop's
  days-to-maturity). That figure already reflects day length (sunrise to
  sunset) and cloud cover. Shade reduces it: sun hours = daylight − shade, and
  shaded hours still get about 35% from sky light.
- **Watering** fills it back up (or adds a set amount if you enter gallons).
- **Due** when usable water drops below 40%. If ≥0.2 in of rain is forecast
  tomorrow, the reminder says it can probably wait.
- **Frozen days** (high ≤34°F) use no water, and feeding reminders pause after
  a cold week.
- **Soil checks** (dry / moist / wet) correct the estimate on the spot. When a
  check disagrees strongly with the model, the container's drying rate is
  nudged 15% toward what you observed. The container's page shows the current
  tuning under *How the water estimate works here*.

Everything is recomputed from your logged history each time, so model
improvements in later versions apply to past data without changing it.

## Updating the app safely

The data layer is built so new versions never damage existing records:

- Records are merged on save, never rebuilt, so fields a version doesn't know
  about are kept.
- Journal entries are never rewritten; deletes are soft (`deletedAt`), and
  photos are never modified.
- Schema changes go through numbered migrations in `js/db.js`. Before a
  migration runs, the app saves a full safety copy, then writes the upgraded
  data in a single transaction. If the migration throws, nothing is written
  and the app says so.
- The same migrations upgrade old backup files when you restore them. A backup
  from a *newer* version is refused until the app is updated.

To release a change:

1. Edit the code.
2. If stored data needs a new shape, bump `SCHEMA_VERSION` in `js/db.js` and
   append a migration to `MIGRATIONS`. Never edit one that has shipped. There
   is a commented example in the file. If you need a new IndexedDB object
   store, bump `IDB_VERSION` and add an entry to `IDB_UPGRADES`.
3. Bump `APP_VERSION` in `js/app.js` and `VERSION` in `sw.js` to the same number,
   and add an entry to `CHANGELOG.md` (what changed, and what any data upgrade does).
   If you add a new file, add it to the `FILES` list in `sw.js`.
4. Commit to GitHub. Next time the app opens online, it shows **A new version is
   ready → Update now**.

Adding a crop to `js/crops.js` needs no migration.

## Files

| File | Purpose |
|---|---|
| `index.html`, `css/app.css` | App shell and styles |
| `js/app.js` | Screens, forms and actions |
| `js/db.js` | Storage, migrations, safety copies, backup files |
| `js/model.js` | Water balance, timing windows, due list, alerts (read-only logic) |
| `js/crops.js` | Default crop timings and sizes; packet values override these |
| `js/weather.js` | Open-Meteo requests with gap backfill (up to 92 days) |
| `js/photos.js` | Photo compression (~1600 px JPEG) and thumbnails |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `CHANGELOG.md` | Release history |

Weather data by [Open-Meteo.com](https://open-meteo.com) (CC BY 4.0).
