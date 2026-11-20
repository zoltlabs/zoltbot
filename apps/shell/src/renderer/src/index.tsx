import { render } from "solid-js/web";
import { App } from "./App";
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

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element was not found.");
}

// The kit gallery is a test page for the headless design checks; it loads only on request.
if (new URLSearchParams(window.location.search).has("kit-gallery")) {
  void import("./kit/KitGallery").then(({ KitGallery }) => render(() => <KitGallery />, root));
} else {
  render(() => <App />, root);
}
