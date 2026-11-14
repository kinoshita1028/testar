// Runs on the audio thread: slices the mono mic signal into fixed-size frames
// and hands them to the main thread for voice-activity detection.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options?.processorOptions?.frameSize || 480;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buf[this.n++] = channel[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
