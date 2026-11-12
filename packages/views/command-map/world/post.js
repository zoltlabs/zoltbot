// Post-processing: ambient occlusion, bloom on things that give off light, and a light
// depth-of-field blur toward the top and bottom edges that keeps the focus row sharp.
// Each graphics level in skin.js turns some of these off; the lowest level skips this file's
// passes and draws the scene directly.
(() => {
  const map = window.CommandMap,
    T = window.THREE;

  // One direction of the tilt-shift blur. Rows near `focus` stay sharp; blur grows with distance.
  const tiltShift = {
    uniforms: {
      tDiffuse: { value: null },
      direction: { value: new T.Vector2() },
      focus: { value: 0.5 },
      band: { value: 0.2 },
      strength: { value: 2 },
    },
    vertexShader:
      "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform vec2 direction;
      uniform float focus, band, strength; // strength is the widest blur, in CSS pixels
      void main() {
        float amount = smoothstep(band, band + 0.3, abs(vUv.y - focus)) * strength;
        vec4 sum = vec4(0.0);
        float total = 0.0;
        for (int i = -4; i <= 4; i++) {
          float weight = 1.0 - abs(float(i)) / 5.0;
          sum += texture2D(tDiffuse, vUv + direction * float(i) * amount * 0.5) * weight;
          total += weight;
        }
        gl_FragColor = sum / total;
      }`,
  };

  map.builders.post.lens = (world, renderer, camera) => {
    const { scene, skin } = world;
    let composer,
      passes = {},
      level = {},
      width = 1,
      height = 1,
      focus = 0.5;
    function build() {
      composer?.dispose();
      for (const pass of Object.values(passes)) pass.dispose?.();
      composer = undefined;
      passes = {};
      renderer.shadowMap.enabled = !!level.shadows;
      world.parts.lighting?.setShadows(!!level.shadows);
      const ratio = Math.min(window.devicePixelRatio || 1, level.pixels ?? 1);
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      if (!level.bloom && !level.ambientOcclusion && !level.depthOfField) return;
      composer = new T.EffectComposer(
        renderer,
        new T.WebGLRenderTarget(width * ratio, height * ratio, {
          type: T.HalfFloatType,
          samples: 4,
        }),
      );
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      composer.addPass(new T.RenderPass(scene, camera));
      if (level.ambientOcclusion) {
        passes.occlusion = new T.GTAOPass(scene, camera, width, height);
        passes.occlusion.blendIntensity = 0.9;
        passes.occlusion.updateGtaoMaterial({
          radius: 1.6,
          distanceExponent: 1.4,
          thickness: 1.2,
          scale: 1.1,
          samples: 12,
        });
        composer.addPass(passes.occlusion);
      }
      if (level.bloom) {
        passes.bloom = new T.UnrealBloomPass(new T.Vector2(width, height), 0.2, 0.4, 1);
        composer.addPass(passes.bloom);
      }
      if (level.depthOfField) {
        passes.blurAcross = new T.ShaderPass(tiltShift);
        passes.blurDown = new T.ShaderPass(tiltShift);
        composer.addPass(passes.blurAcross);
        composer.addPass(passes.blurDown);
      }
      composer.addPass(new T.OutputPass());
      theme();
    }
    function theme() {
      const palette = world.palette;
      renderer.toneMappingExposure = palette.exposure;
      if (passes.bloom) Object.assign(passes.bloom, palette.bloom);
    }
    return {
      setLevel(next) {
        level = next;
        build();
      },
      setSize(w, h) {
        if (w === width && h === height) return;
        width = w;
        height = h;
        renderer.setSize(w, h, false);
        composer?.setSize(w, h);
      },
      theme,
      // `row` is the screen row to keep sharp: 0 at the bottom, 1 at the top.
      setFocus(row) {
        focus = row;
      },
      // Bloom eases off when zoomed far in or out, where lights would otherwise flood the view.
      setZoom(zoom) {
        if (passes.bloom)
          passes.bloom.strength =
            world.palette.bloom.strength * Math.max(0.4, zoom > 1 ? zoom ** -0.6 : zoom ** 0.6);
      },
      passes: () => Object.keys(passes),
      render() {
        if (!composer) {
          renderer.render(scene, camera);
          return;
        }
        if (passes.blurAcross) {
          for (const [pass, x, y] of [
            [passes.blurAcross, 1 / width, 0],
            [passes.blurDown, 0, 1 / height],
          ]) {
            pass.uniforms.direction.value.set(x, y);
            pass.uniforms.focus.value = focus;
            pass.uniforms.band.value = skin.focus.band;
            pass.uniforms.strength.value = skin.focus.blur;
          }
        }
        composer.render();
      },
      dispose() {
        composer?.dispose();
        for (const pass of Object.values(passes)) pass.dispose?.();
      },
    };
  };
})();
