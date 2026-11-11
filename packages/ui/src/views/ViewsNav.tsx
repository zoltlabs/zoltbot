import type { Row } from "../chat/types.js";
import { ListRow } from "../components/primitives.js";
import { useShell } from "../state.js";
import { ViewIcon } from "./ViewIcon.js";
export function ViewsNav({ views }: { views: Row[] }) {
  const id = useShell((state) => state.viewId),
    route = useShell((state) => state.route),
    open = useShell((state) => state.openView);
  const enabled = views.filter(
    (row) => row.enabled && Array.isArray(row.slots) && row.slots.includes("page"),
  );
  if (!enabled.length) return null;
  return (
    <nav aria-label="Views" className="sidebar-section view-nav">
      <h2 className="sidebar-label">Views</h2>
      {enabled.map((view) => (
        <ListRow
          key={String(view.id)}
          icon="Projects"
          label={
            <>
              <ViewIcon
                hash={String(view.bundleHash)}
                path={typeof view.icon === "string" ? view.icon : undefined}
              />{" "}
              {String(view.name)}
            </>
          }
          current={route === "View" && id === view.id}
          onClick={() => open(String(view.id))}
        />
      ))}
    </nav>
  );
}
