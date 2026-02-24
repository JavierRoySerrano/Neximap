# NexiMap Studio — Version Summary

## Project Structure

```
/
├── index.html                ← PRODUCTION file (site is served from here)
├── data/
│   ├── telegeography_cables.json   ← Updated weekly by GitHub Action
│   ├── cable_stations_db.json
│   ├── cable_stations.json
│   ├── peeringdb_facilities.json
│   └── submarine_cables_db.json
├── docs/
│   ├── index.html            ← DEVELOPMENT working copy (edit here, PR to root)
│   └── kml-studio.html
└── .github/workflows/
    └── update-telegeography-data.yml
```

## Important: Site Serving & File Roles

| File | Role |
|---|---|
| `/index.html` | **Production.** The live site is served from the repository root. |
| `/docs/index.html` | **Development.** Working copy where changes are authored. Changes are merged into `/index.html` via Pull Request. |

## Known Issue: "Failed to load: Failed to fetch" in Development

When opening `docs/index.html` directly, features that load local data files
(e.g. "Import Cable Systems" > "Public Cable System DB") will show:

> Failed to load: Failed to fetch

**Cause:** `docs/index.html` references data files at the relative path `data/...`
(e.g. `data/telegeography_cables.json`). This resolves to `docs/data/` which
**does not exist**. All data files live at the repository root under `/data/`.

**Affected data paths:**
- `data/telegeography_cables.json` — TeleGeography submarine cable geometry + metadata
- `data/cable_stations_db.json` — Cable landing stations database
- `data/cable_stations.json` — Cable stations (fallback)
- `data/peeringdb_facilities.json` — PeeringDB facilities

**This does NOT affect production.** The production `/index.html` correctly
resolves `data/...` to `/data/` at the repository root.

## Data Update Pipeline

The file `data/telegeography_cables.json` is automatically refreshed by a
GitHub Actions workflow (`.github/workflows/update-telegeography-data.yml`):

- **Schedule:** Every Monday at 06:00 UTC
- **Sources:**
  - Cable geometry: `https://submarine-cable-api.fcoroyse-spam.workers.dev/cable-geo`
  - Per-cable metadata: `https://tg-cablesystem-rfs-metadata.fcoroyse-spam.workers.dev/cable/{id}`
- **Output:** Combined JSON with geometry + metadata, committed automatically to `/data/telegeography_cables.json`

## Encoding Warning

Both `index.html` files contain 448+ UTF-8 emoji characters. Do **not** edit
them with text-mode tools (`str_replace`, `sed`, `awk`, Python text I/O).
Use Python raw bytes (`open(path,'rb')` / `open(path,'wb')`) and validate
after every edit.
