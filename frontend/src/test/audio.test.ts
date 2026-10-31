import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { FlapAudio, type AudioManifest } from "../audio";
import type { FlapSoundEvent } from "../flapMotion";
import { previewEvents } from "../flapMotion";
import { compareAudioEvents, selectAudioEvents } from "../audioPolicy";

// Test doubles only. Browser checks also decode and render the bundled recording.
const parameter = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
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
type Gain = Node & { gain: ReturnType<typeof parameter> };
type Panner = Node & { pan: ReturnType<typeof parameter> };
class Context {
  state = "suspended";
  destination = new Node();
  sources: Source[] = [];
  pans: ReturnType<typeof parameter>[] = [];
  gains: ReturnType<typeof parameter>[] = [];
  gainNodes: Gain[] = [];
  panNodes: Panner[] = [];
  stateListeners = new Set<() => void>();
  addEventListener = vi.fn((_type: string, listener: () => void) => this.stateListeners.add(listener));
  removeEventListener = vi.fn((_type: string, listener: () => void) => this.stateListeners.delete(listener));
  changeState(state: string) { this.state = state; this.stateListeners.forEach(listener => listener()); }
  get currentTime() { return performance.now() / 1000; }
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  decodeAudioData = vi.fn(async () => ({ duration: 2 }));
  createDynamicsCompressor() {
    return Object.assign(new Node(), { threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter() });
  }
  createGain(): Gain {
    const gain = parameter(), node = Object.assign(new Node(), { gain });
    this.gains.push(gain); this.gainNodes.push(node); return node;
  }
  createStereoPanner(): Panner {
    const pan = parameter(), node = Object.assign(new Node(), { pan });
    this.pans.push(pan); this.panNodes.push(node); return node;
  }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
}
const sourceGain = (source: Source) => source.connect.mock.calls[0][0] as ReturnType<Context["createGain"]>;
const sourcePan = (source: Source) => sourceGain(source).connect.mock.calls[0][0] as ReturnType<Context["createStereoPanner"]>;
const manifest: AudioManifest = {
  version: 1, file: "vestaboard-flip.mp3",
  cues: [{ offset: 0, duration: .065, impact: .029, kind: "flip" }],
};
const event = (at: number, variant = 0): FlapSoundEvent => ({ at, variant, pan: -.6, kind: "flip" });
let engine: FlapAudio;
let context: Context;
let fetcher: MockInstance<typeof fetch>;
let stalledMs = 0;
const flush = async () => { await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers();
  stalledMs = 0;
  const fakeNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow() + stalledMs);
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
    await flush();
    expect(context.resume).toHaveBeenCalled();
    expect(context.sources[0].start).toHaveBeenCalledWith(expect.any(Number), 0, .065);
    expect(context.sources[0].start.mock.calls[0][0]).toBeCloseTo(context.currentTime + .05 - .029 / .98);
    expect(context.sources[0].playbackRate.value).toBeCloseTo(.98);
    expect(sourcePan(context.sources[0]).pan.value).toBe(-.6);
  });

  it("replaces an owner's queued and already scheduled sounds without stopping other cells", async () => {
    await engine.toggle();
    const now = performance.now();
    engine.schedule("a", [event(now + 60), event(now + 700)]);
    engine.schedule("b", [event(now + 90)]);
    await flush();
    const [oldA, b] = context.sources;
    engine.schedule("a", [event(now + 500)]);
    await flush();
    expect(oldA.stop).toHaveBeenCalledOnce();
    expect(b.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(context.sources).toHaveLength(3);
  });

  it.each(["mute", "zero", "hidden", "suspended"])("clears pending sound on %s", async mode => {
    await engine.toggle();
    engine.schedule("cell", [event(performance.now() + 80), event(performance.now() + 700)]);
    await flush();
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

  it("coalesces a whole-board burst without delaying the selected impact", async () => {
    await engine.toggle();
    engine.schedule("burst", Array.from({ length: 300 }, (_, i) => event(performance.now() + 50, i)));
    expect(context.sources).toHaveLength(0);
    await flush();
    expect(context.sources).toHaveLength(1);
    engine.schedule("next", [event(performance.now() + 75)]);
    await flush();
    expect(context.sources).toHaveLength(2);
    engine.mute();
    expect(context.sources.at(-1)?.stop).toHaveBeenCalledOnce();
  });

  it("previews while muted and stops the preview without enabling board audio", async () => {
    await engine.preview();
    await flush();
    expect(engine.getState()).toMatchObject({ enabled: false, previewing: true });
    vi.advanceTimersByTime(200);
    expect(context.sources.length).toBeGreaterThan(0);
    const active = context.sources.filter(source => source.start.mock.calls[0][0] + .065 / source.playbackRate.value > context.currentTime);
    await engine.preview();
    expect(engine.getState().previewing).toBe(false);
    expect(active.every(source => source.stop.mock.calls.length === 1)).toBe(true);
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
    await flush();
    expect(context.sources[0].start).toHaveBeenCalledWith(expect.any(Number), 0, .065);
  });

  it("preserves cue order, rate variation and impact alignment across both cached cue banks", async () => {
    const bank: AudioManifest = { ...manifest, cues: [
      { kind: "flip", offset: 0, duration: .065, impact: .029 },
      { kind: "stop", offset: .1, duration: .060, impact: .025 },
      { kind: "flip", offset: .2, duration: .055, impact: .020 },
      { kind: "stop", offset: .3, duration: .050, impact: .015 },
    ] };
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => bank } as Response);
    await engine.toggle();
    const variants = [0, 1, 6, 7];
    const events = Array.from({ length: 8 }, (_, index): FlapSoundEvent => ({
      at: 80 + index * 50, pan: -.7 + index * .2,
      variant: variants[Math.floor(index / 2)], kind: index % 2 === 0 ? "flip" : "stop",
    }));
    engine.schedule("cell", events);
    await flush();
    expect(context.sources).toHaveLength(events.length);
    events.forEach((event, index) => {
      const choices = bank.cues.filter(cue => cue.kind === event.kind);
      const cue = choices[event.variant % choices.length];
      const rate = .97 + (event.variant % 7) * .01;
      const source = context.sources[index];
      expect(source.start).toHaveBeenCalledWith(expect.any(Number), cue.offset, cue.duration);
      expect(source.start.mock.calls[0][0] + cue.impact! / rate).toBeCloseTo(event.at / 1000, 9);
      expect(source.playbackRate.value).toBeCloseTo(rate, 9);
      expect(sourcePan(source).pan.value).toBe(event.pan);
    });
  });

  it.each([{ duration: .2, impact: .03 }, { duration: .065, impact: .07 }, { duration: .065, impact: -1 }])(
    "rejects clips that exceed one leaf or have an invalid strike position: %j", async cue => {
      fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ ...manifest, cues: [{ kind: "flip", offset: 0, ...cue }] }) } as Response);
      await expect(engine.toggle()).rejects.toThrow("플랩 음원");
      expect(engine.getState().enabled).toBe(false);
    },
  );
});

