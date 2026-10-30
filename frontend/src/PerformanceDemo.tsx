import { FlapRendererProvider, type FlapRenderer } from "./components/FlapRendererProvider";
import RotorDemo from "./RotorDemo";

export type DemoRenderer = FlapRenderer;

export default function PerformanceDemo({ renderer = "optimized" }: { renderer?: DemoRenderer }) {
  return (
    <FlapRendererProvider renderer={renderer}>
      <RotorDemo homeHref={`?demo=performance&renderer=${renderer}`} />
    </FlapRendererProvider>
  );
}
