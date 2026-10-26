class FlapAudio {
  private context: AudioContext | null = null;
  private enabled = false;
  private lastClick = -Infinity;
  private buffer: AudioBuffer | null = null;

  async toggle() {
    if (this.enabled) {
      this.enabled = false;
      return false;
    }
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.context.state !== "running")
      throw new Error("Audio is unavailable");
    this.enabled = true;
    return true;
  }

  click() {
    const ctx = this.context;
    if (!this.enabled || !ctx || ctx.state !== "running" || document.hidden)
      return;
    const now = ctx.currentTime;
    if (now - this.lastClick < 0.03) return; // one global ceiling, even for hundreds of characters
    this.lastClick = now;
    if (!this.buffer) {
      this.buffer = ctx.createBuffer(
        1,
        Math.floor(ctx.sampleRate * 0.026),
        ctx.sampleRate,
      );
      const samples = this.buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++)
        samples[i] =
          (Math.random() * 2 - 1) * Math.exp(-i / (samples.length / 5));
    }
    const noise = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    noise.buffer = this.buffer;
    filter.type = "bandpass";
    filter.frequency.value = 1600;
    filter.Q.value = 0.75;
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.026);
    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.onended = () => {
      noise.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    noise.start(now);
    noise.stop(now + 0.027);
  }
}
export const flapAudio = new FlapAudio();
