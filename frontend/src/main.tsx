import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource/noto-sans-kr/600.css";
import "./styles.css";

const RotorDemo = lazy(() => import("./RotorDemo"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      {new URLSearchParams(window.location.search).get("demo") === "rotors" ? <RotorDemo /> : <App />}
    </Suspense>
  </React.StrictMode>,
);
