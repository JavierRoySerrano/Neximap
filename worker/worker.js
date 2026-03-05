/**
 * NexiMap AI Agent — Phase 2 Cloudflare Worker
 * Full agentic tool-use loop with diagram-state awareness.
 *
 * Deploy: copy this file into the Cloudflare Dashboard editor
 *         Workers & Pages → neximap-ai-agent → Edit Code → paste → Save and Deploy
 *
 * Required secret binding: ANTHROPIC_API_KEY (set in Worker settings → Variables & Secrets)
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `You are Nexi, an AI solutions architect embedded in NexiMap Studio — a professional network diagram and topology design tool used by network engineers and solutions architects.

You are an ACTIVE agent — always prefer calling a tool over just advising. When the user asks to create a node, CREATE IT. When asked for a route, RUN the pathfinder and narrate the result.

## Your capabilities
- Create and edit nodes (cities, datacenters, submarine cable landings, exchange points)
- Create and edit links with latency, bandwidth, pricing, and technology attributes
- Delete nodes and links
- Create full mesh topologies between a set of nodes
- Run the headless pathfinder to compute K-shortest paths and diverse protection paths
- Assign datacenters to nodes
- Show heatmap overlays (capacity, price)
- Highlight paths on the canvas
- Get diagram statistics server-side
- Geolocate any node by city name, address, or explicit lat/lon coordinates (use geolocate_node)

## Tool usage guidelines
- Use node IDs (not labels) in all tool calls
- Use the diagram state to map user references (e.g. "Madrid", "the Frankfurt node") to node IDs before calling tools
- When creating nodes without specified positions, omit x/y — the frontend auto-positions them
- When asked for a route between locations, identify the matching node IDs first, then call run_pathfinder
- For geolocation: ALWAYS use geolocate_node (not edit_node) to set real GPS coordinates on a node. If the user gives a city name, pass it as city_name; if they give explicit coordinates, pass lat/lon directly. geolocate_node resolves and stores gpsLat/gpsLon — this is the ONLY way to set real-world coordinates. edit_node.address is just a display text field, it does NOT set GPS coordinates. After geolocation remind the user to switch to Geo or Map view to see the node plotted geographically
- When the user asks to reposition nodes based on real-world geography ("place nodes on a map", "arrange nodes by location", "move nodes proportionally to their geographic position"): (1) Call geolocate_node for each node — it updates both gpsLat/gpsLon AND the canvas pos:(x,y) simultaneously. (2) Do NOT attempt to compute canvas pixel coordinates from GPS values manually. (3) After geolocate_node returns { status: 'ok', x, y }, confirm to the user that the node has been placed at canvas position (x,y). Never narrate canvas repositioning unless a tool result confirms updated x,y values.
- When the diagram shows a node with gps: data, use those coordinates for geographic reasoning (distance, region, country). The pos: (x,y) values are canvas pixel positions and must NOT be interpreted as geographic coordinates

## Narrating pathfinder results
When you receive a tool_result containing pathfinder data, narrate it conversationally:
- Primary routes: list hops by node label (not ID), total latency ms, hop count
- Protection path: list hops, confirm it is fully link-diverse from primary, mention latency overhead percentage
- If no path found: explain why (disconnected graph, filters too strict) and suggest topology improvements

## After canvas actions
After executing canvas actions, always read the 'action' field in the tool result to describe what happened — do NOT infer creation status from the diagram state snapshot (it reflects state *after* your tool ran, so a newly created item will always appear there):
- action: "created" → the item was **just created** by you. Say e.g. "I created node 'Paris'" or "I created a link between X and Y."
- action: "already_existed" → the item existed before your call. Say e.g. "Node 'Paris' already existed, so no duplicate was created."
- For edit/delete operations (no 'action' field), confirm what property was changed or that the item was removed.

## Canvas views
NexiMap has three canvas views:
- **Main** — standard schematic diagram view (default)
- **Geo** — diagram overlaid on a static world map background
- **Map** — diagram overlaid on an interactive OpenStreetMap

To switch views, ALWAYS use the \`switch_view\` tool with \`view: "main"\`, \`"geo"\`, or \`"map"\`.
NEVER use \`show_route_map\` to switch views — it opens the Route Finder panel with waypoints, not the map view.

## Node positioning guidelines
When creating multiple nodes, their canvas positions should reflect approximate real-world geographic relationships:
- Cities further apart geographically should be placed further apart on the canvas
- European cities should cluster together, Asian cities together, etc.
- Use the create_node tool WITHOUT x/y parameters — the frontend will auto-resolve geographic positions from the city label using its built-in city GPS database
- After creating city nodes, call geolocate_node for each node to assign precise GPS coordinates. This enables the Geo and Map views
- If a node's gps field shows "none" in the diagram state, it has not been geolocated yet

## General guidance
- For complex topologies, break work into sequential steps and execute each one
- When users mention city names, check the current diagram state for existing matching nodes before creating new ones
- Suggest architecture improvements when analysing diagrams
- Be specific and technical — this audience is network engineers`;

/**
 * Build a system prompt that includes a compact summary of the current diagram state.
 * @param {object|null} diagramState
 * @returns {string}
 */
