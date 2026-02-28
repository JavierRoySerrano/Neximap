/**
 * NexiMap AI Agent — Phase 3 Cloudflare Worker
 * Full-loop multitask complex reasoning AI agent with:
 *   - Task planning & decomposition
 *   - Multi-step agentic loop (up to 15 iterations)
 *   - Parallel tool execution
 *   - Server-side network analysis (topology, redundancy, capacity)
 *   - Conversation memory & context summarisation
 *   - Self-reflection & error recovery
 *   - Streaming (SSE) support
 *   - Durable Objects for session persistence (optional binding)
 *
 * Deploy: Cloudflare Dashboard → Workers & Pages → neximap-ai-agent → Edit Code → paste → Save and Deploy
 *
 * Required bindings:
 *   Secret: ANTHROPIC_API_KEY
 *   Optional KV: NEXIMAP_SESSIONS (for conversation persistence)
 */

// ─── CONFIGURATION ──────────────────────────────────────────────────────────

const CONFIG = {
  ANTHROPIC_API_URL: 'https://api.anthropic.com/v1/messages',
  MODEL: 'claude-sonnet-4-6',
  MAX_TOKENS: 8192,
  MAX_AGENT_ITERATIONS: 15,
  MAX_PARALLEL_TOOLS: 5,
  PLANNING_THRESHOLD_CHARS: 120,
  MEMORY_SUMMARY_THRESHOLD: 30,
  SESSION_TTL_SECONDS: 3600,
  STREAM_KEEPALIVE_MS: 15000,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Id, X-Stream',
};

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `You are Nexi, an expert AI solutions architect and network engineer embedded in NexiMap Studio — a professional network diagram, submarine cable mapping, and topology design tool.

You are a PROACTIVE agent that ALWAYS executes actions rather than merely describing them. When asked to create, modify, analyse, or route — you DO it immediately with tool calls.

## Core Identity
- You think step-by-step for complex tasks, breaking them into a clear plan before executing
- You can handle multi-step, multi-tool workflows autonomously
- You reflect on results and correct course if something fails
- You provide expert-level network engineering analysis

## Capabilities

### Canvas Operations
- Create, edit, delete nodes (cities, datacenters, submarine cable landings, exchange points)
- Create, edit, delete links with latency, bandwidth, pricing, and technology attributes
- Create full mesh topologies between node sets
- Assign datacenters from the global PeeringDB database to nodes

### Routing & Analysis
- Run headless K-shortest-path computations with constraint-based filtering
- Compute fully link-diverse protection paths
- Analyse network topology (redundancy, single points of failure, capacity bottlenecks)
- Estimate latency based on geographic distance
- Compute network reliability metrics

### Visualisation
- Show bandwidth or cost heatmap overlays on the canvas
- Highlight computed paths with colour-coding (primary vs protection)
- Open Cable Visor (submarine cable map), Datacenter Visor, KML Studio

### Network Intelligence (server-side)
- Topology analysis: connectivity, redundancy score, biconnected components
- Capacity planning: bottleneck detection, aggregate bandwidth by corridor
- Cost optimisation: cheapest-path analysis, total network cost
- Geographic analysis: estimate fiber latency from coordinates
- Submarine cable knowledge: landing points, owners, capacity, status

## Tool Usage Rules
1. ALWAYS use node IDs (not labels) in tool parameters
2. Use the diagram state to resolve user references ("Madrid", "the Frankfurt node") to node IDs
3. For nodes without specified positions, omit x/y — the frontend auto-positions them
4. When asked for a route, identify matching node IDs first, then call run_pathfinder
5. For complex multi-step tasks, execute tools sequentially — confirm each step before proceeding
6. If a tool fails, analyse the error and try an alternative approach

## Narrating Results
- Pathfinder: list hops by node LABEL (not ID), total latency, hop count, diversity confirmation
- Topology analysis: explain findings in network engineering terms with actionable recommendations
- After canvas actions: confirm what was done in a brief, professional sentence

## Multi-Step Task Handling
For complex requests (e.g. "design a ring topology connecting 5 European cities"):
1. State the plan briefly
2. Execute each step with tool calls
3. Confirm completion with a summary

## Error Recovery
- If a tool call fails, analyse why and attempt an alternative
- If a node referenced by the user doesn't exist, offer to create it
- If pathfinder returns no path, explain the topology gap and suggest fixes`;

// ─── DIAGRAM STATE SERIALISER ───────────────────────────────────────────────

function buildSystemPrompt(diagramState, sessionMemory) {
  let prompt = SYSTEM_PROMPT_BASE;

  // Append session memory summary if available
  if (sessionMemory?.summary) {
    prompt += `\n\n## Conversation Memory\n${sessionMemory.summary}`;
  }
  if (sessionMemory?.keyFacts?.length) {
    prompt += `\n\nKey facts from this session:\n${sessionMemory.keyFacts.map(f => `- ${f}`).join('\n')}`;
  }

  // Append diagram state
  if (!diagramState || (!diagramState.nodes?.length && !diagramState.links?.length)) {
    prompt += '\n\n## Current Diagram State\nThe canvas is empty — no nodes or links yet.';
    return prompt;
  }

  const nodeLines = (diagramState.nodes || []).map(n => {
    const tags = n.tags?.length ? n.tags.join(',') : '';
    const dc = n.datacenter ? ` dc:${n.datacenter}` : '';
    const pos = (n.x != null && n.y != null) ? ` pos:(${Math.round(n.x)},${Math.round(n.y)})` : '';
    return `  ${n.id}|${n.label}|${n.type || 'city'}${tags ? `|tags:[${tags}]` : ''}${dc}${pos}`;
  }).join('\n');

  const linkLines = (diagramState.links || []).map(l => {
    const parts = [`${l.id}|${l.source}→${l.target}`];
    if (l.label) parts.push(l.label);
    if (l.latency_ms) parts.push(`lat:${l.latency_ms}ms`);
    if (l.bandwidth_gbps) parts.push(`bw:${l.bandwidth_gbps}G`);
    if (l.price_usd) parts.push(`$${l.price_usd}/mo`);
    if (l.technology) parts.push(l.technology);
    if (l.tags?.length) parts.push(`tags:[${l.tags.join(',')}]`);
    return `  ${parts.join('|')}`;
  }).join('\n');

  const groups = diagramState.groups || [];
  const groupLines = groups.length ? groups.map(g =>
    `  ${g.id}|${g.label}|${g.type}|members:[${(g.nodes || []).join(',')}]`
  ).join('\n') : '';

  const selected = [];
  if (diagramState.selected_node_id) selected.push(`node=${diagramState.selected_node_id}`);
  if (diagramState.selected_link_id) selected.push(`link=${diagramState.selected_link_id}`);

  prompt += `\n\n## Current Diagram State

Nodes (${diagramState.nodes.length}):
${nodeLines || '  (none)'}

Links (${(diagramState.links || []).length}):
${linkLines || '  (none)'}`;

  if (groupLines) {
    prompt += `\n\nGroups (${groups.length}):\n${groupLines}`;
  }

  prompt += `\n\nSelected: ${selected.length ? selected.join(', ') : 'none'}`;

  return prompt;
}

