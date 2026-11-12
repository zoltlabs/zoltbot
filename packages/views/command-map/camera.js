// The camera: a narrow perspective view from above at an angle. Pan and zoom ease toward
// their targets; with reduced motion they jump instead.
(() => {
  const map = window.CommandMap,
    T = window.THREE;
  map.Camera = class {
    constructor(skin, reducedMotion) {
      this.settings = skin.camera;
      this.reducedMotion = reducedMotion;
      this.lens = new T.PerspectiveCamera(skin.camera.fov, 1, 20, 1400);
      this.goal = { x: 0, z: 0, zoom: 1 }; // where the camera is heading
      this.now = { x: 0, z: 0, zoom: 1 }; // where it is
      this.width = this.height = 1;
      this.ray = new T.Raycaster();
      this.plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
      this.point = new T.Vector3();
    }
    get distance() {
      return this.settings.distance / this.now.zoom;
    }
    resize(width, height) {
      this.width = width;
      this.height = height;
      this.lens.aspect = width / height;
      this.lens.updateProjectionMatrix();
    }
    lookAt(x, z, zoom = this.goal.zoom) {
      const { minZoom, maxZoom } = this.settings;
      Object.assign(this.goal, { x, z, zoom: Math.min(maxZoom, Math.max(minZoom, zoom)) });
    }
    // Moves the view by screen pixels: positive dx looks further right, positive dy further down.
    pan(dx, dy, instant = false) {
      const { fov, distance, yaw, pitch } = this.settings,
        perPixel = (2 * Math.tan((fov * Math.PI) / 360) * distance) / this.goal.zoom / this.height,
        across = dx * perPixel,
        along = (dy * perPixel) / Math.sin(pitch);
      this.lookAt(
        this.goal.x + across * Math.cos(yaw) + along * Math.sin(yaw),
        this.goal.z - across * Math.sin(yaw) + along * Math.cos(yaw),
      );
      if (instant) Object.assign(this.now, { x: this.goal.x, z: this.goal.z });
    }
    jump() {
      Object.assign(this.now, this.goal);
      this.apply();
    }
    // Moves toward the goal. Returns true while the camera is still travelling.
    update(delta) {
      const { now, goal } = this,
        blend = this.reducedMotion ? 1 : 1 - Math.exp(-delta / this.settings.ease);
      now.x += (goal.x - now.x) * blend;
      now.z += (goal.z - now.z) * blend;
      now.zoom *= (goal.zoom / now.zoom) ** blend;
      const moving =
        Math.abs(goal.x - now.x) + Math.abs(goal.z - now.z) > 0.01 ||
        Math.abs(goal.zoom / now.zoom - 1) > 0.002;
      if (!moving) Object.assign(now, goal);
      this.apply();
      return moving;
    }
    apply(extra = 0) {
      const { yaw, pitch } = this.settings,
        reach = this.distance * (1 + extra);
      this.lens.position.set(
        this.now.x + Math.sin(yaw) * Math.cos(pitch) * reach,
        Math.sin(pitch) * reach,
        this.now.z + Math.cos(yaw) * Math.cos(pitch) * reach,
      );
      this.lens.lookAt(this.now.x, 0, this.now.z);
      // Keep the depth range tight around the scene; ambient occlusion needs the precision.
      this.lens.near = Math.max(2, reach * 0.25);
      this.lens.far = reach * 3 + 300;
      this.lens.updateProjectionMatrix();
      this.lens.updateMatrixWorld();
    }
    // World position to screen pixels inside the map.
    project(x, y, z) {
      const value = this.point.set(x, y, z).project(this.lens);
      return [((value.x + 1) / 2) * this.width, ((1 - value.y) / 2) * this.height];
    }
    // Screen pixels to the point on the ground under them.
    ground(sx, sy) {
      this.ray.setFromCamera(
        new T.Vector2((sx / this.width) * 2 - 1, 1 - (sy / this.height) * 2),
        this.lens,
      );
      return this.ray.ray.intersectPlane(this.plane, new T.Vector3());
    }
    // The four ground points at the corners of the screen, for the minimap.
    corners() {
      return [
        [0, 0],
        [this.width, 0],
        [this.width, this.height],
        [0, this.height],
      ].map(([x, y]) => this.ground(x, y));
    }
    // Zoom and center that show a rectangle of ground with some room around it.
    frame(bounds, margin = 1.15) {
      const { fov, distance, pitch } = this.settings,
        tall = 2 * Math.tan((fov * Math.PI) / 360) * distance,
        wide = tall * this.lens.aspect;
      // Ground depth is foreshortened by the camera's pitch.
      const zoom = Math.min(
        wide / (bounds.w * margin + bounds.d * 0.3),
        tall / ((bounds.d * Math.sin(pitch) + bounds.w * 0.25) * margin),
      );
      this.lookAt(bounds.x + bounds.w / 2, bounds.z + bounds.d / 2, zoom);
    }
  };
})();