function buildSystemPrompt(diagramState) {
  if (!diagramState || (!diagramState.nodes?.length && !diagramState.links?.length)) {
    return SYSTEM_PROMPT_BASE + '\n\n## Current Diagram State\nThe canvas is empty — no nodes or links have been added yet.';
  }

  const nodeLines = (diagramState.nodes || []).map(n => {
    const tags = n.tags?.length ? n.tags.join(',') : 'none';
    const dc   = n.datacenter ? ` | dc: ${n.datacenter}` : '';
    const addr = n.address    ? ` | addr: ${n.address}`  : '';
    const gps  = (n.gpsLat != null && n.gpsLon != null)
                   ? ` | gps: ${n.gpsLat},${n.gpsLon}`
                   : ' | gps: none';
    return `  ${n.id} | ${n.label} (${n.type || 'city'}) | tags: [${tags}]${dc}${addr}${gps} | pos: (${n.x},${n.y})`;
  }).join('\n');

  const linkLines = (diagramState.links || []).map(l => {
    const tags = l.tags?.length ? l.tags.join(',') : 'none';
    const lat = l.latency_ms ? `lat:${l.latency_ms}ms` : 'lat:?';
    const bw = l.bandwidth_gbps ? `bw:${l.bandwidth_gbps}G` : 'bw:?';
    const price = l.price_usd ? `$${l.price_usd}/mo` : '';
    return `  ${l.id} | ${l.source}→${l.target} (${l.label || 'unnamed'}) | ${lat} ${bw} ${price} | tech:${l.technology || 'fiber'} | tags:[${tags}]`;
  }).join('\n');

  const selected = [];
  if (diagramState.selected_node_id) selected.push(`node=${diagramState.selected_node_id}`);
  if (diagramState.selected_link_id) selected.push(`link=${diagramState.selected_link_id}`);
  const selectedStr = selected.length ? selected.join(', ') : 'none';

  return `${SYSTEM_PROMPT_BASE}

## Current Diagram State
You have real-time awareness of the canvas:

Nodes (${diagramState.nodes.length}):
${nodeLines || '  (none)'}

Links (${diagramState.links.length}):
${linkLines || '  (none)'}

Selected: ${selectedStr}
Active view: ${diagramState.active_view || 'main'} (main = schematic diagram, geo = static world map, map = interactive OpenStreetMap)

When the user refers to a city or location name, match it to the closest node label, then use the node ID in tool parameters. Use node IDs (not labels) in all tool calls.
Do NOT tell the user they are in a different view than what is shown in "Active view" above. Only suggest switching views if it would be helpful.`;
}

// ─── TOOLS ───────────────────────────────────────────────────────────────────

