import { FLAP_MS, previewEvents, type FlapSoundEvent } from "./flapMotion";
import { compareAudioEvents, MIN_IMPACT_GAP_MS, selectAudioEvents, type AudioCandidate } from "./audioPolicy";

export type AudioCue = { offset: number; duration: number; impact?: number; kind: FlapSoundEvent["kind"] };
export type AudioManifest = { version: 1; file: string; cues: AudioCue[] };
export type SoundState = { enabled: boolean; volume: number; loading: boolean; previewing: boolean };
type Queued = FlapSoundEvent & {
  owner: string; generation: number; order: number;
  cue?: AudioCue; rate?: number; start?: number; end?: number;
};
type Prepared = Queued & AudioCandidate & { cue: AudioCue; rate: number };
type Channel = { gain: GainNode; pan: StereoPannerNode };
type Voice = {
  source: AudioBufferSourceNode; channel: Channel; owner: string;
  start: number; impact: number; end: number; naturalEnd: number; level: number;
  attackEnd: number; releaseStart: number; cancelling: boolean;
};
// Reserve before rendering work can block JS. This covers a bounded 400ms stall
// after prefill; a stalled first registration or longer overload still drops late sound.
const LOOKAHEAD_MS = 500;
const CANCEL_FADE_SECONDS = 0.008;
const CHANNEL_POOL_SIZE = 32;
const MISSING_AUDIO = "플랩 음원 파일을 불러오지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.";

