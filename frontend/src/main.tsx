import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { FlapRendererProvider } from "./components/FlapRendererProvider";
import "@fontsource/noto-sans-kr/300.css";
import "@fontsource/noto-sans-kr/600.css";
import "./styles.css";
import "./board-surface.css";
import "./board-layout.css";

const RotorDemo = lazy(() => import("./RotorDemo"));
const PerformanceDemo = lazy(() => import("./PerformanceDemo"));
const params = new URLSearchParams(window.location.search);
const demo = params.get("demo");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="board-theme monochrome-board">
      <FlapRendererProvider>
        <Suspense fallback={null}>
          {demo === "performance"
            ? <PerformanceDemo renderer={params.get("renderer") === "legacy" ? "legacy" : "optimized"} />
            : demo === "rotors" ? <RotorDemo /> : <App />}
        </Suspense>
      </FlapRendererProvider>
    </div>
  </React.StrictMode>,
);
