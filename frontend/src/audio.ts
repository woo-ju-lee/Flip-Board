import { FLAP_MS, previewEvents, type FlapSoundEvent } from "./flapMotion";

export type AudioCue = { offset: number; duration: number; impact?: number; kind: FlapSoundEvent["kind"] };
export type AudioManifest = { version: 1; file: string; cues: AudioCue[] };
export type SoundState = { enabled: boolean; volume: number; loading: boolean; previewing: boolean };
type Queued = FlapSoundEvent & { owner: string };
type Voice = { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode; owner: string; end: number };
const MAX_VOICES = 24;
const LOOKAHEAD_MS = 90;
const MISSING_AUDIO = "플랩 음원 파일을 불러오지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.";

export class FlapAudio {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private cues: AudioCue[] = [];
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private queue: Queued[] = [];
  private voices = new Set<Voice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private preparing: Promise<void> | null = null;
  private epoch = 0;
  private listeners = new Set<(state: SoundState) => void>();
  private state: SoundState = { enabled: false, volume: 0.3, loading: false, previewing: false };

  constructor() {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }
  private onVisibility = () => { if (document.hidden) { this.epoch++; this.cancelAll(); } };
  getState = (): SoundState => this.state;
  subscribe = (listener: (state: SoundState) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<SoundState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener(this.state));
  }
  setVolume(value: number) {
    const volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.publish({ volume });
    if (this.master && this.context) this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.008);
    if (volume === 0) this.cancelAll();
  }
  private async prepare() {
    if (typeof AudioContext === "undefined") throw new Error("이 브라우저에서 소리를 재생할 수 없습니다.");
    this.context ??= new AudioContext();
    // Resume in the user gesture, before any fetch/decode awaits.
    await this.context.resume();
    if (this.context.state !== "running") throw new Error("이 브라우저에서 소리를 재생할 수 없습니다.");
    if (this.buffer) return;
    if (this.preparing) return this.preparing;
    this.publish({ loading: true });
    this.preparing = (async () => {
      try {
        const root = `${import.meta.env.BASE_URL}audio/`;
        const response = await fetch(`${root}split-flap.json`);
        if (!response.ok) throw new Error(MISSING_AUDIO);
        const manifest: AudioManifest = await response.json();
        if (manifest.version !== 1 || !/^[\w.-]+\.(mp3|wav)$/.test(manifest.file) || !Array.isArray(manifest.cues) || !manifest.cues.length)
          throw new Error(MISSING_AUDIO);
        const recording = await fetch(root + manifest.file);
        if (!recording.ok) throw new Error(MISSING_AUDIO);
        const buffer = await this.context!.decodeAudioData(await recording.arrayBuffer());
        if (!manifest.cues.every(c => ["flip", "stop"].includes(c.kind) && Number.isFinite(c.offset) && Number.isFinite(c.duration)
          && c.offset >= 0 && c.duration >= 0.01 && c.duration / 0.97 <= FLAP_MS / 1000
          && c.offset + c.duration <= buffer.duration + 0.001
          && Number.isFinite(c.impact ?? 0) && (c.impact ?? 0) >= 0 && (c.impact ?? 0) < c.duration))
          throw new Error(MISSING_AUDIO);
        if (!manifest.cues.some(c => c.kind === "flip")) throw new Error(MISSING_AUDIO);
        const graph = this.graph(this.context!, this.state.volume);
        this.buffer = buffer;
        this.cues = manifest.cues;
        this.master = graph.master;
        this.compressor = graph.compressor;
      } catch {
        throw new Error(MISSING_AUDIO);
      } finally {
        this.preparing = null;
        this.publish({ loading: false });
      }
    })();
    return this.preparing;
  }
  private graph(ctx: BaseAudioContext, volume: number) {
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.08;
    const master = ctx.createGain();
    master.gain.value = volume;
    compressor.connect(master).connect(ctx.destination);
    return { compressor, master };
  }
  async toggle(): Promise<boolean> {
    if (this.state.enabled || this.state.loading) {
      this.epoch++;
      this.publish({ enabled: false });
      this.cancelAll();
      return false;
    }
    const epoch = ++this.epoch;
    await this.prepare();
    if (epoch !== this.epoch || document.hidden) return false;
    this.publish({ enabled: true });
    return true;
  }
  mute() {
    this.epoch++;
    this.publish({ enabled: false });
    this.cancelAll();
  }
  schedule(owner: string, events: FlapSoundEvent[]) {
    this.cancel(owner);
    if (!this.state.enabled || this.state.volume === 0 || !this.buffer || document.hidden) return;
    this.enqueue(owner, events);
  }
  private enqueue(owner: string, events: FlapSoundEvent[]) {
    this.queue.push(...events.map(event => ({ ...event, owner })));
    this.queue.sort((a, b) => a.at - b.at);
    this.tick();
    if (this.queue.length || this.voices.size) this.timer ??= setInterval(() => this.tick(), 20);
  }
  private cue(event: FlapSoundEvent) {
    const options = this.cues.filter(c => c.kind === event.kind);
    const choices = options.length ? options : this.cues.filter(c => c.kind === "flip");
    return choices[event.variant % choices.length];
  }
  private play(ctx: BaseAudioContext, destination: AudioNode, event: FlapSoundEvent, when: number, density: number) {
    const cue = this.cue(event);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    source.buffer = this.buffer;
    const rate = 0.97 + (event.variant % 7) * 0.01;
    source.playbackRate.value = rate;
    pan.pan.value = event.pan;
    // The recorded strike is ~29 ms into the clip. Align that strike, not the
    // beginning of the file, with the shared leaf-landing timestamp.
    when = Math.max(ctx.currentTime, when - (cue.impact ?? 0) / rate);
    const duration = cue.duration / rate;
    const level = (event.kind === "stop" ? 0.42 : 0.34) / Math.sqrt(Math.max(1, density / 3));
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + Math.min(0.002, duration / 4));
    gain.gain.setValueAtTime(level, when + Math.max(0.002, duration - 0.008));
    gain.gain.linearRampToValueAtTime(0, when + duration);
    source.connect(gain).connect(pan).connect(destination);
    source.start(when, cue.offset, cue.duration);
    return { source, gain, pan, end: when + duration };
  }
  private tick() {
    const ctx = this.context;
    if (!ctx || ctx.state !== "running" || !this.compressor || document.hidden || this.state.volume === 0) { this.cancelAll(); return; }
    const now = performance.now();
    while (this.queue.length && this.queue[0].at <= now + LOOKAHEAD_MS) {
      const event = this.queue.shift()!;
      if (event.at < now - 80 || this.voices.size >= MAX_VOICES) continue;
      const when = ctx.currentTime + Math.max(0, (event.at - now) / 1000);
      const voice = { ...this.play(ctx, this.compressor, event, when, this.voices.size + 1), owner: event.owner };
      this.voices.add(voice);
      voice.source.onended = () => {
        voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect();
        this.voices.delete(voice);
      };
    }
    if (this.state.previewing && !this.queue.some(e => e.owner === "preview") && ![...this.voices].some(v => v.owner === "preview"))
      this.publish({ previewing: false });
    if (!this.queue.length && !this.voices.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  cancel(owner: string) {
    this.queue = this.queue.filter(e => e.owner !== owner);
    for (const voice of this.voices) if (voice.owner === owner) {
      voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect();
      this.voices.delete(voice);
    }
    if (owner === "preview" && this.state.previewing) this.publish({ previewing: false });
  }
  cancelAll() {
    this.queue = [];
    for (const voice of this.voices) { voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect(); }
    this.voices.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state.previewing) this.publish({ previewing: false });
  }
  async preview() {
    if (this.state.previewing) { this.cancel("preview"); return; }
    const epoch = this.epoch;
    await this.prepare();
    if (epoch !== this.epoch || document.hidden || this.state.volume === 0) return;
    this.publish({ previewing: true });
    this.enqueue("preview", previewEvents(performance.now() + 60));
  }
  /** Same source bank and mix as the app, for a reviewable WAV preview. */
  async renderPreview(): Promise<AudioBuffer> {
    await this.prepare();
    const ctx = new OfflineAudioContext(2, 44100 * 3, 44100);
    const { compressor } = this.graph(ctx, this.state.volume);
    const events = previewEvents(60).sort((a, b) => a.at - b.at);
    const ends: number[] = [];
    for (const event of events) {
      const when = event.at / 1000;
      const density = ends.filter(end => end > when).length + 1;
      if (density > MAX_VOICES) continue;
      ends.push(this.play(ctx, compressor, event, when, density).end);
    }
    return ctx.startRendering();
  }
  dispose() {
    this.mute();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.listeners.clear();
    void this.context?.close();
  }
}
export const flapAudio = new FlapAudio();
