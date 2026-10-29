import { FLAP_MS, hashText, type FlapPlan } from "./flapMotion";

/** Full-width printed leaves share the character rotor's timing and sound clock. */
export function makePanelPlan(from: string, to: string, labels: readonly string[], identity: string, now: number, index: number): FlapPlan {
  const seed = hashText(`${identity}:${from}:${to}`);
  if (from === to) return { steps: [], endAt: now, seed };
  const rotor = ["", ...labels.filter(Boolean)];
  const target = rotor.indexOf(to);
  const count = to && target >= 0 ? 3 + seed % 3 : 1;
  const start = now + seed % 71 + (index % 7) * 16 + Math.floor(index / 7) * 20;
  let previous = from;
  const steps = Array.from({ length: count }, (_, i) => {
    const next = i === count - 1 ? to : rotor[(target - count + i + 1 + rotor.length * 2) % rotor.length];
    const step = { from: previous, to: next, at: start + i * FLAP_MS, landAt: start + (i + 1) * FLAP_MS };
    previous = next;
    return step;
  });
  return { steps, endAt: steps.at(-1)!.landAt, seed };
}