describe("reusable live audio channels", () => {
  it("prepares 32 silent channels when enabling audio and gives every future reservation its own pair", async () => {
    await engine.toggle();
    expect(context.gains).toHaveLength(33); // one master plus the reusable channels
    expect(context.pans).toHaveLength(32);
    expect(context.sources).toHaveLength(0);
    expect(context.gains.slice(1).every(gain => gain.value === 0)).toBe(true);
    expect(context.panNodes.every(pan => pan.connect.mock.calls.length === 0)).toBe(true);
    engine.schedule("dense", Array.from({ length: 18 }, (_, i) => event(60 + i * 25, 3)));
    await flush();
    expect(context.sources).toHaveLength(18);
    expect(new Set(context.sources.map(sourceGain)).size).toBe(18);
    expect(context.gains).toHaveLength(33);
    expect(context.pans).toHaveLength(32);
    vi.advanceTimersByTime(600);
    expect(context.sources.every(source => source.disconnect.mock.calls.length === 1)).toBe(true);
    for (const source of context.sources) {
      expect(sourceGain(source).gain.setValueAtTime.mock.calls.at(-1)?.[0]).toBe(0);
      expect(sourcePan(source).disconnect).toHaveBeenCalledOnce();
    }
    engine.mute();
    await engine.toggle();
    expect(context.gains).toHaveLength(33);
    expect(context.pans).toHaveLength(32);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses ended channels without letting delayed callbacks silence the new voice", async () => {
    await engine.toggle();
    engine.schedule("old", [event(60, 3)]);
    await flush();
    const old = context.sources[0], gain = sourceGain(old), pan = sourcePan(old);
    vi.advanceTimersByTime(100); // prune by audio time, without onended
    engine.schedule("new", [{ ...event(160, 3), pan: .7 }]);
    await flush();
    const current = context.sources[1];
    expect(sourceGain(current)).toBe(gain);
    expect(sourcePan(current)).toBe(pan);
    expect(pan.pan.value).toBe(.7);
    const resets = gain.gain.cancelScheduledValues.mock.calls.length;
    const disconnects = pan.disconnect.mock.calls.length;
    old.onended?.();
    expect(gain.gain.cancelScheduledValues).toHaveBeenCalledTimes(resets);
    expect(pan.disconnect).toHaveBeenCalledTimes(disconnects);
    expect(current.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(current.disconnect).toHaveBeenCalledOnce();
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, context.currentTime);
  });

  it("immediately reuses cancelled future channels after clearing their whole envelope", async () => {
    await engine.toggle();
    engine.schedule("old", [event(100, 3)]);
    await flush();
    const old = context.sources[0], gain = sourceGain(old), pan = sourcePan(old);
    vi.advanceTimersByTime(10);
    engine.cancel("old");
    expect(old.stop).toHaveBeenCalledWith();
    expect(old.disconnect).toHaveBeenCalledOnce();
    expect(gain.gain.cancelScheduledValues).toHaveBeenLastCalledWith(0);
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, .010);
    expect(pan.disconnect).toHaveBeenCalledOnce();
    expect(pan.pan.value).toBe(0);
    engine.schedule("new", [{ ...event(100, 3), pan: .2 }]);
    await flush();
    expect(sourceGain(context.sources[1])).toBe(gain);
    expect(pan.pan.value).toBe(.2);
    expect(gain.disconnect).not.toHaveBeenCalled(); // retain the gain-to-panner wire
    expect(gain.connect).toHaveBeenCalledOnce();
    expect(pan.connect).toHaveBeenCalledTimes(2);
    const envelopeCalls = gain.gain.setValueAtTime.mock.calls.length;
    old.onended?.();
    expect(gain.gain.setValueAtTime).toHaveBeenCalledTimes(envelopeCalls);
  });

  it("keeps a fading channel reserved until all 8ms have elapsed", async () => {
    await engine.toggle();
    engine.schedule("fading", [event(60, 3)]);
    await flush();
    const fading = context.sources[0], gain = sourceGain(fading), pan = sourcePan(fading);
    vi.advanceTimersByTime(35);
    engine.cancel("fading");
    engine.schedule("during", [event(100, 3)]);
    await flush();
    expect(sourceGain(context.sources[1])).not.toBe(gain);
    expect(pan.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9); // past the43ms fade end, next timer has not fired
    engine.schedule("after", [event(150, 3)]); // cancel/updateTimer prunes against the audio clock
    await flush();
    expect(fading.disconnect).toHaveBeenCalledOnce();
    expect(sourceGain(context.sources[2])).toBe(gain);
    expect(pan.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects every pooled channel on disposal, including unused and fading pairs", async () => {
    await engine.toggle();
    engine.schedule("active", [event(60, 3), event(200, 3)]);
    await flush();
    vi.advanceTimersByTime(35);
    engine.dispose();
    expect(context.gainNodes.slice(1).every(gain => gain.disconnect.mock.calls.length === 1)).toBe(true);
    expect(context.panNodes.every(pan => pan.disconnect.mock.calls.length >= 1)).toBe(true);
    expect(context.sources.every(source => source.disconnect.mock.calls.length === 1)).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    context.sources.forEach(source => source.onended?.());
    expect(context.gainNodes.slice(1).every(gain => gain.disconnect.mock.calls.length === 1)).toBe(true);
  });
});

