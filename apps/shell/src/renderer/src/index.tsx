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
import "./account.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element was not found.");
}

render(() => <App />, root);
