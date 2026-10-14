import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled so the site makes no requests to font services (SPEC.md section 11).
import "@fontsource/raleway/latin-600.css";
import "@fontsource/raleway/latin-700.css";
import "@fontsource/raleway/latin-800.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
