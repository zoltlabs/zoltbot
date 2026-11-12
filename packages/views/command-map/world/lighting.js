// Lighting: a soft sky light plus one sun (day) or moon (night) that casts the shadows.
// The shadow area follows the camera so shadows stay sharp wherever the owner looks.
(() => {
  const map = window.CommandMap,
    T = window.THREE;

  map.builders.lighting.sunAndMoon = (world) => {
    const { scene } = world;
    const sky = new T.HemisphereLight(),
      sun = new T.DirectionalLight();
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
    sun.shadow.radius = 1.6;
    scene.add(sky, sun, sun.target);
    const offset = new T.Vector3();
    return {
      theme() {
        const palette = world.palette,
          { azimuth, elevation } = palette.sun;
        sky.color.set(palette.sky.top);
        sky.groundColor.set(palette.sky.ground);
        sky.intensity = palette.sky.intensity;
        sun.color.set(palette.sun.color);
        sun.intensity = palette.sun.intensity;
        offset.set(
          Math.sin(azimuth) * Math.cos(elevation),
          Math.sin(elevation),
          Math.cos(azimuth) * Math.cos(elevation),
        );
        scene.background = new T.Color(palette.mist);
        scene.fog = new T.Fog(palette.mist, 100, 400);
      },
      setShadows(on) {
        sun.castShadow = on;
      },
      // `reach` is how far from the look-at point the camera can see.
      update(frame) {
        const { x, z } = frame.target,
          reach = frame.reach;
        sun.target.position.set(x, 0, z);
        sun.position.copy(sun.target.position).addScaledVector(offset, 300);
        const shadow = sun.shadow.camera;
        if (shadow.right !== reach) {
          Object.assign(shadow, {
            left: -reach,
            right: reach,
            top: reach,
            bottom: -reach,
            near: 50,
            far: 600,
          });
          shadow.updateProjectionMatrix();
        }
        // Fog starts well behind the look-at point and thickens toward the horizon.
        scene.fog.near = frame.distance * 1.4;
        scene.fog.far = frame.distance * 4;
      },
      dispose() {
        scene.remove(sky, sun, sun.target);
        sun.shadow.map?.dispose();
      },
    };
  };
})();
