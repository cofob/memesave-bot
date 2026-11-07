// TEMP visual check (deleted after use).
import "@cofob2/design-system-css/index.css";
import { mount } from "svelte";
import MemeDetail from "./src/MemeDetail.svelte";
const detail = { id: "v1", kind: "video", title: "Hospitality in Half Term Skit", status: "ready", tags: ["relatable", "hospitality", "skit"], thumb: "/zz-poster.png", file: "/zz-missing.mp4", width: 360, height: 640, duration: 30, language: "en", has_text: true, created_at: 1, caption: null, source: null, saved_at: null, description: "A skit.", ocr_text: "HOSPITALITY IN HALF TERM\n" + "hi guys you alright\n".repeat(30), speech_text: null, meme_context: null, cultural_meaning: null, album: [] };
window.fetch = async () => Response.json(detail);
mount(MemeDetail, { target: document.getElementById("app")!, props: { id: "v1", onClose() {}, onTag() {}, onDeleted() {}, onRetried() {} } });
