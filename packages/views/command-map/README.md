# Command map

Your chats as a miniature settlement seen from above. Each workspace is an island, each
worktree a workshop with its branch name on a sign, and each chat a small robot. A chat that
needs you raises a beacon you can see across the map.

Press **Customize** in Settings → Views to get your own copy of this folder. Everything the map
loads is in the folder; it never uses the network. Preview changes without the app:

```sh
pnpm view:dev packages/views/command-map
```

Add `#chats=200` to the preview URL to see a large map.

## What each state looks like

| State | On the map | In the list and on labels |
| --- | --- | --- |
| Working | The robot hammers at its workshop. Sparks fly, the windows are lit and the chimney steams. | Hexagon icon, "Working" |
| Needs you | A tall beam with a diamond on top, rings on the ground, arms raised. An alert at the screen edge points to it when it is off screen and shows how long it has waited. | Diamond icon, "Needs you" |
| Done (finished, unread) | A flag beside the robot. It hops once with confetti when it finishes. | Flag icon, "Done" |
| Idle or later | Sitting, lights off. | Bar icon, "Idle" or "Later" |
| Failed turn or session problem | Leaning over, with a warning triangle above. | Triangle icon, "Warning" |
| Selected | A white ring on the ground. Hover shows a thinner ring. | Checked in the list |

With reduced motion turned on, the camera jumps instead of gliding, nothing animates, and
there are no particles. Every mark stays, standing still.

## Files

Change how it looks:

| File | Holds |
| --- | --- |
| `skin.js` | Palettes for day and night, sizes, timing, camera, graphics levels, sounds, and which builder draws each part |
| `world/terrain.js` | Water, islands, paths, trees, stones, lamps |
| `world/buildings.js` | Workshops and their signs |
| `world/units.js` | The robot model and its poses |
| `world/marks.js` | Beacons, flags, warning triangles, selection rings |
| `world/effects.js` | Contact shadows, light pools, sparks, steam, confetti |
| `world/lighting.js` | Sun or moon, sky light, fog |
| `world/post.js` | Ambient occlusion, bloom, tilt-shift blur |
| `world/kit.js` | Helpers the builders share |
| `map.css`, `hud.css` | The side panel and the controls over the map. They use the app's theme tokens. |

Change how it behaves:

| File | Holds |
| --- | --- |
| `map.js` | Connects Zoltbot's data to everything else |
| `layout.js` | Where islands, workshops and units go |
| `states.js` | What each chat status means, waiting times, icons |
| `world/scene.js` | The renderer and the frame loop |
| `camera.js`, `input.js` | Camera movement; mouse, touch and keys |
| `overlay.js`, `minimap.js`, `hud.js`, `list.js`, `panels.js` | Name tags and edge alerts, minimap, top bar and group chips, chat list, requests and orders |
| `quality.js`, `sound.js` | Graphics level; the three sounds |
| `vendor/` | three.js, bundled. See `vendor/README.md`. |

## Change a palette

Open `skin.js` and edit `palettes.day` (light theme) or `palettes.night` (dark theme). For a
desert by day:

```js
day: {
  mist: "#f3e6d2",
  water: "#d9b98a",       // sand instead of sea
  shallows: "#e2c79c",
  foam: "#ecd9b6",
  grass: ["#d8b56f", "#cfa962", "#e0c080"],
  soil: "#a8743f",
  rock: "#7d5a3a",
  // …leave the rest as it is
}
```

Lists such as `grass`, `walls` and `roofs` hold several colors; each island or building picks
one. `states` colors the marks and robot visors. `emit` and `bloom` set how strongly lights
glow. Reload the preview to see the change.

## Replace the unit model

A builder is a function that draws one part of the world. `world/units.js` registers the robot
builder as `CommandMap.builders.units.robots`, and `skin.js` chooses it with
`builders.units: "robots"`. To use your own model:

1. Copy `world/units.js` to `world/crates.js` and add it to `index.html` after `world/units.js`.
2. Register it under a new name and draw what you like. This one draws each chat as a crate:

   ```js
   (() => {
     const map = window.CommandMap, T = window.THREE, kit = map.kit;
     map.builders.units.crates = (world) => {
       const crates = new kit.Pool(
         world.root,
         new T.BoxGeometry(1.6, 1.6, 1.6),
         new T.MeshStandardMaterial(),
         { cast: true },
       );
       let units = [];
       return {
         setData(layout) {
           units = layout.units;
           crates.begin(units.length);
         },
         update() {
           units.forEach((unit, index) => {
             const { state } = map.unitState(unit.chat);
             crates.put(index, kit.place(unit.x, 0.8, unit.z), world.stateColor(state));
           });
           crates.end();
         },
         setFar() {},            // called when the camera zooms far out or back in
         animated: () => false,  // return true while your model is moving
         theme() {},
         dispose: () => crates.dispose(),
       };
     };
   })();
   ```

3. In `skin.js`, set `builders.units` to `"crates"`.

The marks (beacon, flag, warning) and the selection rings are drawn by `world/marks.js`, so
they keep working with any unit model. Build shapes in code, or ship PNG, WebP or SVG files in
this folder. Model files, audio files and WebAssembly are not allowed in a view.

`update(frame)` runs before each drawn frame. `frame.time` is seconds since the map opened,
`frame.delta` seconds since the last frame, and `frame.markScale` grows as the camera pulls
back. `world.reducedMotion` is true when the owner asked for less motion: draw a still pose.
`world.fire("spark", { x, y, z })` and `world.fire("celebrate", { x, z })` ask the effects
builder for particles.

## Keys

| Key | Does |
| --- | --- |
| Space | Go to the next chat that needs you |
| 1, 2, 3 | Select a control group. With Shift, save the selection as that group. |
| Escape | Clear the selection. Twice: leave the view. |
| Arrow keys, + and −, 0 | Pan, zoom, show the whole map |

Drag on the map to box-select, Shift+click a unit to add or remove it, and click a unit to
open its chat. Drag with the right button, or scroll, to pan. Ctrl or Cmd with scroll zooms.
