# NexiMap AI Agent — Cloudflare Worker

This directory contains the source for the Cloudflare Worker that powers the Nexi AI agent embedded in NexiMap Studio.

## Architecture

```
Browser (docs/index.html)
        │ POST { message, conversation_history, diagram_state, tool_result }
        ▼
Cloudflare Worker (worker.js)
        │ agentLoop() — up to 5 Anthropic API calls
        │   ├─ end_turn → { type: 'final', text }
        │   └─ tool_use →
        │       ├─ server-side (get_diagram_stats): resolved in Worker
        │       └─ client-side (run_pathfinder, create_node, …):
        │          { type: 'needs_tool', tool_call, partial_messages }
        │                  │
        │          Browser executes tool locally
        │          POSTs back with tool_result
        │                  │
        │          Worker resumes agentLoop with tool_result
        └─ Returns { type: 'final', text } to browser
```

## Deployment

### Prerequisites
- A Cloudflare account with Workers enabled
- An Anthropic API key

### Steps

1. **Open** the Cloudflare Dashboard → Workers & Pages → `neximap-ai-agent`
2. **Edit Code** → paste the entire contents of `worker/worker.js`
3. **Save and Deploy**
4. **Set the API key secret** (only needed once):
   - Workers & Pages → `neximap-ai-agent` → Settings → Variables & Secrets
   - Add a secret named `ANTHROPIC_API_KEY` with your Anthropic API key value

### Updating

Repeat steps 1-3 whenever `worker/worker.js` changes.

---

## Smoke Tests

### Test 1 — Diagram stats (server-side tool)

```bash
curl -X POST https://neximap-ai-agent.fcoroyse-spam.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "message": "How many nodes are in the diagram?",
    "conversation_history": [],
    "diagram_state": {
      "nodes": [
        { "id": "1", "label": "Madrid", "x": 100, "y": 200, "type": "city", "tags": [], "datacenter": null, "address": null },
        { "id": "2", "label": "Frankfurt", "x": 400, "y": 150, "type": "city", "tags": [], "datacenter": null, "address": null }
      ],
      "links": [
        { "id": "1", "source": "1", "target": "2", "label": "MAD-FRA", "latency_ms": 22, "bandwidth_gbps": 100, "price_usd": 5000, "tags": [], "technology": "fiber" }
      ],
      "selected_node_id": null,
      "selected_link_id": null
    },
    "tool_result": null
  }'
```

**Expected:** `{ "type": "final", "text": "There are 2 nodes and 1 link …" }`

---

### Test 2 — Empty canvas

```bash
curl -X POST https://neximap-ai-agent.fcoroyse-spam.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What can I do here?",
    "conversation_history": [],
    "diagram_state": { "nodes": [], "links": [], "selected_node_id": null, "selected_link_id": null },
    "tool_result": null
  }'
```

**Expected:** A helpful description of Nexi capabilities.

---

### Test 3 — Create node (client-side tool round-trip)

First call — Worker requests client-side execution:
```bash
curl -X POST https://neximap-ai-agent.fcoroyse-spam.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Add a node called Amsterdam",
    "conversation_history": [],
    "diagram_state": { "nodes": [], "links": [], "selected_node_id": null, "selected_link_id": null },
    "tool_result": null
  }'
```

**Expected:** `{ "type": "needs_tool", "tool_call": { "name": "create_node", "params": { "label": "Amsterdam" }, … }, "partial_messages": […] }`

Second call — browser executes tool, posts back result:
```bash
curl -X POST https://neximap-ai-agent.fcoroyse-spam.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "message": null,
    "conversation_history": [<partial_messages from first response>],
    "diagram_state": { "nodes": [{ "id": "1", "label": "Amsterdam", "x": 300, "y": 250, "type": "city", "tags": [], "datacenter": null, "address": null }], "links": [], "selected_node_id": null, "selected_link_id": null },
    "tool_result": { "tool_use_id": "<id from first response>", "content": { "success": true, "nodeId": "1", "label": "Amsterdam" } }
  }'
```

**Expected:** `{ "type": "final", "text": "I created node 'Amsterdam' on the canvas. …" }`

---

## Phase 2 Tool Reference

| Tool | Side | Description |
|------|------|-------------|
| `run_pathfinder` | client | K-shortest paths + protection path (headless) |
| `create_node` | client | Add a node to the canvas |
| `create_link` | client | Add a link between two nodes |
| `edit_node` | client | Modify node properties |
| `edit_link` | client | Modify link properties |
| `delete_node` | client | Remove a node and its links |
| `delete_link` | client | Remove a specific link |
| `create_full_mesh` | client | Connect all node pairs |
| `assign_datacenter` | client | Assign DC to a node |
| `show_heatmap` | client | Bandwidth/cost heatmap overlay |
| `highlight_path` | client | Draw a coloured path on canvas |
| `get_diagram_stats` | **server** | Node/link counts, totals |

Generated with [Claude Code](https://claude.ai/code)
