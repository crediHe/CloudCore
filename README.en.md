# CloudCore

**A desktop point cloud (LAS / PLY) viewer and processing tool for Windows.**

Airborne and terrestrial LiDAR scans come back as a soup of everything at once — ground, vegetation, buildings, power lines. CloudCore turns that raw file into usable results: ground points, individual tree inventories, power lines, fitted primitives, registered clouds. Rendering is three.js; 13 compute-heavy algorithms are compiled as C++ N-API native modules that operate **in the same address space, zero-copy**, on three.js vertex buffers inside the renderer process.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)
![Native modules: 13](https://img.shields.io/badge/C%2B%2B%20N--API-13%20modules-00599C.svg)

[中文](./README.md) ｜ **English**

<!--
  📷 Hero GIF pending (recorded manually by the author).
  Suggested content: open a LAS → orbit → switch to Elevation / Scalar field coloring, 8–10 s.
  Once recorded: put the file at docs/images/overview.gif, delete this comment and enable the line below.

![CloudCore main window](docs/images/overview.gif)
-->

---

## What it does

| What you want to do                              | How CloudCore does it                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Open a LAS / PLY with tens of millions of points | Chunked streaming reads; the UI stays responsive, and large clouds switch to LOD streaming automatically          |
| Denoise, thin out                                | Radius Filter / Statistical Filter / Voxel Filter                                                                 |
| Separate ground                                  | CSF Ground (airborne semantics) / CSF Pro (high-accuracy cloth for hills and mountains, with progress and cancel) |
| Count trees, measure height and DBH              | Tree segmentation → per-tree entities → tree height / crown width / DBH computation + 3D markers                  |
| Split merged objects                             | Euclidean Cluster with per-cluster color preview                                                                  |
| Extract power lines                              | Off-ground filter → per-point PCA → parabolic-model stripping → end-point completion                              |
| Fit planes / cylinders                           | RANSAC Plane / RANSAC Cylinder, with a live wireframe in the 3D view                                              |
| Align two clouds                                 | Point-pair coarse alignment (Horn) / ICP / GICP, with a live reachable-RMS estimate                               |
| Manually select an object                        | Polygon / box selection, split into a separate entity                                                             |
| Measure distance / angle                         | Point info / two-point distance / three-point angle                                                               |
| Inspect elevation and classification             | Elevation coloring + histogram; classification coloring (industry palette for codes 0–21)                         |
| Deliver results                                  | Save as PLY / LAS 1.2; Tree IDs travel with the file                                                              |

## Quick start

Requirements: **Windows** + Node.js + pnpm.

```bash
pnpm install
pnpm dev              # dev mode (HMR)
```

> The compiled C++ modules (`.node`) are shipped with the repository, so a fresh clone works
> **out of the box** without a C++ toolchain. You only need to rebuild locally if you change
> the C++ sources under `native/` (see "Building the native modules" below).

Package:

```bash
pnpm build:win        # vue-tsc + vite build + electron-builder (zip)
pnpm build:win:local  # same, plus an NSIS installer, no publish
```

## Feature details

### Open and browse

- **LAS 1.2 / PLY binary** read in chunks: the header is parsed first and points are pulled in on demand, so a huge file never has to load completely before you see it.
- **Scene tree** (project / container / entity): drag to reorganize, double-click to rename, per-item visibility, `Ctrl` to add to selection, `Shift` to select a range.
- **LOD streaming renderer**: per-frame draw volume depends on the screen, not on the total point count (thresholds are automatic, with a per-entity override).
- Six standard views (`Ctrl+1..6`), `Home` to fit all, `F` to fit selection, perspective / orthographic toggle.
- Double-click any point to set it as the rotation center.

### Processing algorithms (13 C++ N-API native modules)

The Tools menu groups them in four sections, sharing state with the right-side toolbar:

| Group        | Module               | Algorithm                                                                                                                             | Upstream reference                                                             |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Filter       | `radius-filter`      | Radius outlier removal                                                                                                                | PCL `RadiusOutlierRemoval`                                                     |
| Filter       | `voxel-filter`       | Voxel downsampling (returns the **original point indices** closest to each voxel centroid; coordinates are never rebuilt)             | PCL `VoxelGrid`                                                                |
| Filter       | `statistical-filter` | Statistical outlier removal (kNN mean distance beyond μ+λσ)                                                                           | PCL `StatisticalOutlierRemoval`                                                |
| Segment      | `csf-lidar`          | Ground detection, airborne semantics (cloth simulation, fast)                                                                         | CloudCompare **qCSF**                                                          |
| Segment      | `csf-pro`            | Ground detection, cloth-draping semantics (slow, high accuracy for hills; supports progress and cancel)                               | Original CSF semantics                                                         |
| Segment      | `treeiso`            | Individual tree segmentation (three-stage graph cut)                                                                                  | **qTreeIso** (Xi & Hopkinson 2022)                                             |
| Segment      | `euclidean-cluster`  | Euclidean clustering (static KD-tree + parallel union-find)                                                                           | PCL `EuclideanClusterExtraction`                                               |
| Segment      | `powerline`          | Power line extraction: off-ground filter → per-point PCA → directional connectivity → parabolic-model stripping → endpoint completion | **No upstream equivalent** (neither CloudCompare nor PCL extracts power lines) |
| Fit          | `ransac-plane`       | RANSAC plane fitting (two-stage search + Jacobi least-squares refinement)                                                             | PCL `SACSegmentation`                                                          |
| Fit          | `ransac-cylinder`    | RANSAC cylinder fitting (custom axis estimation: quantized-normal voting × anisotropy ratio)                                          | PCL `SACSegmentationFromNormals`                                               |
| Registration | `registration`       | Registration (Horn quaternion coarse alignment + ICP + **GICP**)                                                                      | CCCoreLib `RegistrationTools` + qCC dialogs; GICP follows PCL semantics        |
| —            | `normal-estimate`    | Normal estimation (least-squares plane / Quadric) + automatic radius (Edit ▸ Normals)                                                 | CloudCompare `ccNormalVectors` / `GuessBestRadius`                             |
| —            | `lod-octree`         | Builds per-entity LOD octrees for streaming (rendering infrastructure, not an algorithm modal)                                        | CloudCompare `ccPointCloudLOD`                                                 |

> Point-by-point differences from upstream, and why every parameter is what it is, are recorded in each
> module's `README-REF.md` (8 of them).

### Splitting and editing

- **Polygon / box segmentation**: circle an object in the 3D view and split it into its own entity.
- **Merge** (`Ctrl+M`), delete (`Delete`, applied to the whole selection).
- **Split by classification**, **set classification value**: from the scene tree context menu, operating on the LAS classification attribute.
- **Segmentation products are numbered automatically** (the "Tree ID" in the properties panel) and colored per tree / per cluster; the ID is written to the file's Point Source ID on Save as, so CloudCompare can color by it directly.

### Tree analysis

- **Tree segmentation**: per-tree color preview that updates live while you tune parameters such as "minimum points"; confirmed splits produce one entity per tree.
- **Compute tree info** (Trees menu): height / crown width / DBH — DBH from a 1.3 m slice with a robust circle fit; when the fit is unreliable it says so explicitly instead of inventing a number.
- **3D markers**: tree center / crown circle / DBH circle, three visibility modes.
- Mark as tree (class 4 / 5), applied to the whole selection.

### Measurement and inspection

- **Measure tool**: point info / two-point distance / three-point angle, picked in 3D with a floating readout.
- **Elevation coloring + histogram**: elevation distribution in the properties panel (computed only while Elevation mode is active).
- **Classification coloring** (Scalar field): an industry palette for codes 0–21, with deterministic fallback colors beyond the table.

### Export (File ▸ Save as…)

- **PLY binary**: coordinates written as doubles, so large georeferenced coordinates stay lossless (a 1e6-scale coordinate squeezed into a float32 loses every decimal).
- **LAS 1.2 uncompressed**, hand-written encoder/decoder, no LASzip dependency.
- Only data held in memory is written (coordinates / colors / classification / Tree IDs); one entity per export.

## Technical highlights

- **Zero-copy native algorithm channel**: C++ modules consume three.js `Float32Array` vertex buffers directly — same memory, same address space. The conventional "points over IPC → C++ → results back over IPC" pipeline loses all its gains to serialization; here it is a **pointer hand-off**. The window security configuration is deliberately wide open (`nodeIntegration: true`, `contextIsolation` off) — **a performance decision whose price is that the app must never load untrusted remote content**.
- **One shared contract across 13 modules**: inputs, error semantics and return-value convention ("indices in vertex-buffer space", never candidate-array indices) are uniform, so the renderer needs only a thin calling convention and all 13 algorithm panels have the same shape.
- **LOD streaming rendering**: the full cloud lives in RAM while only the current frame's batch sits in GPU memory; drag quality drops and then densifies step by step when idle, following CloudCompare's `ccPointCloudLOD` design so that 100 M points cost about as much to draw as 1 M.
- **Hand-written LAS / PLY I/O**: reads (chunked streaming) and writes (batched encoding + header bbox back-fill) are strictly symmetric, with zero external dependencies.
- **Every algorithm has a provenance and a written diff**: which upstream each module aligns with (CloudCompare / PCL / qTreeIso / CSF), where it deliberately differs and why, is documented per module in `README-REF.md` (8 of them).

## Architecture

```
src/
├── main/           Main process: plugins + core managers
│   ├── core/       WindowManager / PluginRegistry / StoreManager / LasManager /
│   │               PlyManager / PointCloudSaveManager / RobustnessManager …
│   └── plugins/    Plugins only wire things up; logic lives in core/*Manager.ts
├── preload/        Preload: attaches window.electronAPI / electronEvents to the page world
├── renderer/       Vue 3 renderer
│   ├── stores/     Hand-rolled state management (no Pinia / vue-router / event bus)
│   ├── three/      Engine, LOD display layer / traversal / scheduler / tree builder, 3D overlays
│   ├── composables/ Interaction (segmentation, measurement, pivot, modal registry)
│   ├── components/ Scene tree, properties panel, toolbars, dialogs
│   └── utils/      Pure functions: color spaces, selection math, contract mirrors of each native module
└── shared/         Types and utilities shared by main and renderer

native/             13 C++ N-API modules (node-gyp, released via asarUnpack)
tests/
├── unit/           Vitest: algorithm contracts + brute-force JS cross-checks
└── e2e/            Playwright: launches the real build, drives the real UI
```

Three architecture decisions worth calling out:

1. **Large arrays and three.js objects never enter the reactivity system** (`Uint32Array`, `BufferGeometry` live in module-level Maps) — Vue's deep proxy would drag rendering down.
2. **Algorithm products share the source entity's vertex buffer**, with the visible subset defined by `geometry.index`; preview = swapping the index or colors (instant, zero-copy), confirm = complement, split, new entity.
3. **The main process is plugin-based**: `PluginRegistry` only owns lifecycle; each plugin only wires things up while its logic lives in a `*Manager` singleton. Teardown runs in reverse registration order, and the logger and crash-guard plugins must register first.

## Building the native modules (only when you change C++)

You need **Visual Studio** (with the "Desktop development with C++" workload) **and a system Python** (node-gyp dependency):

```bash
pnpm build:native     # rebuilds all 13 modules, no incremental mode
```

> node-gyp locates Visual Studio through `vswhere.exe`. If a plain terminal reports "Visual Studio not
> found", add `C:\Program Files (x86)\Microsoft Visual Studio\Installer` to `PATH` first.

## Tests

```bash
pnpm test:unit        # Vitest unit tests
pnpm lint             # ESLint (deliberately loose: real errors only, no formatting)
```

- **The unit tests are a second specification of the algorithms**: each native module's contract tests are cross-checked bit-for-bit against a brute-force JS reference, and modules such as `registration` additionally pin determinism, chunk-invariance and thread-independence. On machines without a C++ toolchain, the groups that need native binaries **skip as a whole**.
- **e2e** (Playwright) launches the real build and goes through the exact entry points a user clicks. Electron's main process holds a single-instance lock, so e2e must run serially (`workers: 1` is fixed in `playwright.config.ts`); rebuild with `pnpm build:test` after changing main-process code.

## Known limitations

- **Windows only.** Parts of the implementation (window controls, tray, packaging) are platform-bound.
- **No sample point cloud data in this repository.** Bring your own `.las` / `.ply` files; tests use synthetic data generated at runtime.
- **Merged entities lose their normals**: normals from different sources may contradict each other, so recompute after a merge. This is intentional, not a defect.
- **Window security was traded for performance** (see "Technical highlights"), so **this application must not load untrusted remote content**.
- LAS support is 1.2 uncompressed only (no LAZ), with a classification ceiling of 31 (LAS 1.2 keeps only the low 5 bits; PLY classification is a full u8 and lossless).

## License

[GPL-3.0](./LICENSE) © 2026 何星驰 (He Xingchi)

This project is **for learning and exchange only** and is not intended for commercial use. Modules such as
`csf-lidar` / `csf-pro` / `treeiso` / `euclidean-cluster` / `ransac-plane` / `ransac-cylinder` /
`normal-estimate` / `registration` align in algorithm semantics with upstream projects including CloudCompare
(GPL), CSF, qTreeIso and PCL (BSD-3-Clause); the differences are documented per module in the corresponding
`README-REF.md`. Publishing the whole under GPL-3.0 is precisely to stay license-compatible with those upstreams.
