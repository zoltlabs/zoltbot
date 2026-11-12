# Vendored libraries

| File | Library | Version | License | Source |
| --- | --- | --- | --- | --- |
| `three-0.187.0.bundle.min.js` | three.js, with the add-ons listed below | 0.187.0 | MIT (`LICENSE.txt`) | `https://registry.npmjs.org/three/-/three-0.187.0.tgz` |

The bundle is one classic script that defines `window.THREE`. It holds the whole three.js core
plus these add-ons from `examples/jsm`: `EffectComposer`, `RenderPass`, `ShaderPass`,
`UnrealBloomPass`, `GTAOPass`, `OutputPass`, `RoundedBoxGeometry` and `mergeGeometries`.

`scripts/build-command-map-vendor.mjs` in the Zoltbot repository builds it: the script downloads
the pinned npm package, checks its integrity hash, bundles it with esbuild and copies the license.
The view loads only this file. It never loads a library from the network.
