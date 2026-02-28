# NexiMap AI Agent — Cloudflare Worker (Phase 3)

Full-loop multitask complex reasoning AI agent for NexiMap Studio.

## Architecture

```
Browser (docs/index.html)
        │ POST { message, conversation_history, diagram_state, tool_result, session_id, stream }
        ▼
Cloudflare Worker (worker.js) ─── Phase 3 Agent ───
        │
        │ agentLoop() — up to 15 Anthropic API iterations
        │
        ├─── THINK tool ────────────────────────────────
        │     Internal chain-of-thought / planning
        │     scratchpad. Resolved silently in-worker.
        │     Not visible to the user.
        │
        ├─── SERVER-SIDE ANALYSIS ──────────────────────
        │     ├─ analyse_topology → connectivity, SPOFs,
        │     │   redundancy score, articulation points,
        │     │   bridge links, degree distribution
        │     ├─ analyse_capacity → bottlenecks, max-flow,
        │     │   bandwidth by technology, over/under-provisioning
        │     ├─ analyse_cost → total cost, $/Gbps efficiency,
        │     │   cost by technology, optimisation opportunities
        │     ├─ estimate_latency → haversine distance ×
        │     │   route factor × fiber propagation delay
        │     ├─ find_nodes → search/filter diagram nodes
        │     ├─ suggest_design → topology analysis + design recs
        │     └─ get_diagram_stats → counts, totals, density
        │
        ├─── CLIENT-SIDE TOOLS (returned to browser) ───
        │     ├─ Canvas: create/edit/delete node/link,
        │     │   full mesh, assign DC
        │     ├─ Routing: run_pathfinder (K-shortest + protection)
        │     ├─ Visualisation: heatmap, highlight_path
        │     └─ UI Panels: cable visor, DC visor, KML studio,
        │        filters, route map, network summary
        │
        ├─── MEMORY MANAGEMENT ─────────────────────────
        │     Long conversations auto-summarised.
        │     Last 20 messages kept verbatim.
        │     Key facts + actions extracted from earlier messages.
        │
        ├─── SESSION PERSISTENCE (optional KV) ─────────
        │     conversation_history stored in NEXIMAP_SESSIONS KV.
        │     Auto-expires after 1 hour.
        │
        └─── STREAMING (SSE) ───────────────────────────
              Real-time events: agent_start, iteration_start,
              text, tool_start, tool_result, needs_tool, agent_end
```

## What's New in Phase 3

| Feature | Phase 2 | Phase 3 |
|---------|---------|---------|
| Max iterations | 5 | 15 |
| Max tokens | 4,096 | 8,192 |
| Internal reasoning | — | `think` tool (chain-of-thought scratchpad) |
| Server-side analysis | `get_diagram_stats` only | 7 server tools (topology, capacity, cost, latency, search, design) |
| Parallel tools | First tool only | All server tools resolved in parallel; client tools queued |
| Memory management | — | Auto-summarisation for long conversations |
| Session persistence | — | Optional KV binding for cross-request state |
| Streaming | — | SSE with per-iteration events |
| Error recovery | — | Auto-retry on 529, graceful degradation |
| Health check | — | `GET /` returns capabilities + tool inventory |
| Module format | Service Worker | ES Module (with SW backward compat) |
| Design intelligence | — | `suggest_design` with topology-aware recommendations |

## Deployment

### Prerequisites
- Cloudflare account with Workers enabled
- Anthropic API key

### Steps

1. **Open** Cloudflare Dashboard → Workers & Pages → `neximap-ai-agent`
2. **Edit Code** → paste the contents of `worker/worker.js`
3. **Save and Deploy**
4. **Set the API key secret** (only needed once):
   - Settings → Variables & Secrets
   - Add secret `ANTHROPIC_API_KEY`

### Optional: Session Persistence

To enable conversation persistence across page reloads:

1. Create a KV namespace: Workers & Pages → KV → Create
2. Bind it to the worker: Settings → Variables → KV Namespace Bindings
   - Variable name: `NEXIMAP_SESSIONS`
   - Select the KV namespace