// ─── TOOL DEFINITIONS ───────────────────────────────────────────────────────

const NEXIMAP_TOOLS = [
  // ── Phase 3: Planning & Reasoning ──
  {
    name: 'think',
    description: 'Internal reasoning scratchpad. Use this to plan multi-step actions, analyse the diagram state, or reason about complex network design decisions BEFORE taking action. The user does not see this — it is purely for your internal chain-of-thought. Use this when the request is complex and requires planning.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Your internal reasoning, analysis, or step-by-step plan'
        }
      },
      required: ['reasoning']
    }
  },

  // ── Phase 3: Server-side Network Analysis ──
  {
    name: 'analyse_topology',
    description: 'Deep server-side topology analysis. Returns: connectivity (is the graph connected?), redundancy score (min node/link connectivity), single points of failure (articulation points and bridges), biconnected components, and degree distribution. Use when the user asks about network resilience, redundancy, or topology quality.',
    input_schema: {
      type: 'object',
      properties: {
        include_recommendations: {
          type: 'boolean',
          description: 'Include AI-generated improvement recommendations (default true)'
        }
      },
      required: []
    }
  },
  {
    name: 'analyse_capacity',
    description: 'Analyse network capacity: identify bottleneck links (lowest bandwidth on shortest paths), compute aggregate bandwidth by corridor/region, find over/under-provisioned segments, and estimate max-flow between node pairs. Use when the user asks about capacity planning, bottlenecks, or bandwidth.',
    input_schema: {
      type: 'object',
      properties: {
        source_node_id: { type: 'string', description: 'Optional: compute max-flow from this node' },
        target_node_id: { type: 'string', description: 'Optional: compute max-flow to this node' }
      },
      required: []
    }
  },
  {
    name: 'analyse_cost',
    description: 'Analyse network cost: total monthly cost, cost per Gbps, cost distribution by technology and region, identify most/least cost-effective links, and suggest cost optimisation opportunities.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'estimate_latency',
    description: 'Estimate fiber-optic latency between two geographic coordinates using great-circle distance and standard fiber propagation delay (4.9 µs/km). Useful when the user wants to set realistic latency values for new links.',
    input_schema: {
      type: 'object',
      properties: {
        lat1: { type: 'number', description: 'Latitude of point A' },
        lon1: { type: 'number', description: 'Longitude of point A' },
        lat2: { type: 'number', description: 'Latitude of point B' },
        lon2: { type: 'number', description: 'Longitude of point B' },
        cable_route_factor: {
          type: 'number',
          description: 'Multiplier for cable route vs straight line (default 1.3 for terrestrial, 1.5 for subsea)'
        }
      },
      required: ['lat1', 'lon1', 'lat2', 'lon2']
    }
  },
  {
    name: 'get_diagram_stats',
    description: 'Return diagram statistics: node count, link count, total bandwidth, average latency, technology breakdown, tag distribution, and network density metrics.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'find_nodes',
    description: 'Search for nodes in the current diagram by label, type, tag, or datacenter. Returns matching node IDs and labels. Use this to resolve user references like "all European cities" or "nodes tagged backbone" before performing operations.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (matched against label, fuzzy)' },
        type: { type: 'string', description: 'Filter by node type' },
        tag: { type: 'string', description: 'Filter by tag' },
        datacenter: { type: 'string', description: 'Filter by datacenter name' }
      },
      required: []
    }
  },
  {
    name: 'suggest_design',
    description: 'Generate network design suggestions based on requirements. Analyses the current topology and recommends improvements: where to add redundancy, optimal node placement for a new PoP, recommended link capacities, and cost-effective architectures. Use when the user asks "what should I do" or "how to improve" the network.',
    input_schema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The design goal (e.g. "add redundancy to Europe", "connect to Asia with < 200ms", "minimize cost")'
        },
        constraints: {
          type: 'object',
          description: 'Optional constraints',
          properties: {
            max_latency_ms: { type: 'number' },
            min_bandwidth_gbps: { type: 'number' },
            max_monthly_cost_usd: { type: 'number' },
            required_regions: { type: 'array', items: { type: 'string' } },
            technology_preference: { type: 'string' }
          }
        }
      },
      required: ['goal']
    }
  },

  // ── Canvas-action tools (client-side) ──
  {
    name: 'run_pathfinder',
    description: 'Headless pathfinder: compute K-shortest primary paths + optionally a fully-diverse protection path. Returns detailed route data. Use whenever the user asks for routes, connectivity, paths, or latency analysis between two points.',
    input_schema: {
      type: 'object',
      properties: {
        originNodeId: { type: 'string', description: 'Source node ID' },
        destNodeId: { type: 'string', description: 'Destination node ID' },
        k: { type: 'number', description: 'Number of shortest paths (default 3)' },
        calculateProtection: { type: 'boolean', description: 'Compute link-diverse protection path (default false)' },
        primaryFilters: {
          type: 'object',
          description: 'Optional filters for primary paths',
          properties: {
            requiredNodeTags: { type: 'array', items: { type: 'string' } },
            excludedNodeTags: { type: 'array', items: { type: 'string' } },
            requiredLinkTags: { type: 'array', items: { type: 'string' } },
            excludedLinkTags: { type: 'array', items: { type: 'string' } },
            mustUseNodes: { type: 'array', items: { type: 'string' } },
            mustUseLinks: { type: 'array', items: { type: 'string' } },
            minCapacityGbps: { type: 'number' },
            maxLatencyMs: { type: 'number' },
            preferMLG: { type: 'boolean' },
            optimizeCost: { type: 'boolean' }
          }
        },
        protectionFilters: {
          type: 'object',
          description: 'Optional filters for protection path',
          properties: {
            requiredNodeTags: { type: 'array', items: { type: 'string' } },
            excludedNodeTags: { type: 'array', items: { type: 'string' } },
            requiredLinkTags: { type: 'array', items: { type: 'string' } },
            excludedLinkTags: { type: 'array', items: { type: 'string' } },
            mustUseNodes: { type: 'array', items: { type: 'string' } },
            enforceFullDiversity: { type: 'boolean', description: '100% link-disjoint from primary (default true)' }
          }
        }
      },
      required: ['originNodeId', 'destNodeId']
    }
  },
  {
    name: 'create_node',
    description: 'Create a new node on the canvas. Returns the new node ID.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Display name' },
        type: { type: 'string', enum: ['city', 'datacenter', 'submarine_cable_landing', 'exchange_point', 'custom'] },
        x: { type: 'number', description: 'Canvas X (optional — auto-positions)' },
        y: { type: 'number', description: 'Canvas Y (optional — auto-positions)' },
        tags: { type: 'array', items: { type: 'string' } },
        datacenter: { type: 'string' },
        address: { type: 'string' }
      },
      required: ['label']
    }
  },
  {
    name: 'create_link',
    description: 'Create a link between two existing nodes.',
    input_schema: {
      type: 'object',
      properties: {
        sourceNodeId: { type: 'string' },
        targetNodeId: { type: 'string' },
        label: { type: 'string' },
        latency_ms: { type: 'number' },
        bandwidth_gbps: { type: 'number' },
        price_usd: { type: 'number' },
        technology: { type: 'string', enum: ['fiber', 'subsea', 'microwave', 'satellite'] },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['sourceNodeId', 'targetNodeId']
    }
  },
  {
    name: 'edit_node',
    description: 'Edit properties of an existing node.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        label: { type: 'string' },
        type: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        datacenter: { type: 'string' },
        address: { type: 'string' }
      },
      required: ['nodeId']
    }
  },
  {
    name: 'edit_link',
    description: 'Edit properties of an existing link.',
    input_schema: {
      type: 'object',
      properties: {
        linkId: { type: 'string' },
        label: { type: 'string' },
        latency_ms: { type: 'number' },
        bandwidth_gbps: { type: 'number' },
        price_usd: { type: 'number' },
        technology: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['linkId']
    }
  },
  {
    name: 'delete_node',
    description: 'Delete a node and all its connected links.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId']
    }
  },
  {
    name: 'delete_link',
    description: 'Delete a specific link.',
    input_schema: {
      type: 'object',
      properties: { linkId: { type: 'string' } },
      required: ['linkId']
    }
  },
  {
    name: 'create_full_mesh',
    description: 'Create links between ALL pairs of given nodes (full mesh topology).',
    input_schema: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' } },
        default_bandwidth_gbps: { type: 'number' },
        default_latency_ms: { type: 'number' },
        technology: { type: 'string' }
      },
      required: ['nodeIds']
    }
  },
  {
    name: 'assign_datacenter',
    description: 'Assign a datacenter to a node.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        datacenter_name: { type: 'string' }
      },
      required: ['nodeId', 'datacenter_name']
    }
  },
  {
    name: 'show_heatmap',
    description: 'Activate a heatmap overlay (bandwidth, cost) or turn it off.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['bandwidth', 'cost', 'off'] }
      },
      required: ['mode']
    }
  },
  {
    name: 'highlight_path',
    description: 'Highlight a path on the canvas with colour-coded links and nodes.',
    input_schema: {
      type: 'object',
      properties: {
        node_sequence: { type: 'array', items: { type: 'string' }, description: 'Ordered node IDs forming the path' },
        color: { type: 'string', description: 'Hex colour (e.g. "#22c55e")' },
        label: { type: 'string' },
        is_protection: { type: 'boolean' }
      },
      required: ['node_sequence']
    }
  },

  // ── UI panel tools (client-side) ──
  {
    name: 'open_cable_visor',
    description: 'Open the Cable Visor panel to browse submarine cable systems.',
    input_schema: {
      type: 'object',
      properties: { cable_name: { type: 'string', description: 'Optional cable name filter' } },
      required: []
    }
  },
  {
    name: 'open_datacenter_visor',
    description: 'Open the Datacenter Visor to browse and add datacenters.',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string' } },
      required: []
    }
  },
  {
    name: 'open_pathfinder',
    description: 'LEGACY — opens the Pathfinder UI panel. Prefer run_pathfinder for headless computation.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string' },
        destination: { type: 'string' },
        run_calculation: { type: 'boolean' }
      },
      required: []
    }
  },
  {
    name: 'open_kml_studio',
    description: 'Open the KML Studio for importing KML/GeoJSON data.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'filter_by_tag',
    description: 'Filter the diagram to show only nodes/links with specific tags.',
    input_schema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['include', 'exclude'] }
      },
      required: ['tags']
    }
  },
  {
    name: 'filter_by_cable_system',
    description: 'Filter diagram to show nodes/links in a specific cable system.',
    input_schema: {
      type: 'object',
      properties: { cable_system_name: { type: 'string' } },
      required: ['cable_system_name']
    }
  },
  {
    name: 'filter_by_nodes_or_containers',
    description: 'Filter diagram by node type or container.',
    input_schema: {
      type: 'object',
      properties: {
        node_types: { type: 'array', items: { type: 'string' } },
        container_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'filter_map',
    description: 'Apply map filters (region, technology, provider).',
    input_schema: {
      type: 'object',
      properties: {
        region: { type: 'string' },
        technology: { type: 'string' },
        provider: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'show_route_map',
    description: 'Show or toggle the geographic map view.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_link_info',
    description: 'Get detailed information about a specific link.',
    input_schema: {
      type: 'object',
      properties: { link_id: { type: 'string' } },
      required: ['link_id']
    }
  },
  {
    name: 'clear_all_filters',
    description: 'Clear all active filters and show the full diagram.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_network_summary',
    description: 'Get a high-level network diagram summary.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'show_route_price',
    description: 'Show pricing for a route between two nodes.',
    input_schema: {
      type: 'object',
      properties: { origin: { type: 'string' }, destination: { type: 'string' } },
      required: []
    }
  },
  {
    name: 'create_network_diagram',
    description: 'Open the network data table editor.',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

// ─── CLIENT-SIDE vs SERVER-SIDE TOOL REGISTRY ───────────────────────────────

const SERVER_SIDE_TOOLS = new Set([
  'think',
  'analyse_topology',
  'analyse_capacity',
  'analyse_cost',
  'estimate_latency',
  'get_diagram_stats',
  'find_nodes',
  'suggest_design',
]);

const CLIENT_SIDE_TOOLS = new Set([
  'run_pathfinder',
  'create_node', 'create_link', 'edit_node', 'edit_link',
  'delete_node', 'delete_link',
  'create_full_mesh', 'assign_datacenter',
  'show_heatmap', 'highlight_path',
  'open_cable_visor', 'open_datacenter_visor', 'open_pathfinder', 'open_kml_studio',
  'filter_by_tag', 'filter_by_cable_system', 'filter_by_nodes_or_containers',
  'filter_map', 'show_route_map', 'get_link_info', 'clear_all_filters',
  'get_network_summary', 'show_route_price', 'create_network_diagram',
]);

// ─── SERVER-SIDE TOOL IMPLEMENTATIONS ───────────────────────────────────────

/**
 * Graph analysis utilities operating on diagram state.
 */
const GraphAnalysis = {
  /**
   * Build an adjacency list from diagram state.
   */
  buildAdjacency(diagramState) {
    const adj = {};
    const nodes = diagramState?.nodes || [];
    const links = diagramState?.links || [];

    for (const n of nodes) {
      adj[n.id] = [];
    }
    for (const l of links) {
      const src = l.source || l.a;
      const tgt = l.target || l.b;
      if (adj[src]) adj[src].push({ node: tgt, link: l });
      if (adj[tgt]) adj[tgt].push({ node: src, link: l });
    }
    return adj;
  },

  /**
   * BFS connectivity check. Returns connected components.
   */
  connectedComponents(adj) {
    const visited = new Set();
    const components = [];

    for (const nodeId of Object.keys(adj)) {
      if (visited.has(nodeId)) continue;
      const component = [];
      const queue = [nodeId];
      visited.add(nodeId);
      while (queue.length > 0) {
        const current = queue.shift();
        component.push(current);
        for (const neighbor of adj[current]) {
          if (!visited.has(neighbor.node)) {
            visited.add(neighbor.node);
            queue.push(neighbor.node);
          }
        }
      }
      components.push(component);
    }
    return components;
  },

  /**
   * Find articulation points (single points of failure for nodes).
   */
  articulationPoints(adj) {
    const nodeIds = Object.keys(adj);
    if (nodeIds.length === 0) return [];

    const disc = {};
    const low = {};
    const parent = {};
    const ap = new Set();
    let timer = 0;

    function dfs(u) {
      let children = 0;
      disc[u] = low[u] = timer++;
      for (const neighbor of adj[u]) {
        const v = neighbor.node;
        if (disc[v] === undefined) {
          children++;
          parent[v] = u;
          dfs(v);
          low[u] = Math.min(low[u], low[v]);
          if (parent[u] === undefined && children > 1) ap.add(u);
          if (parent[u] !== undefined && low[v] >= disc[u]) ap.add(u);
        } else if (v !== parent[u]) {
          low[u] = Math.min(low[u], disc[v]);
        }
      }
    }

    for (const nodeId of nodeIds) {
      if (disc[nodeId] === undefined) {
        dfs(nodeId);
      }
    }

    return [...ap];
  },

  /**
   * Find bridge links (single points of failure for links).
   */
  bridgeLinks(adj, links) {
    const nodeIds = Object.keys(adj);
    if (nodeIds.length === 0) return [];

    const disc = {};
    const low = {};
    const parent = {};
    const bridges = [];
    let timer = 0;

    function dfs(u) {
      disc[u] = low[u] = timer++;
      for (const neighbor of adj[u]) {
        const v = neighbor.node;
        if (disc[v] === undefined) {
          parent[v] = u;
          dfs(v);
          low[u] = Math.min(low[u], low[v]);
          if (low[v] > disc[u]) {
            bridges.push(neighbor.link);
          }
        } else if (v !== parent[u]) {
          low[u] = Math.min(low[u], disc[v]);
        }
      }
    }

    for (const nodeId of nodeIds) {
      if (disc[nodeId] === undefined) {
        dfs(nodeId);
      }
    }

    return bridges;
  },

  /**
   * Compute degree distribution of the graph.
   */
  degreeDistribution(adj) {
    const degrees = {};
    for (const [nodeId, neighbors] of Object.entries(adj)) {
      degrees[nodeId] = neighbors.length;
    }
    const values = Object.values(degrees);
    return {
      per_node: degrees,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      avg: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : 0,
      leaf_nodes: values.filter(d => d === 1).length,
      isolated_nodes: values.filter(d => d === 0).length,
    };
  },

  /**
   * Haversine distance in km between two geographic coordinates.
   */
  haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /**
   * Estimate fiber latency from coordinates.
   * Standard single-mode fiber: ~4.9 µs/km (refractive index ~1.468, speed of light / n).
   */
  estimateFiberLatencyMs(lat1, lon1, lat2, lon2, routeFactor = 1.3) {
    const distKm = this.haversineKm(lat1, lon1, lat2, lon2) * routeFactor;
    const latencyMs = distKm * 0.0049; // 4.9 µs/km = 0.0049 ms/km
    return {
      straight_line_km: Math.round(this.haversineKm(lat1, lon1, lat2, lon2)),
      cable_route_km: Math.round(distKm),
      route_factor: routeFactor,
      one_way_latency_ms: Math.round(latencyMs * 10) / 10,
      round_trip_latency_ms: Math.round(latencyMs * 2 * 10) / 10,
    };
  },
};

/**
 * Execute a server-side tool and return the result.
 */
function executeServerTool(toolName, toolInput, diagramState) {
  const d = diagramState || { nodes: [], links: [], groups: [] };
  const nodes = d.nodes || [];
  const links = d.links || [];

  switch (toolName) {
    case 'think': {
      // The thinking tool is purely for the model's internal reasoning.
      // We acknowledge it so the loop continues.
      return { status: 'ok', message: 'Internal reasoning noted. Proceed with your plan.' };
    }

    case 'get_diagram_stats': {
      const totalBw = links.reduce((s, l) => s + (l.bandwidth_gbps || 0), 0);
      const avgLat = links.length
        ? Math.round(links.reduce((s, l) => s + (l.latency_ms || 0), 0) / links.length * 10) / 10
        : 0;
      const totalCost = links.reduce((s, l) => s + (l.price_usd || 0), 0);

      const techBreakdown = {};
      for (const l of links) {
        const tech = l.technology || 'unspecified';
        techBreakdown[tech] = (techBreakdown[tech] || 0) + 1;
      }

      const nodeTypeBreakdown = {};
      for (const n of nodes) {
        const t = n.type || 'city';
        nodeTypeBreakdown[t] = (nodeTypeBreakdown[t] || 0) + 1;
      }

      const allTags = new Set();
      for (const n of nodes) (n.tags || []).forEach(t => allTags.add(t));
      for (const l of links) (l.tags || []).forEach(t => allTags.add(t));

      // Network density = actual links / max possible links (n*(n-1)/2)
      const maxLinks = nodes.length > 1 ? nodes.length * (nodes.length - 1) / 2 : 0;
      const density = maxLinks > 0 ? Math.round(links.length / maxLinks * 1000) / 1000 : 0;

      return {
        node_count: nodes.length,
        link_count: links.length,
        group_count: (d.groups || []).length,
        total_bandwidth_gbps: totalBw,
        average_latency_ms: avgLat,
        total_monthly_cost_usd: totalCost,
        network_density: density,
        technologies: techBreakdown,
        node_types: nodeTypeBreakdown,
        unique_tags: [...allTags],
      };
    }

    case 'analyse_topology': {
      const adj = GraphAnalysis.buildAdjacency(d);
      const components = GraphAnalysis.connectedComponents(adj);
      const artPoints = GraphAnalysis.articulationPoints(adj);
      const bridges = GraphAnalysis.bridgeLinks(adj, links);
      const degrees = GraphAnalysis.degreeDistribution(adj);

      // Map IDs back to labels for readability
      const nodeMap = {};
      for (const n of nodes) nodeMap[n.id] = n.label;

      const artPointLabels = artPoints.map(id => nodeMap[id] || id);
      const bridgeLabels = bridges.map(l => {
        const src = l.source || l.a;
        const tgt = l.target || l.b;
        return `${nodeMap[src] || src} ↔ ${nodeMap[tgt] || tgt}${l.label ? ` (${l.label})` : ''}`;
      });

      // Redundancy score: minimum degree (excluding isolated nodes)
      const activeNodeDegrees = Object.values(degrees.per_node).filter(d => d > 0);
      const minDegree = activeNodeDegrees.length ? Math.min(...activeNodeDegrees) : 0;

      const result = {
        is_connected: components.length <= 1,
        connected_components: components.length,
        component_sizes: components.map(c => c.length),
        articulation_points: artPointLabels,
        articulation_point_count: artPoints.length,
        bridge_links: bridgeLabels,
        bridge_count: bridges.length,
        degree_distribution: {
          min: degrees.min,
          max: degrees.max,
          average: degrees.avg,
          leaf_nodes: degrees.leaf_nodes,
          isolated_nodes: degrees.isolated_nodes,
        },
        redundancy_score: minDegree >= 2 ? 'good' : minDegree === 1 ? 'partial' : 'none',
        min_node_degree: minDegree,
      };

      if (toolInput.include_recommendations !== false) {
        const recs = [];
        if (!result.is_connected) {
          recs.push(`Network is disconnected (${components.length} components). Add links to connect isolated segments.`);
        }
        if (artPoints.length > 0) {
          recs.push(`${artPoints.length} single points of failure: ${artPointLabels.join(', ')}. Add bypass links to eliminate these.`);
        }
        if (bridges.length > 0) {
          recs.push(`${bridges.length} bridge link(s) with no redundancy: ${bridgeLabels.join('; ')}. Add parallel paths.`);
        }
        if (degrees.leaf_nodes > 0) {
          const leafIds = Object.entries(degrees.per_node).filter(([, d]) => d === 1).map(([id]) => nodeMap[id] || id);
          recs.push(`${degrees.leaf_nodes} leaf node(s) (single connection): ${leafIds.join(', ')}. Consider adding second links for resilience.`);
        }
        if (minDegree >= 2 && artPoints.length === 0 && bridges.length === 0) {
          recs.push('Network topology has good redundancy — no single points of failure detected.');
        }
        result.recommendations = recs;
      }

      return result;
    }

    case 'analyse_capacity': {
      if (links.length === 0) {
        return { status: 'empty', message: 'No links in the diagram to analyse.' };
      }

      const nodeMap = {};
      for (const n of nodes) nodeMap[n.id] = n.label;

      // Sort links by bandwidth to find bottlenecks
      const linksWithBw = links.filter(l => l.bandwidth_gbps > 0);
      const sorted = [...linksWithBw].sort((a, b) => a.bandwidth_gbps - b.bandwidth_gbps);
      const bottlenecks = sorted.slice(0, 5).map(l => ({
        link: `${nodeMap[l.source || l.a] || l.source || l.a} ↔ ${nodeMap[l.target || l.b] || l.target || l.b}`,
        label: l.label || '',
        bandwidth_gbps: l.bandwidth_gbps,
      }));

      // Bandwidth by technology
      const bwByTech = {};
      for (const l of links) {
        const tech = l.technology || 'unspecified';
        bwByTech[tech] = (bwByTech[tech] || 0) + (l.bandwidth_gbps || 0);
      }

      // Total and average
      const totalBw = links.reduce((s, l) => s + (l.bandwidth_gbps || 0), 0);
      const avgBw = links.length ? Math.round(totalBw / links.length * 10) / 10 : 0;

      // Identify overprovisioned (>10x average) and underprovisioned (<0.1x average) links
      const overprovisioned = links.filter(l => (l.bandwidth_gbps || 0) > avgBw * 10).map(l => ({
        link: `${nodeMap[l.source || l.a] || ''} ↔ ${nodeMap[l.target || l.b] || ''}`,
        bandwidth_gbps: l.bandwidth_gbps,
        ratio_to_avg: Math.round((l.bandwidth_gbps / avgBw) * 10) / 10,
      }));
      const underprovisioned = linksWithBw.filter(l => l.bandwidth_gbps < avgBw * 0.1).map(l => ({
        link: `${nodeMap[l.source || l.a] || ''} ↔ ${nodeMap[l.target || l.b] || ''}`,
        bandwidth_gbps: l.bandwidth_gbps,
        ratio_to_avg: Math.round((l.bandwidth_gbps / avgBw) * 10) / 10,
      }));

      const result = {
        total_bandwidth_gbps: totalBw,
        average_bandwidth_gbps: avgBw,
        links_with_bandwidth: linksWithBw.length,
        links_without_bandwidth: links.length - linksWithBw.length,
        bottleneck_links: bottlenecks,
        bandwidth_by_technology: bwByTech,
        overprovisioned_links: overprovisioned,
        underprovisioned_links: underprovisioned,
      };

      // Simple max-flow estimate (min-cut) if source/target specified
      if (toolInput.source_node_id && toolInput.target_node_id) {
        // Use BFS to find all paths and compute a naive min-cut approximation
        const adj = GraphAnalysis.buildAdjacency(d);
        const src = toolInput.source_node_id;
        const tgt = toolInput.target_node_id;

        // Count min-cut: number of link-disjoint paths (Menger's theorem approximation)
        let disjointPaths = 0;
        const usedLinks = new Set();
        for (let attempt = 0; attempt < 20; attempt++) {
          const visited = new Set([src]);
          const queue = [[src, []]]; // [nodeId, path of link IDs]
          let found = false;
          while (queue.length > 0) {
            const [curr, path] = queue.shift();
            if (curr === tgt) {
              disjointPaths++;
              for (const linkId of path) usedLinks.add(linkId);
              found = true;
              break;
            }
            for (const neighbor of (adj[curr] || [])) {
              if (!visited.has(neighbor.node) && !usedLinks.has(neighbor.link.id)) {
                visited.add(neighbor.node);
                queue.push([neighbor.node, [...path, neighbor.link.id]]);
              }
            }
          }
          if (!found) break;
        }

        result.max_flow_estimate = {
          source: nodeMap[src] || src,
          target: nodeMap[tgt] || tgt,
          link_disjoint_paths: disjointPaths,
          min_bandwidth_across_paths_gbps: 'requires detailed max-flow computation',
        };
      }

      return result;
    }

    case 'analyse_cost': {
      if (links.length === 0) {
        return { status: 'empty', message: 'No links in the diagram to analyse.' };
      }

      const nodeMap = {};
      for (const n of nodes) nodeMap[n.id] = n.label;

      const linksWithCost = links.filter(l => l.price_usd > 0);
      const totalCost = linksWithCost.reduce((s, l) => s + l.price_usd, 0);
      const totalBw = linksWithCost.reduce((s, l) => s + (l.bandwidth_gbps || 0), 0);

      // Cost per Gbps for each link
      const costEfficiency = linksWithCost
        .filter(l => l.bandwidth_gbps > 0)
        .map(l => ({
          link: `${nodeMap[l.source || l.a] || ''} ↔ ${nodeMap[l.target || l.b] || ''}`,
          label: l.label || '',
          price_usd: l.price_usd,
          bandwidth_gbps: l.bandwidth_gbps,
          cost_per_gbps: Math.round(l.price_usd / l.bandwidth_gbps * 100) / 100,
        }))
        .sort((a, b) => a.cost_per_gbps - b.cost_per_gbps);

      // Cost by technology
      const costByTech = {};
      for (const l of linksWithCost) {
        const tech = l.technology || 'unspecified';
        costByTech[tech] = (costByTech[tech] || 0) + l.price_usd;
      }

      return {
        total_monthly_cost_usd: totalCost,
        total_annual_cost_usd: totalCost * 12,
        links_with_cost_data: linksWithCost.length,
        links_without_cost_data: links.length - linksWithCost.length,
        average_cost_per_gbps: totalBw > 0 ? Math.round(totalCost / totalBw * 100) / 100 : null,
        cost_by_technology: costByTech,
        most_cost_effective: costEfficiency.slice(0, 3),
        least_cost_effective: costEfficiency.slice(-3).reverse(),
      };
    }

    case 'estimate_latency': {
      const { lat1, lon1, lat2, lon2, cable_route_factor } = toolInput;
      const factor = cable_route_factor || 1.3;
      return GraphAnalysis.estimateFiberLatencyMs(lat1, lon1, lat2, lon2, factor);
    }

    case 'find_nodes': {
      let results = [...nodes];

      if (toolInput.query) {
        const q = toolInput.query.toLowerCase();
        results = results.filter(n =>
          n.label?.toLowerCase().includes(q) ||
          n.id?.toLowerCase().includes(q)
        );
      }
      if (toolInput.type) {
        results = results.filter(n => n.type === toolInput.type);
      }
      if (toolInput.tag) {
        results = results.filter(n => (n.tags || []).includes(toolInput.tag));
      }
      if (toolInput.datacenter) {
        const dcQ = toolInput.datacenter.toLowerCase();
        results = results.filter(n => n.datacenter?.toLowerCase().includes(dcQ));
      }

      return {
        count: results.length,
        nodes: results.map(n => ({
          id: n.id,
          label: n.label,
          type: n.type || 'city',
          tags: n.tags || [],
          datacenter: n.datacenter || null,
        })),
      };
    }

    case 'suggest_design': {
      // This tool returns structured context that the LLM then interprets
      // and uses to formulate design recommendations.
      const adj = GraphAnalysis.buildAdjacency(d);
      const components = GraphAnalysis.connectedComponents(adj);
      const degrees = GraphAnalysis.degreeDistribution(adj);
      const artPoints = GraphAnalysis.articulationPoints(adj);
      const bridges = GraphAnalysis.bridgeLinks(adj, links);
      const nodeMap = {};
      for (const n of nodes) nodeMap[n.id] = n.label;

      return {
        goal: toolInput.goal,
        constraints: toolInput.constraints || {},
        current_analysis: {
          node_count: nodes.length,
          link_count: links.length,
          is_connected: components.length <= 1,
          components: components.length,
          articulation_points: artPoints.map(id => nodeMap[id] || id),
          bridges: bridges.map(l => `${nodeMap[l.source || l.a] || ''} ↔ ${nodeMap[l.target || l.b] || ''}`),
          degree_distribution: degrees,
          total_bandwidth_gbps: links.reduce((s, l) => s + (l.bandwidth_gbps || 0), 0),
          total_monthly_cost_usd: links.reduce((s, l) => s + (l.price_usd || 0), 0),
          technologies_used: [...new Set(links.map(l => l.technology).filter(Boolean))],
        },
        instruction: 'Based on this analysis and the stated goal, provide specific, actionable design recommendations. Reference specific nodes by label when suggesting new links or modifications. If the user needs new nodes, specify recommended labels, types, and connections.',
      };
    }

    default:
      return { status: 'error', message: `Unknown server tool: ${toolName}` };
  }
}

// ─── CONVERSATION MEMORY MANAGEMENT ─────────────────────────────────────────

/**
 * Build a compact summary of long conversation history to fit in context.
 * Keeps the last N messages verbatim and summarises earlier ones.
 */
function manageConversationMemory(messages) {
  if (messages.length <= CONFIG.MEMORY_SUMMARY_THRESHOLD) {
    return { messages, sessionMemory: null };
  }

  // Keep the last 20 messages verbatim, summarise the rest
  const keepCount = 20;
  const toSummarise = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

  // Extract key facts from summarised messages
  const keyFacts = [];
  const actions = [];

  for (const msg of toSummarise) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      if (msg.content.length > 20) {
        keyFacts.push(`User asked: "${msg.content.slice(0, 100)}${msg.content.length > 100 ? '…' : ''}"`);
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          actions.push(`Called ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
        }
      }
    }
  }

  const summary = [
    `Earlier in this conversation (${toSummarise.length} messages summarised):`,
    ...keyFacts.slice(-10),
    actions.length > 0 ? `Actions taken: ${actions.slice(-10).join('; ')}` : '',
  ].filter(Boolean).join('\n');

  return {
    messages: toKeep,
    sessionMemory: { summary, keyFacts: keyFacts.slice(-5) },
  };
}

// ─── ANTHROPIC API CALL ─────────────────────────────────────────────────────

async function callAnthropic(messages, apiKey, systemPrompt, stream = false) {
  const body = {
    model: CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }
    ],
    tools: NEXIMAP_TOOLS,
    messages,
  };

  if (stream) {
    body.stream = true;
  }

  return fetch(CONFIG.ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
  });
}

// ─── AGENTIC LOOP ───────────────────────────────────────────────────────────

/**
 * Full-loop multitask agentic execution.
 *
 * The loop handles:
 *   1. Server-side tools (think, analyse_*, find_nodes, etc.) — resolved in-worker
 *   2. Client-side tools (create_node, run_pathfinder, etc.) — returned to frontend
 *   3. Parallel tool calls — all server-side tools in a batch resolved together
 *   4. Mixed batches — server tools resolved, first client tool returned to frontend
 *   5. Max iteration limit with graceful termination
 *
 * @param {Array}       messages           Conversation history
 * @param {string}      apiKey             Anthropic API key
 * @param {object|null} diagramState       Current canvas snapshot
 * @param {object|null} incomingToolResult { tool_use_id, content } from frontend
 * @returns {object} { type: 'final'|'needs_tool', ... }
 */
async function agentLoop(messages, apiKey, diagramState, incomingToolResult) {
  // If continuing after a client-side tool execution, append the result
  if (incomingToolResult) {
    // Support both single and batch tool results
    const results = Array.isArray(incomingToolResult) ? incomingToolResult : [incomingToolResult];
    const toolResultBlocks = results.map(r => ({
      type: 'tool_result',
      tool_use_id: r.tool_use_id,
      content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
    }));
    messages.push({ role: 'user', content: toolResultBlocks });
  }

  // Manage memory for long conversations
  const { messages: managedMessages, sessionMemory } = manageConversationMemory(messages);
  const workingMessages = [...managedMessages];

  const systemPrompt = buildSystemPrompt(diagramState, sessionMemory);

  // Track actions for the response
  const executedActions = [];

  for (let iter = 0; iter < CONFIG.MAX_AGENT_ITERATIONS; iter++) {
    const res = await callAnthropic(workingMessages, apiKey, systemPrompt);

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Anthropic API error (iter ${iter}):`, res.status, errText);

      // Retry on 529 (overloaded) with backoff
      if (res.status === 529 && iter < CONFIG.MAX_AGENT_ITERATIONS - 1) {
        await new Promise(r => setTimeout(r, 1000 * (iter + 1)));
        continue;
      }

      return {
        type: 'final',
        text: `API error ${res.status}. Please try again.`,
        actions: executedActions,
        error: errText.slice(0, 200),
      };
    }

    const claude = await res.json();

    // ── Natural end ─────────────────────────────────────────────────────
    if (claude.stop_reason === 'end_turn') {
      const text = claude.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      return {
        type: 'final',
        text: text || '(Done)',
        actions: executedActions,
        iterations_used: iter + 1,
      };
    }

    // ── Tool use ────────────────────────────────────────────────────────
    if (claude.stop_reason === 'tool_use') {
      // Append assistant message to conversation
      workingMessages.push({ role: 'assistant', content: claude.content });

      const toolUses = claude.content.filter(b => b.type === 'tool_use');
      const textBlocks = claude.content.filter(b => b.type === 'text');
      const partialText = textBlocks.map(b => b.text).join('');

      // Separate server-side and client-side tools
      const serverTools = toolUses.filter(t => SERVER_SIDE_TOOLS.has(t.name));
      const clientTools = toolUses.filter(t => CLIENT_SIDE_TOOLS.has(t.name));

      // Execute ALL server-side tools in parallel
      const serverResults = [];
      for (const tool of serverTools) {
        const result = executeServerTool(tool.name, tool.input, diagramState);
        serverResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        });

        // Track non-think actions
        if (tool.name !== 'think') {
          executedActions.push({
            tool: tool.name,
            input: tool.input,
            result_summary: typeof result === 'object' ? (result.status || 'computed') : 'ok',
          });
        }
      }

      // If there are client-side tools, we need to return to the frontend
      if (clientTools.length > 0) {
        // But first, we need to provide server-side results
        // If there are server results pending, append them and the client tools
        // will be returned to the frontend for execution

        if (serverResults.length > 0) {
          // We have a mixed batch. Provide server results first,
          // then return the first client tool to the frontend.
          // The remaining client tools will be handled in subsequent iterations.
          workingMessages.push({ role: 'user', content: serverResults });

          // Continue the loop — the LLM will see server results and may
          // decide to proceed with client tools or change course
          continue;
        }

        // Pure client-side tool call(s) — return to frontend
        const firstClientTool = clientTools[0];
        executedActions.push({
          tool: firstClientTool.name,
          input: firstClientTool.input,
          side: 'client',
        });

        return {
          type: 'needs_tool',
          tool_call: {
            id: firstClientTool.id,
            name: firstClientTool.name,
            params: firstClientTool.input,
          },
          // If multiple client tools, queue the rest
          queued_tool_calls: clientTools.slice(1).map(t => ({
            id: t.id,
            name: t.name,
            params: t.input,
          })),
          partial_text: partialText || undefined,
          partial_messages: workingMessages,
          actions: executedActions,
          iterations_used: iter + 1,
        };
      }

      // All tools were server-side — append results and continue
      if (serverResults.length > 0) {
        workingMessages.push({ role: 'user', content: serverResults });
        continue;
      }
    }

    // Unexpected stop reason
    console.warn('Unexpected stop_reason:', claude.stop_reason);
    const fallbackText = claude.content
      ?.filter(b => b.type === 'text')
      ?.map(b => b.text)
      ?.join('') || '';
    if (fallbackText) {
      return {
        type: 'final',
        text: fallbackText,
        actions: executedActions,
        iterations_used: iter + 1,
      };
    }
    break;
  }

  // Iteration limit reached
  return {
    type: 'final',
    text: 'I completed the requested operations.',
    actions: executedActions,
    iterations_used: CONFIG.MAX_AGENT_ITERATIONS,
    max_iterations_reached: true,
  };
}

// ─── STREAMING AGENTIC LOOP ────────────────────────────────────────────────

/**
 * Stream-based agentic loop using Server-Sent Events.
 * Sends incremental updates to the client as the agent reasons and acts.
 */
async function agentLoopStreaming(messages, apiKey, diagramState, incomingToolResult, writable) {
  const encoder = new TextEncoder();
  const writer = writable.getWriter();

  function sendEvent(event, data) {
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  // Append incoming tool result if present
  if (incomingToolResult) {
    const results = Array.isArray(incomingToolResult) ? incomingToolResult : [incomingToolResult];
    const toolResultBlocks = results.map(r => ({
      type: 'tool_result',
      tool_use_id: r.tool_use_id,
      content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
    }));
    messages.push({ role: 'user', content: toolResultBlocks });
  }

  const { messages: managedMessages, sessionMemory } = manageConversationMemory(messages);
  const workingMessages = [...managedMessages];
  const systemPrompt = buildSystemPrompt(diagramState, sessionMemory);
  const executedActions = [];

  sendEvent('agent_start', { max_iterations: CONFIG.MAX_AGENT_ITERATIONS });

  for (let iter = 0; iter < CONFIG.MAX_AGENT_ITERATIONS; iter++) {
    sendEvent('iteration_start', { iteration: iter + 1 });

    const res = await callAnthropic(workingMessages, apiKey, systemPrompt, false);

    if (!res.ok) {
      const errText = await res.text();
      sendEvent('error', { status: res.status, message: errText.slice(0, 200) });

      if (res.status === 529 && iter < CONFIG.MAX_AGENT_ITERATIONS - 1) {
        sendEvent('retry', { wait_ms: 1000 * (iter + 1) });
        await new Promise(r => setTimeout(r, 1000 * (iter + 1)));
        continue;
      }

      sendEvent('agent_end', {
        type: 'final',
        text: `API error ${res.status}`,
        actions: executedActions,
      });
      writer.close();
      return;
    }

    const claude = await res.json();

    if (claude.stop_reason === 'end_turn') {
      const text = claude.content.filter(b => b.type === 'text').map(b => b.text).join('');
      sendEvent('text', { content: text });
      sendEvent('agent_end', {
        type: 'final',
        text,
        actions: executedActions,
        iterations_used: iter + 1,
      });
      writer.close();
      return;
    }

    if (claude.stop_reason === 'tool_use') {
      workingMessages.push({ role: 'assistant', content: claude.content });

      const toolUses = claude.content.filter(b => b.type === 'tool_use');
      const textBlocks = claude.content.filter(b => b.type === 'text');

      if (textBlocks.length > 0) {
        sendEvent('text', { content: textBlocks.map(b => b.text).join('') });
      }

      const serverTools = toolUses.filter(t => SERVER_SIDE_TOOLS.has(t.name));
      const clientTools = toolUses.filter(t => CLIENT_SIDE_TOOLS.has(t.name));

      // Execute server tools and stream progress
      const serverResults = [];
      for (const tool of serverTools) {
        sendEvent('tool_start', { name: tool.name, input: tool.input });
        const result = executeServerTool(tool.name, tool.input, diagramState);
        serverResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        });
        sendEvent('tool_result', { name: tool.name, result });
        if (tool.name !== 'think') {
          executedActions.push({ tool: tool.name, input: tool.input });
        }
      }

      if (clientTools.length > 0) {
        if (serverResults.length > 0) {
          workingMessages.push({ role: 'user', content: serverResults });
          continue;
        }

        const firstClientTool = clientTools[0];
        executedActions.push({ tool: firstClientTool.name, input: firstClientTool.input, side: 'client' });

        sendEvent('needs_tool', {
          tool_call: { id: firstClientTool.id, name: firstClientTool.name, params: firstClientTool.input },
          queued_tool_calls: clientTools.slice(1).map(t => ({ id: t.id, name: t.name, params: t.input })),
          partial_messages: workingMessages,
          actions: executedActions,
          iterations_used: iter + 1,
        });
        writer.close();
        return;
      }

      if (serverResults.length > 0) {
        workingMessages.push({ role: 'user', content: serverResults });
        continue;
      }
    }

    console.warn('Unexpected stop_reason:', claude.stop_reason);
    break;
  }

  sendEvent('agent_end', {
    type: 'final',
    text: 'I completed the requested operations.',
    actions: executedActions,
    iterations_used: CONFIG.MAX_AGENT_ITERATIONS,
    max_iterations_reached: true,
  });
  writer.close();
}

// ─── SESSION PERSISTENCE (KV) ───────────────────────────────────────────────

async function loadSession(sessionId, env) {
  if (!sessionId || !env?.NEXIMAP_SESSIONS) return null;
  try {
    const data = await env.NEXIMAP_SESSIONS.get(`session:${sessionId}`, { type: 'json' });
    return data;
  } catch (e) {
    console.warn('Failed to load session:', e.message);
    return null;
  }
}

async function saveSession(sessionId, data, env) {
  if (!sessionId || !env?.NEXIMAP_SESSIONS) return;
  try {
    await env.NEXIMAP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify(data),
      { expirationTtl: CONFIG.SESSION_TTL_SECONDS }
    );
  } catch (e) {
    console.warn('Failed to save session:', e.message);
  }
}

