import { render } from "solid-js/web";
import { App } from "./App";
import "./styles.css";
import "./company.css";
import "./dictation.css";
import "./organization.css";
import "./artifacts.css";
import "./views.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element was not found.");
}

render(() => <App />, root);
