import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { FlapAudio, type AudioManifest } from "../audio";
import type { FlapSoundEvent } from "../flapMotion";

// Test doubles only. Browser checks also decode and render the bundled recording.
const parameter = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() });
class Node {
  connect = vi.fn((next: unknown) => next);
  disconnect = vi.fn();
}
class Source extends Node {
  buffer = null;
  playbackRate = parameter();
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}
class Context {
  state = "suspended";
  destination = new Node();
  sources: Source[] = [];
  pans: ReturnType<typeof parameter>[] = [];
  get currentTime() { return performance.now() / 1000; }
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  decodeAudioData = vi.fn(async () => ({ duration: 2 }));
  createDynamicsCompressor() {
    return Object.assign(new Node(), { threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter() });
  }
  createGain() { return Object.assign(new Node(), { gain: parameter() }); }
  createStereoPanner() { const pan = parameter(); this.pans.push(pan); return Object.assign(new Node(), { pan }); }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
}
const manifest: AudioManifest = {
  version: 1, file: "vestaboard-flip.mp3",
  cues: [{ offset: 0, duration: .065, impact: .029, kind: "flip" }],
};
const event = (at: number, variant = 0): FlapSoundEvent => ({ at, variant, pan: -.6, kind: "flip" });
let engine: FlapAudio;
let context: Context;
let fetcher: MockInstance<typeof fetch>;
beforeEach(() => {
  vi.useFakeTimers();
  context = new Context();
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => ({
    ok: true, json: async () => manifest, arrayBuffer: async () => new ArrayBuffer(8), url: String(url),
  } as Response));
  engine = new FlapAudio();
});
afterEach(() => { engine.dispose(); vi.unstubAllGlobals(); });

describe("sample audio lifecycle", () => {
  it("starts muted at 30%, loads only after a gesture, pans and varies recorded samples", async () => {
    expect(engine.getState()).toMatchObject({ enabled: false, volume: .3 });
    engine.schedule("cell", [event(50)]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await engine.toggle()).toBe(true);
    engine.schedule("cell", [event(performance.now() + 50, 1)]);
    expect(context.resume).toHaveBeenCalled();
    expect(context.sources[0].start).toHaveBeenCalledWith(expect.any(Number), 0, .065);
    expect(context.sources[0].start.mock.calls[0][0]).toBeCloseTo(context.currentTime + .05 - .029 / .98);
    expect(context.sources[0].playbackRate.value).toBeCloseTo(.98);
    expect(context.pans[0].value).toBe(-.6);
  });

  it("replaces an owner's queued and already scheduled sounds without stopping other cells", async () => {
    await engine.toggle();
    const now = performance.now();
    engine.schedule("a", [event(now + 60), event(now + 700)]);
    engine.schedule("b", [event(now + 60)]);
    const [oldA, b] = context.sources;
    engine.schedule("a", [event(now + 500)]);
    expect(oldA.stop).toHaveBeenCalledOnce();
    expect(b.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(context.sources).toHaveLength(3);
  });

  it.each(["mute", "zero", "hidden", "suspended"])("clears pending sound on %s", async mode => {
    await engine.toggle();
    engine.schedule("cell", [event(performance.now() + 20), event(performance.now() + 500)]);
    if (mode === "mute") engine.mute();
    if (mode === "zero") engine.setVolume(0);
    if (mode === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    }
    if (mode === "suspended") { context.state = "suspended"; vi.advanceTimersByTime(20); }
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(context.sources).toHaveLength(1);
  });

  it("caps a whole-board burst at 24 simultaneous voices", async () => {
    await engine.toggle();
    engine.schedule("burst", Array.from({ length: 300 }, (_, i) => event(performance.now() + 50, i)));
    expect(context.sources).toHaveLength(24);
    context.sources.forEach(source => source.onended?.());
    engine.schedule("next", [event(performance.now() + 50)]);
    expect(context.sources).toHaveLength(25);
    engine.mute();
    expect(context.sources.at(-1)?.stop).toHaveBeenCalledOnce();
  });

  it("previews while muted and stops the preview without enabling board audio", async () => {
    await engine.preview();
    expect(engine.getState()).toMatchObject({ enabled: false, previewing: true });
    vi.advanceTimersByTime(200);
    expect(context.sources.length).toBeGreaterThan(0);
    await engine.preview();
    expect(engine.getState().previewing).toBe(false);
    expect(context.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
    const count = context.sources.length;
    vi.advanceTimersByTime(3000);
    expect(context.sources).toHaveLength(count);
  });

  it("leaves sound off after a failed download and allows a retry", async () => {
    fetcher.mockRejectedValueOnce(new Error("network"));
    await expect(engine.toggle()).rejects.toThrow("플랩 음원");
    expect(engine.getState()).toMatchObject({ enabled: false, loading: false });
    expect(await engine.toggle()).toBe(true);
  });

  it("rejects cue ranges outside the decoded recording", async () => {
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ ...manifest, cues: [{ kind: "flip", offset: 99, duration: .1 }] }) } as Response);
    await expect(engine.toggle()).rejects.toThrow("플랩 음원");
    expect(context.sources).toHaveLength(0);
  });

  it("does not re-enable audio if muted or hidden while the bank is loading", async () => {
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const loading = engine.toggle();
    await Promise.resolve();
    engine.mute();
    resolve({ ok: true, json: async () => manifest } as Response);
    expect(await loading).toBe(false);
    expect(engine.getState().enabled).toBe(false);
  });

  it("uses the recorded flip for the final stop without requiring a separate motor sample", async () => {
    await engine.toggle();
    engine.schedule("final", [{ ...event(performance.now() + 70), kind: "stop" }]);
    expect(context.sources[0].start).toHaveBeenCalledWith(expect.any(Number), 0, .065);
  });

  it.each([{ duration: .2, impact: .03 }, { duration: .065, impact: .07 }, { duration: .065, impact: -1 }])(
    "rejects clips that exceed one leaf or have an invalid strike position: %j", async cue => {
      fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ ...manifest, cues: [{ kind: "flip", offset: 0, ...cue }] }) } as Response);
      await expect(engine.toggle()).rejects.toThrow("플랩 음원");
      expect(engine.getState().enabled).toBe(false);
    },
  );
});
