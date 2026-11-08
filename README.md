# Business OS platform (from scratch)

The new Business OS, built from the ground up. The old `Business-OS` repo is reference only.

Status: **architecture stage**. There is no application code yet. This repo starts with the system map that the code will follow.

## The system map

- `architecture/model.js`: **the source of truth**. Every system, container, component, data store and arrow is defined here, along with the phase it arrives in and the library or framework it uses.
- `architecture/map.html`: the interactive viewer. Open it in a browser next to `model.js`. It is read-only, so make changes in `model.js`.
- `architecture/SCHEMA.md`: the data format plus the rules for phases and for expand/collapse.
- `architecture/validate.mjs`: run `node architecture/validate.mjs` after every edit. It catches broken ids, wrong phases and flow steps with no arrow.
- `docs/adr/0001-system-map-format.md`: why the map works this way (the C4 model plus collapsible sections).

### How to read it

- **Sections expand and collapse**, like Figma sections. A collapsed box keeps every arrow that crosses its edge, and parallel arrows merge with a count.
- **Phases** P0–P4 run up to the **Stage 1 target** set in the 2026-11-05 meeting: CRM, quotations, sales, purchases and invoicing in about 3 months, with identity ready for SaaS and vendor ID verification. For each phase the map marks what is new, what changed and what was retired.
- **Flows** play a journey across the boxes. Examples: staff sign-in, SCIM provisioning, lead to accepted quote, order to cash, vendor verification, and request to vendor bill.

## Sources

- The blueprint: `Techrida/projects/business-os/docs/BLUEPRINT.md` in life-kb (the Windows dev machine: `F:\Projects\Techrida\_analysis\business-os\BLUEPRINT.md`).
- The 8 Business OS PDFs (4 Sep 2026) and decisions D1–D6 (life-kb `Techrida/decisions-log.md`).
- The meeting study guide, sections 4.8, 4.10 and 4.13.

Week numbers in the phases are **proposals**. They are not yet agreed with Rajendra.
