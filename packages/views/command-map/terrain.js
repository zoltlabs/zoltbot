// The ground around the cities: coast, grassland, forests, hills and mountains. Generated from
// the seed in skin.js, so the same chats always get the same map. Pure data, no drawing.
(() => {
  const map = window.CommandMap,
    { key, dist } = window.CommandMapHex;
  const hash = (x, y, seed) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y, seed) => {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      xf = smooth(x - xi),
      yf = smooth(y - yi);
    const a = hash(xi, yi, seed),
      b = hash(xi + 1, yi, seed),
      c = hash(xi, yi + 1, seed),
      d = hash(xi + 1, yi + 1, seed);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  const layered = (x, y, seed) =>
    noise(x, y, seed) * 0.65 + noise(x * 2.1, y * 2.1, seed + 7) * 0.35;
  map.hash = hash;

  // Returns every hex to draw, each with its terrain type and owning city (or null).
  map.terrain = (layout, seed = map.skin.seed, margin = 5) => {
    const owned = new Map(layout.land.map((hex) => [key(hex.q, hex.r), hex.city]));
    const cities = layout.cities;
    if (!cities.length) return [];
    // Bounds in offset rows and columns, so the map is a rectangle on screen.
    const columnOf = (hex) => hex.q + Math.floor(hex.r / 2);
    const rows = layout.land.map((hex) => hex.r),
      columns = layout.land.map(columnOf);
    const top = Math.min(...rows) - margin,
      bottom = Math.max(...rows) + margin,
      left = Math.min(...columns) - margin,
      right = Math.max(...columns) + margin;
    const tiles = [];
    for (let r = top; r <= bottom; r++)
      for (let column = left; column <= right; column++) {
        const q = column - Math.floor(r / 2),
          hex = { q, r },
          city = owned.get(key(q, r)) ?? null;
        // Distance past the edge of the nearest territory: 0 inside, 1 just outside.
        let near = Infinity;
        for (const c of cities) near = Math.min(near, dist(hex, c) - c.radius);
        const edge = Math.min(column - left, right - column, (r - top) * 1.4, (bottom - r) * 1.4);
        const height =
          layered(column * 0.22, r * 0.26, seed) +
          (near <= 1 ? 0.4 : near <= 3 ? 0.15 : 0) -
          (edge < 2 ? 0.35 : edge < 4 ? 0.12 : 0);
        const rough = layered(column * 0.31, r * 0.31, seed + 11),
          wet = layered(column * 0.27, r * 0.27, seed + 23);
        let type;
        if (city) type = wet > 0.5 ? "grass" : "plains";
        else if (height < 0.5) type = height < 0.4 ? "ocean" : "coast";
        else if (rough > 0.7 && near > 1) type = "mountain";
        else if (rough > 0.58) type = "hills";
        else if (wet > 0.56) type = "forest";
        else type = wet > 0.42 ? "grass" : "plains";
        tiles.push({ q, r, type, city, tone: hash(q, r, seed + 5) });
      }
    return tiles;
  };
})();
