# CLAUDE.md — Persistent Instructions for Claude Code

## Project: NexiMap Studio

### Critical: File Structure & Editing Rules

- **Production file:** `/index.html` (repository root) — the live site is served from here.
- **Development file:** `/docs/index.html` — this is the working copy where Claude makes changes. Changes are merged into `/index.html` via Pull Request.
- **All data files** live under `/data/` at the repository root (NOT under `/docs/data/`).

### Known Issue: "Failed to fetch" in docs/index.html

When running `docs/index.html` directly, features that load local data
(e.g. "Import Cable Systems" > "Public Cable System DB") will show
**"Failed to load: Failed to fetch"**. This is expected because
`docs/index.html` references `data/...` which resolves to `docs/data/`
— a directory that does not exist. All data files are at `/data/`.
This does NOT affect production (`/index.html`).

Affected data paths:
- `data/telegeography_cables.json`
- `data/cable_stations_db.json`
- `data/cable_stations.json`
- `data/peeringdb_facilities.json`

### Encoding Warning

Both `index.html` files contain 448+ UTF-8 emoji characters.
Do NOT edit with text-mode tools (str_replace, sed, awk, Python text I/O).
Use Python raw bytes: `open(path,'rb')` / `open(path,'wb')`.
Validate after every edit — see `NEXIMAP_VERSION_SUMMARY.md`.

### Data Pipeline

`data/telegeography_cables.json` is auto-updated weekly (Monday 06:00 UTC)
by GitHub Actions workflow `.github/workflows/update-telegeography-data.yml`.
