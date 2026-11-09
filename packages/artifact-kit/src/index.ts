import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { kitComponents, kitStyles } from "./styles.js";

export { artifactTemplate } from "./templates.js";
export function artifactKitAsset(root: string, name: string) {
  let bytes: Buffer, mime: string;
  if (name === "style.css") {
    bytes = Buffer.from(kitStyles);
    mime = "text/css";
  } else if (name === "components.js") {
    bytes = Buffer.from(kitComponents);
    mime = "text/javascript";
  } else if (name === "chart.js") {
    const local = path.join(root, "packages/artifact-kit/v1/chart-4.5.1.umd.js");
    bytes = readFileSync(
      existsSync(local) ? local : new URL("../v1/chart-4.5.1.umd.js", import.meta.url),
    );
    mime = "text/javascript";
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      "48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a"
    )
      throw Error("artifact_kit_corrupt");
  } else return undefined;
  return { bytes, mime };
}
