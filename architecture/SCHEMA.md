# System map model: schema and rules

The map is one data file, `model.js`. It sets `window.BOS_MODEL`. The viewer (`map.html`) only reads it. All edits go in `model.js` and are committed. Nothing is edited in the browser.

The model follows the **C4 model** levels (person / software system / container / component) and adds **phases**, so you can see the system grow release by release.

## Top-level shape

```js
window.BOS_MODEL = {
  meta:     { title, subtitle, updated },               // strings
  phases:   [Phase],                                    // ordered, earliest first
  elements: [Element],
  relations:[Relation],
  flows:    [Flow],
};
```

### Phase
| field | type | meaning |
|---|---|---|
| `id` | string | `"P0"`, `"P1"`, … Order in the array is the order in time. |
| `name` | string | Short name, e.g. "Ground floor" |
| `weeks` | string | e.g. "Weeks 1–2 (proposed)" |
| `goal` | string | One sentence |
| `exit` | string | The test that says this phase is done |
| `target` | bool? | `true` on the phase the meeting targeted (Stage 1 done). Viewer flags it. |

### Element
| field | type | meaning |
|---|---|---|
| `id` | string | Unique, kebab-case |
| `parent` | string \| null | Parent element id. `null` = top level. **Any depth.** An element with children is a **section**. |
| `kind` | enum | `person`, `system`, `container`, `component`, `store`, `external`, `worker`, `later` |
| `name` | string | Label on the card |
| `tech` | string? | Library / framework / product, shown on the card, e.g. "NestJS 11 · TypeScript" |
| `licence` | string? | e.g. "MIT", "AGPL-3.0 (unmodified)" |
| `desc` | string | What it does, plain words (detail sheet) |
| `since` | phase id | First phase it exists in |
| `until` | phase id? | First phase it **no longer** exists in (retired). Omit if it stays. |
| `changes` | `{ [phaseId]: string }`? | What changes about it in that phase (it exists before and after) |
| `nfr` | string[]? | Numbers it must hit, e.g. `"p95 < 300 ms"` |
| `refs` | string[]? | Where the requirement comes from, e.g. `"Blueprint §3.3"`, `"Meeting 4.8"` |
| `proposed` | bool? | `true` = our proposal, not in the source documents. Viewer marks it. |
| `collapsed` | bool? | Default state for a section (`true` = starts collapsed) |
| `layer` | `"dev"` or `"measure"`? | Not part of the product: developer tooling (`dev`) or measurement and monitoring (`measure`). Omit for the product. See Layers below. |

### Relation (an arrow)
| field | type | meaning |
|---|---|---|
| `id` | string | Unique |
| `src`, `dst` | element ids | **Always the most specific elements** (leaves where possible). Never duplicate an arrow on a parent: the viewer derives it. |
| `label` | string | Verb phrase, e.g. "verifies token (JWKS)" |
| `tech` | string? | Protocol, e.g. "OIDC", "SCIM 2.0", "HTTPS/JSON", "SQL" |
| `since`, `until` | phase ids | As for elements. An arrow is shown only when both ends are shown too. |
| `layer` | `"dev"` or `"measure"`? | Only for an arrow between two product elements that is itself tooling. An arrow that touches a layered element needs no layer of its own: it goes with that element. |

### Flow (a playable journey, a C4 "dynamic view")
| field | type | meaning |
|---|---|---|
| `id`, `name` | string | |
| `since` | phase id | Flow is offered from this phase on |
| `desc` | string | One line |
| `layer` | `"dev"` or `"measure"`? | Hidden from the flow list while the layer is off. |
| `steps` | `[{ src, dst, note }]` | Ordered hops between element ids. `note` is the caption for that hop. |

## Phase rules (the viewer applies these)

At selected phase **P** (index `i`):
- An element **exists** when `idx(since) <= i` and (`until` is missing or `i < idx(until)`).
- Its **status** at P:
  - `new`: `since === P`
  - `changed`: `changes[P]` exists
  - `retired`: `until === P`. It is drawn faded and struck through in this phase only, then disappears.
  - otherwise `same`
