import { FlapRendererContext } from "./components/FlapRendererContext";
import { OptimizedFlapCharacter } from "./components/OptimizedFlapCharacter";
import RotorDemo from "./RotorDemo";

export type DemoRenderer = "optimized" | "legacy";

export default function PerformanceDemo({ renderer = "optimized" }: { renderer?: DemoRenderer }) {
  const Character = renderer === "optimized" && typeof Element.prototype.animate === "function"
    ? OptimizedFlapCharacter : null;
  return (
    <FlapRendererContext.Provider value={Character}>
      <RotorDemo homeHref={`?demo=performance&renderer=${renderer}`} />
    </FlapRendererContext.Provider>
  );
}
