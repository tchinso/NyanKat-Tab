class NyanKatCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(2048); this.offset = 0; this.epoch = -1;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'reset') { this.offset = 0; this.epoch = data.epoch; }
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.buffer[this.offset++] = sample / channels.length;
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ audio: this.buffer, epoch: this.epoch }, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('nyankat-capture', NyanKatCapture);
