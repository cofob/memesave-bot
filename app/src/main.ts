import "@cofob2/design-system-css/index.css";
import { mount } from "svelte";
import App from "./App.svelte";
import SharedAnalysis from "./SharedAnalysis.svelte";

// A public analysis link opens without login.
const Root = new URLSearchParams(location.search).has("analysis") ? SharedAnalysis : App;
mount(Root, { target: document.getElementById("app")! });
