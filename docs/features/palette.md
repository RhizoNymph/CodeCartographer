# Palette

## Scope

The colour vocabulary of the graph: which hex each edge kind, block kind, and
node type renders as, and the invariants that keep colour trustworthy as a
category signal.

**In scope**
- `EDGE_HUES`, `EDGE_COLORS`, `BLOCK_COLORS`, `NODE_COLORS` in
  `packages/app/src/api/types.ts`.
- The hue budget (how many distinct edge colours exist) and which edge kinds
  share one.
- Cross-map deconfliction: no hex, and no near-duplicate hex, may identify more
  than one category.
- Contrast of every edge hue against every surface it can cross on the dark
  canvas.

**Not in scope**
- Edge geometry, routing, bundling (`edgeGeometry.ts`, `elkLayout.ts`).
- Edge width/alpha (`EDGE_STYLES` in `canvas/renderers/types.ts`), except where a
  merged hue makes alpha the only remaining differentiator between two kinds.
- Resolution-based styling (ambiguous edges render dashed/dimmed) — that is
  orthogonal to hue and lives in the edge renderer.
- Chrome/UI colours outside the graph (toolbar, sidebar backgrounds).

## Design rules

1. **A colour identifies exactly one category.** No hex appears in more than one
   of `EDGE_COLORS` / `BLOCK_COLORS` / `NODE_COLORS`, and no edge hue is within
   CIE76 ΔE 20 of any block or node colour.
2. **Five edge hues, not seven.** Seven hues exceed what a user holds in working
   memory. Edge kinds that answer the same question share a hue:
   - `FunctionCall` + `MethodCall` → one *calls* hue.
   - `Inheritance` + `TraitImpl` → one *subtype relation* hue.
   The kinds remain fully distinct in the graph model, tooltips, edge-kind
   toggles, and `EDGE_STYLES`. Only the colour merges.
3. **Edges own saturation; nodes own muting.** Every chromatic edge hue is more
   saturated than every block colour, so edges read as figure and node fills as
   ground.
4. **Import stays the most distinct hue.** It is the flagship module-view edge
   and the only edge kind shown in module view, so it holds a reserved indigo
   that no block may approach.
5. **Legibility on the dark canvas.** Every edge hue clears WCAG 3:1 (the
   non-text graphics threshold) against the canvas background `#0f172a`, both
   node fills, and all ten darkened block fills. Import clears 3.5:1 against the
   node fills it crosses in module view.

## Palette

**Edge hues** (`EDGE_HUES`) — 5 hues covering 7 kinds:

| Hue | Hex | Edge kinds |
|-----|-----|-----------|
| import | `#818cf8` indigo | `Import` |
| calls | `#4ade80` green | `FunctionCall`, `MethodCall` |
| typeReference | `#fbbf24` amber | `TypeReference` |
| subtype | `#f472b6` pink | `Inheritance`, `TraitImpl` |
| variableUsage | `#94a3b8` slate | `VariableUsage` |

The four chromatic hues sit at roughly even spacing around the wheel
(amber ~43°, green ~142°, indigo ~239°, pink ~330°); `VariableUsage` is
deliberately neutral because it is the noisiest, least informative kind.

**Block colours** (`BLOCK_COLORS`) — one muted family, HSL saturation 42%,
lightness 62%:

| Kind | Hex | | Kind | Hex |
|------|-----|-|------|-----|
| Function | `#758fc7` blue | | Interface | `#75bdc7` cyan |
| Class | `#bb75c7` purple | | Impl | `#a9c775` lime |
| Struct | `#c7b775` sand | | Module | `#c77b75` clay |
| Enum | `#75c787` green | | Constant | `#c79975` tan |
| Trait | `#c7759e` rose | | TypeAlias | `#75c7ad` teal |

Block hues avoid the indigo/slate band (roughly 186°–268° at this
saturation/lightness) because a muted colour in that band is perceptually a
near-duplicate of the Import and VariableUsage edge hues. That is why `Impl`
(previously `#6366f1`, byte-identical to the old Import edge) and `Module`
(previously `#64748b`, byte-identical to the old VariableUsage edge) moved to
lime and clay.

