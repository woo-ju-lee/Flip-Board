// Browser-test instrumentation only. This is never included in the app bundle.
export async function installAudioProbe(page) {
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    const connect = AudioNode.prototype.connect;
    const connections = new WeakMap();
    const findPanner = source => {
      const visited = new Set(), pending = [source];
      while (pending.length) {
        const node = pending.pop();
        if (visited.has(node)) continue;
        visited.add(node);
        if (node instanceof StereoPannerNode) return node;
        pending.push(...(connections.get(node) || []));
      }
      return null;
    };
    const probe = window.__flapAudioProbe = {
      contexts: [], starts: [], active: new Set(), maxActive: 0,
      tap: null, analyser: null, recorder: null, chunks: [],
      pcmMeter: null, pcmSink: null, pcmRequest: 0, pcmReplies: new Map(), animationAudit: null,
      panReference: null,
      beginAnimationAudit() {
        this.animationAudit = { startedAt: performance.now(), firstNativeSource: null,
          firstAnimation: null, sourceCalls: 0, animationCalls: 0 };
      },
      noteAnimation(kind, target) {
        if (!this.animationAudit || !target?.closest?.('.flap')) return;
        this.animationAudit.animationCalls++;
        this.animationAudit.firstAnimation ??= { kind, at: performance.now(),
          nativeSourcesBeforeAnimation: this.animationAudit.sourceCalls };
      },
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
      // Count every rendered PCM sample on the audio thread. Unlike polling an
      // AnalyserNode from JS, this also observes output during main-thread stalls.
      async preparePcmMeter() {
        if (this.pcmMeter) return;
        const context = this.contexts[0];
        if (!context || !this.analyser) throw new Error('Enable audio before preparing the PCM meter');
        const source = `class FlapPcmMeter extends AudioWorkletProcessor {
          constructor() {
            super(); this.recording = false; this.recordWindows = false; this.reset();
            this.port.onmessage = ({ data }) => {
              if (data.command === 'start') {
                this.recordWindows = Boolean(data.options?.windows);
                this.reset(); this.recording = true;
                this.stats.requestedCaptureStartTime = currentFrame / sampleRate;
                this.stats.captureStartTime = this.stats.requestedCaptureStartTime;
              }
              if (data.command === 'stop') {
                this.recording = false;
                if (this.windowFrames) this.finishWindow();
                this.stats.reportedCaptureEndTime = currentFrame / sampleRate;
                this.stats.captureEndTime = this.firstRenderFrame === null ? currentFrame / sampleRate
                  : (this.firstRenderFrame + this.stats.processedFrames) / sampleRate;
              }
              this.port.postMessage({ id: data.id, ...this.stats, sampleRate });
            };
          }
          reset() {
            this.stats = { samples: 0, nonzeroSamples: 0, clippedSamples: 0, nonFiniteSamples: 0,
              peak: 0, sumSquares: 0, processedFrames: 0, rmsWindows: [], renderFrameDiscontinuities: [] };
            this.windowFrames = 0; this.windowSamples = 0; this.windowSquares = 0;
            this.firstRenderFrame = null;
            this.windowSize = Math.round(sampleRate * 0.01);
          }
          finishWindow() {
            this.stats.rmsWindows.push({ at: this.windowStart / sampleRate,
              duration: this.windowFrames / sampleRate, rms: Math.sqrt(this.windowSquares / this.windowSamples) });
            this.windowFrames = 0; this.windowSamples = 0; this.windowSquares = 0;
          }
          process(inputs, outputs) {
            if (this.recording) {
              const channels = inputs[0] || [];
              const frames = outputs[0]?.[0]?.length || 128;
              const channelCount = channels.length || 2;
              const reportedRenderFrame = currentFrame;
              if (this.firstRenderFrame === null) {
                this.firstRenderFrame = reportedRenderFrame;
                this.stats.captureStartTime = reportedRenderFrame / sampleRate;
              }
              // RMS windows follow the actual captured sample stream. Chromium
              // can expose the previous128-sample currentFrame for one callback;
              // preserve those raw offsets instead of making fictitious holes.
              const renderFrame = this.firstRenderFrame + this.stats.processedFrames;
              if (this.recordWindows) {
                if (reportedRenderFrame !== renderFrame)
                  this.stats.renderFrameDiscontinuities.push({ expected: renderFrame, actual: reportedRenderFrame });
              }
              for (let frame = 0; frame < frames; frame++) {
                if (this.recordWindows && !this.windowFrames) this.windowStart = renderFrame + frame;
                for (let channel = 0; channel < channelCount; channel++) {
                  const sample = channels[channel]?.[frame] ?? 0;
                  const magnitude = Math.abs(sample);
                  this.stats.samples++;
                  if (!Number.isFinite(sample)) { this.stats.nonFiniteSamples++; continue; }
                  if (magnitude > 0.000001) this.stats.nonzeroSamples++;
                  if (magnitude >= 1) this.stats.clippedSamples++;
                  if (magnitude > this.stats.peak) this.stats.peak = magnitude;
                  this.stats.sumSquares += sample * sample;
                  if (this.recordWindows) { this.windowSamples++; this.windowSquares += sample * sample; }
                }
                if (this.recordWindows && ++this.windowFrames === this.windowSize) this.finishWindow();
              }
              this.stats.processedFrames += frames;
            }
            return true;
          }
        }
        registerProcessor('flap-pcm-meter', FlapPcmMeter);`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try { await context.audioWorklet.addModule(url); }
        finally { URL.revokeObjectURL(url); }
        this.pcmMeter = new AudioWorkletNode(context, 'flap-pcm-meter', { channelCount: 2, channelCountMode: 'explicit' });
        this.pcmSink = context.createGain();
        this.pcmSink.gain.value = 0;
        this.pcmMeter.port.onmessage = ({ data }) => {
          this.pcmReplies.get(data.id)?.(data);
          this.pcmReplies.delete(data.id);
        };
        // Bypass destination instrumentation: the meter is a silent parallel tap,
        // never an additional audible path or an input to its own analyser.
        connect.call(this.analyser, this.pcmMeter);
        connect.call(this.pcmMeter, this.pcmSink);
        connect.call(this.pcmSink, context.destination);
      },
      pcmCommand(command, options = {}) {
        const id = ++this.pcmRequest;
        return new Promise(resolve => {
          this.pcmReplies.set(id, resolve);
          this.pcmMeter.port.postMessage({ command, id, options });
        });
      },
      async startPcmCapture(options = {}) { await this.preparePcmMeter(); return this.pcmCommand('start', options); },
      stopPcmCapture() { return this.pcmCommand('stop'); },
    };
    const animate = Element.prototype.animate;
    if (animate) Element.prototype.animate = function(...args) {
      probe.noteAnimation('animate', this);
      return animate.apply(this, args);
    };
    if (typeof Animation !== 'undefined') {
      const play = Animation.prototype.play;
      Animation.prototype.play = function(...args) {
        probe.noteAnimation('play', this.effect?.target);
        return play.apply(this, args);
      };
    }
    AudioNode.prototype.connect = function(destination, ...rest) {
      if (destination === this.context.destination) {
        probe.tap ??= this.context.createMediaStreamDestination();
        probe.analyser ??= this.context.createAnalyser();
        connect.call(this, probe.tap);
        connect.call(this, probe.analyser);
      }
      const result = connect.call(this, destination, ...rest);
      if (destination instanceof AudioNode) {
        const outputs = connections.get(this) || [];
        if (!outputs.includes(destination)) outputs.push(destination);
        connections.set(this, outputs);
      }
      return result;
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
            performanceTime: performance.now(),
            wallTime: (performance.timeOrigin + performance.now()) / 1000, frames: source.buffer?.length,
            pan: findPanner(source)?.pan.value ?? null, stopRequests: [], ended: false };
          // Optional spatial regression reference. Read only after the engine
          // assigned its panner, so this cannot repair an incorrectly cached pan.
          if (probe.panReference) {
            const bounds = probe.panReference.getBoundingClientRect();
            entry.panReference = { left: bounds.left, width: bounds.width, viewportWidth: innerWidth,
              scrollX, fullscreen: Boolean(document.fullscreenElement),
              expectedPan: Math.max(-.85, Math.min(.85, (bounds.left + bounds.width / 2) / Math.max(1, innerWidth) * 2 - 1)) };
          }
          probe.starts.push(entry);
          probe.active.add(source);
          probe.maxActive = Math.max(probe.maxActive, probe.active.size);
          source.addEventListener('ended', () => { entry.ended = true; probe.active.delete(source); }, { once: true });
          const result = start(when, offset, duration);
          if (probe.animationAudit) {
            probe.animationAudit.sourceCalls++;
            probe.animationAudit.firstNativeSource ??= { at: performance.now(), when, contextTime: ctx.currentTime };
          }
          return result;
        };
        source.stop = (...args) => {
          const calledAt = ctx.currentTime;
          const requestedWhen = args[0] ?? 0;
          // Do not record rejected native stop() calls as successful cancellations.
          const result = stop(...args);
          if (entry) {
            const effectiveAt = Math.max(calledAt, requestedWhen);
            entry.stopRequests.push({ calledAt, requestedWhen, effectiveAt });
            // A later stop() replaces a future stop, but cannot resurrect output
            // that already ended while the main-thread ended callback was delayed.
            if (!entry.ended && (entry.stopped === undefined || entry.stopped > calledAt)) entry.stopped = effectiveAt;
          }
          return result;
        };
        return source;
      }
    };
  });
}
