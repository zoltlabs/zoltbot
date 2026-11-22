// What the map looks like: terrain colors, workspace colors, hex size and sounds. Edit this
// file to restyle the map. Panel colors for the light and dark themes are in style.css.
(() => {
  window.CommandMap = window.CommandMap || {};
  const map = window.CommandMap;
  map.skin = {
    // Hex radius in pixels at zoom 1, and how much the map is squashed to look tilted.
    hex: { radius: 34, tilt: 0.74 },
    // Changing the seed gives a different coastline, forests and mountains.
    seed: 20261113,
    // Each terrain type: two tones for its top (tiles alternate), and how high it stands.
    terrain: {
      ocean: { tops: ["#1d4f74", "#215a82"], lift: 0 },
      coast: { tops: ["#2f7ea3", "#3689ad"], lift: 1 },
      grass: { tops: ["#6f9a3c", "#78a443"], lift: 6 },
      plains: { tops: ["#a9a45a", "#b4ae63"], lift: 6 },
      forest: { tops: ["#5a8434", "#63903a"], lift: 6 },
      hills: { tops: ["#9c9256", "#a89d5e"], lift: 10 },
      mountain: { tops: ["#7c7a74", "#87857e"], lift: 12 },
    },
    // Workspace colors, in order. Each is dark enough for white text on its banner.
    workspaces: ["#2f62c8", "#7d3fb8", "#a8325a", "#1f7a5a", "#9a5a12", "#2c6f8f", "#8a3f9a", "#5a6472"],
    // State colors on the map. Markers sit on dark plates in both themes.
    states: {
      needs_you: "#ff9a5c",
      working: "#a9a4ff",
      review: "#3ec27a",
      idle: "#7d7d86",
      problem: "#e6a23c",
      selected: "#fff1c9",
    },
    // Walker colors: legs, body, body shade, arm, head.
    walker: ["#3a3d46", "#5b606c", "#4c515c", "#4a4e58", "#6b707c"],
    // Agent colors on shoulders, flags and portraits. Unknown agents use `other`.
    providers: {
      claude: "#d97757",
      codex: "#f2f2f4",
      gemini: "#7aa7ff",
      grok: "#9a9aa2",
      cursor: "#c9b5ff",
      opencode: "#9fe2bd",
      pi: "#3ea6c2",
      other: "#b7b7bd",
    },
    // Web Audio notes for the three sounds: [frequency in Hz, start in seconds, length].
    sounds: {
      needsYou: {
        wave: "triangle",
        gain: 0.16,
        notes: [
          [659, 0, 0.16],
          [988, 0.14, 0.3],
        ],
      },
      finished: {
        wave: "sine",
        gain: 0.14,
        notes: [
          [523, 0, 0.2],
          [659, 0.09, 0.2],
          [784, 0.18, 0.45],
        ],
      },
      failed: {
        wave: "sawtooth",
        gain: 0.08,
        notes: [
          [196, 0, 0.2],
          [147, 0.18, 0.4],
        ],
      },
    },
  };
})();
