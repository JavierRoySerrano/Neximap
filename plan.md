# Cable Visor: CLS-Based Filtering & Map Zoom Enhancement

## Goal
Add three hierarchical filter modes to the Cable Visor toolbar that let users filter cables by where they land:
1. **By CLS Name** - Select a specific Cable Landing Station (searchable dropdown)
2. **By City** - Select a city to show all CLS in that city and their cables
3. **By Country** - Select a country to show all CLS in that country and their cables

Each mode zooms the map to the selected geography.

---

## Architecture Decision: Cascading Filter Approach

Rather than three separate controls, I propose a **single cascading filter group** that sits alongside the existing Region and Search filters. This keeps the toolbar clean and professional:

```
[Filter by: Station v] [Select Station... (searchable) v]
```

The first dropdown selects the **filter mode** (Station / City / Country). The second is a **searchable combo-box** that populates based on the mode. This is a common UX pattern (like Google Maps) that scales well.

### Why not three separate dropdowns?
- Wastes toolbar space
- Confusing when multiple are active simultaneously
- Harder to clear/reset

### Why a searchable combo-box?
- `cable_stations_db.json` has ~700+ stations - a plain `<select>` is unusable at that scale
- Users need type-ahead search for station names like "Shima" or "Eureka"
- Professional mapping tools always use search-as-you-type for location selection

---

## Data Flow

```
cable_stations_db.json (loaded as window._dcDatabase.facilities)
        |
        v
  Build lookup indices on first use:
    - stationIndex:  Map<stationName, stationObject>
    - cityIndex:     Map<city, Set<stationName>>
    - countryIndex:  Map<country, Set<city>>
    - cableToStation: Map<cableName, Set<stationName>>
        |
        v
  User selects filter mode + value
        |
        v
  Resolve: value -> Set<cable_system names>
        |
        v
  Filter renderCableVisorList() to only show matching cables
        |
        v
  Zoom map: fitBounds() to station/city/country bbox
```

---

## Implementation Steps

### Step 1: Build CLS Index Data Structure
**Where:** New function `buildCLSFilterIndices()` called from `loadCableVisorData()` after data loads.

**What:**
- Read `window._dcDatabase.facilities` (already loaded from cable_stations_db.json)
- Filter for `facility_type === "cable_station"` entries only
- Build four Maps:
  - `clsFilterData.byName` - `Map<name, {lat, lon, city, country, cable_systems}>`
  - `clsFilterData.byCity` - `Map<"city, country", [{name, lat, lon, cable_systems}, ...]>`
  - `clsFilterData.byCountry` - `Map<country_code, [{city, name, lat, lon, cable_systems}, ...]>`
  - `clsFilterData.cableToStations` - `Map<cable_system_name, [station, ...]>` (reverse index)

**Country display:** Use a small country code-to-name mapping for display (US -> United States, JP -> Japan, etc.) since the DB stores ISO codes.

### Step 2: Add HTML for CLS Filter Controls
**Where:** In the `#cableVisorToolbar` HTML, add a new row below the existing search/region row.

**New row layout:**
```html
<div id="cableVisorCLSFilterRow" style="display:flex; gap:8px; align-items:center; margin-top:4px;">
  <span style="font-size:10px; font-weight:600; color:#64748b;">CLS Filter:</span>
  <select id="cableVisorCLSMode" style="...">
    <option value="">Off</option>
    <option value="station">By Station</option>
    <option value="city">By City</option>
    <option value="country">By Country</option>
  </select>
  <div id="cableVisorCLSSearchWrap" style="position:relative; flex:1; display:none;">
    <input type="text" id="cableVisorCLSSearchInput" placeholder="Type to search..." autocomplete="off" />
    <div id="cableVisorCLSDropdown" class="cls-filter-dropdown"></div>
  </div>
  <button id="btnClearCLSFilter" class="btn" style="padding:4px 8px; font-size:10px; display:none;" title="Clear CLS filter">✗</button>
</div>
```

### Step 3: CSS for Searchable Dropdown
**Where:** In the `<style>` section, near the existing visor styles.

**New styles:**
- `.cls-filter-dropdown` - Absolute positioned dropdown list below the input
  - `max-height: 220px; overflow-y: auto;` for scrollable list
  - `border: 1px solid #d0d0d0; border-radius: 4px; background: white; box-shadow: 0 4px 12px rgba(0,0,0,0.15);`
  - `z-index: 1000;` to float above map
- `.cls-filter-dropdown-item` - Individual items with hover highlight
  - Shows station name + city + country in a compact layout
  - Shows cable count badge
- `.cls-filter-dropdown-item:hover` / `.cls-filter-dropdown-item.highlighted` - Blue highlight
- `.cls-filter-active-tag` - Small tag showing the active filter value (shown in the input field area)

### Step 4: JavaScript - Searchable Dropdown Logic
**Where:** New function block near the existing visor filter code (~line 22700).

**Functions:**
- `initCLSFilter()` - Called once, sets up event listeners:
  - Mode dropdown change -> populate search options, show/hide search input
  - Search input keyup -> filter dropdown items (debounced 150ms)
  - Search input focus -> show dropdown if has items
  - Dropdown item click -> apply filter
  - Click outside -> close dropdown
  - Clear button click -> reset filter
  - Keyboard navigation (ArrowUp/Down/Enter/Escape) for accessibility

