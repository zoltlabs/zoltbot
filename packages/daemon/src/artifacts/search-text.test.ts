import { expect, it } from "vitest";
import { artifactSearchText } from "./search-text.js";

it("indexes bounded visible prose without JavaScript, CSS or hidden template text", () => {
  expect(
    artifactSearchText(
      "text/html",
      "<style>secretStyle</style><h1>Visible &amp; clear</h1><script>hiddenCode</script><template>hiddenTemplate</template>",
    ),
  ).toBe(" Visible & clear ");
  expect(artifactSearchText("text/html", "<h1>Visible</h1><script>unclosed")).toBe(" Visible ");
  expect(artifactSearchText("text/javascript", "privateImplementation")).toBe("");
  expect(artifactSearchText("text/plain", "x".repeat(20000))).toHaveLength(16000);
});
