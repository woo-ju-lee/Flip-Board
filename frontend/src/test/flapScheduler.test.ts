import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFlapSchedulerState, scheduleFlap, type FlapFrameTask } from "../flapScheduler";

let pendingFrames: Map<number, FrameRequestCallback>;
let cleanups: Array<() => void>;
let hidden: boolean;
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const task = (overrides: Partial<FlapFrameTask> = {}): FlapFrameTask => ({
  prepare: vi.fn(), onPrepared: vi.fn(), update: vi.fn(() => true), onHidden: vi.fn(), ...overrides,
});
const register = (value: FlapFrameTask) => {
  const cancel = scheduleFlap(value);
  cleanups.push(cancel);
  return cancel;
};
const frame = () => {
  const callbacks = [...pendingFrames.values()];
  pendingFrames.clear();
  callbacks.forEach(callback => callback(1000));
};

beforeEach(() => {
  hidden = false;
  cleanups = [];
  pendingFrames = new Map();
  let nextFrame = 0;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    pendingFrames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => pendingFrames.delete(id)));
});
afterEach(async () => {
  cleanups.forEach(cancel => cancel());
  await microtasks();
  expect(getFlapSchedulerState()).toEqual({ activeCells: 0, framePending: false });
  expect(pendingFrames.size).toBe(0);
  vi.unstubAllGlobals();
});

describe("shared early flap preparation", () => {
  it("reads every geometry before registration and allows the audio microtask before visual work", async () => {
    const order: string[] = [];
    register(task({
      prepare: () => order.push("read-a"),
      onPrepared: () => { order.push("register-a"); queueMicrotask(() => order.push("audio-flush")); },
      update: () => { order.push("draw-a"); return false; },
    }));
    register(task({
      prepare: () => order.push("read-b"), onPrepared: () => order.push("register-b"),
      update: () => { order.push("draw-b"); return false; },
    }));
    expect(order).toEqual([]);
    expect(pendingFrames.size).toBe(0);
    await microtasks();
    expect(order).toEqual(["read-a", "read-b", "register-a", "register-b", "audio-flush"]);
    expect(pendingFrames.size).toBe(1);
    frame();
    expect(order.slice(-2)).toEqual(["draw-a", "draw-b"]);
    expect(pendingFrames.size).toBe(0);
  });

  it("does not resurrect canceled work when a new registration shares its queued microtask", async () => {
    const old = task(), next = task();
    const queue = vi.spyOn(globalThis, "queueMicrotask");
    register(old)();
    register(next);
    expect(queue).toHaveBeenCalledTimes(1);
    await microtasks();
    expect(old.prepare).not.toHaveBeenCalled();
    expect(old.onPrepared).not.toHaveBeenCalled();
    expect(next.prepare).toHaveBeenCalledOnce();
    expect(next.onPrepared).toHaveBeenCalledOnce();
    expect(pendingFrames.size).toBe(1);
  });

  it("cancels all hidden tasks before preparation even without a dispatched visibility event", async () => {
    const a = task(), b = task();
    register(a); register(b);
    hidden = true;
    await microtasks();
    for (const value of [a, b]) {
      expect(value.prepare).not.toHaveBeenCalled();
      expect(value.onPrepared).not.toHaveBeenCalled();
      expect(value.onHidden).toHaveBeenCalledOnce();
    }
    expect(getFlapSchedulerState()).toEqual({ activeCells: 0, framePending: false });
  });

  it.each(["prepare", "onPrepared"] as const)("rechecks cancellation between tasks during %s", async phase => {
    const b = task();
    let cancelB = () => {};
    const a = task({ [phase]: () => cancelB() });
    register(a);
    cancelB = register(b);
    await microtasks();
    expect(b.onPrepared).not.toHaveBeenCalled();
    expect(b.prepare).toHaveBeenCalledTimes(phase === "prepare" ? 0 : 1);
    frame();
    expect(b.update).not.toHaveBeenCalled();
    expect(a.update).toHaveBeenCalledOnce();
  });

  it.each(["prepare", "onPrepared"] as const)("prepares reentrant registrations from %s in a separate complete batch", async phase => {
    const order: string[] = [];
    const b = task({ prepare: () => order.push("read-b"), onPrepared: () => order.push("ready-b") });
    const a = task({
      prepare: () => { order.push("read-a"); if (phase === "prepare") register(b); },
      onPrepared: () => { order.push("ready-a"); if (phase === "onPrepared") register(b); },
    });
    register(a);
    await microtasks();
    expect(order).toEqual(["read-a", "ready-a", "read-b", "ready-b"]);
    expect(pendingFrames.size).toBe(1);
    frame();
    expect(a.update).toHaveBeenCalledOnce();
    expect(b.update).toHaveBeenCalledOnce();
  });

  it("never falls back to synchronous preparation inside an existing animation frame", async () => {
    const a = task(), b = task();
    register(a);
    await microtasks();
    register(b);
    // Deliberately dispatch before the microtask checkpoint to test the guard.
    frame();
    expect(a.update).toHaveBeenCalledOnce();
    expect(b.prepare).not.toHaveBeenCalled();
    expect(b.onPrepared).not.toHaveBeenCalled();
    expect(b.update).not.toHaveBeenCalled();
    await microtasks();
    frame();
    expect(b.prepare).toHaveBeenCalledOnce();
    expect(b.onPrepared).toHaveBeenCalledOnce();
    expect(b.update).toHaveBeenCalledOnce();
  });

  it("stops between the read and registration phases if the document becomes hidden", async () => {
    const a = task({ prepare: () => { hidden = true; } });
    const b = task();
    register(a); register(b);
    await microtasks();
    expect(a.onPrepared).not.toHaveBeenCalled();
    expect(b.onPrepared).not.toHaveBeenCalled();
    expect(a.onHidden).toHaveBeenCalledOnce();
    expect(b.onHidden).toHaveBeenCalledOnce();
    expect(pendingFrames.size).toBe(0);
  });
});