const NEXIMAP_TOOLS = [
  // ── Legacy UI-action tools (kept for backward compatibility) ──
  {
    name: 'open_cable_visor',
    description: 'Open the Cable Visor panel — an interactive MAP showing submarine cable routes from the TeleGeography database. This is NOT the Cable System List (use open_cable_system_list for the sidebar list of cable systems in the diagram).',
    input_schema: {
      type: 'object',
      properties: { cable_name: { type: 'string', description: 'Optional: filter by cable name' } },
      required: []
    }
  },
  {
    name: 'open_datacenter_visor',
    description: 'Open the Datacenter Visor panel — an interactive MAP showing datacenter locations worldwide. This is NOT the Datacenter List (use open_datacenter_list for the sidebar list of facility containers in the diagram).',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Optional search term' } },
      required: []
    }
  },
  {
    name: 'open_pathfinder',
    description: 'LEGACY — opens the Pathfinder UI panel. Prefer run_pathfinder for headless calculation.',
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
    description: 'Open the KML Studio for importing KML/GeoJSON geographic data.',
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
    description: 'Filter diagram by node type or container (region/datacenter).',
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
    description: 'Apply map/geographic filters (region, technology, provider).',
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
    description: 'Show a route on the map with an ordered sequence of waypoints (origin → destination). Opens the Route Finder panel. Do NOT use this to switch canvas views — use switch_view instead.',
    input_schema: {
      type: 'object',
      properties: {
        waypoints: { type: 'array', items: { type: 'string' }, description: 'Ordered list of node names/IDs forming the route' }
      },
      required: []
    }
  },
  {
    name: 'switch_view',
    description: 'Switch the active canvas view. Use "main" for the standard schematic diagram, "geo" for a static world map background, "map" for an interactive OpenStreetMap overlay. Always use this tool when the user asks to switch or change the view.',
    input_schema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['main', 'geo', 'map'],
          description: '"main" = standard canvas diagram (default), "geo" = static world map background, "map" = interactive OpenStreetMap'
        }
      },
      required: ['view']
    }
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
    description: 'Get a high-level summary of the network diagram.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'show_route_price',
    description: 'Show pricing information for a route between two nodes.',
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
  },

  // ── Phase 2: headless + canvas-action tools ──
  {
    name: 'run_pathfinder',
    description: 'Headless pathfinder: compute K-shortest primary paths + optionally a fully-diverse protection path. Returns detailed route data for narration. Use whenever the user asks for routes, connectivity, paths, or latency analysis between two points. Set calculateProtection: true whenever the user asks for a protection or backup path.',
    input_schema: {
      type: 'object',
      properties: {
        originNodeId: { type: 'string', description: 'Source node ID (from diagram state)' },
        destNodeId: { type: 'string', description: 'Destination node ID (from diagram state)' },
        k: { type: 'number', description: 'Number of shortest paths to return (default 3)' },
        calculateProtection: { type: 'boolean', description: 'Set to true to compute a link-diverse protection path in addition to primary routes. Always set this when the user asks for a protection, backup, or diverse path.' },
        primaryFilters: {
          type: 'object',
          description: 'Optional filters for the primary path computation',
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
          description: 'Optional independent filter set for the protection path',
          properties: {
            requiredNodeTags: { type: 'array', items: { type: 'string' } },
            excludedNodeTags: { type: 'array', items: { type: 'string' } },
            requiredLinkTags: { type: 'array', items: { type: 'string' } },
            excludedLinkTags: { type: 'array', items: { type: 'string' } },
            mustUseNodes: { type: 'array', items: { type: 'string' } },
            enforceFullDiversity: {
              type: 'boolean',
              description: '100% link-disjoint from primary (default true)'
            }
          }
        }
      },
      required: ['originNodeId', 'destNodeId']
    }
  },
  {
    name: 'create_node',
    description: 'Create a new node on the canvas. Returns { action: "created", nodeId, label }. Auto-positions if x/y not specified.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Display name of the node' },
        type: {
          type: 'string',
          enum: ['city', 'datacenter', 'submarine_cable_landing', 'exchange_point', 'custom'],
          description: 'Node type'
        },
        x: { type: 'number', description: 'Canvas X position (optional)' },
        y: { type: 'number', description: 'Canvas Y position (optional)' },
        tags: { type: 'array', items: { type: 'string' } },
        datacenter: { type: 'string', description: 'Datacenter name to assign' },
        address: { type: 'string', description: 'Physical address' }
      },
      required: ['label']
    }
  },
  {
    name: 'create_link',
    description: 'Create a link between two existing nodes. Returns { action: "created", linkId }.',
    input_schema: {
      type: 'object',
      properties: {
        sourceNodeId: { type: 'string', description: 'Source node ID' },
        targetNodeId: { type: 'string', description: 'Target node ID' },
        label: { type: 'string', description: 'Link label/name' },
        latency_ms: { type: 'number', description: 'Latency in milliseconds' },
        bandwidth_gbps: { type: 'number', description: 'Bandwidth in Gbps' },
        price_usd: { type: 'number', description: 'Monthly cost in USD' },
        technology: { type: 'string', enum: ['fiber', 'subsea', 'microwave', 'satellite'] },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['sourceNodeId', 'targetNodeId']
    }
  },
  {
    name: 'edit_node',
    description: 'Edit any property of an existing node (label, type, position, tags, datacenter, address).',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'ID of node to edit' },
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
    description: 'Edit any property of an existing link (label, latency, bandwidth, price, technology, tags).',
    input_schema: {
      type: 'object',
      properties: {
        linkId: { type: 'string', description: 'ID of link to edit' },
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
    description: 'Delete a node and all its connected links from the canvas.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId']
    }
  },
  {
    name: 'delete_link',
    description: 'Delete a specific link from the canvas.',
    input_schema: {
      type: 'object',
      properties: { linkId: { type: 'string' } },
      required: ['linkId']
    }
  },
  {
    name: 'create_full_mesh',
    description: 'Create links between ALL pairs of the given nodes (full mesh topology). Useful for ring or hub-and-spoke topologies.',
    input_schema: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'Node IDs to mesh together' },
        default_bandwidth_gbps: { type: 'number' },
        default_latency_ms: { type: 'number' },
        technology: { type: 'string' }
      },
      required: ['nodeIds']
    }
  },
  {
    name: 'assign_datacenter',
    description: 'Assign a datacenter (from the datacenter database) to a node.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        datacenter_name: { type: 'string', description: 'Datacenter name as it appears in the datacenter list' }
      },
      required: ['nodeId', 'datacenter_name']
    }
  },
  {
    name: 'show_heatmap',
    description: 'Activate a heatmap overlay on the canvas visualising capacity (bandwidth) or cost, or turn it off.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['bandwidth', 'cost', 'off'],
          description: '"bandwidth" colours links by capacity, "cost" by price, "off" disables heatmap'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'highlight_path',
    description: 'Highlight a path (ordered sequence of node IDs) on the canvas with colour-coded links and nodes.',
    input_schema: {
      type: 'object',
      properties: {
        node_sequence: { type: 'array', items: { type: 'string' }, description: 'Ordered list of node IDs forming the path' },
        color: { type: 'string', description: 'Hex colour code (e.g. "#22c55e")' },
        label: { type: 'string', description: 'Optional label for the highlighted path' },
        is_protection: { type: 'boolean', description: 'If true, render as protection/backup path styling' }
      },
      required: ['node_sequence']
    }
  },
  {
    name: 'get_diagram_stats',
    description: 'Return diagram statistics (node count, link count, total bandwidth, average latency, technology breakdown). Computed server-side from diagram_state — no frontend round-trip needed.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'geolocate_node',
    description: 'Set GPS coordinates (gpsLat/gpsLon) on a node AND update its canvas position (x,y) simultaneously. Returns { status, node_id, gpsLat, gpsLon, x, y } — the x,y fields confirm the new canvas position after GPS-to-canvas conversion. Resolves coordinates via: (1) explicit lat/lon if provided, (2) internal city database lookup, (3) Nominatim geocoding API fallback. Use whenever the user asks to geolocate a node, set GPS coordinates, place a node on the map, or reposition nodes geographically. This is the ONLY correct way to place nodes at geographic canvas positions — do NOT use edit_node with manually computed pixel coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node name, code, or numeric ID to geolocate' },
        city_name: { type: 'string', description: 'City or country name to look up (e.g. "London", "Frankfurt, Germany")' },
        lat: { type: 'number', description: 'Explicit latitude in decimal degrees (if user provides coordinates directly)' },
        lon: { type: 'number', description: 'Explicit longitude in decimal degrees (if user provides coordinates directly)' }
      },
      required: ['node_id']
    }
  },
  {
    name: 'open_cable_system_list',
    description: 'Open the Cable System List panel (CS List) in the sidebar, showing all cable systems defined in the current diagram.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'open_cable_system_details',
    description: 'Open the Cable System Details/Inspector panel (CS Details) for a specific cable system. Shows landing points, geometry, FA match status, and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        cable_system_id: { type: 'number', description: 'Cable system ID to inspect (from diagram state). If omitted, opens the panel for the currently selected cable system.' }
      },
      required: []
    }
  },
  {
    name: 'open_datacenter_list',
    description: 'Open the Datacenter/Facility List panel (DC List) in the sidebar. Shows all datacenter containers and cable stations in the diagram, with filtering by type, country, and region.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'query_cable_database',
    description: 'Search the TeleGeography submarine cable database for cable systems by name, region, landing country, or status. Returns matching cables with metadata (name, RFS year, length, owners, landing points). Use this when the user asks about real-world submarine cables.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Cable name or keyword to search for' },
        region: { type: 'string', description: 'Filter by region (e.g. "Europe", "Asia", "Trans-Atlantic")' },
        country: { type: 'string', description: 'Filter by landing country name' },
        status: { type: 'string', enum: ['active', 'planned', 'under construction', 'decommissioned'], description: 'Filter by cable status' },
        limit: { type: 'number', description: 'Max results to return (default 10)' }
      },
      required: []
    }
  },
  {
    name: 'query_datacenter_database',
    description: 'Search the datacenter/facility database (PeeringDB + cable stations) for datacenters and cable landing stations by name, city, country, or operator. Returns matching facilities with metadata (name, city, country, lat/lon, carrier count). Use this when the user asks about real-world datacenters or cable landing stations.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Facility name or keyword to search for' },
        city: { type: 'string', description: 'Filter by city name' },
        country: { type: 'string', description: 'Filter by country name or code' },
        facility_type: { type: 'string', enum: ['datacenter', 'cable_station'], description: 'Filter by facility type' },
        limit: { type: 'number', description: 'Max results to return (default 10)' }
      },
      required: []
    }
  }
];