describe("stalled scheduling and cancellation", () => {
  it("drops the six missed starts that previously collapsed onto one impact", async () => {
    await engine.toggle();
    stalledMs = 1000;
    engine.schedule("cell", [920, 940, 960, 980, 1000, 1020, 1040].map(at => event(at, 3)));
    await flush();
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].start.mock.calls[0][0]).toBeCloseTo(1.040 - .029, 9);
  });

  it.each([100, 200, 300, 400])("keeps prefilled impacts continuous through a %ims stall", async duration => {
    await engine.toggle();
    const targets = Array.from({ length: 50 }, (_, index) => 100 + index * 30);
    engine.schedule("fixture", targets.map(at => event(at, 3)));
    await flush();
    // Native future reservations exist before JS stops; only three audible
    // intervals overlap, even though more than eight nodes are scheduled.
    expect(context.sources).toHaveLength(14);
    expect(context.sources.at(-1)!.start.mock.calls[0][0] + .029).toBeCloseTo(.49, 9);
    stalledMs += duration;
    // The next timer runs after the stall, not once for every missed tick.
    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(1800);
    const impacts = context.sources.map(source => (source.start.mock.calls[0][0] + .029) * 1000);
    expect(impacts).toHaveLength(targets.length);
    impacts.forEach((at, index) => expect(at).toBeCloseTo(targets[index], 8));
    expect(Math.max(...impacts.slice(1).map((at, index) => at - impacts[index]))).toBeLessThanOrEqual(50);
  });

  it("drops missed starts after an 800ms overload and resumes original future timestamps", async () => {
    await engine.toggle();
    engine.schedule("fixture", Array.from({ length: 50 }, (_, index) => event(100 + index * 30, 3)));
    await flush();
    const prefilled = context.sources.length;
    expect(prefilled).toBe(14);
    stalledMs += 800;
    vi.advanceTimersByTime(20);
    const recovered = context.sources.slice(prefilled);
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered[0].start.mock.calls[0][0] + .029).toBeCloseTo(.85, 9);
    expect(recovered.every(source => source.start.mock.calls[0][0] >= .82)).toBe(true);
    vi.advanceTimersByTime(1800);
    const impacts = context.sources.map(source => (source.start.mock.calls[0][0] + .029) * 1000);
    expect(impacts.length).toBeLessThan(50);
    expect(impacts.at(-1)).toBeCloseTo(1570, 8);
    expect(Math.min(...impacts.slice(1).map((at, index) => at - impacts[index]))).toBeGreaterThanOrEqual(25);
  });

  it("does not claim prefill protection when JS stalls before the initial microtask", async () => {
    await engine.toggle();
    engine.schedule("fixture", Array.from({ length: 25 }, (_, index) => event(100 + index * 30, 3)));
    expect(context.sources).toHaveLength(0);
    stalledMs = 400;
    await flush();
    expect(context.sources[0].start.mock.calls[0][0] + .029).toBeCloseTo(.43, 9);
    expect(context.sources.every(source => source.start.mock.calls[0][0] >= .4)).toBe(true);
  });

  it("preserves every on-time 160ms impact for a single cell", async () => {
    await engine.toggle();
    engine.schedule("cell", [60, 220, 380, 540].map(at => event(at, 3)));
    await flush();
    vi.advanceTimersByTime(600);
    expect(context.sources.map(source => source.start.mock.calls[0][0] + .029)).toEqual([.06, .22, .38, .54]);
  });

  it("selects a later owner's stop before committing the complete microtask batch", async () => {
    await engine.toggle();
    engine.schedule("first", [event(60, 3)]);
    engine.schedule("last", [{ ...event(70, 3), kind: "stop", pan: .8 }]);
    await flush();
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].start.mock.calls[0][0]).toBeCloseTo(.070 - .029, 9);
    expect(sourcePan(context.sources[0]).pan.value).toBe(.8);
  });

  it("peeks beyond the scheduling horizon without deleting an uncommitted window", async () => {
    await engine.toggle();
    engine.schedule("cell", [event(495, 3), { ...event(510, 3), kind: "stop" }]);
    await flush();
    expect(context.sources).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].start.mock.calls[0][0]).toBeCloseTo(.510 - .029, 9);
  });

  it("snapshots caller values before a distant event is prepared", async () => {
    await engine.toggle();
    const original: FlapSoundEvent = { ...event(700, 3), kind: "stop", pan: .4 };
    const input = [original];
    engine.schedule("cell", input);
    original.at = 60;
    original.variant = 0;
    original.kind = "flip";
    original.pan = -.8;
    input.splice(0, 1, event(80));
    await flush();
    expect(context.sources).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(context.sources).toHaveLength(1);
    const source = context.sources[0];
    expect(source.start.mock.calls[0][0]).toBeCloseTo(.700 - .029, 9);
    expect(source.playbackRate.value).toBe(1);
    expect(sourcePan(source).pan.value).toBe(.4);
    expect(sourceGain(source).gain.linearRampToValueAtTime.mock.calls[0][0]).toBe(.42);
  });

  it("sorts later-ready windows across batches and preserves a stop beyond that tick's horizon", async () => {
    await engine.toggle();
    engine.schedule("z", [event(900, 3), event(695, 3), event(760, 3)]);
    engine.schedule("b", [{ ...event(710, 3), kind: "stop", pan: -.7 }]);
    await flush();
    vi.advanceTimersByTime(200); // horizon700: stop710 wins over695, but cannot be committed yet
    expect(context.sources).toHaveLength(0);
    engine.schedule("a", [{ ...event(710, 3), kind: "stop", pan: .7 }]);
    await flush();
    expect(context.sources).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(context.sources).toHaveLength(1);
    expect(sourcePan(context.sources[0]).pan.value).toBe(.7); // owner tie precedes registration order
    vi.advanceTimersByTime(180);
    const impacts = context.sources.map(source => source.start.mock.calls[0][0] + .029);
    expect(impacts).toHaveLength(3);
    [.710, .760, .900].forEach((at, index) => expect(impacts[index]).toBeCloseTo(at, 9));
  });

  it("keeps viable neighbours when source creation makes a preferred stop expire", async () => {
    await engine.toggle();
    const createSource = context.createBufferSource.bind(context);
    vi.spyOn(context, "createBufferSource").mockImplementationOnce(() => {
      const source = createSource();
      stalledMs = 85; // the preferred 110ms stop needed its source to start at 81ms
      return source;
    });
    engine.schedule("cell", [event(100, 3), { ...event(110, 3), kind: "stop" }, event(120, 3), event(145, 3)]);
    await flush();
    expect(context.sources[0].start).not.toHaveBeenCalled();
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(sourceGain(context.sources[1])).toBe(sourceGain(context.sources[0]));
    expect(context.gains).toHaveLength(33);
    const impacts = context.sources.filter(source => source.start.mock.calls.length)
      .map(source => source.start.mock.calls[0][0] + .029);
    expect(impacts).toHaveLength(2);
    expect(impacts[0]).toBeCloseTo(.120, 9);
    expect(impacts[1]).toBeCloseTo(.145, 9);
  });

  it("does not replace a committed impact when a later batch offers a stop", async () => {
    await engine.toggle();
    engine.schedule("a", [event(60, 3)]);
    await flush();
    engine.schedule("b", [{ ...event(70, 3), kind: "stop" }, event(85, 3)]);
    await flush();
    expect(context.sources).toHaveLength(2);
    expect(context.sources.map(source => source.start.mock.calls[0][0] + .029)).toEqual([.06, .085]);
  });

  it("keeps original impact times despite jitter in the published audio clock", async () => {
    await engine.toggle();
    const targets = Array.from({ length: 50 }, (_, index) => 100 + index * 30);
    engine.schedule("cell", targets.map(at => event(at, 3)));
    await flush();
    vi.advanceTimersByTime(250);
    let offset = -.009;
    vi.spyOn(context, "currentTime", "get").mockImplementation(() => performance.now() / 1000 + offset);
    vi.advanceTimersByTime(60);
    offset = .012;
    vi.advanceTimersByTime(1800);
    const impacts = context.sources.map(source => (source.start.mock.calls[0][0] + .029) * 1000);
    expect(impacts).toHaveLength(targets.length);
    impacts.forEach((at, index) => expect(at).toBeCloseTo(targets[index], 8));
  });

  it("refreshes the clock mapping after a fully idle period", async () => {
    await engine.toggle();
    engine.schedule("a", [event(60, 3)]);
    await flush();
    vi.advanceTimersByTime(120);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    vi.spyOn(context, "currentTime", "get").mockImplementation(() => performance.now() / 1000 + .025);
    const expected = context.currentTime + .06;
    engine.schedule("b", [event(performance.now() + 60, 3)]);
    await flush();
    expect(context.sources[1].start.mock.calls[0][0] + .029).toBeCloseTo(expected, 9);
  });

  it("retains the active mapping through an 8ms cancellation fade", async () => {
    await engine.toggle();
    engine.schedule("a", [event(60, 3)]);
    await flush();
    vi.advanceTimersByTime(35);
    engine.cancel("a");
    vi.spyOn(context, "currentTime", "get").mockImplementation(() => performance.now() / 1000 + .001);
    engine.schedule("b", [event(100, 3)]);
    await flush();
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0].stop.mock.calls[0][0]).toBeCloseTo(.043, 9);
    expect(context.sources[1].start.mock.calls[0][0] + .029).toBeCloseTo(.100, 9);
  });

  it("remaps a remembered impact safely when an ended fade makes the engine idle", async () => {
    await engine.toggle();
    engine.schedule("a", [event(60, 3)]);
    await flush();
    vi.advanceTimersByTime(35);
    engine.cancel("a"); // fades out at43ms, before its originally planned60ms impact
    stalledMs += 20;
    vi.spyOn(context, "currentTime", "get").mockImplementation(() => performance.now() / 1000 - .010);
    context.sources[0].onended?.(); // audio clock45ms, wall clock55ms; last timer is removed
    expect(vi.getTimerCount()).toBe(0);
    engine.schedule("b", [event(90, 3), event(95, 3)]);
    await flush();
    expect(context.sources).toHaveLength(2);
    // The new anchor maps these candidates to80/85ms; the old60ms reservation
    // still excludes80ms even though its source has already been disconnected.
    expect(context.sources[1].start.mock.calls[0][0] + .029).toBeCloseTo(.085, 9);
  });

  it("invalidates the timeline on suspension and anchors resumed work to the audio clock", async () => {
    await engine.toggle();
    engine.schedule("a", [event(60, 3), event(200, 3), event(700, 3)]);
    await flush();
    vi.advanceTimersByTime(10);
    let pausedMs = 0;
    vi.spyOn(context, "currentTime", "get").mockImplementation(() => context.state === "suspended"
      ? .01 : (performance.now() - pausedMs) / 1000);
    context.changeState("suspended");
    expect(context.sources.every(source => source.stop.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    pausedMs = 1000;
    context.changeState("running");
    engine.schedule("b", [event(performance.now() + 60, 3)]);
    await flush();
    expect(context.sources).toHaveLength(3);
    expect(context.sources[2].start.mock.calls[0][0] + .029).toBeCloseTo(.070, 9);
  });

  it("keeps only the latest owner request and never revives a cancelled flush", async () => {
    await engine.toggle();
    engine.schedule("a", [event(50, 3)]);
    engine.schedule("a", [event(75, 3)]);
    engine.cancel("a");
    engine.schedule("a", [event(90, 3)]);
    await flush();
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].start.mock.calls[0][0]).toBeCloseTo(.09 - .029, 9);
    engine.schedule("b", [event(60, 3)]);
    engine.mute();
    await engine.toggle();
    engine.schedule("c", [event(60, 3)]);
    await flush();
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1].start.mock.calls[0][0]).toBeCloseTo(.06 - .029, 9);
  });

  it.each(["mute", "zero", "hidden"])("does not commit a pending batch after %s", async mode => {
    await engine.toggle();
    engine.schedule("a", [event(60, 3)]);
    if (mode === "mute") engine.mute();
    if (mode === "zero") engine.setVolume(0);
    if (mode === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await flush();
    vi.advanceTimersByTime(1000);
    expect(context.sources).toHaveLength(0);
  });

  it("fades audible sound for 8ms without disconnecting it early", async () => {
    await engine.toggle();
    engine.schedule("a", [event(50, 3)]);
    await flush();
    const source = context.sources[0], gain = sourceGain(source).gain;
    vi.advanceTimersByTime(30);
    engine.cancel("a");
    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(.03);
    expect(gain.setValueAtTime).toHaveBeenLastCalledWith(.34, .03);
    expect(gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, .038);
    expect(source.stop).toHaveBeenCalledWith(.038);
    expect(source.disconnect).not.toHaveBeenCalled();
    engine.cancel("a");
    expect(source.stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10);
    expect(source.disconnect).toHaveBeenCalledOnce(); // no onended callback required
  });

  it("starts cancellation from the current attack envelope value", async () => {
    await engine.toggle();
    engine.schedule("a", [event(50, 3)]);
    await flush();
    vi.advanceTimersByTime(22); // sample starts at 21ms; half way through the 2ms attack
    engine.cancel("a");
    expect(sourceGain(context.sources[0]).gain.setValueAtTime.mock.calls.at(-1)![0]).toBeCloseTo(.17, 9);
    expect(context.sources[0].stop).toHaveBeenLastCalledWith(.030);
  });

  it("starts cancellation from the release envelope and never extends the natural tail", async () => {
    await engine.toggle();
    engine.schedule("a", [event(50, 3)]);
    await flush();
    vi.advanceTimersByTime(82); // natural release runs from 78 to 86ms
    engine.cancel("a");
    expect(sourceGain(context.sources[0]).gain.setValueAtTime.mock.calls.at(-1)![0]).toBeCloseTo(.17, 9);
    expect(context.sources[0].stop.mock.calls[0][0]).toBeCloseTo(.086, 9);
  });

  it("cancels future sound immediately and frees its impact reservation", async () => {
    await engine.toggle();
    engine.schedule("a", [event(60, 3)]);
    await flush();
    engine.cancel("a");
    expect(context.sources[0].stop).toHaveBeenCalledWith();
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(sourceGain(context.sources[0]).gain.cancelScheduledValues).toHaveBeenLastCalledWith(0);
    expect(sourceGain(context.sources[0]).gain.setValueAtTime).toHaveBeenLastCalledWith(0, context.currentTime);
    engine.schedule("b", [event(60, 3)]);
    await flush();
    expect(context.sources).toHaveLength(2);
  });

  it("releases ended sources by audio time even when onended is delayed", async () => {
    await engine.toggle();
    engine.schedule("a", Array.from({ length: 20 }, (_, index) => event(60 + index * 160, 3)));
    await flush();
    vi.advanceTimersByTime(3300);
    expect(context.sources).toHaveLength(20);
    expect(context.sources.every(source => source.disconnect.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    context.sources.forEach(source => source.onended?.());
    expect(context.sources.every(source => source.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("finishes muted preview even when its last ended callback wins over the timer", async () => {
    await engine.preview();
    await flush();
    vi.advanceTimersByTime(2400);
    context.sources.forEach(source => source.onended?.());
    expect(engine.getState().previewing).toBe(false);
    expect(engine.getState().enabled).toBe(false);
  });

  it("uses the same selection policy for the offline preview", async () => {
    class OfflineContext extends Context {
      get currentTime() { return 0; }
      startRendering = vi.fn(async () => ({ sources: this.sources }));
    }
    const offline = new OfflineContext();
    vi.stubGlobal("OfflineAudioContext", class { constructor() { return offline; } });
    await engine.renderPreview();
    const events = previewEvents(60).map((event, order) => {
      const rate = .97 + (event.variant % 7) * .01;
      const start = event.at - .029 / rate * 1000;
      return { ...event, owner: "preview", order, start, end: start + .065 / rate * 1000 };
    }).sort(compareAudioEvents);
    const expected = selectAudioEvents(events, Infinity, []).selected.map(({ event }) => event.at);
    const actual = offline.sources.map(source => (source.start.mock.calls[0][0] + .029 / source.playbackRate.value) * 1000);
    expect(actual).toHaveLength(expected.length);
    actual.forEach((at, index) => expect(at).toBeCloseTo(expected[index], 8));
    expect(expected.length).toBeLessThan(events.length);
    expect(context.sources).toHaveLength(0);
    expect(offline.sources.every(source => !context.gainNodes.includes(sourceGain(source)))).toBe(true);
    expect(new Set(offline.sources.map(sourceGain)).size).toBe(offline.sources.length);
    expect(context.panNodes.every(pan => pan.connect.mock.calls.length === 0)).toBe(true);
  });
});
