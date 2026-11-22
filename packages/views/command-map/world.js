// Draws the map as SVG: terrain, territory borders, cities, districts, walkers and the marks
// under them. Everything is built from shapes in code; there are no image files.
(() => {
  const map = window.CommandMap,
    skin = map.skin,
    { key } = window.CommandMapHex;
  const R = skin.hex.radius,
    TILT = skin.hex.tilt,
    SQRT3 = Math.sqrt(3);
  const f = (value) => Math.round(value * 10) / 10;
  const corner = (x, y, i, scale = 1) => {
    const angle = (Math.PI / 180) * (60 * i - 30);
    return [f(x + R * scale * Math.cos(angle)), f(y + R * scale * Math.sin(angle) * TILT)];
  };
  const hexPoints = (x, y, scale = 1) =>
    [0, 1, 2, 3, 4, 5].map((i) => corner(x, y, i, scale).join(",")).join(" ");
  // Edge i runs from corner i to corner i + 1 and faces this neighbor.
  const FACING = [
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
    [1, -1],
  ];
  const shade = (hex, factor) => {
    const n = Number.parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) =>
      Math.max(0, Math.min(255, Math.round(v * factor))),
    );
    return `rgb(${c.join(",")})`;
  };
  map.cityColor = (city) => skin.workspaces[city.index % skin.workspaces.length];
  map.providerColor = (chat) => skin.providers[chat.provider?.id] ?? skin.providers.other;
  map.markColor = (chat) => {
    const { state, problem } = map.unitState(chat);
    return problem && state !== "needs_you" ? skin.states.problem : skin.states[state];
  };

  function decor(tile, x, y) {
    const j = (salt) => map.hash(tile.q, tile.r, salt);
    let s = "";
    if (tile.type === "forest") {
      for (let i = 0; i < 5; i++) {
        const tx = f(x + (j(i) - 0.5) * R * 1.1),
          ty = f(y + (j(i + 9) - 0.5) * R * 0.7);
        s += `<rect x="${tx - 1}" y="${ty}" width="2" height="5" fill="#4a3520"/>`;
        s += `<path d="M${tx} ${ty - 13}L${tx + 7} ${ty + 1}H${tx - 7}Z" fill="${i % 2 ? "#2f5a25" : "#3a6a2b"}"/>`;
        s += `<path d="M${tx} ${ty - 13}L${tx + 7} ${ty + 1}H${tx}Z" fill="rgba(0,0,0,0.18)"/>`;
      }
    } else if (tile.type === "hills") {
      s += `<path d="M${f(x - 18)} ${f(y + 6)}q9 -16 18 0M${f(x - 2)} ${f(y - 2)}q10 -15 20 0" fill="none" stroke="#6e6537" stroke-width="3" stroke-linecap="round"/>`;
    } else if (tile.type === "mountain") {
      const peak = (px, w, h, light, dark) =>
        `<path d="M${f(px - w)} ${f(y + 8)}L${f(px)} ${f(y + 8 - h)}L${f(px + w)} ${f(y + 8)}Z" fill="${light}"/>` +
        `<path d="M${f(px)} ${f(y + 8 - h)}L${f(px + w)} ${f(y + 8)}H${f(px + w * 0.4)}Z" fill="${dark}"/>` +
        `<path d="M${f(px - w * 0.3)} ${f(y + 8 - h * 0.7)}L${f(px)} ${f(y + 8 - h)}L${f(px + w * 0.35)} ${f(y + 8 - h * 0.68)}Z" fill="#f2f0ea"/>`;
      s += peak(x - 6, 15, 30, "#6a6862", "#55534e") + peak(x + 12, 12, 22, "#76746d", "#5d5b55");
    } else if (tile.type === "ocean" && j(3) > 0.55) {
      s += `<path class="wave" d="M${f(x - 10)} ${f(y)}q5 -4 10 0t10 0" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>`;
    } else if ((tile.type === "grass" || tile.type === "plains") && !tile.city && j(4) > 0.6) {
      s += `<circle cx="${f(x - 8)}" cy="${f(y + 4)}" r="2" fill="rgba(40,70,20,0.35)"/>`;
      s += `<circle cx="${f(x + 6)}" cy="${f(y - 3)}" r="1.6" fill="rgba(40,70,20,0.35)"/>`;
    }
    return s;
  }

  function city(color, x, y) {
    const house = (hx, hy, w, roof) =>
      `<rect x="${hx - w / 2}" y="${hy - 8}" width="${w}" height="8" fill="#e6dcc4"/>` +
      `<rect x="${hx}" y="${hy - 8}" width="${w / 2}" height="8" fill="#c9bea4"/>` +
      `<path d="M${hx - w / 2 - 2} ${hy - 8}L${hx} ${hy - 15}L${hx + w / 2 + 2} ${hy - 8}Z" fill="${roof}"/>`;
    return (
      `<ellipse cx="${x}" cy="${y + 2}" rx="${f(R * 0.8)}" ry="${f(R * 0.45)}" fill="#b9ab88"/>` +
      house(x - 16, y + 2, 10, "#a34a2f") +
      house(x + 15, y + 4, 11, "#a34a2f") +
      house(x - 8, y + 12, 9, "#8f3f28") +
      house(x + 7, y + 13, 10, "#a34a2f") +
      `<rect x="${x - 6}" y="${y - 20}" width="12" height="20" fill="#efe6d0"/>` +
      `<rect x="${x}" y="${y - 20}" width="6" height="20" fill="#cfc4aa"/>` +
      `<path d="M${x - 8} ${y - 20}L${x} ${y - 30}L${x + 8} ${y - 20}Z" fill="${color}"/>` +
      `<line x1="${x}" y1="${y - 30}" x2="${x}" y2="${y - 42}" stroke="#3a2a18" stroke-width="1.5"/>` +
      `<path d="M${x} ${y - 42}h11l-3 3 3 3h-11Z" fill="${color}"/>`
    );
  }

  function district(color, active, x, y) {
    const lamp = active ? "#ffd27a" : "#2a3038";
    return (
      `<polygon points="${hexPoints(x, y, 0.78)}" fill="#cdbf98" opacity="0.9"/>` +
      `<polygon points="${hexPoints(x, y, 0.78)}" fill="none" stroke="${color}" stroke-width="2" opacity="0.8"/>` +
      `<rect x="${x - 13}" y="${y - 14}" width="26" height="14" fill="#5f6b78"/>` +
      `<rect x="${x}" y="${y - 14}" width="13" height="14" fill="#4b5560"/>` +
      `<path d="M${x - 15} ${y - 14}h30l-4 -6h-22Z" fill="#3e4851"/>` +
      `<rect x="${x + 6}" y="${y - 28}" width="5" height="10" fill="#3e4851"/>` +
      (active ? `<circle class="smoke" cx="${x + 8}" cy="${y - 31}" r="3" fill="rgba(230,230,230,0.6)"/>` : "") +
      `<rect x="${x - 9}" y="${y - 10}" width="6" height="5" fill="${lamp}"/>` +
      `<rect x="${x + 2}" y="${y - 10}" width="6" height="5" fill="${lamp}"/>`
    );
  }

  // A small walker robot. Its shoulders wear the agent's color and its visor shows the state.
  function walker(chat, x, y) {
    const [legs, body, side, arm, head] = skin.walker,
      { state, problem } = map.unitState(chat);
    const low = state === "idle" && !problem ? 3 : 0,
      tilt = problem ? ` transform="rotate(14 ${x} ${y})"` : "",
      pc = map.providerColor(chat);
    return (
      `<g class="walker ${state}" data-chat="${chat.id}"${tilt}>` +
      `<ellipse cx="${x}" cy="${y}" rx="11" ry="4.5" fill="rgba(0,0,0,0.35)"/>` +
      `<rect x="${x - 6}" y="${y - 9 + low}" width="4" height="${9 - low}" fill="${legs}"/>` +
      `<rect x="${x + 2}" y="${y - 9 + low}" width="4" height="${9 - low}" fill="${legs}"/>` +
      `<rect x="${x - 9}" y="${y - 24 + low}" width="18" height="15" rx="3" fill="${body}"/>` +
      `<rect x="${x}" y="${y - 24 + low}" width="9" height="15" rx="3" fill="${side}"/>` +
      `<rect x="${x - 11}" y="${y - 24 + low}" width="5" height="6" fill="${pc}"/>` +
      `<rect x="${x + 6}" y="${y - 24 + low}" width="5" height="6" fill="${pc}"/>` +
      `<rect class="arm" x="${x + 9}" y="${y - 20 + low}" width="3" height="10" fill="${arm}"/>` +
      `<rect x="${x - 6}" y="${y - 33 + low}" width="12" height="9" rx="2" fill="${head}"/>` +
      `<rect x="${x - 4}" y="${y - 30 + low}" width="8" height="3" fill="${map.markColor(chat)}"/>` +
      "</g>"
    );
  }

  map.World = class {
    constructor(svg) {
      this.svg = svg;
      this.camera = svg.querySelector("#camera");
      this.ground = svg.querySelector("#ground");
      this.marks = svg.querySelector("#marks");
      this.things = svg.querySelector("#things");
      this.tiles = new Map();
      this.layout = { cities: [], districts: [], units: [], land: [] };
      this.bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    }
    // World position of a hex center, raised to the top of its tile.
    at(q, r) {
      const tile = this.tiles.get(key(q, r)),
        lift = tile ? skin.terrain[tile.type].lift : 0;
      return { x: f(R * SQRT3 * (q + r / 2)), y: f(R * 1.5 * r * TILT - lift) };
    }
    setData(layout) {
      this.layout = layout;
      const tiles = map.terrain(layout);
      this.tiles = new Map(tiles.map((tile) => [key(tile.q, tile.r), tile]));
      const colors = new Map(layout.cities.map((c) => [c.id, map.cityColor(c)]));
      let ground = "",
        borders = "";
      const xs = [],
        ys = [];
      for (const tile of tiles) {
        const base = { x: R * SQRT3 * (tile.q + tile.r / 2), y: R * 1.5 * tile.r * TILT },
          look = skin.terrain[tile.type],
          top = this.at(tile.q, tile.r);
        xs.push(base.x);
        ys.push(base.y);
        if (look.lift) ground += `<polygon points="${hexPoints(base.x, base.y)}" fill="${shade(look.tops[0], 0.55)}"/>`;
        ground += `<polygon points="${hexPoints(top.x, top.y)}" fill="${look.tops[tile.tone > 0.5 ? 0 : 1]}" stroke="rgba(0,0,0,0.14)"/>`;
        ground += decor(tile, top.x, top.y);
        if (!tile.city) continue;
        const color = colors.get(tile.city);
        borders += `<polygon points="${hexPoints(top.x, top.y)}" fill="${color}" opacity="0.14"/>`;
        FACING.forEach(([dq, dr], i) => {
          if (this.tiles.get(key(tile.q + dq, tile.r + dr))?.city === tile.city) return;
          const [ax, ay] = corner(top.x, top.y, i, 0.94),
            [bx, by] = corner(top.x, top.y, (i + 1) % 6, 0.94);
          const line = `x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke-linecap="round"`;
          borders += `<line ${line} stroke="${color}" stroke-width="7" opacity="0.4"/>`;
          borders += `<line ${line} stroke="${shade(color, 1.45)}" stroke-width="2.5"/>`;
        });
      }
      this.ground.innerHTML = ground + borders;
      this.bounds = xs.length
        ? { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
        : { left: 0, right: 0, top: 0, bottom: 0 };
      // Cities, districts and walkers, drawn back to front.
      const items = [
        ...layout.cities.map((c) => ({ ...c, draw: (x, y) => city(colors.get(c.id), x, y) })),
        ...layout.districts.map((d) => ({
          ...d,
          draw: (x, y) => district(colors.get(d.city), d.active, x, y),
        })),
        ...layout.units.map((u) => ({ ...u, draw: (x, y) => walker(u.chat, x, y + 8) })),
      ].sort((a, b) => a.r - b.r || a.q - b.q);
      this.things.innerHTML = items
        .map((item) => {
          const { x, y } = this.at(item.q, item.r);
          return item.draw(x, y);
        })
        .join("");
    }
    // Hexes under units: orange for a chat that needs you, gold for the selection.
    setMarks(selected) {
      let s = "";
      for (const unit of this.layout.units) {
        const { x, y } = this.at(unit.q, unit.r);
        if (unit.chat.status === "needs_you")
          s += `<polygon class="asking" points="${hexPoints(x, y, 0.9)}" fill="rgba(255,154,92,0.25)" stroke="${skin.states.needs_you}" stroke-width="3"/>`;
        if (selected.has(unit.chat.id)) {
          s += `<polygon points="${hexPoints(x, y)}" fill="rgba(255,226,160,0.28)" stroke="${skin.states.selected}" stroke-width="5" opacity="0.9"/>`;
          s += `<polygon class="chosen" points="${hexPoints(x, y)}" fill="none" stroke="#d2ae6d" stroke-width="3" stroke-dasharray="10 6"/>`;
        }
      }
      this.marks.innerHTML = s;
    }
  };
})();
