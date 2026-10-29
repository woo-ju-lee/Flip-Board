import { memo, useContext, useEffect, useId, useRef, useState } from "react";
import { flapAudio } from "../audio";
import { DIGIT_ROTOR, makeFlapPlan, makeIndexedFlapPlan, soundEvents } from "../flapMotion";
import { FlapRendererContext } from "./FlapRendererContext";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = () => setReduced(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return reduced;
}

export const FlapCharacter = memo(function FlapCharacter({ value, index, reduced, rotor }: {
  value: string; index: number; reduced: boolean; rotor?: readonly string[];
}) {
  const owner = useId();
  const element = useRef<HTMLSpanElement>(null);
  // Indexed drums begin at their displayed value. Changes preserve this physical position.
  const settled = useRef(rotor ? value : " ");
  const [frame, setFrame] = useState({ from: settled.current, to: settled.current, active: false, serial: 0 });
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = () => {
      settled.current = value;
      setFrame(f => ({ from: value, to: value, active: false, serial: f.serial }));
    };
    const cancel = () => {
      timers.forEach(clearTimeout);
      flapAudio.cancel(owner);
    };
    if (reduced || document.hidden || settled.current === value) {
      finish();
      return cancel;
    }
    const now = performance.now();
    const plan = rotor
      ? makeIndexedFlapPlan(settled.current, value, rotor, `${owner}:${index}`, now)
      : makeFlapPlan(settled.current, value, `${owner}:${index}`, now);
    if (!plan.steps.length) { finish(); return cancel; }
    setFrame(f => ({ from: settled.current, to: settled.current, active: false, serial: f.serial }));
    const bounds = element.current?.getBoundingClientRect();
    const pan = bounds ? ((bounds.left + bounds.width / 2) / Math.max(1, window.innerWidth)) * 2 - 1 : 0;
    flapAudio.schedule(owner, soundEvents(plan, pan));
    plan.steps.forEach(step => {
      timers.push(setTimeout(() => {
        setFrame(f => ({ from: step.from, to: step.to, active: true, serial: f.serial + 1 }));
      }, Math.max(0, step.at - now)));
      timers.push(setTimeout(() => {
        settled.current = step.to;
        setFrame(f => ({ from: step.to, to: step.to, active: false, serial: f.serial }));
      }, Math.max(0, step.landAt - now)));
    });
    const onVisibility = () => { if (document.hidden) { cancel(); finish(); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancel(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [value, reduced, index, owner, rotor]);
  return (
    <span ref={element} className="flap" aria-hidden="true" data-flipping={frame.active ? "true" : "false"} data-value={value}>
      <span className="flap-half flap-top"><span>{frame.to}</span></span>
      <span className="flap-half flap-bottom"><span>{frame.active ? frame.from : frame.to}</span></span>
      {frame.active && <span key={frame.serial} className="flap-motion">
        <span className="flap-half flap-top flap-out"><span>{frame.from}</span></span>
        <span className="flap-half flap-bottom flap-in"><span>{frame.to}</span></span>
      </span>}
      <span className="flap-seam" />
      <span className="flap-hinge hinge-left" /><span className="flap-hinge hinge-right" />
    </span>
  );
});

export const SplitFlap = memo(function SplitFlap({ text, length, className = "", reduced, rotor, indexedDigits = false }: {
  text: string; length: number; className?: string; reduced: boolean; rotor?: readonly string[]; indexedDigits?: boolean;
}) {
  const Character = useContext(FlapRendererContext) ?? FlapCharacter;
  const chars = Array.from(text);
  const fitted = chars.length > length ? [...chars.slice(0, length - 1), "…"]
    : [...chars, ...Array(Math.max(0, length - chars.length)).fill(" ")];
  return (
    <span className={`flap-word ${className}`} aria-label={text || "빈칸"} title={text}>
      {fitted.map((char, index) => <Character key={index} value={char} index={index} reduced={reduced}
        rotor={rotor ?? (indexedDigits && /^\d$/.test(char) ? DIGIT_ROTOR : undefined)} />)}
    </span>
  );
});
