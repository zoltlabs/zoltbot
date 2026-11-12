// The skin: every color, size and timing the world uses, and which builder draws each part.
// Change values here to reskin the map without touching logic. See README.md for examples.
(() => {
  window.CommandMap = window.CommandMap || {};
  const map = window.CommandMap;
  map.skin = {
    // Which builder draws each part of the world. A builder registers itself under
    // CommandMap.builders.<part>.<name> (see world/*.js); name another one here to replace it.
    builders: {
      terrain: "platforms",
      buildings: "facilities",
      units: "mechs",
      marks: "tactical",
      effects: "sparks",
      lighting: "sunAndMoon",
      post: "lens",
    },

    // World colors. "day" follows the app's light theme and "night" its dark theme.
    // The look is a forward base: steel platforms on bare ground, muted, with a few lit accents.
    // Lists are varied per platform or structure so neighbours differ.
    palettes: {
      day: {
        mist: "#c5c9cc", // background and fog: the empty ground between platforms
        ground: "#a3a6a6",
        gridLine: "#8f9294", // survey grid drawn on the ground
        deck: ["#7b8187", "#80857f", "#77808a", "#858280"], // platform plating
        deckLine: "#666c72", // seams between plates
        deckEdge: "#50555b", // the platform's stepped base
        trim: ["#d6a419", "#3d8fb8", "#b9583c", "#5c9a68"], // painted line around each platform
        pad: "#5d6368", // marked bay in front of each structure
        padLine: "#c9ccce",
        hull: ["#a2a8ae", "#aaa69c", "#9fa8b2"], // structure walls
        hullDark: "#6a7078", // upper decks and roof units
        door: "#2f3338",
        stack: "#474c52",
        bayOff: "#3a4046", // light strips when no one is working
        bayLit: "#ffd27a",
        signBoard: "#1d2024",
        signPost: "#474c52",
        signInk: "#ffc857",
        signGlow: 0.25, // how much light a sign gives off
        armor: "#8a9097", // unit frame
        joint: "#34383d", // legs, arms and hips
        visorOff: "#1c1f23",
        crate: ["#6c7a52", "#8a7350", "#5d6a78"],
        lampLit: "#e6e2d6",
        ring: "#f4fff4", // selection ring
        ringEdge: "#14181a",
        exhaust: "#e4e6e8",
        // State colors for marks and visors. They echo the app's status colors, tuned to read
        // against steel and ground rather than a white page.
        states: {
          needs_you: "#ff7a1a",
          working: "#2f9bff",
          review: "#2bb673",
          idle: "#7d8288",
          problem: "#f0b400",
        },
        sun: { color: "#fff4e2", intensity: 3.1, azimuth: -0.75, elevation: 0.8 },
        sky: { top: "#dfe6ee", ground: "#8c8f90", intensity: 0.8 },
        exposure: 1.0,
        emit: 1.0, // multiplier for things that give off light
        glow: 0, // strength of light pools on the ground
        shade: 0.3, // darkness of the soft contact shadow under units and structures
        bloom: { strength: 0.18, radius: 0.35, threshold: 1.0 },
      },
      night: {
        mist: "#101215",
        ground: "#22262b",
        gridLine: "#343a41",
        deck: ["#4b525b", "#4f5356", "#47505c", "#535156"],
        deckLine: "#353b43",
        deckEdge: "#2a2f36",
        trim: ["#b88a14", "#2c7396", "#96452f", "#457a52"],
        pad: "#333940",
        padLine: "#8a929b",
        hull: ["#7a828d", "#807e7a", "#76808e"],
        hullDark: "#4c535c",
        door: "#121519",
        stack: "#24282d",
        bayOff: "#5a4a2a", // a low light is left on at night
        bayLit: "#ffcf70",
        signBoard: "#0e1013",
        signPost: "#24282d",
        signInk: "#ffc857",
        signGlow: 0.8,
        armor: "#8b939e",
        joint: "#30353c",
        visorOff: "#0b0d10",
        crate: ["#3a442c", "#4a3e2c", "#323a44"],
        lampLit: "#ffe2a6",
        ring: "#f4fff4",
        ringEdge: "#050607",
        exhaust: "#8d949c",
        states: {
          needs_you: "#ff9a4d",
          working: "#59b0ff",
          review: "#3ec27a",
          idle: "#5d636b",
          problem: "#e6a23c",
        },
        sun: { color: "#e6e9f0", intensity: 2.6, azimuth: -0.75, elevation: 0.9 }, // the moon
        sky: { top: "#a9adb5", ground: "#44474c", intensity: 2.2 },
        exposure: 1.1,
        emit: 2.4,
        glow: 0.3,
        shade: 0.45,
        bloom: { strength: 0.4, radius: 0.4, threshold: 1.0 },
      },
    },

    // Each provider gets a team color (a theme token), worn on the shoulders and chest, and one
    // piece of equipment on top. Equipment: antenna, twin, fin, ears, halo, hat, brim, dome.
    // Unknown providers get one by name.
    providers: {
      claude: { token: "--zb-provider-claude", detail: "antenna" },
      codex: { token: "--zb-provider-codex", detail: "brim" },
      gemini: { token: "--zb-provider-gemini", detail: "twin" },
      grok: { token: "--zb-provider-grok", detail: "fin" },
      cursor: { token: "--zb-provider-cursor", detail: "ears" },
      opencode: { token: "--zb-provider-opencode", detail: "halo" },
      pi: { token: "--zb-provider-pi", detail: "hat" },
    },
    fallbackTokens: ["--zb-avatar-2", "--zb-avatar-3", "--zb-avatar-4", "--zb-avatar-6"],
    fallbackDetails: ["dome", "antenna", "fin", "ears"],

    // Sizes in world units. A unit slot in the layout is 4 wide.
    sizes: {
      ground: -1.3, // height of the bare ground; platform tops are at 0
      grid: 10, // spacing of the survey grid on the ground
      platformCorner: 1.2,
      skirt: 0.7, // how far the stepped base sticks out past the deck
      building: { w: 5, h: 2.1, d: 4 },
      robot: 1.8, // scale of the unit model
      beacon: 8, // height of the "needs you" beam
      labelZoom: 1.5, // show every on-screen unit's name at this zoom or closer
      farZoom: 0.5, // below this zoom units become simple markers
    },

    camera: {
      fov: 24,
      distance: 110, // at zoom 1
      yaw: 0.54, // radians east of south
      pitch: 0.93, // radians above the horizon
      minZoom: 0.14,
      maxZoom: 4,
      ease: 0.14, // seconds for pan and zoom to cover most of the distance
    },

    // Seconds.
    timing: {
      intro: 1.5, // the world settling into place on first load
      work: 0.7, // one pass of the welding arm
      beaconPulse: 1.6,
      celebrate: 1.4,
      ambientFps: 30, // frame rate while only ambient animation plays
      idleFps: 2, // frame rate while nothing moves
    },

    // Depth of field: rows this far from the focus (as a fraction of the height) stay sharp, and
    // the far edges soften by at most `blur` pixels. Kept light; a strong blur looks like a toy.
    focus: { band: 0.3, blur: 1.1 },

    // What each graphics level turns on. Auto steps down when frames take longer than `slowMs`.
    quality: {
      high: { depthOfField: true, ambientOcclusion: true, shadows: true, bloom: true, pixels: 2 },
      medium: {
        depthOfField: false,
        ambientOcclusion: false,
        shadows: true,
        bloom: true,
        pixels: 1.5,
      },
      low: {
        depthOfField: false,
        ambientOcclusion: false,
        shadows: false,
        bloom: false,
        pixels: 1,
      },
      slowMs: 26,
      sampleFrames: 40,
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
  map.builders = {
    terrain: {},
    buildings: {},
    units: {},
    marks: {},
    effects: {},
    lighting: {},
    post: {},
  };
})();