export class FlapAudio {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private cueBanks: Record<FlapSoundEvent["kind"], AudioCue[]> = { flip: [], stop: [] };
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private channels = new Set<Channel>();
  private availableChannels: Channel[] = [];
  private queue: Queued[] = [];
  private pending = new Map<string, Queued[]>();
  private generations = new Map<string, number>();
  private nextGeneration = 0;
  private nextOrder = 0;
  private flushPending = false;
  private batchEpoch = 0;
  private voices = new Set<Voice>();
  // An ended short sample can still exclude impacts inside the 25ms spacing.
  private reservations = new Set<Voice>();
  // currentTime can be published to JS in coarse, jittery batches. One mapping
  // per active timeline preserves the spacing of its original impact times.
  private clockAnchor: { performanceTime: number; audioTime: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private preparing: Promise<void> | null = null;
  private epoch = 0;
  private listeners = new Set<(state: SoundState) => void>();
  private state: SoundState = { enabled: false, volume: 0.3, loading: false, previewing: false };

  constructor() {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }
  private onVisibility = () => { if (document.hidden) { this.epoch++; this.cancelAll(); } };
  private onContextState = () => {
    if (this.context?.state !== "running") { this.cancelAll(); this.clockAnchor = null; }
  };
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
    if (!this.context) {
      this.context = new AudioContext();
      this.context.addEventListener("statechange", this.onContextState);
    }
    if (this.context.state !== "running") { this.cancelAll(); this.clockAnchor = null; }
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
        const channels: Channel[] = [];
        try {
          for (let i = 0; i < CHANNEL_POOL_SIZE; i++) channels.push(this.createChannel(this.context!));
        } catch (error) {
          for (const channel of channels) { channel.gain.disconnect(); channel.pan.disconnect(); }
          graph.compressor.disconnect(); graph.master.disconnect();
          throw error;
        }
        this.buffer = buffer;
        const flips = manifest.cues.filter(cue => cue.kind === "flip");
        const stops = manifest.cues.filter(cue => cue.kind === "stop");
        this.cueBanks = { flip: flips, stop: stops.length ? stops : flips };
        this.master = graph.master;
        this.compressor = graph.compressor;
        // Prepare the reusable graph while enabling audio, before a page change
        // needs to reserve its first 500ms. Each future source owns one channel.
        this.channels = new Set(channels);
        this.availableChannels = channels;
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
  private createChannel(ctx: BaseAudioContext): Channel {
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.gain.value = 0;
    gain.connect(pan);
    return { gain, pan };
  }
  private acquireChannel(ctx: BaseAudioContext, destination: AudioNode): Channel {
    const live = ctx === this.context;
    const channel = (live ? this.availableChannels.pop() : undefined) ?? this.createChannel(ctx);
    if (live) this.channels.add(channel);
    // New channels are silent; returned channels already had all automation
    // cleared and gain/pan reset. Acquiring one needs no repeated native resets.
    channel.pan.connect(destination);
    return channel;
  }
  private releaseChannel(ctx: BaseAudioContext, channel: Channel) {
    channel.pan.disconnect();
    if (ctx === this.context) {
      // Disconnecting the old source happens first. Clear its entire envelope,
      // including future events from an immediately cancelled reservation.
      channel.gain.gain.cancelScheduledValues(0);
      channel.gain.gain.setValueAtTime(0, ctx.currentTime);
      channel.pan.pan.cancelScheduledValues(0);
      channel.pan.pan.value = 0;
      if (this.availableChannels.length < CHANNEL_POOL_SIZE) {
        this.availableChannels.push(channel);
        return;
      }
      this.channels.delete(channel);
    }
    // Offline channels never enter the live pool. Excess live channels are
    // transient, so cancellation bursts cannot grow the idle pool indefinitely.
    channel.gain.disconnect();
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
    const generation = ++this.nextGeneration;
    this.generations.set(owner, generation);
    this.pending.set(owner, events.map(event => this.snapshotEvent(event, owner, generation)));
    this.requestFlush();
  }
  private requestFlush() {
    if (this.flushPending) return;
    this.flushPending = true;
    const epoch = this.batchEpoch;
    queueMicrotask(() => {
      if (epoch !== this.batchEpoch) return;
      this.flushPending = false;
      this.queue = this.queue.filter(event => this.generations.get(event.owner) === event.generation);
      for (const events of this.pending.values()) this.queue.push(...events);
      this.pending.clear();
      this.tick();
    });
  }
  private updateTimer() {
    if (this.context) this.prune(this.context.currentTime);
    if (this.queue.length || this.voices.size) this.timer ??= setInterval(() => this.tick(), 20);
    else if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    // Remembered impact exclusions stay in absolute audio time, so they can be
    // mapped through a new anchor without keeping an idle clock/timer alive.
    if (!this.queue.length && !this.pending.size && !this.voices.size) this.clockAnchor = null;
  }
  private finishPreviewWhenIdle() {
    if (this.state.previewing && !this.pending.has("preview") && !this.queue.some(e => e.owner === "preview")
      && ![...this.voices].some(v => v.owner === "preview")) this.publish({ previewing: false });
  }
  private cue(event: FlapSoundEvent) {
    const choices = this.cueBanks[event.kind];
    return choices[event.variant % choices.length];
  }
  private snapshotEvent(event: FlapSoundEvent, owner: string, generation: number): Queued {
    // Own the scalar values immediately: callers may reuse their input array or
    // event objects while a distant impact is still waiting to enter lookahead.
    return { at: event.at, pan: event.pan, variant: event.variant, kind: event.kind,
      owner, generation, order: this.nextOrder++ };
  }
  private prepareEvent(event: Queued): Prepared {
    if (event.cue) return event as Prepared;
    const cue = this.cue(event);
    const rate = 0.97 + (event.variant % 7) * 0.01;
    const start = event.at - (cue.impact ?? 0) / rate * 1000;
    // Hydrate our own snapshot once, without allocating a second event object.
    event.cue = cue;
    event.rate = rate;
    event.start = start;
    event.end = start + cue.duration / rate * 1000;
    return event as Prepared;
  }
  private play(ctx: BaseAudioContext, destination: AudioNode, event: Prepared, when: number, density: number): Voice | null {
    // Source creation may itself take time: never clamp a missed start to now.
    if (when < ctx.currentTime) return null;
    const { cue, rate } = event;
    const source = ctx.createBufferSource();
    const channel = this.acquireChannel(ctx, destination);
    const { gain, pan } = channel;
    source.buffer = this.buffer;
    source.playbackRate.value = rate;
    pan.pan.value = event.pan;
    const duration = cue.duration / rate;
    const level = (event.kind === "stop" ? 0.42 : 0.34) / Math.sqrt(Math.max(1, density / 3));
    const attackEnd = when + Math.min(0.002, duration / 4);
    const releaseStart = when + Math.max(0.002, duration - 0.008);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, attackEnd);
    gain.gain.setValueAtTime(level, releaseStart);
    gain.gain.linearRampToValueAtTime(0, when + duration);
    source.connect(gain);
    if (when < ctx.currentTime) {
      source.disconnect();
      this.releaseChannel(ctx, channel);
      return null;
    }
    source.start(when, cue.offset, cue.duration);
    return { source, channel, owner: event.owner, start: when, impact: when + (cue.impact ?? 0) / rate,
      end: when + duration, naturalEnd: when + duration, level, attackEnd, releaseStart, cancelling: false };
  }
  private release(voice: Voice) {
    if (!this.voices.delete(voice)) return;
    voice.source.disconnect();
    this.releaseChannel(this.context!, voice.channel);
  }
  private prune(now: number) {
    for (const voice of this.voices) if (voice.end <= now) this.release(voice);
    for (const voice of this.reservations)
      if (voice.end <= now && voice.impact <= now - MIN_IMPACT_GAP_MS / 1000) this.reservations.delete(voice);
  }
  private stopVoice(voice: Voice, immediate = false) {
    const now = this.context!.currentTime;
    if (immediate || voice.start >= now || voice.end <= now || this.context!.state !== "running") {
      voice.source.stop();
      if (voice.start >= now) this.reservations.delete(voice);
      voice.end = Math.min(voice.end, now);
      this.release(voice);
      return;
    }
    if (voice.cancelling) return;
    voice.cancelling = true;
    // This engine owns the whole envelope, so evaluate its current value even
    // on browsers without cancelAndHoldAtTime (AudioParam.value is not a clock).
    const level = now < voice.attackEnd ? voice.level * (now - voice.start) / (voice.attackEnd - voice.start)
      : now > voice.releaseStart ? voice.level * (voice.naturalEnd - now) / (voice.naturalEnd - voice.releaseStart) : voice.level;
    voice.channel.gain.gain.cancelScheduledValues(now);
    voice.channel.gain.gain.setValueAtTime(Math.max(0, level), now);
    voice.end = Math.min(voice.naturalEnd, now + CANCEL_FADE_SECONDS);
    voice.channel.gain.gain.linearRampToValueAtTime(0, voice.end);
    voice.source.stop(voice.end);
  }
  private tick() {
    const ctx = this.context;
    if (ctx) this.prune(ctx.currentTime);
    if (!ctx || ctx.state !== "running" || !this.compressor || document.hidden || this.state.volume === 0) { this.cancelAll(); return; }
    // Do not re-anchor every tick: publication jitter could turn original 30ms
    // impacts into <25ms audio intervals and incorrectly thin a continuous plan.
    const audioNow = ctx.currentTime;
    const anchor = this.clockAnchor ??= { performanceTime: performance.now(), audioTime: audioNow };
    const timelineTime = (time: number) => anchor.performanceTime + (time - anchor.audioTime) * 1000;
    const now = timelineTime(audioNow);
    const reservations = [...this.reservations].map(voice => ({
      at: timelineTime(voice.impact),
      start: timelineTime(voice.start),
      end: timelineTime(voice.end),
    }));
    const destination = this.compressor;
    const horizon = now + LOOKAHEAD_MS;
    const ready: Prepared[] = [], future: Queued[] = [];
    // Only the scheduling window and its stop-priority peek need cue metadata
    // or sorting now. Future snapshots retain their original registration order.
    for (const event of this.queue) {
      if (event.at <= horizon + MIN_IMPACT_GAP_MS) ready.push(this.prepareEvent(event));
      else future.push(event);
    }
    ready.sort(compareAudioEvents);
    const startTime = (event: Prepared) => anchor.audioTime + (event.start - anchor.performanceTime) / 1000;
    const { remaining } = selectAudioEvents(ready, horizon, reservations,
      event => this.generations.get(event.owner) === event.generation && startTime(event) >= ctx.currentTime,
      (event, density) => {
        const voice = this.play(ctx, destination, event, startTime(event), density);
        if (!voice) return false;
        this.voices.add(voice);
        this.reservations.add(voice);
        voice.source.onended = () => { this.release(voice); this.finishPreviewWhenIdle(); this.updateTimer(); };
        return true;
      });
    this.queue = [...remaining, ...future];
    this.finishPreviewWhenIdle();
    this.updateTimer();
  }
  cancel(owner: string) {
    this.generations.delete(owner);
    this.pending.delete(owner);
    for (const voice of this.voices) if (voice.owner === owner) this.stopVoice(voice);
    // Invalid queue entries are removed together, not once for every cell.
    if (this.queue.length) this.requestFlush();
    if (owner === "preview" && this.state.previewing) this.publish({ previewing: false });
    this.updateTimer();
  }
  cancelAll() {
    this.batchEpoch++;
    this.flushPending = false;
    this.pending.clear();
    this.generations.clear();
    this.queue = [];
    for (const voice of this.voices) this.stopVoice(voice);
    this.updateTimer();
    if (this.state.previewing) this.publish({ previewing: false });
  }
  async preview() {
    if (this.state.previewing) { this.cancel("preview"); return; }
    const epoch = this.epoch;
    await this.prepare();
    if (epoch !== this.epoch || document.hidden || this.state.volume === 0) return;
    this.cancel("preview");
    this.publish({ previewing: true });
    this.enqueue("preview", previewEvents(performance.now() + 60));
  }
  /** Same source bank and mix as the app, for a reviewable WAV preview. */
  async renderPreview(): Promise<AudioBuffer> {
    await this.prepare();
    const ctx = new OfflineAudioContext(2, 44100 * 3, 44100);
    const { compressor } = this.graph(ctx, this.state.volume);
    const events = previewEvents(60).map(event => this.prepareEvent(this.snapshotEvent(event, "preview", 0))).sort(compareAudioEvents);
    selectAudioEvents(events, Infinity, [], undefined,
      (event, density) => this.play(ctx, compressor, event, event.start / 1000, density) !== null);
    return ctx.startRendering();
  }
  dispose() {
    this.mute();
    for (const voice of this.voices) this.stopVoice(voice, true);
    this.reservations.clear();
    this.updateTimer();
    for (const channel of this.channels) { channel.gain.disconnect(); channel.pan.disconnect(); }
    this.channels.clear();
    this.availableChannels = [];
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.listeners.clear();
    this.context?.removeEventListener("statechange", this.onContextState);
    void this.context?.close();
  }
}
export const flapAudio = new FlapAudio();
