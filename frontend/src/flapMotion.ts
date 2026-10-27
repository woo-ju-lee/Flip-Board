/** One clock/sequence drives both the falling leaves and their landing sounds. */
export const FLAP_MS = 160;
export const DIGIT_ROTOR: readonly string[] = Object.freeze(Array.from("0123456789"));
export type FlapStep = { from: string; to: string; at: number; landAt: number };
export type FlapPlan = { steps: FlapStep[]; endAt: number; seed: number };
const LATIN = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = " 0123456789";
const HANGUL = "가강경계고광구국금김나남노대덕도동라로마명목무문미방백부산서선성소수순시신안양어여연영오온왕용우운울원유인일장전정제조종주중지진창천철청춘충태통평포하한함해행호홍화환횡흥";
const SYMBOLS = " -+.:/›…";

export function hashText(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return hash >>> 0;
}
/** A physical drum moves forward through a fixed list, including the wraparound. */
export function makeIndexedFlapPlan(
  from: string, to: string, rotor: readonly string[], identity: string, now: number,
): FlapPlan {
  const seed = hashText(`${identity}:${from}:${to}`);
  const current = rotor.indexOf(from);
  const target = rotor.indexOf(to);
  // An unknown label is shown directly; never insert it into/reorder the drum at runtime.
  if (from === to || current < 0 || target < 0) return { steps: [], endAt: now, seed };
  const count = (target - current + rotor.length) % rotor.length;
  const start = now + seed % 181;
  const steps = Array.from({ length: count }, (_, i) => ({
    from: rotor[(current + i) % rotor.length],
    to: rotor[(current + i + 1) % rotor.length],
    at: start + i * FLAP_MS,
    landAt: start + (i + 1) * FLAP_MS,
  }));
  return { steps, endAt: steps.at(-1)?.landAt ?? now, seed };
}
export function makeFlapPlan(from: string, to: string, identity: string, now: number): FlapPlan {
  const seed = hashText(`${identity}:${from}:${to}`);
  if (from === to) return { steps: [], endAt: now, seed };
  let rotor = /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(to) ? HANGUL
    : /[0-9]/.test(to) ? DIGITS : /[A-Za-z]/.test(to) ? LATIN : SYMBOLS;
  if (!rotor.includes(to)) rotor += to;
  const count = 6 + seed % 7;
  const target = rotor.indexOf(to);
  const start = now + seed % 181;
  const steps: FlapStep[] = [];
  let previous = from;
  for (let i = 0; i < count; i++) {
    const next = i === count - 1 ? to : rotor[(target - count + i + 1 + rotor.length * 2) % rotor.length];
    const at = start + i * FLAP_MS;
    steps.push({ from: previous, to: next, at, landAt: at + FLAP_MS });
    previous = next;
  }
  return { steps, endAt: steps.at(-1)!.landAt, seed };
}
export type FlapSoundEvent = { at: number; pan: number; variant: number; kind: "flip" | "stop" };
export function soundEvents(plan: FlapPlan, pan: number): FlapSoundEvent[] {
  if (!plan.steps.length) return [];
  return plan.steps.map((step, i) => ({
    at: step.landAt, pan: Math.max(-0.85, Math.min(0.85, pan)),
    variant: (plan.seed + i * 17) >>> 0,
    kind: i === plan.steps.length - 1 ? "stop" : "flip",
  }));
}
export function previewEvents(now: number): FlapSoundEvent[] {
  return Array.from("SEOUL서울", (letter, i) =>
    soundEvents(makeFlapPlan(" ", letter, `preview-${i}`, now + i * 35), (i / 6 - 0.5) * 1.6),
  ).flat();
}