Sessions auto-expire after 1 hour.

---

## API Reference

### `POST /` — Chat

```json
{
  "message": "string | null",
  "conversation_history": [{ "role": "user|assistant", "content": "..." }, ...],
  "diagram_state": {
    "nodes": [...],
    "links": [...],
    "groups": [...],
    "selected_node_id": "string | null",
    "selected_link_id": "string | null"
  },
  "tool_result": { "tool_use_id": "string", "content": {} } | null,
  "session_id": "string | null",
  "stream": false
}
```

#### Response — Final

```json
{
  "type": "final",
  "text": "The network has 5 nodes and 7 links...",
  "actions": [
    { "tool": "analyse_topology", "input": {}, "result_summary": "computed" }
  ],
  "iterations_used": 3
}
```

#### Response — Needs Client Tool

```json
{
  "type": "needs_tool",
  "tool_call": { "id": "toolu_xxx", "name": "create_node", "params": { "label": "Amsterdam" } },
  "queued_tool_calls": [],
  "partial_text": "I'll create the Amsterdam node now.",
  "partial_messages": [...],
  "actions": [...],
  "iterations_used": 2
}
```

### `POST /` — Streaming (SSE)

Set `"stream": true` or header `X-Stream: true`.

Events:
| Event | Data |
|-------|------|
| `agent_start` | `{ max_iterations }` |
| `iteration_start` | `{ iteration }` |
| `text` | `{ content }` |
| `tool_start` | `{ name, input }` |
| `tool_result` | `{ name, result }` |
| `needs_tool` | Same as non-streaming `needs_tool` response |
| `error` | `{ status, message }` |
| `retry` | `{ wait_ms }` |
| `agent_end` | Same as non-streaming `final` response |

### `GET /` — Health Check

Returns capabilities, version, and tool inventory.

---

## Server-Side Tools Reference

| Tool | Description |
|------|-------------|
| `think` | Internal reasoning scratchpad (chain-of-thought) |
| `analyse_topology` | Graph connectivity, SPOFs, redundancy, articulation points, bridges, degree distribution |
| `analyse_capacity` | Bottleneck links, bandwidth by tech, over/under-provisioning, max-flow estimate |
| `analyse_cost` | Total cost, $/Gbps efficiency, cost by technology, optimisation opportunities |
| `estimate_latency` | Haversine distance × route factor × 4.9 µs/km fiber propagation |
| `get_diagram_stats` | Node/link counts, total bandwidth, avg latency, density, tags |
| `find_nodes` | Search/filter nodes by label, type, tag, datacenter |
| `suggest_design` | Topology-aware design recommendations based on stated goal + constraints |

## Client-Side Tools Reference

| Tool | Description |
|------|-------------|
| `run_pathfinder` | K-shortest paths + protection routing (headless) |
| `create_node` | Add a node to the canvas |
| `create_link` | Add a link between two nodes |
| `edit_node` | Modify node properties |
| `edit_link` | Modify link properties |
| `delete_node` | Remove a node and its links |
| `delete_link` | Remove a specific link |
| `create_full_mesh` | Connect all node pairs |
| `assign_datacenter` | Assign DC to a node |
| `show_heatmap` | Bandwidth/cost heatmap overlay |
| `highlight_path` | Draw a coloured path on canvas |
| `open_cable_visor` | Open submarine cable browser |
| `open_datacenter_visor` | Open datacenter browser |
| `open_pathfinder` | Open pathfinder UI (legacy) |
| `open_kml_studio` | Open KML/GeoJSON importer |
| `filter_by_tag` | Filter by tags |
| `filter_by_cable_system` | Filter by cable system |
| `filter_by_nodes_or_containers` | Filter by node type/container |
| `filter_map` | Apply map filters |
| `show_route_map` | Toggle map view |
| `get_link_info` | Get link details |
| `clear_all_filters` | Clear all filters |
| `get_network_summary` | Get network summary |
| `show_route_price` | Show route pricing |
| `create_network_diagram` | Open data table editor |

---

## Smoke Tests

