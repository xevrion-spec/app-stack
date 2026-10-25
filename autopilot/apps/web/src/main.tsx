import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { setLocale } from "./i18n";
import { applyTheme, getTheme } from "./theme";

setLocale(new URLSearchParams(location.search).get("lang") ?? localStorage.getItem("autopilot.locale") ?? "en-GB");
applyTheme(getTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
