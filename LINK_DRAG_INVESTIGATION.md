# Link Endpoint Drag Investigation Summary

**Date:** 2026-02-16
**Status:** Resolved (user-side) / Improvements identified

## Reported Issue

> When selecting a link, it correctly shows glowed marked end points. The user can select one end and drag it to another node, but when dropping it on another node, it doesn't finish connected. The new node shows orange colour in border, but the link keeps stuck to the mouse and doesn't finish in the selected new node.

## Root Cause

The **Link Creation Mode** (Add Link button) was active when attempting to drag an endpoint. When `linkMode` is `true`, the node `mouseup` handler at line ~14632 calls `ev.stopPropagation()`, which prevents the global `window` mouseup handler from finalizing the endpoint drag at line ~17172. This causes `state.dragging` to never be cleared, leaving the link "stuck" to the mouse.

### Why This Happens

The event flow during an endpoint drop on a node:

1. User releases mouse over target node
2. Node's `mouseup` handler fires first (line 14620)
3. **If `linkMode` is active:** `ev.stopPropagation()` is called (line 14632) → event never reaches `window`
4. **If `linkMode` is NOT active:** `state.dragging` check at line 14677 returns early WITHOUT `stopPropagation()` → event bubbles to `window` → endpoint drag finalizes correctly

## How the Endpoint Drag Feature Works

### Flow

| Step | Code Location | Description |
|------|--------------|-------------|
| 1. Select edge | Lines 13921–14190 | Click invisible hit-area path on edge |
| 2. Handles appear | Lines 13295–13329 | Two `<circle>` elements rendered above nodes |
| 3. Start drag | Lines 13308–13311 | `mousedown` on handle sets `state.dragging = { type: 'endpointHandle', ... }` |
| 4. Visual feedback | Lines 13861–13865 | `drawEdge()` overrides endpoint position with mouse coords |
| 5. Snap ring | Lines 13331–13352 | Animated dashed circle shown on nearest node within 80px |
| 6. Drop/finalize | Lines 17171–17197 | `window` mouseup reassigns `edge.a` or `edge.b` to nearest node |

### Snap Distance

The snap threshold is **80 SVG canvas units** (not screen pixels). This distance is NOT zoom-adjusted, which means:
- At high zoom: snap zone appears very small on screen
- At low zoom: snap zone appears very large on screen

## Potential Improvements Identified

### 1. Prevent Conflict with Link Mode (High Priority)

When `linkMode` is active, endpoint handles should either:
- Not be rendered at all, OR
- The endpoint drag should work independently of link mode by using a different event handling path

### 2. Zoom-Adjusted Snap Threshold (Medium Priority)

Convert the 80-unit threshold to screen pixels so snapping feels consistent at any zoom level:
```js
const snapThreshold = 80 / currentZoomScale;
```

### 3. Duplicate Edge Prevention (Low Priority)

When re-routing an endpoint, warn if the new routing creates a duplicate of an existing edge between the same two nodes.

### 4. Parallel Edge Offset on Handles (Low Priority)

Endpoint handles for parallel edges appear offset from the actual node center due to the perpendicular offset applied for visual separation. The handle's visual starting position doesn't match the node it represents.

## Resolution

**No code change needed** — the issue was caused by having the Link Creation Mode button active while attempting to drag an endpoint. Deactivating the link mode button resolves the behavior.

A future improvement could disable endpoint-handle interaction while in link mode, or make the two features work independently.
