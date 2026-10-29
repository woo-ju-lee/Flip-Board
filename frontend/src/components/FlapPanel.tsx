import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flapAudio } from "../audio";
import { soundEvents } from "../flapMotion";
import { makePanelPlan } from "../panelMotion";

export const FlapPanel = memo(function FlapPanel({ value, labels, index, reduced, renderValue, className = "" }: {
  value: string; labels: readonly string[]; index: number; reduced: boolean;
  renderValue: (value: string) => ReactNode; className?: string;
}) {
  const owner = useId();
  const element = useRef<HTMLSpanElement>(null);
  const settled = useRef("");
  const [frame, setFrame] = useState({ from: "", to: "", active: false, serial: 0 });
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = () => {
      settled.current = value;
      setFrame(f => ({ from: value, to: value, active: false, serial: f.serial }));
    };
    const cancel = () => { timers.forEach(clearTimeout); flapAudio.cancel(owner); };
    if (reduced || document.hidden || settled.current === value) { finish(); return cancel; }
    const now = performance.now();
    const plan = makePanelPlan(settled.current, value, labels, owner, now, index);
    const bounds = element.current?.getBoundingClientRect();
    const pan = bounds ? ((bounds.left + bounds.width / 2) / Math.max(1, innerWidth)) * 2 - 1 : 0;
    setFrame(f => ({ from: settled.current, to: settled.current, active: false, serial: f.serial }));
    flapAudio.schedule(owner, soundEvents(plan, pan));
    for (const step of plan.steps) {
      timers.push(setTimeout(() => setFrame(f => ({ from: step.from, to: step.to, active: true, serial: f.serial + 1 })), step.at - now));
      timers.push(setTimeout(() => {
        settled.current = step.to;
        setFrame(f => ({ from: step.to, to: step.to, active: false, serial: f.serial }));
      }, step.landAt - now));
    }
    const visible = () => { if (document.hidden) { cancel(); finish(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { cancel(); document.removeEventListener("visibilitychange", visible); };
  }, [value, labels, index, reduced, owner]);
  const face = (text: string) => <span className="panel-face">{text ? renderValue(text) : null}</span>;
  return <span ref={element} className={`flap flap-panel ${className}`} data-value={value}
    data-flipping={frame.active ? "true" : "false"} aria-hidden="true">
    <span className="flap-half flap-top">{face(frame.to)}</span>
    <span className="flap-half flap-bottom">{face(frame.active ? frame.from : frame.to)}</span>
    {frame.active && <span key={frame.serial} className="flap-motion">
      <span className="flap-half flap-top flap-out">{face(frame.from)}</span>
      <span className="flap-half flap-bottom flap-in">{face(frame.to)}</span>
    </span>}
    <span className="flap-seam" />
    <span className="flap-hinge hinge-left" /><span className="flap-hinge hinge-right" />
  </span>;
});
