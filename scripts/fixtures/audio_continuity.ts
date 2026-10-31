// Test-only entry point, bundled into ignored artifacts by the browser runner.
// The runner resolves this import to either the frozen baseline or current engine.
import { FlapAudio } from '__AUDIO_ENGINE__';

const engine = new FlapAudio();
const state = window as unknown as {
  __flapAudioProbe: { contexts: AudioContext[]; starts: { when: number; rate: number }[] };
  __audioFixture: {
    enabled: boolean;
    error: string | null;
    run: (options: { volume: number; stallMs: number; phase: 'prefilled' | 'before-microtask' }) => Promise<unknown>;
  };
};
state.__audioFixture = {
  enabled: false, error: null,
  async run({ volume, stallMs, phase }) {
    engine.setVolume(volume / 100);
    const context = state.__flapAudioProbe.contexts[0];
    const planStart = performance.now();
    const audioAnchor = context.currentTime;
    const targets = Array.from({ length: 67 }, (_, index) => planStart + 70 + index * 30);
    const events = targets.map((at, index) => ({ at, pan: 0, variant: 3,
      kind: index === targets.length - 1 ? 'stop' as const : 'flip' as const }));
    const block = () => {
      const start = performance.now(), audioStart = context.currentTime;
      while (performance.now() - start < stallMs) { /* Controlled test-only main-thread stall. */ }
      return { requestedMs: stallMs, actualMs: performance.now() - start,
        performanceStart: start, performanceEnd: performance.now(), audioStart, audioEnd: context.currentTime };
    };
    engine.schedule('fixed-dense-fixture', events);
    let stall;
    let prefill;
    if (phase === 'before-microtask') {
      prefill = { nativeSources: state.__flapAudioProbe.starts.length, audioTime: context.currentTime };
      stall = block();
      await Promise.resolve();
    } else {
      // The engine's batch microtask runs before this continuation; these are
      // real AudioBufferSource.start reservations, not just queued JS events.
      await Promise.resolve();
      prefill = { nativeSources: state.__flapAudioProbe.starts.length, audioTime: context.currentTime };
      stall = block();
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, targets.at(-1)! + 160 - performance.now())));
    return { planStart, audioAnchor, targets, spacingMs: 30, phase, stall, prefill };
  },
};
document.querySelector('#enable')!.addEventListener('click', async () => {
  try { state.__audioFixture.enabled = await engine.toggle(); }
  catch (error) { state.__audioFixture.error = String(error); }
});
