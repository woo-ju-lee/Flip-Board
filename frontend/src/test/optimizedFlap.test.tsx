import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flapAudio } from "../audio";
import { OptimizedFlapCharacter } from "../components/OptimizedFlapCharacter";
import { DIGIT_ROTOR, FLAP_MS } from "../flapMotion";
import { getFlapSchedulerState } from "../flapScheduler";
import { STATION_CHARACTER_ROTOR } from "../stationCharacters";

// Drive the browser's frame clock explicitly: a stalled frame must not turn into
// hundreds of timer callbacks or replay expired animations when it resumes.
function browserClock() {
  let now = 1000;
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => pending.delete(id)));
  return {
    get now() { return now; },
    get pending() { return pending.size; },
    // Changing the clock without dispatching a frame models a blocked main thread.
    elapseTo(time: number) { now = time; },
    frameAt(time: number) {
      now = time;
      act(() => {
        const callbacks = [...pending.values()];
        pending.clear();
        callbacks.forEach(callback => callback(time));
      });
    },
    flush() { this.frameAt(now); },
  };
}

type BrowserAnimation = {
  currentTime: number | null;
  startTime: number | null;
  playState: AnimationPlayState;
  cancel: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
};

let clock: ReturnType<typeof browserClock>;
let animations: BrowserAnimation[];
let animateDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  clock = browserClock();
  animations = [];
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(flapAudio, "schedule").mockImplementation(() => {});
  vi.spyOn(flapAudio, "cancel");
  animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => {
      const animation: BrowserAnimation = {
        currentTime: 0,
        startTime: null,
        playState: "running",
        cancel: vi.fn(() => { animation.playState = "idle"; animation.currentTime = null; }),
        play: vi.fn(() => { animation.playState = "running"; }),
        pause: vi.fn(() => { animation.playState = "paused"; }),
      };
      animations.push(animation);
      return animation as unknown as Animation;
    }),
  });
});

