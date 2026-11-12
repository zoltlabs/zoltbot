// Small helpers the world builders share: stable randomness, colors, instanced pools,
// matrices and generated textures.
(() => {
  const map = window.CommandMap,
    T = window.THREE,
    kit = {};
  map.kit = kit;

  // A stable number for a string, so an island keeps its tint and a robot its rhythm.
  kit.hash = (text) => {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++)
      value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return value >>> 0;
  };
  kit.unit = (text) => kit.hash(text) / 4294967296; // 0 to 1
  kit.pick = (list, key) => list[kit.hash(String(key)) % list.length];

  // Reads a theme token (for example "--zb-attention") as a color, whatever CSS form it has.
  let probe;
  kit.token = (name) => {
    if (!probe) {
      probe = document.createElement("span");
      probe.hidden = true;
      document.body.append(probe);
    }
    probe.style.color = "";
    probe.style.color = `var(${name})`;
    const channels = (getComputedStyle(probe).color.match(/[0-9.]+/g) ?? [128, 128, 128]).map(
      Number,
    );
    return new T.Color().setRGB(
      channels[0] / 255,
      channels[1] / 255,
      channels[2] / 255,
      T.SRGBColorSpace,
    );
  };

  // One draw call for many copies of a shape. Call begin(count), put(...) each, then end().
  kit.Pool = class {
    constructor(parent, geometry, material, { cast = false, receive = false } = {}) {
      Object.assign(this, { parent, geometry, material, cast, receive, capacity: 0 });
      this.grow(16);
    }
    grow(capacity) {
      if (this.mesh) {
        this.parent.remove(this.mesh);
        this.mesh.dispose();
      }
      this.capacity = capacity;
      this.mesh = new T.InstancedMesh(this.geometry, this.material, capacity);
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = this.cast;
      this.mesh.receiveShadow = this.receive;
      this.mesh.count = 0;
      this.mesh.visible = this.shown ?? true;
      this.parent.add(this.mesh);
    }
    begin(count) {
      if (count > this.capacity) this.grow(2 ** Math.ceil(Math.log2(count)));
      this.mesh.count = count;
    }
    put(index, matrix, color) {
      this.mesh.setMatrixAt(index, matrix);
      if (color) this.mesh.setColorAt(index, color);
    }
    end() {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
    show(visible) {
      this.shown = visible;
      this.mesh.visible = visible;
    }
    dispose() {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
      this.geometry.dispose();
      this.material.dispose();
    }
  };

  // Matrices. `place` builds one from a position, turn and scale; `under` places a part
  // relative to a parent matrix. Both return a scratch matrix: use it before the next call.
  const position = new T.Vector3(),
    turn = new T.Quaternion(),
    size = new T.Vector3(),
    angles = new T.Euler(),
    scratch = new T.Matrix4(),
    local = new T.Matrix4();
  function compose(target, x, y, z, rx, ry, rz, sx, sy, sz) {
    position.set(x, y, z);
    turn.setFromEuler(angles.set(rx, ry, rz, "YXZ"));
    size.set(sx, sy, sz);
    return target.compose(position, turn, size);
  }
  kit.place = (x, y, z, { rx = 0, ry = 0, rz = 0, s = 1, sx = s, sy = s, sz = s } = {}) =>
    compose(scratch, x, y, z, rx, ry, rz, sx, sy, sz);
  kit.under = (parent, x, y, z, { rx = 0, ry = 0, rz = 0, s = 1, sx = s, sy = s, sz = s } = {}) =>
    scratch.multiplyMatrices(parent, compose(local, x, y, z, rx, ry, rz, sx, sy, sz));

  // Geometry: give every vertex one color, and join pieces into a single shape.
  kit.paint = (geometry, color) => {
    const count = geometry.attributes.position.count,
      values = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) color.toArray(values, index * 3);
    geometry.setAttribute("color", new T.BufferAttribute(values, 3));
    return geometry;
  };
  kit.join = (pieces) => {
    const plain = pieces.map((piece) => {
      const geometry = piece.index ? piece.toNonIndexed() : piece;
      geometry.deleteAttribute("uv");
      return geometry;
    });
    const joined = T.mergeGeometries(plain);
    for (const piece of [...pieces, ...plain]) piece.dispose();
    return joined;
  };

  // A soft round dot, white in the middle and clear at the edge. Used for contact shadows,
  // light pools and particles.
  kit.dot = (hardness = 0) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d"),
      gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(hardness, "rgba(255,255,255,1)");
    gradient.addColorStop(hardness + (1 - hardness) * 0.4, "rgba(255,255,255,0.4)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  };

  kit.ease = (value) => 1 - (1 - Math.min(1, Math.max(0, value))) ** 3; // ease-out
  kit.pop = (value) => {
    // ease-out with a small overshoot, for things that arrive
    const t = Math.min(1, Math.max(0, value)) - 1;
    return 1 + 2.2 * t * t * t + 1.2 * t * t;
  };
})();
