import { StrictMode, useLayoutEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlapPanel } from "../components/FlapPanel";
import { flapAudio } from "../audio";
import { FLAP_MS } from "../flapMotion";
import { getFlapSchedulerState } from "../flapScheduler";
import { makePanelPlan } from "../panelMotion";

function browserClock() {
  let now = 1000;
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    pending.set(++id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((key: number) => pending.delete(key)));
  return {
    get now() { return now; },
    get pending() { return pending.size; },
    elapseTo(time: number) { now = time; },
    frameAt(time: number) {
      now = time;
      act(() => {
        const callbacks = [...pending.values()];
        pending.clear();
        callbacks.forEach(callback => callback(time));
      });
    },
    async prepare() { await act(async () => { await Promise.resolve(); }); },
    async flush() { await this.prepare(); this.frameAt(now); },
  };
}

type TestAnimation = {
  currentTime: number | null;
  startTime: number | null;
  play: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  playState: AnimationPlayState;
};
const labels = Object.freeze(["A", "B", "C", "D", "E"]);
const renderValue = (value: string) => value === "B" ? <img src="/logo-b.svg" alt="" /> : <strong>{value}</strong>;
const panel = (value: string, reduced = false) =>
  <FlapPanel value={value} labels={labels} index={0} reduced={reduced} renderValue={renderValue} />;
