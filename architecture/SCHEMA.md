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

### Relation (an arrow)
| field | type | meaning |
|---|---|---|
| `id` | string | Unique |
| `src`, `dst` | element ids | **Always the most specific elements** (leaves where possible). Never duplicate an arrow on a parent: the viewer derives it. |
| `label` | string | Verb phrase, e.g. "verifies token (JWKS)" |
| `tech` | string? | Protocol, e.g. "OIDC", "SCIM 2.0", "HTTPS/JSON", "SQL" |
| `since`, `until` | phase ids | As for elements. An arrow is shown only when both ends are shown too. |

### Flow (a playable journey, a C4 "dynamic view")
| field | type | meaning |
|---|---|---|
| `id`, `name` | string | |
| `since` | phase id | Flow is offered from this phase on |
| `desc` | string | One line |
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

## Levels (quick expand presets)
- **Context**: collapse everything below the top level.
- **Containers**: expand the top level only.
- **Components**: expand two levels.
- **Everything**: expand all.