- `populateCLSSearchOptions(mode)` - Builds the dropdown items array based on mode:
  - `"station"`: All station names, sorted, with city+country subtitle
  - `"city"`: All unique cities, sorted, with country and station count
  - `"country"`: All unique countries, sorted, with station count

- `filterCLSDropdown(query)` - Filters visible dropdown items by substring match (case-insensitive) on name, city, country. Shows top 50 results max.

- `applyCLSFilter(mode, value)` - Core function:
  1. Resolve value to a `Set<cable_system_name>` using the indices
  2. Store in `cableVisorState.clsFilter = { mode, value, cableSystems: Set }`
  3. Call `renderCableVisorList()` (which checks `clsFilter`)
  4. Call `zoomToFilteredArea(mode, value)` for map zoom
  5. Show active filter tag + clear button
  6. Auto-select matching cables on map

- `clearCLSFilter()` - Removes filter, re-renders list, resets zoom

### Step 5: Integrate with renderCableVisorList()
**Where:** Modify the existing `renderCableVisorList()` function (~line 22715).

**Change:** Add CLS filter check alongside existing region and search filters:
```javascript
// Existing filters
if (regionFilter && cable.region !== regionFilter) return false;
if (searchText && !matchesSearch(cable, searchText)) return false;

// NEW: CLS filter
if (cableVisorState.clsFilter) {
  const allowedCables = cableVisorState.clsFilter.cableSystems;
  // Match by cable name (normalize for comparison)
  if (!matchesCLSFilter(cable, allowedCables)) return false;
}
```

**Cable name matching strategy:** The cable names in `cable_systems` arrays (e.g., "JUNO", "FASTER", "Asia Pacific Gateway (APG)") need fuzzy matching against the visor cable database names (from TeleGeography). Strategy:
- Exact match first
- Then try: contains, starts-with, normalized (remove parenthetical abbreviations)
- Build a pre-computed mapping on load for reliable cross-referencing

### Step 6: Map Zoom to Geography
**Where:** New function `zoomToFilteredArea(mode, value)`.

**Logic:**
- **Station mode:** Zoom to station coordinates with zoom level ~12 (city-level detail)
  - `map.flyTo({ center: [lon, lat], zoom: 12, duration: 1500 })`
- **City mode:** Compute bounding box of all stations in that city
  - `map.fitBounds(bbox, { padding: 80, duration: 1500 })`
  - If single station, use flyTo with zoom ~11
- **Country mode:** Compute bounding box of all stations in that country
  - `map.fitBounds(bbox, { padding: 50, duration: 1500 })`
  - For large countries (US, JP), this gives a good overview

### Step 7: Visual Feedback on Map
**Where:** Enhance `updateStationMarkers()` or add companion function.

**What:** When a CLS filter is active:
- Highlight filtered stations with a distinct marker style (larger, pulsing, or different color)
- Show station name labels automatically for filtered stations
- Optionally draw a subtle highlight circle around the filtered area

### Step 8: Wire Up Event Listeners
**Where:** In the existing visor initialization code (near line 23578 where other button listeners are set up).

**What:**
- Call `initCLSFilter()` after the visor panel is shown
- Ensure filter state resets when switching data sources (list vs API)
- Ensure filter state persists during the session (survives panel resize, etc.)

---

## Interaction with Existing Filters

The CLS filter works **in combination** with existing filters:
- **Region filter + CLS filter:** Both apply (intersection). E.g., "Cables landing in Japan AND in Asia Pacific region"
- **Search text + CLS filter:** Both apply. E.g., "Cables landing at Shima that contain 'FASTER' in the name"
- **Clear CLS filter:** Only removes CLS filter, preserves region and search

---

## File Changes Summary

| File | Changes |
|------|---------|
| `index.html` lines ~1200 | Add CSS for `.cls-filter-dropdown`, `.cls-filter-dropdown-item`, etc. (~40 lines) |
| `index.html` lines ~50040 | Add HTML for CLS filter row in toolbar (~15 lines) |
| `index.html` lines ~22700 | Add `buildCLSFilterIndices()`, `initCLSFilter()`, `populateCLSSearchOptions()`, `filterCLSDropdown()`, `applyCLSFilter()`, `clearCLSFilter()`, `zoomToFilteredArea()` (~250 lines) |
| `index.html` lines ~22730 | Modify `renderCableVisorList()` to check CLS filter (~10 lines) |
| `index.html` lines ~22260 | Modify `loadCableVisorData()` to call `buildCLSFilterIndices()` (~3 lines) |
| `index.html` lines ~21996 | Modify `showCableVisor()` to call `initCLSFilter()` (~2 lines) |

**Total:** ~320 lines of new code, ~15 lines modified in existing functions.

---

## Edge Cases & Robustness

1. **No matching cables:** Show "No cables match this CLS filter" message in list
2. **Station with no cable_systems:** Skip in index (nothing to filter)
3. **Cable name mismatch between DBs:** Use normalized fuzzy matching with pre-built mapping
4. **Empty city/country:** Skip entries with missing location data
5. **Dropdown performance:** Limit to 50 visible items with "Type to narrow..." hint
6. **Mobile/small screens:** Dropdown should not overflow panel bounds