// ─── HEALTH CHECK ENDPOINT ──────────────────────────────────────────────────

function handleHealthCheck() {
  return new Response(JSON.stringify({
    status: 'ok',
    version: 'phase-3',
    model: CONFIG.MODEL,
    max_iterations: CONFIG.MAX_AGENT_ITERATIONS,
    capabilities: [
      'multi-step-reasoning',
      'parallel-tool-execution',
      'server-side-topology-analysis',
      'capacity-planning',
      'cost-analysis',
      'latency-estimation',
      'conversation-memory',
      'streaming-sse',
      'session-persistence',
      'error-recovery',
      'design-suggestions',
    ],
    server_tools: [...SERVER_SIDE_TOOLS],
    client_tools: [...CLIENT_SIDE_TOOLS],
  }), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ─── MAIN REQUEST HANDLER ───────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (request.method === 'GET') {
      return handleHealthCheck();
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    try {
      const apiKey = env?.ANTHROPIC_API_KEY || (typeof ANTHROPIC_API_KEY !== 'undefined' ? ANTHROPIC_API_KEY : null);
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY secret not configured' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const body = await request.json();
      const {
        message = null,
        conversation_history = [],
        diagram_state = null,
        tool_result = null,
        session_id = null,
        stream = false,
      } = body;

      // Load session if available
      let session = await loadSession(session_id, env);

      // Build messages from history + session
      let messages = session?.conversation_history || [...conversation_history];

      // Append new user message
      if (message) {
        messages.push({ role: 'user', content: message });
      }

      // Streaming mode
      if (stream || request.headers.get('X-Stream') === 'true') {
        const { readable, writable } = new TransformStream();

        ctx.waitUntil((async () => {
          try {
            await agentLoopStreaming(messages, apiKey, diagram_state, tool_result, writable);
          } catch (err) {
            const encoder = new TextEncoder();
            const writer = writable.getWriter();
            writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`));
            writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // Standard (non-streaming) mode
      const result = await agentLoop(messages, apiKey, diagram_state, tool_result);

      // Save session if session_id provided
      if (session_id && result.type === 'final') {
        // Append the final assistant message to the conversation for persistence
        messages.push({ role: 'assistant', content: result.text });
        await saveSession(session_id, {
          conversation_history: messages.slice(-50), // Keep last 50 messages
          last_active: Date.now(),
        }, env);
      } else if (session_id && result.type === 'needs_tool') {
        await saveSession(session_id, {
          conversation_history: result.partial_messages,
          last_active: Date.now(),
        }, env);
      }

      return new Response(JSON.stringify(result), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({
        type: 'final',
        text: 'An internal error occurred. Please try again.',
        error: err.message,
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};

// ─── BACKWARD COMPATIBILITY: Service Worker syntax ──────────────────────────
// Support both ES module (export default) and Service Worker (addEventListener)
// so this works in both Wrangler and the Dashboard editor.
if (typeof addEventListener === 'function') {
  addEventListener('fetch', event => {
    // Shim: create a minimal env from global bindings
    const env = {};
    if (typeof ANTHROPIC_API_KEY !== 'undefined') env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
    if (typeof NEXIMAP_SESSIONS !== 'undefined') env.NEXIMAP_SESSIONS = NEXIMAP_SESSIONS;

    const handler = {
      async fetch(request, env, ctx) {
        // Delegate to the module handler
        const mod = { fetch: arguments.callee };
        // Re-implement inline to avoid circular ref
        return handleRequestLegacy(request, env);
      }
    };

    event.respondWith(handleRequestLegacy(event.request, env));
  });
}

async function handleRequestLegacy(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    return handleHealthCheck();
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }

  try {
    const apiKey = env?.ANTHROPIC_API_KEY || (typeof ANTHROPIC_API_KEY !== 'undefined' ? ANTHROPIC_API_KEY : null);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY secret not configured' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json();
    const {
      message = null,
      conversation_history = [],
      diagram_state = null,
      tool_result = null,
    } = body;

    let messages = [...conversation_history];
    if (message) {
      messages.push({ role: 'user', content: message });
    }

    const result = await agentLoop(messages, apiKey, diagram_state, tool_result);

    return new Response(JSON.stringify(result), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Worker error:', err);
    return new Response(JSON.stringify({
      type: 'final',
      text: 'An internal error occurred. Please try again.',
      error: err.message,
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
