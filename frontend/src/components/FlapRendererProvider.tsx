import type { ReactNode } from "react";
import { FlapRendererContext } from "./FlapRendererContext";
import { OptimizedFlapCharacter } from "./OptimizedFlapCharacter";

export type FlapRenderer = "optimized" | "legacy";

export function FlapRendererProvider({ renderer = "optimized", children }: {
  renderer?: FlapRenderer;
  children: ReactNode;
}) {
  const Character = renderer === "optimized" && typeof Element !== "undefined"
    && typeof Element.prototype.animate === "function" ? OptimizedFlapCharacter : null;
  return <FlapRendererContext.Provider value={Character}>{children}</FlapRendererContext.Provider>;
}
