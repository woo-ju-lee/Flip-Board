import { createContext, type ComponentType } from "react";

export type FlapCharacterProps = {
  value: string;
  index: number;
  reduced: boolean;
  rotor?: readonly string[];
};

// Only the performance demo supplies an alternative. The regular app retains
// its existing renderer and does not load the experimental animation engine.
export const FlapRendererContext = createContext<ComponentType<FlapCharacterProps> | null>(null);
