# Graph System Design

Pages as nodes, links between them as edges. Two modes: a **local graph** (side panel, neighbourhood of the current page) and a **global graph** (full-page tab, entire vault). Same data, same renderer.

Stack decision and rationale: D022.

---

## Rendering

### `d3-force` for simulation, Canvas 2D for drawing, Web Worker for both

The two concerns are separable and must stay that way. Obsidian's graph runs a force simulation for physics and draws with WebGL — proof that the renderer is swappable when the simulation is decoupled.

**Why not Sigma.js:** rejected on visual direction. Sigma does support force layouts (ForceAtlas2 via graphology) and is fully interactive, so the earlier framing of it as "stats-oriented" was not the real objection — the real one is that custom appearance requires writing WebGL programs. During visual exploration, Canvas 2D lets you try six node treatments in an afternoon; shaders do not.

**Why not Cytoscape.js:** same reasoning. Styleable in principle, but its model steers toward its defaults.

**Why the Worker:** the simulation ticks ~300 times on load. On the main thread that is a frozen UI at a few thousand nodes. Retrofitting a Worker means restructuring the render loop, so it goes in from the start.

```
Main thread                    Worker
───────────                    ──────
fetch nodes/edges  ────────▶   d3-force simulation
                   ◀────────   Float32Array of positions (per tick)
Canvas draw
hit detection
```

Positions cross the boundary as a transferable `Float32Array` — no serialisation cost.

**Constraint:** the draw loop must never call into the simulation. It consumes positions and nothing else.

Canvas 2D means manual hit detection. A quadtree over node positions, rebuilt per tick, handles hover and click.

---

## Data Model

### Flat arrays, not adjacency lists

```ts
type GraphNode = {
  id: string
  title: string
  icon: string | null
  pageType: 'page' | 'database'
  isEntry: boolean
  linkCount: number
}

type GraphEdge = {
  id: string
  source: string     // d3 replaces with an object reference at runtime
  target: string
  type: 'mention' | 'embed' | 'relation'
}
```

`d3-force` expects a flat edge list and mutates it in place. An adjacency list would need flattening before use, and in an undirected graph every edge would appear twice, duplicating metadata and making edge filtering a walk over every node.

`linkCount` drives node size and is computed in SQL. It is derived data (D011) — never synced, recomputed on projection.

### Edge types

| Type | Style | Weight | Meaning |
|---|---|---|---|
| `relation` | solid | thick, accent colour | DB relation property |
| `mention` | solid | thin | `@page` inline mention |
| `embed` | dashed | thin | DB embed block |

Relations are visually dominant — they are intentional, structural connections. Mentions are ambient.

### DB entries as nodes

Entries are pages, so they appear. Excluding them would hide real structure — a Person entry linked to several Task entries is meaningful.

`isEntry` allows dimmer rendering without special-casing anywhere else.

**Noise control:** a "Show DB entries" toggle, off by default in global mode, on in local mode where the neighbourhood is small anyway.

---

## Queries

### Global — nodes

The previous version of this query used an `OR` across two columns in a join condition:

```sql
-- WRONG: OR in a join condition defeats both indexes, forcing a scan
LEFT JOIN page_links pl ON pl.source_page_id = p.id OR pl.target_page_id = p.id
```

Split into a UNION ALL so each half uses its index:

```sql
SELECT p.id, p.title, p.icon, p.type AS pageType,
       CASE WHEN par.type = 'database' THEN 1 ELSE 0 END AS isEntry,
       COUNT(pl.id) AS linkCount
FROM pages p
LEFT JOIN pages par ON p.parent_id = par.id
LEFT JOIN (
  SELECT source_page_id AS pid, id FROM page_links
  UNION ALL
  SELECT target_page_id AS pid, id FROM page_links
) pl ON pl.pid = p.id
WHERE p.is_deleted = 0
GROUP BY p.id;
```