let clock: ReturnType<typeof browserClock>;
let animations: TestAnimation[];
let descriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  clock = browserClock();
  animations = [];
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
  vi.spyOn(flapAudio, "cancel");
  descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => {
      const animation: TestAnimation = {
        currentTime: 0, startTime: null, playState: "running",
        play: vi.fn(() => { animation.playState = "running"; }),
        cancel: vi.fn(() => { animation.playState = "idle"; animation.currentTime = null; }),
      };
      animations.push(animation);
      return animation as unknown as Animation;
    }),
  });
});
afterEach(async () => {
  cleanup();
  await clock.prepare();
  expect(getFlapSchedulerState()).toEqual({ activeCells: 0, framePending: false });
  expect(clock.pending).toBe(0);
  vi.unstubAllGlobals();
  if (descriptor) Object.defineProperty(Element.prototype, "animate", descriptor);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

function scheduledPlan(from: string, to: string, now: number) {
  const [owner, events] = vi.mocked(flapAudio.schedule).mock.calls.at(-1)!;
  const plan = makePanelPlan(from, to, labels, owner, now, 0);
  expect(events.map(event => event.at)).toEqual(plan.steps.map(step => step.landAt));
  return plan;
}
const wrappers = (container: HTMLElement) => [...container.querySelectorAll(".flap-motion, .flap-out, .flap-in")];
const settledFace = (container: HTMLElement) => container.querySelector(":scope > .flap > .flap-top > .panel-face")!;

describe("optimized logo panels", () => {
  it("reuses the mounted board position after arbitrary logo content and target changes", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const board = (value: string) => <section className="board-housing"><div className="display-table">
      {panel(value)}
    </div></section>;
    const start = clock.now;
    const { container, rerender } = render(board("B"));
    const root = container.querySelector<HTMLElement>(".flap")!;
    const bounds = vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: window.innerWidth * .7, width: window.innerWidth * .2,
    } as DOMRect);
    await clock.prepare();
    const initial = scheduledPlan("", "B", start);
    clock.frameAt(initial.steps.at(-1)!.landAt);
    expect(root.querySelector("img")).not.toBeNull();
    rerender(board("D"));
    await clock.prepare();
    scheduledPlan("B", "D", clock.now);
    expect(bounds).toHaveBeenCalledOnce();
    vi.mocked(flapAudio.schedule).mock.calls.at(-1)![1].forEach(event => expect(event.pan).toBeCloseTo(.6));
  });

  it("registers the original panned plan before the first animation frame", async () => {
    const start = clock.now;
    const { container } = render(panel("D"));
    const root = container.firstElementChild!;
    const width = window.innerWidth;
    const bounds = vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ left: width * .7, width: width * .2 } as DOMRect);
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
    await clock.prepare();
    const plan = scheduledPlan("", "D", start);
    expect(bounds).toHaveBeenCalledOnce();
    vi.mocked(flapAudio.schedule).mock.calls[0][1].forEach(event => expect(event.pan).toBeCloseTo(.6));
    expect(animations).toHaveLength(0);
    expect(clock.pending).toBe(1);
    clock.frameAt(plan.steps[0].at + 20);
    expect(flapAudio.schedule).toHaveBeenCalledTimes(1);
    expect(animations).toHaveLength(2);
  });

  it.each(["unmount", "hidden", "reduced", "disconnected"])("does not register a panel removed by %s before preparation", async mode => {
    const { container, rerender, unmount } = render(panel("D"));
    if (mode === "unmount") unmount();
    if (mode === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      act(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    if (mode === "reduced") rerender(panel("D", true));
    if (mode === "disconnected") container.remove();
    await clock.prepare();
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(animations).toHaveLength(0);
    expect(clock.pending).toBe(0);
    expect(getFlapSchedulerState()).toEqual({ activeCells: 0, framePending: false });
  });

  it("preserves all 160ms leaves and arbitrary React content on persistent moving faces", async () => {
    const started = clock.now;
    const { container, rerender } = render(panel("D"));
    const faces = wrappers(container);
    expect(faces).toHaveLength(3);
    expect(container.firstChild).toHaveClass("flap-panel-optimized");
    expect(container.firstChild).not.toHaveClass("flap-optimized");
    await clock.flush();
    const plan = scheduledPlan("", "D", started);
    for (const step of plan.steps) {
      clock.frameAt(step.at + FLAP_MS / 2);
      const incoming = container.querySelector(".flap-in > .panel-face")!;
      if (step.to === "B") expect(incoming.querySelector("img")).toHaveAttribute("src", "/logo-b.svg");
      else expect(incoming.textContent).toBe(step.to);
      expect(wrappers(container)).toEqual(faces);
      expect(animations).toHaveLength(2);
      expect(animations.map(animation => animation.currentTime)).toEqual([FLAP_MS / 2, FLAP_MS / 2]);
    }
    clock.frameAt(plan.endAt);
    expect(settledFace(container)).toHaveTextContent("D");
    expect(container.firstChild).toHaveAttribute("data-flipping", "false");
    expect(wrappers(container)).toEqual(faces);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);
    expect(clock.pending).toBe(0);
    vi.mocked(flapAudio.schedule).mockClear();
    rerender(panel("D"));
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
  });

  it("skips expired visual steps after a stalled frame rather than replaying them", async () => {
    const started = clock.now;
    const { container } = render(panel("D"));
    await clock.flush();
    const plan = scheduledPlan("", "D", started);
    clock.frameAt(plan.steps[2].at + 24);
    expect(animations).toHaveLength(2);
    expect(animations.map(animation => animation.play.mock.calls.length)).toEqual([1, 1]);
    expect(animations.map(animation => animation.currentTime)).toEqual([24, 24]);
    const current = container.querySelector(".flap-in > .panel-face")!;
    if (plan.steps[2].to === "B") expect(current.querySelector("img")).not.toBeNull();
    else expect(current.textContent).toBe(plan.steps[2].to);
    clock.frameAt(plan.endAt + 300);
    expect(settledFace(container)).toHaveTextContent("D");
    expect(clock.pending).toBe(0);
  });

  it("reconciles a delayed React commit before starting its obsolete animation", async () => {
    let delayedUntil: number | null = null;
    function Content({ value }: { value: string }) {
      useLayoutEffect(() => {
        if (delayedUntil !== null) {
          clock.elapseTo(delayedUntil);
          delayedUntil = null;
        }
      });
      return <span>{value}</span>;
    }
    const started = clock.now;
    const { container } = render(<FlapPanel value="D" labels={labels} index={0} reduced={false}
      renderValue={value => <Content value={value} />} />);
    await clock.flush();
    const plan = scheduledPlan("", "D", started);
    delayedUntil = plan.steps[2].at + 20;
    clock.frameAt(plan.steps[0].at + 5);
    expect(container.querySelector(".flap-in > .panel-face")).toHaveTextContent(plan.steps[2].to);
    expect(animations.map(animation => animation.currentTime)).toEqual([20, 20]);
    expect(animations.map(animation => animation.play.mock.calls.length)).toEqual([1, 1]);
  });

  it("retargets from the last landed logo even if no frame ran during the stall", async () => {
    const started = clock.now;
    const { container, rerender } = render(panel("D"));
    await clock.flush();
    const plan = scheduledPlan("", "D", started);
    clock.elapseTo(plan.steps[1].landAt + 10);
    const retargetedAt = clock.now;
    const landed = plan.steps[1].to;
    const next = landed === "E" ? "A" : "E";
    rerender(panel(next));
    await clock.flush();
    const newPlan = scheduledPlan(landed, next, retargetedAt);
    expect(flapAudio.cancel).toHaveBeenCalled();
    clock.frameAt(newPlan.endAt);
    expect(settledFace(container)).toHaveTextContent(next);
    expect(container.firstChild).toHaveAttribute("data-flipping", "false");
    expect(clock.pending).toBe(0);
  });

  it("cancels an unlanded rotation when its target returns to the settled value", async () => {
    const started = clock.now;
    const { container, rerender } = render(panel("D"));
    await clock.flush();
    const first = scheduledPlan("", "D", started);
    clock.frameAt(first.endAt);
    const changedAt = clock.now;
    rerender(panel("E"));
    await clock.flush();
    const second = scheduledPlan("D", "E", changedAt);
    clock.frameAt(second.steps[0].at + 10);
    vi.mocked(flapAudio.schedule).mockClear();
    rerender(panel("D"));
    expect(settledFace(container)).toHaveTextContent("D");
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);
  });

  it.each(["hidden", "reduced"])("settles and cancels shared work on %s", async mode => {
    const { container, rerender } = render(panel("D"));
    await clock.flush();
    const at = vi.mocked(flapAudio.schedule).mock.calls.at(-1)![1][0].at;
    clock.frameAt(at - 20);
    if (mode === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      act(() => document.dispatchEvent(new Event("visibilitychange")));
    } else rerender(panel("D", true));
    expect(settledFace(container)).toHaveTextContent("D");
    expect(container.firstChild).toHaveAttribute("data-flipping", "false");
    expect(flapAudio.cancel).toHaveBeenCalled();
    expect(clock.pending).toBe(0);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);
  });

  it("shares one browser frame and cleans up in StrictMode", async () => {
    const { unmount } = render(<StrictMode>{panel("D")}{panel("E")}</StrictMode>);
    await clock.prepare();
    expect(getFlapSchedulerState()).toEqual({ activeCells: 2, framePending: true });
    expect(clock.pending).toBe(1);
    expect(flapAudio.schedule).toHaveBeenCalledTimes(2);
    expect(animations).toHaveLength(0);
    await clock.flush();
    expect(flapAudio.schedule).toHaveBeenCalledTimes(2);
    unmount();
    expect(clock.pending).toBe(0);
  });

  it("retains the CSS/timer fallback when WAAPI is unavailable", async () => {
    Reflect.deleteProperty(Element.prototype, "animate");
    vi.useFakeTimers();
    const { container, unmount } = render(panel("D"));
    expect(container.firstChild).not.toHaveClass("flap-panel-optimized");
    expect(clock.pending).toBe(0);
    act(() => vi.advanceTimersByTime(1800));
    expect(settledFace(container)).toHaveTextContent("D");
    expect(container.querySelector(".flap-motion")).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
