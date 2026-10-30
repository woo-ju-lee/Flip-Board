import { createContext, type ComponentType } from "react";

export type FlapCharacterProps = {
  value: string;
  index: number;
  reduced: boolean;
  rotor?: readonly string[];
};

// The app and offline entrypoints supply the shared renderer provider.
// Null explicitly selects the legacy renderer, including unsupported browsers.
export const FlapRendererContext = createContext<ComponentType<FlapCharacterProps> | null>(null);