**Node colours** (`NODE_COLORS`): `Directory` `#1e293b`, `File` `#1e3a5f`.

## Control flow

```
api/types.ts  (EDGE_HUES -> EDGE_COLORS, BLOCK_COLORS, NODE_COLORS)
    |
    +-- canvas/layout/elkLayout.ts     EDGE_COLORS[kind] -> EdgeDatum.color
    |                                   (direct + aggregated edges)
    |        -> canvas/renderers/edgeDrawing  strokes with EDGE_STYLES alpha/width
    |
    +-- canvas/renderers/nodeCreation.ts   NODE_COLORS -> Directory/File fill
    |                                      BLOCK_COLORS * BLOCK_FILL_DARKEN
    |                                      -> CodeBlock fill
    |
    +-- canvas/Tooltip.tsx             EDGE_COLORS[kind] as edge label colour;
    |                                  BLOCK_COLORS[kind] as pill text + "33" bg
    +-- canvas/SelectionChip.tsx       BLOCK_COLORS[kind]  (arrives with PR #35)
    +-- toolbar/EdgeToggleButton.tsx   EDGE_COLORS[kind] swatch
    +-- toolbar/LODSettingsPanel.tsx   EDGE_COLORS[kind] border/fill
```

Nothing on the Rust side carries colour. `EdgeKind::color()` was removed as dead
code; the frontend never consumed it and no Rust caller existed.

## Files

| File | Role |
|------|------|
| `packages/app/src/api/types.ts` | Owns the palette: `EDGE_HUES`, `EDGE_COLORS`, `BLOCK_COLORS`, `NODE_COLORS`. |
| `packages/app/src/canvas/renderers/types.ts` | `EDGE_STYLES` width/alpha per kind; keeps merged-hue pairs separable. |
| `packages/app/src/canvas/renderers/nodeCreation.ts` | `getNodeColor`, `BLOCK_FILL_DARKEN`; turns palette hexes into Pixi ints. |
| `packages/app/src/canvas/layout/elkLayout.ts` | Stamps `EDGE_COLORS[kind]` onto each layout edge. |
| `packages/app/src/canvas/Tooltip.tsx` | Edge-kind label colour and block-kind pill. |
| `packages/app/src/canvas/SelectionChip.tsx` | Block-kind chip colour (added by PR #35; picks up palette values automatically). |
| `packages/app/src/toolbar/EdgeToggleButton.tsx` | Per-kind toggle swatch. |
| `packages/app/src/toolbar/LODSettingsPanel.tsx` | Per-kind swatch in the LOD panel. |
| `packages/app/tests/palette.test.ts` | Enforces every invariant above (ΔE, contrast, saturation ordering, hue merges, cross-map collisions). |
| `crates/cc-core/src/model/edge.rs` | `EdgeKind` — deliberately carries no colour. |

## Invariants

Enforced by `packages/app/tests/palette.test.ts`:

- `EDGE_COLORS.FunctionCall === EDGE_COLORS.MethodCall`.
- `EDGE_COLORS.Inheritance === EDGE_COLORS.TraitImpl`.
- `new Set(Object.values(EDGE_COLORS)).size <= 5`.
- Distinct edge hues are mutually ≥ ΔE 30 apart.
- No hex is shared across `EDGE_COLORS` / `BLOCK_COLORS` / `NODE_COLORS`.
- Every edge hue is ≥ ΔE 20 from every block and node colour.
- Block colours are mutually ≥ ΔE 15 apart.
- Every chromatic edge hue out-saturates every block colour.
- `VariableUsage` is the lowest-chroma edge hue (< 0.35 HSL saturation).
- Every edge hue clears 3:1 contrast against the canvas, both node fills, and
  all ten darkened block fills; Import clears 3.5:1 against the node fills.
- Every palette entry is a lowercase `#rrggbb` string.

Not machine-checked, but load-bearing:

- Adding an edge kind must not add a sixth hue without an explicit decision to
  raise the budget; prefer merging it into an existing semantic group.
- Adding a block kind must place its hue outside the indigo/slate band.