### Test 1 — Health check

```bash
curl https://neximap-ai-agent.fcoroyse-spam.workers.dev/
```

**Expected:** JSON with `status: "ok"`, `version: "phase-3"`, tool lists.

### Test 2 — Topology analysis (server-side, multi-tool)

```bash
curl -X POST https://neximap-ai-agent.fcoroyse-spam.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyse the resilience of this network. Are there any single points of failure?",
    "conversation_history": [],
    "diagram_state": {
      "nodes": [
        { "id": "1", "label": "Madrid", "x": 100, "y": 200, "type": "city", "tags": [] },
        { "id": "2", "label": "Frankfurt", "x": 400, "y": 150, "type": "city", "tags": [] },
        { "id": "3", "label": "London", "x": 300, "y": 50, "type": "city", "tags": [] },
        { "id": "4", "label": "Paris", "x": 250, "y": 120, "type": "city", "tags": [] }
      ],
      "links": [
        { "id": "1", "source": "1", "target": "2", "label": "MAD-FRA", "latency_ms": 22, "bandwidth_gbps": 100, "price_usd": 5000, "technology": "fiber" },
        { "id": "2", "source": "2", "target": "3", "label": "FRA-LON", "latency_ms": 15, "bandwidth_gbps": 200, "price_usd": 8000, "technology": "fiber" },
        { "id": "3", "source": "3", "target": "4", "label": "LON-PAR", "latency_ms": 8, "bandwidth_gbps": 100, "price_usd": 3000, "technology": "fiber" }
      ],
      "selected_node_id": null,
      "selected_link_id": null
    }
  }'
```

**Expected:** Agent uses `think` + `analyse_topology` internally, returns analysis identifying Madrid and Paris as leaf nodes with recommendations.

### Test 3 — Complex multi-step reasoning

```bash
curl -X POST https://neximap-ai-agent.fcoroyse-spam.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Design a resilient European backbone network connecting Madrid, Frankfurt, London, Paris, and Amsterdam with at least 2-connected topology and subsea links where appropriate. Then analyse the result.",
    "conversation_history": [],
    "diagram_state": { "nodes": [], "links": [], "selected_node_id": null, "selected_link_id": null }
  }'
```

**Expected:** Agent plans (using `think`), then creates nodes sequentially via `needs_tool` responses, building the topology step by step.

### Test 4 — Streaming mode

```bash
curl -N -X POST https://neximap-ai-agent.fcoroyse-spam.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "X-Stream: true" \
  -d '{
    "message": "What can you tell me about the current network?",
    "conversation_history": [],
    "diagram_state": {
      "nodes": [
        { "id": "1", "label": "NYC", "x": 100, "y": 200, "type": "city", "tags": ["backbone"] },
        { "id": "2", "label": "LAX", "x": 500, "y": 200, "type": "city", "tags": ["backbone"] }
      ],
      "links": [
        { "id": "1", "source": "1", "target": "2", "label": "NYC-LAX", "latency_ms": 60, "bandwidth_gbps": 400, "price_usd": 15000, "technology": "fiber" }
      ],
      "selected_node_id": null,
      "selected_link_id": null
    },
    "stream": true
  }'
```

**Expected:** SSE stream with `agent_start`, `iteration_start`, `tool_start`/`tool_result` (for diagram stats), `text`, `agent_end`.

---

## Graph Analysis Algorithms

The worker implements these algorithms server-side (no external dependencies):

| Algorithm | Used By | Complexity |
|-----------|---------|------------|
| BFS connected components | `analyse_topology` | O(V + E) |
| Tarjan's articulation points | `analyse_topology` | O(V + E) |
| Bridge detection (DFS) | `analyse_topology` | O(V + E) |
| Degree distribution | `analyse_topology` | O(V + E) |
| Haversine distance | `estimate_latency` | O(1) |
| Link-disjoint paths (iterative BFS) | `analyse_capacity` | O(k × (V + E)) |
| Cost efficiency ranking | `analyse_cost` | O(E log E) |

---

Generated with [Claude Code](https://claude.ai/code)