- An element whose parent does not exist is not shown.
- A toggle ("Only what changed") dims everything with status `same`.

## Collapse rules (the viewer applies these)

1. **Visible node**: an element is visible when it exists at P and **every** ancestor is expanded.
2. **Lifting** (Structurizr calls these "implied relationships"): for each existing relation, replace `src` with its nearest visible ancestor-or-self, and `dst` likewise.
3. **Drop** the lifted arrow if both ends become the same node (the arrow is internal to a collapsed box).
4. **Merge** lifted arrows with the same (src, dst) pair. The merged arrow shows the label if there is one, otherwise "N links". Its hover/detail lists every underlying relation (label + tech).
5. A **flow step** uses the same lifting. If both ends lift to the same box, the step pulses that box instead of moving along an arrow.
6. A collapsed section is drawn as a card with its name, tech, a kind sticker and a "+N inside" button. An expanded section is a frame (like a Figma section) with a header that holds the name, tech and a "−" button. Its children are inside it.

## Layers: dev and measurement tooling

An element, relation or flow may carry `layer: "dev"` or `layer: "measure"`. Anything without a layer is the product.

- The tools bar has a **Dev & measurement** toggle. It is **off by default** and remembered (`layers` in the saved state).
- **Off:** a layered element does not exist in any view, nor do its children, relations touching it, or relations and flows that carry a layer. Phases, search, flows, levels and the layout all behave as if it was never in the model.
- **On:** they appear with a small **Dev** or **Measure** chip and a diagonal-stripe tint (violet for dev, teal for measure). Children of a layered section get the tint too, the chip only sits on the element that declares the layer.
- The Key explains both layers. If the model has no layered item, the toggle is dimmed and says so.
- Layout: there are two cached masters (see below), one per toggle state.

## Stable layout (what the viewer guarantees)

Switching phase or level must not make boxes jump or swap sides.

1. **Master layout.** Computed once with ELK (real card sizes, measured at the last phase): every element that exists in *any* phase, every section expanded (the Complete level). It is deliberately not only the last phase, so an element that is retired earlier (`until`) still has a place. It is cached per layer toggle and rebuilt when the data, the fonts (card sizes) or the layer toggle change. It never depends on the phase or on what is expanded.
2. **Every view** (any phase, any set of open sections) keeps the master's order among visible siblings (same parent frame, or both top level): if A sat entirely left of B in the master, A stays left of B; if A sat entirely above B, A stays above B (diagonal pairs keep both). Hidden boxes are simply removed and the space closes: gaps shrink to a fixed minimum, collapsed sections shrink to card size, frames shrink to their contents.
3. **How.** ELK is used for the master only. A view is placed by a constraint pass over the master's boxes (columns and rows closed up, then each box centred between its earliest and latest allowed position) and its arrows are routed by the viewer's own orthogonal router (grid of box margins and corridor tracks, A* with bend and overlap costs; labels placed on a stretch where they clear every card). Feeding ELK the master positions as hints (INTERACTIVE layering, semi-interactive crossing minimisation, model order) was tried first and did not hold the order (hundreds of violations), which is why views no longer go through ELK.
4. **Self-check.** After every layout the viewer counts pairs of visible siblings that break the master order and calls `console.warn('[map] order violations', n)` if n > 0. In the browser console, `await bosMap.sweep()` lays out every phase at every level and returns the counts. The bar is 0 everywhere.

## Levels (quick expand presets)
The buttons are labelled **Concise**, **Containers**, **Components**, **Complete**; their keys (`data-level`) are still `context`, `containers`, `components`, `everything`. Saved state stores the set of open sections, never a level name, so old saved states map to the right level automatically.
- **Concise** (`context`, tooltip "System view"): collapse everything below the top level.
- **Containers** (tooltip "Apps, services and stores"): expand the top level only.
- **Components** (tooltip "Parts inside each service"): expand two levels.
- **Complete** (`everything`, tooltip "Everything in the system"): expand all.