afterEach(() => {
  cleanup();
  expect(getFlapSchedulerState()).toEqual({ activeCells: 0, framePending: false });
  expect(clock.pending).toBe(0);
  vi.unstubAllGlobals();
  if (animateDescriptor) Object.defineProperty(Element.prototype, "animate", animateDescriptor);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

const cell = (value: string, reduced = false, rotor: readonly string[] = DIGIT_ROTOR) =>
  <OptimizedFlapCharacter value={value} index={0} reduced={reduced} rotor={rotor} />;
const top = (container: HTMLElement) => container.querySelector(".flap > .flap-top > span")!.textContent;
const bottom = (container: HTMLElement) => container.querySelector(".flap > .flap-bottom > span")!.textContent;
const incoming = (container: HTMLElement) => container.querySelector(".flap-in > span")!.textContent;
const scheduled = () => vi.mocked(flapAudio.schedule).mock.calls.at(-1)![1];

describe("optimized physical flap renderer", () => {
  it("shows an indexed initial value without work and preserves every 8 → 2 leaf and sound", () => {
    const { container, rerender } = render(cell("8"));
    expect(top(container)).toBe("8");
    expect(bottom(container)).toBe("8");
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
    const faces = [...container.querySelectorAll(".flap-motion, .flap-motion *")];

    rerender(cell("2"));
    clock.flush();
    const events = scheduled();
    expect(events).toHaveLength(4);
    expect(events.map(event => event.kind)).toEqual(["flip", "flip", "flip", "stop"]);
    expect(events.slice(1).map((event, i) => event.at - events[i].at)).toEqual([FLAP_MS, FLAP_MS, FLAP_MS]);

    const sequence: string[] = [];
    events.forEach(event => {
      clock.frameAt(event.at - FLAP_MS / 2);
      expect(container.querySelector(".flap")).toHaveAttribute("data-flipping", "true");
      sequence.push(incoming(container)!);
      expect([...container.querySelectorAll(".flap-motion, .flap-motion *")]).toEqual(faces);
    });
    expect(sequence).toEqual(["9", "0", "1", "2"]);
    clock.frameAt(events.at(-1)!.at);
    expect(top(container)).toBe("2");
    expect(bottom(container)).toBe("2");
    expect(container.querySelector(".flap")).toHaveAttribute("data-flipping", "false");
    expect(clock.pending).toBe(0);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);
    expect([...container.querySelectorAll(".flap-motion, .flap-motion *")]).toEqual(faces);

    vi.mocked(flapAudio.schedule).mockClear();
    rerender(cell("2"));
    clock.flush();
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
  });

  it("keeps every syllable of the longest station drum transition and turns back to the blank leaf", () => {
    const rotor = STATION_CHARACTER_ROTOR;
    const { container, rerender } = render(cell(rotor[0], false, rotor));
    rerender(cell(rotor.at(-1)!, false, rotor));
    clock.flush();
    const events = scheduled();
    expect(events).toHaveLength(rotor.length - 1);
    const observed: string[] = [];
    events.forEach(event => {
      clock.frameAt(event.at - FLAP_MS / 2);
      observed.push(incoming(container)!);
    });
    expect(observed).toEqual(rotor.slice(1));
    clock.frameAt(events.at(-1)!.at);
    expect(top(container)).toBe(rotor.at(-1));
    rerender(cell(" ", false, rotor));
    clock.flush();
    expect(scheduled()).toHaveLength(1);
    clock.frameAt(scheduled()[0].at);
    expect(top(container)).toBe(" ");
    expect(bottom(container)).toBe(" ");
  });

  it("redirects from the last landed leaf and cancels the old sound owner", () => {
    const { container, rerender } = render(cell("8"));
    rerender(cell("2"));
    clock.flush();
    const [owner, events] = vi.mocked(flapAudio.schedule).mock.calls[0];
    clock.frameAt(events[0].at + FLAP_MS / 2);
    expect(incoming(container)).toBe("0"); // 9 has landed; 0 is still falling.
    vi.mocked(flapAudio.cancel).mockClear();

    rerender(cell("0"));
    clock.flush();
    expect(flapAudio.cancel).toHaveBeenCalledWith(owner);
    expect(scheduled()).toHaveLength(1); // 9 → 0, not 8 → 9 → 0.
    clock.frameAt(scheduled()[0].at);
    expect(top(container)).toBe("0");
    expect(bottom(container)).toBe("0");
    expect(clock.pending).toBe(0);
  });

  it("reconciles a landed leaf before retargeting even if no frame callback ran", () => {
    const { container, rerender } = render(cell("8"));
    rerender(cell("2"));
    clock.flush();
    const events = scheduled();
    clock.elapseTo(events[1].at + 10); // 0 landed during a blocked frame.
    rerender(cell("1"));
    clock.flush();
    expect(scheduled()).toHaveLength(1);
    clock.frameAt(scheduled()[0].at);
    expect(top(container)).toBe("1");
  });

  it("cancels an unfinished turn when the target returns to the settled value", () => {
    const { container, rerender } = render(cell("8"));
    rerender(cell("2"));
    clock.flush();
    clock.frameAt(scheduled()[0].at - FLAP_MS / 2);
    vi.mocked(flapAudio.schedule).mockClear();
    rerender(cell("8"));
    expect(top(container)).toBe("8");
    expect(bottom(container)).toBe("8");
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);
  });

  it("resumes at the current phase after a stalled frame without replaying expired leaves", () => {
    const { container, rerender } = render(cell("8"));
    rerender(cell("2"));
    clock.flush();
    const events = scheduled();
    const playsBeforeStall = animations.reduce((count, animation) => count + animation.play.mock.calls.length, 0);
    const time = events[2].at - 40; // Third leaf (0 → 1), 120ms into its 160ms turn.
    clock.frameAt(time);
    expect(incoming(container)).toBe("1");
    expect(bottom(container)).toBe("0");
    expect(animations.some(animation => animation.currentTime === 120)).toBe(true);
    // Only the currently visible leaf should start, never 9/0 then 1 in a burst.
    expect(animations.reduce((count, animation) => count + animation.play.mock.calls.length, 0) - playsBeforeStall).toBeLessThanOrEqual(4);
    expect(flapAudio.schedule).toHaveBeenCalledTimes(1);
    clock.frameAt(events.at(-1)!.at + 5000);
    expect(top(container)).toBe("2");
    expect(bottom(container)).toBe("2");
    expect(clock.pending).toBe(0);
  });

  it("uses one pending frame for multiple active cells and stops after all settle", () => {
    const group = (values: string[]) => <>{values.map((value, index) =>
      <OptimizedFlapCharacter key={index} value={value} index={index} reduced={false} rotor={DIGIT_ROTOR} />)}</>;
    const { rerender } = render(group(["8", "3", "1"]));
    rerender(group(["2", "7", "1"]));
    expect(clock.pending).toBe(1);
    expect(getFlapSchedulerState()).toEqual({ activeCells: 2, framePending: true });
    clock.flush();
    expect(flapAudio.schedule).toHaveBeenCalledTimes(2);
    clock.frameAt(clock.now + 100);
    expect(clock.pending).toBe(1);
    const lastLanding = Math.max(...vi.mocked(flapAudio.schedule).mock.calls.flatMap(([, events]) => events.map(event => event.at)));
    clock.frameAt(lastLanding);
    expect(getFlapSchedulerState()).toEqual({ activeCells: 0, framePending: false });
    expect(clock.pending).toBe(0);
  });

  it("settles immediately on hide and reduced motion, cancelling sounds and animations", () => {
    const { container, rerender } = render(cell("8"));
    rerender(cell("2"));
    clock.flush();
    clock.frameAt(scheduled()[0].at - 40);
    const owner = vi.mocked(flapAudio.schedule).mock.calls[0][0];
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(top(container)).toBe("2");
    expect(bottom(container)).toBe("2");
    expect(flapAudio.cancel).toHaveBeenCalledWith(owner);
    expect(clock.pending).toBe(0);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);

    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    rerender(cell("7"));
    clock.flush();
    clock.frameAt(scheduled()[0].at - 40);
    rerender(cell("7", true));
    expect(top(container)).toBe("7");
    expect(bottom(container)).toBe("7");
    expect(clock.pending).toBe(0);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);
    vi.mocked(flapAudio.schedule).mockClear();
    rerender(cell("3", true));
    expect(top(container)).toBe("3");
    expect(flapAudio.schedule).not.toHaveBeenCalled();
  });

  it("shows a character missing from the drum directly without scheduling work", () => {
    const { container, rerender } = render(cell("8"));
    rerender(cell("?"));
    expect(top(container)).toBe("?");
    expect(bottom(container)).toBe("?");
    expect(flapAudio.schedule).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
    rerender(cell("5"));
    expect(top(container)).toBe("5");
    expect(flapAudio.schedule).not.toHaveBeenCalled();
  });

  it("keeps the hidden-settled target when time passes before a visible retarget", () => {
    const { container, rerender } = render(cell("1"));
    rerender(cell("8"));
    clock.flush();
    const oldEvents = scheduled();
    clock.frameAt(oldEvents[0].at + 10);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(top(container)).toBe("8");
    expect(clock.pending).toBe(0);

    // The cancelled old timeline would now be at 4, but hiding already landed 8.
    clock.elapseTo(clock.now + 2 * FLAP_MS);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    rerender(cell("9"));
    clock.flush();
    expect(scheduled()).toHaveLength(1); // Must start at 8, not resume the old plan.
    clock.frameAt(scheduled()[0].at);
    expect(top(container)).toBe("9");
    expect(bottom(container)).toBe("9");
  });

  it("cleans up StrictMode remounts and an unmount in mid-flip", () => {
    const view = (value: string) => <StrictMode>
      <OptimizedFlapCharacter value={value} index={0} reduced={false} />
    </StrictMode>;
    const { container, rerender, unmount } = render(view("A"));
    expect(clock.pending).toBe(1);
    clock.flush();
    const latest = scheduled();
    clock.frameAt(latest[0].at - 40);
    rerender(view("B"));
    clock.flush();
    expect(clock.pending).toBe(1);
    clock.frameAt(scheduled()[0].at - 40);
    expect(container.querySelector(".flap")).toHaveAttribute("data-flipping", "true");
    const owners = vi.mocked(flapAudio.schedule).mock.calls.map(([owner]) => owner);
    unmount();
    for (const owner of owners) expect(flapAudio.cancel).toHaveBeenCalledWith(owner);
    expect(clock.pending).toBe(0);
    expect(animations.every(animation => animation.playState === "idle")).toBe(true);
  });
});
