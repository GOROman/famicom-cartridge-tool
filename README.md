# Famicom Cartridge Tool

Browser-based parametric STL editor for 3D-printable Famicom (Dendy) cartridge shells.
Import the base top/bottom shell STLs, add parametric features (grooves, label recess,
boolean cuts, engraved/embossed text) and export print-ready binary STL files.

**Live app:** https://goroman.github.io/famicom-cartridge-tool/

## Features

- **STL import / export** — binary STL, drag & drop or file picker; export top, bottom, or both
- **Parametric feature stack** (non-destructive, per part, CSG via [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg))
  - **Groove** — axis, position, width, depth, length, count and spacing
  - **Label Recess** — rounded-rectangle sticker recess with size, depth, corner radius, on/off
  - **Box / Cylinder** — generic boolean add/subtract primitives
  - **Text** — engrave or emboss with size, depth, position, rotation
- **Rendering** — Wireframe / Simple shaded / PBR with HDR environment (drop in your own `.hdr`)
- **Shadows** — soft shadow mapping with a toggle

## Development

```sh
npm install
npm run dev     # local dev server
npm run build   # production build into dist/
```

Deployed automatically to GitHub Pages via GitHub Actions on push to `main`.

## Base model

Bundled base shells are from [Dendy (Famicom) cartridge](https://www.thingiverse.com/thing:3357677) (Thingiverse #3357677). Units are millimetres, Z-up.
