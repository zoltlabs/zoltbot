# Artifact kit v1

The application bundles its neutral styles/components and serves this pinned chart bundle only for manifests declaring kit v1. No external assets are fetched. Future incompatible changes require a new kit version.

Chart.js 4.5.1 and its bundled @kurkle/color 0.3.2 are MIT. The exact npm tarball and tagged upstream licenses were checked before vendoring; complete notices accompany the unchanged bundle. Bundle SHA-256: `48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a`. Checked tarball SHA-256s: Chart.js `f540d98468457ac7a0aabb32006dfb066297e096c5ea063a5d80aa973d1c337a`, @kurkle/color `af9eaac0ecbb472fe2093d2a4525629f96541f4e6422c031d9c86d4dc8fc7511`. Their LICENSE.md files were byte-identical to upstream v4.5.1 and v0.3.2. Source maps are not shipped; they are unnecessary for rendering.
