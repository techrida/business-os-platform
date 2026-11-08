# ADR 0001: System map as a C4-shaped model with collapsible sections

- Status: accepted (2026-11-08, an assistant for Kuu)
- Context: Kuu wants one map of the whole system (services, databases, connections, frontends) that reads at module level when zoomed out. Each module should expand in place, like a Figma section. When a module is collapsed, arrows that cross its boundary should attach to the box. The map should be shown phase by phase.

## Existing standards we checked

| Standard / tool | What it gives | Why not used as-is |
|---|---|---|
| **C4 model** (c4model.com) | Four levels (system context, container, component, code), plus "dynamic" diagrams for flows | It is a notation, not a viewer. **We adopt its levels and vocabulary.** |
| **Structurizr DSL** (Apache-2.0) | "Implied relationships": an arrow to a child also counts as an arrow to its parent | It renders separate views per level, not one board that expands in place. **We copy its implied-relationship rule** (we call it lifting). |
| **LikeC4** (MIT) | C4-style DSL, nested elements, dynamic views, an interactive viewer that drills down | Drill-down opens a different view. We could not confirm in-place expand/collapse with arrows lifted to the collapsed box. A good **export target later**: our model keeps C4 kinds so it maps across. |
| **BPMN collapsed / expanded sub-process** | The same idea for process diagrams (a "+" marker on a collapsed box) | Process notation, not architecture |
| Graph drawing: **compound (clustered) graphs** | The theory: collapse a cluster into a meta-node and reroute its edges | We implement it ourselves |

## Decision

1. The model is one JS data file (`architecture/model.js`). Elements use C4 kinds (`person`, `system`, `container`, `component`, `store`, `external`) plus `worker` and `later`.
2. Arrows are stored only between the most specific elements. The viewer lifts each end to its nearest visible ancestor, drops arrows that end up inside a single box, and merges duplicates with a count.
3. Every element and arrow has `since` / `until` phases plus per-phase change notes, so the map can show the system **changing**, not just growing.
4. Layout uses **ELK.js** (`layered`, hierarchy handling `INCLUDE_CHILDREN`; EPL-2.0) from jsDelivr at a pinned version. No build step.
5. The viewer is read-only. All edits go in the repo and are checked by `validate.mjs`.

## Consequences

- One file to review in pull requests, and the history lives in git.
- If the map outgrows a hand-written file, generate `model.js` from LikeC4 or Structurizr, or move to one of them. The C4 kinds keep that move cheap.
- The map will later grow to cover deployment (containers on hosts) and the database tables (ERD) as separate layers.
