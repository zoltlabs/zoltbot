// The skin: every color, size and timing the world uses, and which builder draws each part.
// Change values here to reskin the map without touching logic. See README.md for examples.
(() => {
  window.CommandMap = window.CommandMap || {};
  const map = window.CommandMap;
  map.skin = {
    // Which builder draws each part of the world. A builder registers itself under
    // CommandMap.builders.<part>.<name> (see world/*.js); name another one here to replace it.
    builders: {
      terrain: "islands",
      buildings: "workshops",
      units: "robots",
      marks: "beacons",
      effects: "sparks",
      lighting: "sunAndMoon",
      post: "diorama",
    },

    // World colors. "day" follows the app's light theme and "night" its dark theme.
    // Lists are varied per island, building or tree so neighbours differ.
    palettes: {
      day: {
        mist: "#e3ebee", // background and fog: the calm space between islands
        water: "#a5cbd6",
        shallows: "#bfdde3",
        foam: "#eef6f6",
        grass: ["#93c06c", "#c7ba78", "#7fb596", "#b4c568", "#a5bb8c"],
        soil: "#b38d66",
        rock: "#8f7f72",
        path: "#dccdae",
        walls: ["#f4ebdc", "#ecdcc8", "#e6e2d8"],
        roofs: ["#c9573f", "#42718f", "#d18c3c", "#5f7c59"],
        door: "#6d4c36",
        chimney: "#8c827a",
        windowOff: "#5c7386",
        windowLit: "#ffe2a0",
        signBoard: "#ecd2a2",
        signPost: "#7c5c3e",
        signInk: "#2b2118",
        signGlow: 0, // how much light a sign gives off
        shell: "#f2f2ee", // robot head
        tread: "#3b3e46",
        visorOff: "#23262d",
        foliage: ["#4f9a5b", "#63a85f", "#3f8a63"],
        trunk: "#7c5c3e",
        stone: "#a9aba8",
        lampOff: "#d8d2c4",
        lampLit: "#d8d2c4",
        ring: "#ffffff", // selection ring
        ringEdge: "#1c1d22",
        // State colors for marks and robot visors. They echo the app's status colors, brighter,
        // because they must read against grass and water rather than a white page.
        states: {
          needs_you: "#ff6a1a",
          working: "#5a50f0",
          review: "#1fa463",
          idle: "#8b8b93",
          problem: "#f2a900",
        },
        sun: { color: "#fff2dc", intensity: 2.7, azimuth: -0.9, elevation: 0.95 },
        sky: { top: "#e4f2ff", ground: "#b9c7a0", intensity: 1.15 },
        exposure: 1.0,
        emit: 1.0, // multiplier for things that give off light
        glow: 0, // strength of light pools on the ground
        shade: 0.26, // darkness of the soft contact shadow under units and buildings
        bloom: { strength: 0.22, radius: 0.4, threshold: 1.0 },
      },
      night: {
        mist: "#15171b",
        water: "#1f242c",
        shallows: "#252b34",
        foam: "#2e3540",
        grass: ["#46705a", "#6b6a4a", "#3f6c69", "#58734a", "#51705f"],
        soil: "#6a564c",
        rock: "#4a4550",
        path: "#857868",
        walls: ["#9a93a3", "#a59597", "#9499aa"],
        roofs: ["#a85047", "#41688c", "#ad7c42", "#55735a"],
        door: "#3f2f27",
        chimney: "#63606a",
        windowOff: "#8a6a3a", // a low light is left on at night
        windowLit: "#ffcf70",
        signBoard: "#5f4d3a",
        signPost: "#4f3d30",
        signInk: "#f6ead6",
        signGlow: 0.35,
        shell: "#d9dce6",
        tread: "#24262d",
        visorOff: "#0d0f13",
        foliage: ["#2f6049", "#376b53", "#2a5748"],
        trunk: "#4f3d30",
        stone: "#6b6e78",
        lampOff: "#3a3c44",
        lampLit: "#ffd88a",
        ring: "#ffffff",
        ringEdge: "#0b0c10",
        states: {
          needs_you: "#ff9a5c",
          working: "#9089ff",
          review: "#3ec27a",
          idle: "#6b6b74",
          problem: "#e6a23c",
        },
        sun: { color: "#cdd6f5", intensity: 1.9, azimuth: -0.9, elevation: 1.05 }, // the moon
        sky: { top: "#a3abc2", ground: "#3a3f4c", intensity: 1.9 },
        exposure: 1.15,
        emit: 2.4,
        glow: 0.32,
        shade: 0.4,
        bloom: { strength: 0.38, radius: 0.45, threshold: 1.0 },
      },
    },

    // Each provider gets a body color (a theme token) and one silhouette detail on the head.
    // Details: antenna, twin, fin, ears, halo, hat, brim, dome. Unknown providers get one by name.
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

    // Sizes in world units. A unit slot in the layout is 3.5 wide.
    sizes: {
      water: -2.2, // height of the water surface; island tops are at 0
      islandCorner: 3.5,
      skirt: 0.9, // how far the rock base sticks out past the grass
      building: { w: 5, h: 2.8, d: 4, roof: 1.7 },
      robot: 1.4, // scale of the unit model
      beacon: 8, // height of the "needs you" beam
      labelZoom: 1.5, // show every on-screen unit's name at this zoom or closer
      farZoom: 0.5, // below this zoom units become simple markers
    },

    camera: {
      fov: 20, // narrow, for the miniature look
      distance: 125, // at zoom 1
      yaw: 0.54, // radians east of south
      pitch: 0.86, // radians above the horizon
      minZoom: 0.14,
      maxZoom: 4,
      ease: 0.14, // seconds for pan and zoom to cover most of the distance
    },

    // Seconds.
    timing: {
      intro: 1.5, // the world settling into place on first load
      work: 0.55, // one hammer swing
      beaconPulse: 1.6,
      celebrate: 1.4,
      ambientFps: 30, // frame rate while only ambient animation plays
      idleFps: 2, // frame rate while nothing moves
    },

    // Tilt-shift: rows this far from the focus (as a fraction of the height) stay sharp.
    focus: { band: 0.18, blur: 2.6 },

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
