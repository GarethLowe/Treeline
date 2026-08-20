# ForestFire

A physically-based 3D forest and grass fire simulation running in the browser on WebGPU.
Explorable in first person and from a free camera. Fire behaviour is derived from published
fire science — Rothermel surface spread, Van Wagner crown initiation, explicit radiative and
convective heat transfer, Lagrangian firebrands — not authored by eye.

Grass, brush, shrub and tree-scale fire in one model, across five ecosystems: Western US
conifer, grassland/savanna, Mediterranean chaparral, Australian dry eucalypt, and UK mixed
field and forest.

## Status

Pre-implementation. The [specification](SPEC.md) is complete and verified; the toolchain is
standing; work packages are defined but not yet built.

## Running it

```bash
npm install
npm run dev
```

Then open <http://127.0.0.1:5173>. Requires Chrome or Edge 113+ with WebGPU.

The boot screen reports which GPU adapter it actually got. **Check it.** On hybrid-GPU
laptops the browser will often hand back the integrated adapter even when the discrete one
is requested, and the difference is roughly an order of magnitude in frame time. The boot
path warns when the adapter looks integrated.

| Command | |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run typecheck` | Type-check browser and build-tooling sources |
| `npm run build` | Type-check, then production build |
| `npm test` | Unit tests |
| `npm run validate` | Fire-behaviour validation suite against published benchmark data |

## Documentation

[SPEC.md](SPEC.md) is the index. Start with
[Overview & Locked Decisions](docs/spec/00-overview.md), then
[Work Package Decomposition](docs/spec/90-workpackages.md) if you are implementing.

## Requirements

- Node.js 20+
- A GPU supporting WebGPU with compute shaders. Developed against an RTX 4070 Laptop;
  the performance target is 60 fps at 1440p with dynamic quality scaling.
- The dev server sets COOP/COEP headers so `SharedArrayBuffer` and Web Workers are
  available for world generation and audio.