// ─── CLIENT-SIDE TOOL REGISTRY ───────────────────────────────────────────────

// These tools must be executed by the frontend (they touch the DOM/canvas).
// When the agent selects one of these, the worker returns { type: 'needs_tool' }
// to the frontend, which executes it and POSTs the result back.
const CLIENT_SIDE_TOOLS = new Set([
  // Phase 2 canvas tools
  'run_pathfinder',
  'create_node',
  'create_link',
  'edit_node',
  'edit_link',
  'delete_node',
  'delete_link',
  'create_full_mesh',
  'assign_datacenter',
  'show_heatmap',
  'highlight_path',
  'geolocate_node',
  // Legacy UI tools
  'open_cable_visor',
  'open_datacenter_visor',
  'open_pathfinder',
  'open_kml_studio',
  'filter_by_tag',
  'filter_by_cable_system',
  'filter_by_nodes_or_containers',
  'filter_map',
  'show_route_map',
  'get_link_info',
  'clear_all_filters',
  'get_network_summary',
  'show_route_price',
  'create_network_diagram',
  'switch_view',
  'open_cable_system_list',
  'open_cable_system_details',
  'open_datacenter_list',
  'query_cable_database',
  'query_datacenter_database'
]);

// ─── ANTHROPIC API CALL ──────────────────────────────────────────────────────

