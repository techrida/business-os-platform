/**
 * The sidebar as data. Groups and items follow the Figma sidebar (node 727:10457) and the P1
 * screen map. Pure data with no React import, so unit tests and the header title lookup can use
 * it anywhere.
 *
 * An item is "built" when it has an `href`: it renders as a link. Every other item renders
 * as a plain disabled row. The phase is internal data and is never shown to users. When an item
 * ships, give it an `href` and a phase in SHIPPED_PHASES; nav.test.ts keeps the two in step.
