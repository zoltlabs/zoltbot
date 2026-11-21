// D4: the agent dock's own page, loaded into its always-on-top window.
import { render } from "solid-js/web";
import { followAppearance } from "../appearance/appearance";
import { followLanguage } from "../i18n/language";
import { Dock } from "./Dock";
import "../theme.css";
import "../styles.css";
import "../appearance/appearance.css";
import "./dock.css";

const root = document.getElementById("root");
if (!root) throw new Error("Dock root element was not found.");
followAppearance();
followLanguage();
render(() => <Dock />, root);
