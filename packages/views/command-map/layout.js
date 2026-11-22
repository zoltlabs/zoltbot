// Turns chats and workspaces into hex positions: one city per workspace, one district per
// worktree next to it, and one hex per chat near its district. Pure data, no drawing.
//
// Hexes use axial coordinates (q, r) with pointy tops; r grows downward on screen.
(() => {
  const DIRS = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  const key = (q, r) => `${q},${r}`;
  const dist = (a, b) =>
    (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
  // Screen position of a hex center in hex-size units, before tilt.
  const spot = (q, r) => ({ x: Math.sqrt(3) * (q + r / 2), y: 1.5 * r });
  // Every hex within `radius` of the center, nearest first.
  function area(center, radius) {
    const list = [];
    for (let dq = -radius; dq <= radius; dq++)
      for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++)
        list.push({ q: center.q + dq, r: center.r + dr });
    return list.sort((a, b) => dist(a, center) - dist(b, center));
  }
  // The two rows above a city stay empty so its banner never covers a unit.
  const reserved = (center, hex) =>
    (hex.r === center.r - 1 || hex.r === center.r - 2) &&
    hex.q - center.q >= -2 &&
    hex.q - center.q <= 3;
  // Nearest first; ties go to the same row, then lower rows, then right before left.
  const order = (anchor) => (a, b) => {
    const pa = spot(a.q - anchor.q, a.r - anchor.r),
      pb = spot(b.q - anchor.q, b.r - anchor.r);
    return (
      dist(a, anchor) - dist(b, anchor) ||
      Math.abs(pa.y) - Math.abs(pb.y) ||
      pb.y - pa.y ||
      pb.x - pa.x
    );
  };
  window.CommandMapHex = { DIRS, key, dist, spot, area };

  window.commandMapLayout = (chats, workspaces, now = Date.now()) => {
    const visible = chats.filter(
      (chat) =>
        chat.status !== "settled" &&
        (["needs_you", "working", "review"].includes(chat.status) ||
          Date.parse(chat.updatedAt) >= now - 86400000),
    );
    const known = new Set(workspaces.map((workspace) => workspace.id)),
      groups = new Map();
    for (const chat of visible) {
      const id = known.has(chat.workspaceId) ? chat.workspaceId : "other";
      const list = groups.get(id) ?? [];
      list.push(chat);
      groups.set(id, list);
    }
    // Size each city first: enough land for its districts and units, plus a little room.
    const plans = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, list], index) => {
        const bases = new Map(),
          loose = [];
        for (const chat of list.toSorted((a, b) => a.id.localeCompare(b.id))) {
          if (!chat.worktree) {
            loose.push(chat);
            continue;
          }
          const group = bases.get(chat.worktree.id) ?? [];
          group.push(chat);
          bases.set(chat.worktree.id, group);
        }
        const need = bases.size + list.length,
          origin = { q: 0, r: 0 };
        let radius = 2;
        while (
          area(origin, radius).filter((hex) => dist(hex, origin) > 0 && !reserved(origin, hex))
            .length <
          Math.ceil(need * 1.15) + 1
        )
          radius++;
        return {
          id,
          index,
          name: workspaces.find((workspace) => workspace.id === id)?.name ?? "Other",
          bases,
          loose,
          radius,
        };
      });
    // Place cities on a staggered grid wide enough that no two territories touch.
    const widest = Math.max(2, ...plans.map((plan) => plan.radius)),
      step = widest * 2 + 4,
      columns = Math.max(1, Math.ceil(Math.sqrt(plans.length * 1.5)));
    const cities = [],
      districts = [],
      units = [],
      land = [];
    for (const plan of plans) {
      const column = plan.index % columns,
        row = Math.floor(plan.index / columns) * step,
        offset = (column * step + (Math.floor(plan.index / columns) % 2 ? step / 2 : 0)) | 0;
      const center = { q: offset - Math.floor(row / 2), r: row };
      cities.push({ id: plan.id, name: plan.name, index: plan.index, radius: plan.radius, ...center });
      const tiles = area(center, plan.radius);
      for (const hex of tiles) land.push({ ...hex, city: plan.id });
      const taken = new Set([key(center.q, center.r)]);
      for (const hex of tiles) if (reserved(center, hex)) taken.add(key(hex.q, hex.r));
      const free = (anchor) =>
        tiles.filter((hex) => !taken.has(key(hex.q, hex.r))).sort(order(anchor))[0];
      const claim = (anchor) => {
        const hex = free(anchor) ?? center;
        taken.add(key(hex.q, hex.r));
        return hex;
      };
      // Districts take the nearest open hexes around the city, side by side first.
      const placed = [...plan.bases].map(([id, group]) => {
        const hex = claim(center),
          worktree = group[0].worktree;
        const district = {
          id,
          city: plan.id,
          ...hex,
          name: worktree.branch ?? (worktree.kind === "folder" ? "Main folder" : "Worktree"),
          active: group.some((chat) => chat.status === "working"),
        };
        districts.push(district);
        return { district, group };
      });
      for (const { district, group } of placed)
        for (const chat of group)
          units.push({ chat, city: plan.id, district: district.id, ...claim(district) });
      for (const chat of plan.loose) units.push({ chat, city: plan.id, ...claim(center) });
    }
    return { cities, districts, units, land };
  };
})();
