# Browser UI fixture

`local-form.png` is a nonsecret local form screenshot from the pinned CLI compatibility spike. It contains fake alias data and a raster-only numeric challenge. It is used to test binary delivery, the gallery, image dimensions and revision grouping; synthetic UI success is not native-browser acceptance.

The opt-in canaries in tools/canary/src/browser-product.ts and browser-shared.ts generate new random raster digits in server memory. Those digits are absent from DOM text, paths and model prompts.
