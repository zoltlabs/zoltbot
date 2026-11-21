import { render } from "solid-js/web";
import { App } from "./App";
import { followAppearance } from "./appearance/appearance";
import { ToastRegion } from "./kit";
import "./theme.css";
import "./styles.css";
import "./company.css";
import "./dictation.css";
import "./organization.css";
import "./artifacts.css";
import "./views.css";
import "./tasks.css";
import "./models.css";
import "./channels.css";
import "./account.css";
import "./appearance/appearance.css";

const root = document.getElementById("root");
followAppearance();

if (!root) {
  throw new Error("Renderer root element was not found.");
}

// The kit gallery and the design fixtures are test pages for the headless design checks; they
// load only on request.
const search = new URLSearchParams(window.location.search);
const fixture = search.get("design-fixture");
if (fixture !== null) {
  void import("./kit/DesignFixtures").then(({ DesignFixture }) =>
    render(() => <DesignFixture name={fixture} />, root),
  );
} else if (search.has("kit-gallery")) {
  void import("./kit/KitGallery").then(({ KitGallery }) => render(() => <KitGallery />, root));
} else {
  render(
    () => (
      <>
        <App />
        <ToastRegion />
      </>
    ),
    root,
  );
}
