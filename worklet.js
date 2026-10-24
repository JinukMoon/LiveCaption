// Downsamples mic audio to 16 kHz mono PCM16 and posts 100 ms chunks to the main thread.
// Each output sample is the mean of the input samples it covers (box filter), which keeps
// aliasing low enough for speech without a separate low-pass stage.

const OUT_RATE = 16000;
const CHUNK = 1600; // 100 ms

class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE; // input samples per output sample
    this.pos = 0;
    this.sum = 0;
    this.n = 0;
    this.out = new Int16Array(CHUNK);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        const v = Math.max(-1, Math.min(1, this.sum / this.n));
        this.out[this.len++] = v < 0 ? v * 32768 : v * 32767;
        this.sum = 0;
        this.n = 0;
        if (this.len === CHUNK) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(CHUNK);
          this.len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm16k', Pcm16k);
