// Turns chats and workspaces into positions: one region (island) per workspace, one base
// (workshop) per worktree, and one slot per chat in front of its base. Pure data, no drawing.
(() => {
  const SLOT = 3.5, // spacing between units
    BUILDING = { w: 5, d: 4 }, // workshop footprint
    SIGN = 2.5, // room beside the workshop for its sign
    MARGIN = 3.5, // grass around the cells of a region
    GAP = 3, // between cells
    REGION_GAP = 12; // water between regions
  // Places boxes left to right in rows no wider than `width`. Returns the size used.
  function shelves(boxes, width, gap) {
    let x = 0,
      z = 0,
      depth = 0,
      used = 0;
    for (const box of boxes) {
      if (x > 0 && x + box.w > width) {
        x = 0;
        z += depth + gap;
        depth = 0;
      }
      box.x = x;
      box.z = z;
      x += box.w + gap;
      depth = Math.max(depth, box.d);
      used = Math.max(used, x - gap);
    }
    return { w: used, d: z + depth };
  }
  window.commandMapLayout = (chats, workspaces, saved = {}, now = Date.now()) => {
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
    const regions = [],
      units = [],
      bases = [],
      cells = [];
    for (const [id, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      // One cell per worktree. A chat with no worktree stands alone, without a workshop.
      const byBase = new Map();
      for (const chat of list.toSorted((a, b) => a.id.localeCompare(b.id))) {
        const key = chat.worktree?.id ?? chat.id;
        const group = byBase.get(key) ?? [];
        group.push(chat);
        byBase.set(key, group);
      }
      const regionCells = [...byBase].map(([key, group]) => {
        const built = !!group[0].worktree,
          columns = Math.min(8, Math.max(built ? 2 : 1, Math.ceil(Math.sqrt(group.length * 1.6)))),
          rows = Math.ceil(group.length / columns);
        return {
          key,
          group,
          built,
          columns,
          w: Math.max(built ? BUILDING.w + SIGN : 0, columns * SLOT) + 1,
          d: (built ? BUILDING.d + 1 : 0) + rows * SLOT + 0.5,
        };
      });
      const area = regionCells.reduce((sum, cell) => sum + (cell.w + GAP) * (cell.d + GAP), 0);
      const size = shelves(
        regionCells,
        Math.max(...regionCells.map((cell) => cell.w), Math.sqrt(area) * 1.3),
        GAP,
      );
      regions.push({
        id,
        name: workspaces.find((workspace) => workspace.id === id)?.name ?? "Other",
        w: Math.max(16, size.w + MARGIN * 2),
        d: Math.max(14, size.d + MARGIN * 2 + 1),
        cells: regionCells,
      });
    }
    // Pack regions into rows, then let saved positions override.
    const total = regions.reduce(
      (sum, region) => sum + (region.w + REGION_GAP) * (region.d + REGION_GAP),
      0,
    );
    shelves(
      regions,
      Math.max(...regions.map((region) => region.w), Math.sqrt(total) * 1.45),
      REGION_GAP,
    );
    for (const region of regions) {
      const position = saved[region.id];
      if (Number.isFinite(position?.x)) region.x = position.x;
      if (Number.isFinite(position?.z)) region.z = position.z;
      for (const cell of region.cells) {
        const x = region.x + MARGIN + cell.x,
          z = region.z + MARGIN + cell.z;
        cells.push({ x, z, w: cell.w, d: cell.d, region: region.id });
        const worktree = cell.group[0].worktree;
        if (cell.built)
          bases.push({
            id: cell.key,
            region: region.id,
            x: x + 0.5 + BUILDING.w / 2,
            z: z + BUILDING.d / 2,
            name: worktree.branch ?? (worktree.kind === "folder" ? "Main folder" : "Worktree"),
            active: cell.group.some((chat) => chat.status === "working"),
          });
        const front = z + (cell.built ? BUILDING.d + 1 : 0),
          inset = (cell.w - cell.columns * SLOT) / 2;
        cell.group.forEach((chat, index) => {
          units.push({
            chat,
            region: region.id,
            base: cell.built ? cell.key : undefined,
            x: x + inset + SLOT / 2 + (index % cell.columns) * SLOT,
            z: front + SLOT / 2 + Math.floor(index / cell.columns) * SLOT,
          });
        });
      }
      delete region.cells;
    }
    return { regions, units, bases, cells };
  };
})();
