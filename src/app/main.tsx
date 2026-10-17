import { render } from "preact";
import { App } from "./App";
import "./styles.css";

render(<App />, document.getElementById("app")!);

// autoShow off: the prompt is shown by App once the user is signed in.
if (typeof PWAInstall !== "undefined") PWAInstall.init({ appName: "Bitebook", autoShow: false, remember: 7 });

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js");
}
