import { ActivityDetails } from "./ActivityDetails.js";
import { activityLabel } from "./activity-data.js";
import { MessageRow } from "./MessageRow.js";
import { body, type Row, text } from "./types.js";

export function ActivityGroup({ items, name }: { items: Row[]; name: string }) {
  const running = items.some(
    (item) => body(item).streaming === true || body(item).status === "running",
  );
  return (
    <ActivityDetails label={activityLabel(items)} running={running}>
      <ol aria-label="Activity steps">
        {items.map((item) => (
          <li key={text(item.id)}>
            <MessageRow item={item} name={name} />
          </li>
        ))}
      </ol>
    </ActivityDetails>
  );
}
