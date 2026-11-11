(() => {
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
      bases = [];
    let x = 0,
      z = 0,
      rowDepth = 0,
      column = 0;
    for (const [id, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const baseGroups = new Map();
      for (const chat of list.toSorted((a, b) => a.id.localeCompare(b.id))) {
        const key = chat.worktree?.id ?? chat.id;
        const group = baseGroups.get(key) ?? [];
        group.push(chat);
        baseGroups.set(key, group);
      }
      const cell = Math.max(
        12,
        Math.ceil(Math.sqrt(Math.max(...[...baseGroups.values()].map((group) => group.length)))) *
          4 +
          8,
      );
      const columns = Math.ceil(Math.sqrt(baseGroups.size)),
        w = Math.max(20, columns * cell + 12),
        d = Math.max(18, Math.ceil(baseGroups.size / columns) * cell + 12);
      const position = saved[id],
        rx = Number.isFinite(position?.x) ? position.x : x,
        rz = Number.isFinite(position?.z) ? position.z : z;
      regions.push({
        id,
        name: workspaces.find((workspace) => workspace.id === id)?.name ?? "Other",
        x: rx,
        z: rz,
        w,
        d,
      });
      let index = 0;
      for (const [key, group] of baseGroups) {
        const bx = rx + 6 + (index % columns) * cell,
          bz = rz + 7 + Math.floor(index / columns) * cell;
        if (group[0].worktree) bases.push({ id: key, x: bx, z: bz });
        group.forEach((chat, unit) => {
          units.push({
            chat,
            region: id,
            x: bx + 4 + (unit % Math.ceil(Math.sqrt(group.length))) * 4,
            z: bz + Math.floor(unit / Math.ceil(Math.sqrt(group.length))) * 4,
          });
        });
        index++;
      }
      x += w + 12;
      rowDepth = Math.max(rowDepth, d);
      column++;
      if (column >= 3) {
        column = 0;
        x = 0;
        z += rowDepth + 12;
        rowDepth = 0;
      }
    }
    return { regions, units, bases };
  };
})();
