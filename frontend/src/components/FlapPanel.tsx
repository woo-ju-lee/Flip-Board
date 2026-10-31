import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flapAudio } from "../audio";
import { FLAP_MS, soundEvents } from "../flapMotion";
import { scheduleFlap } from "../flapScheduler";
import { readFlapPan, registerFlapPan } from "../flapPan";
import { makePanelPlan } from "../panelMotion";

type PanelProps = {
  value: string; labels: readonly string[]; index: number; reduced: boolean;
  renderValue: (value: string) => ReactNode; className?: string;
};

export const FlapPanel = memo(function FlapPanel(props: PanelProps) {
  return typeof Element !== "undefined" && typeof Element.prototype.animate === "function"
    ? <OptimizedFlapPanel {...props} /> : <LegacyFlapPanel {...props} />;
});

type PanelFrame = { from: string; to: string; active: boolean; at: number; generation: number };

/** React owns arbitrary logo content; only the persistent moving faces use WAAPI. */
function OptimizedFlapPanel({ value, labels, index, reduced, renderValue, className = "" }: PanelProps) {
  const owner = useId();
  const element = useRef<HTMLSpanElement>(null);
  const outgoing = useRef<HTMLSpanElement>(null);
  const incoming = useRef<HTMLSpanElement>(null);
  const animations = useRef<Animation[] | null>(null);
  const generation = useRef(0);
  const settled = useRef("");
  const refresh = useRef<((time: number) => boolean) | null>(null);
  const [frame, setFrame] = useState<PanelFrame>({ from: "", to: "", active: false, at: 0, generation: 0 });
  const cancelAnimations = () => animations.current?.forEach(animation => animation.cancel());

  useEffect(() => registerFlapPan(element.current!), []);

  useLayoutEffect(() => {
    if (!frame.active || frame.generation !== generation.current) { cancelAnimations(); return; }
    const elapsed = performance.now() - frame.at;
    // React may commit after another leaf has already landed. Reconcile to the
    // current step before starting motion instead of briefly replaying old faces.
    if (elapsed >= FLAP_MS) {
      cancelAnimations();
      refresh.current?.(performance.now());
      return;
    }
    if (!animations.current) {
      animations.current = [
        outgoing.current!.animate([
          { transform: "rotateX(0deg)", filter: "brightness(1)" },
          { transform: "rotateX(-90deg)", filter: "brightness(.55)" },
        ], { duration: FLAP_MS / 2, easing: "cubic-bezier(.45,0,.95,.55)", fill: "both" }),
        incoming.current!.animate([
          { transform: "rotateX(90deg)", filter: "brightness(.65)" },
          { transform: "rotateX(-3deg)", filter: "brightness(1.02)", offset: .87 },
          { transform: "rotateX(0deg)", filter: "brightness(1)" },
        ], { duration: FLAP_MS / 2, delay: FLAP_MS / 2, easing: "cubic-bezier(.15,.55,.3,1)", fill: "both" }),
      ];
    }
    const timelineTime = document.timeline?.currentTime;
    for (const animation of animations.current) {
      animation.cancel();
      animation.play();
      animation.currentTime = Math.max(0, elapsed);
      if (typeof timelineTime === "number") animation.startTime = timelineTime - Math.max(0, elapsed);
    }
  }, [frame]);

  useEffect(() => {
    const root = element.current!;
    const currentGeneration = ++generation.current;
    const show = (from: string, to: string, active = false, at = 0) => {
      setFrame({ from, to, active, at, generation: currentGeneration });
    };
    const finish = () => {
      settled.current = value;
      cancelAnimations();
      show(value, value);
    };
    if (reduced || document.hidden || settled.current === value) {
      finish();
      return () => { generation.current++; cancelAnimations(); flapAudio.cancel(owner); };
    }

    const plan = makePanelPlan(settled.current, value, labels, owner, performance.now(), index);
    show(settled.current, settled.current);
    let landed = 0;
    let displayed = -1;
    let pan = 0;
    let cancelled = false;
    let unregister = () => {};
    const reconcile = (time: number) => {
      while (landed < plan.steps.length && plan.steps[landed].landAt <= time)
        settled.current = plan.steps[landed++].to;
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      generation.current++;
      reconcile(performance.now());
      unregister();
      refresh.current = null;
      cancelAnimations();
      flapAudio.cancel(owner);
    };
    const update = (time: number) => {
      if (cancelled || !root.isConnected) { cancel(); return false; }
      reconcile(time);
      if (landed === plan.steps.length) {
        finish();
        refresh.current = null;
        // Also remove the task if a delayed React commit completed this plan.
        unregister();
        return false;
      }
      const step = plan.steps[landed];
      if (time >= step.at && displayed !== landed) {
        displayed = landed;
        show(step.from, step.to, true, step.at);
      }
      return true;
    };
    refresh.current = update;
    unregister = scheduleFlap({
      prepare() {
        if (cancelled || !root.isConnected) { cancel(); return; }
        pan = readFlapPan(root);
      },
      onPrepared() {
        if (cancelled || !root.isConnected) { cancel(); return; }
        flapAudio.schedule(owner, soundEvents(plan, pan));
      },
      update,
      onHidden() { cancel(); finish(); },
    });
    return cancel;
  }, [value, labels, index, reduced, owner]);

  const face = (text: string) => <span className="panel-face">{text ? renderValue(text) : null}</span>;
  return <span ref={element} className={`flap flap-panel flap-panel-optimized ${className}`} data-value={value}
    data-flipping={frame.active ? "true" : "false"} aria-hidden="true">
    <span className="flap-half flap-top">{face(frame.to)}</span>
    <span className="flap-half flap-bottom">{face(frame.active ? frame.from : frame.to)}</span>
    <span className="flap-motion">
      <span ref={outgoing} className="flap-half flap-top flap-out">{face(frame.from)}</span>
      <span ref={incoming} className="flap-half flap-bottom flap-in">{face(frame.to)}</span>
    </span>
    <span className="flap-seam" />
    <span className="flap-hinge hinge-left" /><span className="flap-hinge hinge-right" />
  </span>;
}

/** Retain the CSS/timer path for browsers without the Web Animations API. */
function LegacyFlapPanel({ value, labels, index, reduced, renderValue, className = "" }: PanelProps) {
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
}