`ix_links_src` and `ix_links_tgt` both apply.

### Global — edges

```sql
SELECT pl.id, pl.source_page_id AS source, pl.target_page_id AS target, pl.type
FROM page_links pl
JOIN pages s ON s.id = pl.source_page_id AND s.is_deleted = 0
JOIN pages t ON t.id = pl.target_page_id AND t.is_deleted = 0;
```

Two queries rather than one — independent datasets, and joining them produces a cartesian mess.

`page_links` already carries all three edge types, so no union with `relations` is needed.

### Local — recursive CTE

The previous design followed edges in one direction per hop. `page_links` rows are directional but graph *neighbourhood* is not, so a page that is only ever linked **to** — which describes most hub pages — never appeared in its own neighbourhood.

Each hop must traverse both directions:

```sql
WITH RECURSIVE nbr(id, depth) AS (
  SELECT ?, 0
  UNION
  SELECT CASE WHEN pl.source_page_id = n.id
              THEN pl.target_page_id ELSE pl.source_page_id END,
         n.depth + 1
  FROM nbr n
  JOIN page_links pl
    ON pl.source_page_id = n.id OR pl.target_page_id = n.id
  WHERE n.depth < ?
)
SELECT DISTINCT id FROM nbr;
```

The `OR` is acceptable here — the recursion is seeded from a single page and bounded by depth, so it touches a small subgraph rather than scanning.

The resulting IDs filter both the node and edge queries.

Depth is a parameter, so the slider triggers a refetch rather than a client-side filter. The neighbourhood is always exactly right rather than a prefetched superset.

---

## Modes

### Local graph (side panel)

Neighbourhood of the open page. Docked right of the editor, toggleable, refetches on page change.

- Depth slider, 1–4 hops, default 2
- Clicking a node navigates; the panel follows
- Active page node has a distinct stroke

### Global graph (full-page tab)

Entire vault. Opened from the command palette or sidebar. Behaves like any other tab.

- Full zoom and pan
- Filter panel
- Node search highlights matches

---

## Interactions

| Interaction | Behaviour |
|---|---|
| Hover | Tooltip with title and icon. Neighbours stay full opacity, others dim |
| Click | Open the page in a new tab |
| Drag node | Follows cursor, pins on release, simulation adjusts around it |
| Pan | Drag empty canvas |
| Zoom | Scroll wheel. Labels fade in above a threshold |

Labels are hidden at low zoom to prevent illegible overlap on the global graph.

---

## Filters

Global mode only. Client-side — the dataset is fetched once and the renderer filters. No requery on toggle.

```
Edges:   [x] mentions   [x] relations   [x] embeds
Nodes:   [ ] DB entries          (off by default)
Roots:   [ ] limit to subtree of [page ▾]
```

---

## Live Updates

The graph reads `page_links`, which the projector rebuilds per page on every change.

The projector emits `{ type: 'page_links_changed', pageId }` after writing. The frontend decides whether to act:

- **Local panel** — refetch if `pageId` is inside the current neighbourhood
- **Global tab** — refetch edges. Nodes change only on page create or delete, which is a separate event

Pull for loads, push for invalidation only. The event is one page ID; the frontend ignores it when irrelevant. Pushing full node and edge payloads on every keystroke would be wasteful, and pull-only would leave an open panel silently stale.

This applies to changes arriving from **other devices** too, since incoming updates run through the same projector.

---

## Performance

Rendering is not the bottleneck; the force simulation is. It is in a Worker, so the UI stays responsive regardless.

- DB entries off by default in global mode keeps node counts sane
- Local mode simulates only the neighbourhood
- Above ~3000 pages, suggest scoping to a subtree via the root filter

If it becomes a real problem the fix is targeted — swap Canvas 2D for a WebGL renderer, or cool the simulation faster. Because the draw loop is decoupled, that is a contained change. Not worth solving upfront for a personal tool.
