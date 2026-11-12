// Graphics level: high, medium or low (see skin.js for what each turns on). "Auto" starts
// high, or low on a software renderer, and steps down when frames take too long.
(() => {
  const map = window.CommandMap;
  const levels = ["high", "medium", "low"];
  map.qualityLevels = levels;

  map.Quality = class {
    // onChange(level name) runs whenever the level in use changes.
    constructor(skin, renderer, onChange) {
      this.settings = skin.quality;
      this.onChange = onChange;
      this.choice = "auto";
      this.samples = [];
      this.skip = 12; // the first frames compile shaders and are not typical
      const gl = renderer.getContext(),
        info = gl.getExtension("WEBGL_debug_renderer_info"),
        name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      this.software = /swiftshader|llvmpipe|software/i.test(name);
      this.level = this.software ? "low" : "high";
    }
    // The owner's choice: "auto" or one of the levels.
    choose(choice) {
      this.choice = levels.includes(choice) ? choice : "auto";
      const next = this.choice === "auto" ? (this.software ? "low" : "high") : this.choice;
      this.samples = [];
      if (next !== this.level) {
        this.level = next;
        this.onChange(next);
      }
    }
    // Call once per drawn frame with the time since the previous one, in milliseconds.
    // Only frames drawn back to back count; pauses between idle frames say nothing.
    measure(elapsed, continuous) {
      if (this.choice !== "auto" || this.level === "low" || !continuous) return;
      if (this.skip > 0) {
        this.skip--;
        return;
      }
      this.samples.push(elapsed);
      if (this.samples.length < this.settings.sampleFrames) return;
      const median = this.samples.toSorted((a, b) => a - b)[this.samples.length >> 1];
      this.samples = [];
      if (median > this.settings.slowMs) {
        this.level = levels[levels.indexOf(this.level) + 1];
        this.skip = 12;
        this.onChange(this.level);
      }
    }
  };
})();
