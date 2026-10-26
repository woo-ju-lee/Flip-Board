// Browser-test instrumentation only. This is never included in the app bundle.
export async function installAudioProbe(page) {
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    const connect = AudioNode.prototype.connect;
    const probe = window.__flapAudioProbe = {
      contexts: [], starts: [], active: new Set(), maxActive: 0,
      tap: null, analyser: null, recorder: null, chunks: [],
      peak() {
        if (!this.analyser) return 0;
        const samples = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(samples);
        return samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
      },
      startRecording() {
        this.chunks = [];
        this.recorder = new MediaRecorder(this.tap.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
        this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
        this.recordingStartedAt = (performance.timeOrigin + performance.now()) / 1000;
        this.recorder.start();
        return this.recordingStartedAt;
      },
      stopRecording() {
        return new Promise(resolve => {
          this.recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(this.chunks).arrayBuffer())));
          this.recorder.stop();
        });
      },
    };
    AudioNode.prototype.connect = function(destination, ...rest) {
      if (destination === this.context.destination) {
        probe.tap ??= this.context.createMediaStreamDestination();
        probe.analyser ??= this.context.createAnalyser();
        connect.call(this, probe.tap);
        connect.call(this, probe.analyser);
      }
      return connect.call(this, destination, ...rest);
    };
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); probe.contexts.push(this); }
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        const stop = source.stop.bind(source);
        const ctx = this;
        let entry;
        source.start = (when = 0, offset = 0, duration) => {
          entry = { when, offset, duration, rate: source.playbackRate.value, contextTime: ctx.currentTime,
            wallTime: (performance.timeOrigin + performance.now()) / 1000, frames: source.buffer?.length };
          probe.starts.push(entry);
          probe.active.add(source);
          probe.maxActive = Math.max(probe.maxActive, probe.active.size);
          source.addEventListener('ended', () => probe.active.delete(source), { once: true });
          return start(when, offset, duration);
        };
        source.stop = (...args) => {
          if (entry) entry.stopped = ctx.currentTime;
          return stop(...args);
        };
        return source;
      }
    };
  });
}