async function callAnthropic(messages, apiKey, systemPrompt) {
  return fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      tools: NEXIMAP_TOOLS.map((t, i, arr) =>
        i === arr.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' } }
          : t
      ),
      messages
    })
  });
}

// ─── AGENTIC LOOP ────────────────────────────────────────────────────────────

/**
 * Multi-turn agentic loop (max 5 iterations).
 *
 * If `incomingToolResult` is set, this is a continuation from the frontend
 * after it executed a client-side tool.  The result is appended as a
 * tool_result message before the first Anthropic call.
 *
 * @param {Array}       messages          Conversation so far
 * @param {string}      apiKey            Anthropic API key
 * @param {object|null} diagramState      Current canvas snapshot
 * @param {object|null} incomingToolResult { tool_use_id, content }
 * @returns {object}  { type: 'final'|'needs_tool', ... }
 */
async function agentLoop(messages, apiKey, diagramState, incomingToolResult) {
  // If this is a tool_result continuation, prepend it before the first call
  if (incomingToolResult) {
    // Support both single object and array of tool results from the frontend
    const toolResults = Array.isArray(incomingToolResult) ? incomingToolResult : [incomingToolResult];
    messages.push({
      role: 'user',
      content: toolResults.map(tr => ({
        type: 'tool_result',
        tool_use_id: tr.tool_use_id,
        content: JSON.stringify(tr.content)
      }))
    });
  }

  const systemPrompt = buildSystemPrompt(diagramState);

  for (let iter = 0; iter < 5; iter++) {
    const res = await callAnthropic(messages, apiKey, systemPrompt);
    if (!res.ok) {
      const errText = await res.text();
      console.error('Anthropic API error:', res.status, errText);
      return { type: 'final', text: `API error ${res.status}: ${errText.slice(0, 200)}`, actions: [] };
    }

    const claude = await res.json();

    // ── Natural end ────────────────────────────────────────────────────────
    if (claude.stop_reason === 'end_turn') {
      const text = claude.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      return { type: 'final', text: text || '(Done)', actions: [] };
    }

    // ── Tool use ───────────────────────────────────────────────────────────
    if (claude.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: claude.content });

      const toolUses = claude.content.filter(b => b.type === 'tool_use');

      // Separate client-side and server-side tools
      const clientTools = [];
      const serverToolResults = [];

      for (const tool of toolUses) {
        if (CLIENT_SIDE_TOOLS.has(tool.name)) {
          clientTools.push({ id: tool.id, name: tool.name, params: tool.input });
        } else {
          // Server-side tool → compute result here
          let toolResultContent;
          if (tool.name === 'get_diagram_stats') {
            const d = diagramState || { nodes: [], links: [] };
            toolResultContent = {
              node_count: d.nodes.length,
              link_count: d.links.length,
              total_bandwidth_gbps: d.links.reduce((s, l) => s + (l.bandwidth_gbps || 0), 0),
              avg_latency_ms: d.links.length > 0
                ? Math.round(d.links.reduce((s, l) => s + (l.latency_ms || 0), 0) / d.links.length * 10) / 10
                : 0,
              technologies: [...new Set(d.links.map(l => l.technology).filter(Boolean))],
              tag_summary: {}
            };
          } else {
            toolResultContent = { status: 'ok', message: 'Acknowledged by server.' };
          }
          serverToolResults.push({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: JSON.stringify(toolResultContent)
          });
        }
      }

      // If there are client-side tools, return ALL of them to the frontend
      // Include server-side results so the frontend can send them back together
      if (clientTools.length > 0) {
        // Append any server-side results first so the conversation stays valid
        if (serverToolResults.length > 0) {
          messages.push({ role: 'user', content: serverToolResults });
        }
        return {
          type: 'needs_tool',
          tool_calls: clientTools,
          partial_messages: messages
        };
      }

      // All tools were server-side — append results and continue the loop
      if (serverToolResults.length > 0) {
        messages.push({ role: 'user', content: serverToolResults });
      }
      continue;
    }

    // Unexpected stop_reason
    console.warn('Unexpected stop_reason:', claude.stop_reason);
    break;
  }

  return { type: 'final', text: 'I completed the requested operations.', actions: [] };
}

// ─── FETCH HANDLER ───────────────────────────────────────────────────────────

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const apiKey = typeof ANTHROPIC_API_KEY !== 'undefined' ? ANTHROPIC_API_KEY : null;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY secret not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const {
      message = null,
      conversation_history = [],
      diagram_state = null,
      tool_result = null
    } = body;

    // Build the messages array from conversation history (cap to last 20 messages to control cost)
    let messages = conversation_history.length > 20
      ? conversation_history.slice(-20)
      : [...conversation_history];

    // Append new user message (not present when this is a tool_result continuation)
    if (message) {
      messages.push({ role: 'user', content: message });
    }

    // Run the agentic loop
    const result = await agentLoop(messages, apiKey, diagram_state, tool_result);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Worker error:', err);
    return new Response(JSON.stringify({
      type: 'final',
      text: 'An internal error occurred. Please try again.',
      error: err.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
