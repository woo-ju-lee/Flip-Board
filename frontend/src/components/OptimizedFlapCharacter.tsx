import { memo, useEffect, useId, useRef } from "react";
import { flapAudio } from "../audio";
import { FLAP_MS, makeFlapPlan, makeIndexedFlapPlan, soundEvents, type FlapStep } from "../flapMotion";
import { scheduleFlap } from "../flapScheduler";

type Faces = {
  top: Text;
  bottom: Text;
  outgoing: Text;
  incoming: Text;
  out: HTMLElement;
  into: HTMLElement;
  outShade: HTMLElement;
  inShade: HTMLElement;
  animations: Animation[] | null;
};

function text(node: Text, value: string) {
  // textContent would replace the Text node on every leaf. Keep that node too.
  if (node.data !== value) node.data = value;
}

function facesFor(root: HTMLElement): Faces {
  const out = root.querySelector<HTMLElement>(".flap-out")!;
  const into = root.querySelector<HTMLElement>(".flap-in")!;
  return {
    top: root.querySelector(":scope > .flap-top > span")!.firstChild as Text,
    bottom: root.querySelector(":scope > .flap-bottom > span")!.firstChild as Text,
    outgoing: out.querySelector("span")!.firstChild as Text,
    incoming: into.querySelector("span")!.firstChild as Text,
    out, into,
    outShade: out.querySelector<HTMLElement>(".flap-shade")!,
    inShade: into.querySelector<HTMLElement>(".flap-shade")!,
    animations: null,
  };
}

function cancelAnimations(faces: Faces) {
  faces.animations?.forEach(animation => animation.cancel());
}

function showSettled(root: HTMLElement, faces: Faces, value: string) {
  cancelAnimations(faces);
  text(faces.top, value);
  text(faces.bottom, value);
  text(faces.outgoing, value);
  text(faces.incoming, value);
  root.dataset.flipping = "false";
}

function startLeaf(root: HTMLElement, faces: Faces, step: FlapStep, elapsed: number) {
  text(faces.top, step.to);
  text(faces.bottom, step.from);
  text(faces.outgoing, step.from);
  text(faces.incoming, step.to);
  if (root.dataset.flipping !== "true") root.dataset.flipping = "true";

  if (!faces.animations) {
    const upper: KeyframeAnimationOptions = {
      duration: FLAP_MS / 2, easing: "cubic-bezier(.45,0,.95,.55)", fill: "both",
    };
    const lower: KeyframeAnimationOptions = {
      duration: FLAP_MS / 2, delay: FLAP_MS / 2,
      easing: "cubic-bezier(.15,.55,.3,1)", fill: "both",
    };
    faces.animations = [
      faces.out.animate([{ transform: "rotateX(0deg)" }, { transform: "rotateX(-90deg)" }], upper),
      faces.into.animate([
        { transform: "rotateX(90deg)" },
        { transform: "rotateX(-3deg)", offset: 0.87 },
        { transform: "rotateX(0deg)" },
      ], lower),
      faces.outShade.animate([{ opacity: 0 }, { opacity: 0.45 }], upper),
      faces.inShade.animate([{ opacity: 0.35 }, { opacity: 0, offset: 0.87 }, { opacity: 0 }], lower),
    ];
  }
  // Reuse the same Animation objects, including when a new target interrupts us.
  // Align to the plan clock instead of adding a frame's delay to every leaf.
  const timelineTime = document.timeline?.currentTime;
  for (const animation of faces.animations) {
    animation.cancel();
    animation.play();
    animation.currentTime = elapsed;
    // A resolved start time avoids waiting for a pending play task to establish
    // its clock on a later frame. The fallback also supports test DOMs.
    if (typeof timelineTime === "number") animation.startTime = timelineTime - elapsed;
  }
}

/**
 * Demo renderer inspired by splitflap.org's shared queue and cached cell faces.
 * Unlike that reference, every intermediate leaf uses the original 160ms flip.
 * React owns the stable structure; the renderer owns its Text nodes and motion.
 */
export const OptimizedFlapCharacter = memo(function OptimizedFlapCharacter({ value, index, reduced, rotor }: {
  value: string; index: number; reduced: boolean; rotor?: readonly string[];
}) {
  const owner = useId();
  const element = useRef<HTMLSpanElement>(null);
  const initial = useRef(rotor ? value : " ");
  const settled = useRef(initial.current);
  const faces = useRef<Faces | null>(null);

  useEffect(() => {
    const root = element.current!;
    const view = faces.current ??= facesFor(root);
    const finish = () => {
      settled.current = value;
      showSettled(root, view, value);
    };
    if (reduced || document.hidden || settled.current === value) {
      finish();
      return () => { cancelAnimations(view); flapAudio.cancel(owner); };
    }

    const now = performance.now();
    const plan = rotor
      ? makeIndexedFlapPlan(settled.current, value, rotor, `${owner}:${index}`, now)
      : makeFlapPlan(settled.current, value, `${owner}:${index}`, now);
    if (!plan.steps.length) {
      finish();
      return () => { cancelAnimations(view); flapAudio.cancel(owner); };
    }
    showSettled(root, view, settled.current);
    let landed = 0;
    let displayed = -1;
    let pan = 0;
    let soundScheduled = false;
    let cancelled = false;
    let unregister = () => {};
    const reconcileLanded = (time: number) => {
      // Advance only the logical position after a stalled frame, never replay a
      // burst of expired animations. In ordinary frames every leaf is rendered.
      while (landed < plan.steps.length && plan.steps[landed].landAt <= time) {
        settled.current = plan.steps[landed++].to;
      }
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      reconcileLanded(performance.now());
      unregister();
      cancelAnimations(view);
      flapAudio.cancel(owner);
    };
    unregister = scheduleFlap({
      prepare() {
        const bounds = root.getBoundingClientRect();
        pan = ((bounds.left + bounds.width / 2) / Math.max(1, window.innerWidth)) * 2 - 1;
      },
      update(time) {
        if (cancelled) return false;
        if (!soundScheduled) {
          soundScheduled = true;
          flapAudio.schedule(owner, soundEvents(plan, pan));
        }
        reconcileLanded(time);
        if (landed === plan.steps.length) {
          finish();
          return false;
        }
        const step = plan.steps[landed];
        if (time >= step.at && displayed !== landed) {
          displayed = landed;
          startLeaf(root, view, step, time - step.at);
        }
        return true;
      },
      onHidden() {
        cancel();
        finish();
      },
    });
    return cancel;
  }, [value, reduced, index, owner, rotor]);

  return (
    <span ref={element} className="flap flap-optimized" aria-hidden="true" data-flipping="false" data-value={value}>
      <span className="flap-half flap-top"><span>{initial.current}</span></span>
      <span className="flap-half flap-bottom"><span>{initial.current}</span></span>
      <span className="flap-motion">
        <span className="flap-half flap-top flap-out"><span>{initial.current}</span><i className="flap-shade" /></span>
        <span className="flap-half flap-bottom flap-in"><span>{initial.current}</span><i className="flap-shade" /></span>
      </span>
      <span className="flap-seam" />
      <span className="flap-hinge hinge-left" /><span className="flap-hinge hinge-right" />
    </span>
  );
});
