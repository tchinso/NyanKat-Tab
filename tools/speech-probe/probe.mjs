const output = document.querySelector('#result');
try {
  const context = new OfflineAudioContext(1, 1, 16000);
  const decoded = await context.decodeAudioData(await (await fetch('/models/test.wav')).arrayBuffer());
  const seconds = Number(new URL(location.href).searchParams.get('seconds'));
  const audio = decoded.getChannelData(0).slice(0, seconds > 0 ? Math.floor(seconds * 16000) : undefined);
  const worker = new Worker('./worker.mjs', { type: 'module' });
  worker.onmessage = ({ data }) => {
    window.probeResult = data;
    output.textContent = JSON.stringify(data, null, 2);
    worker.terminate();
  };
  worker.onerror = event => {
    window.probeResult = { ok: false, error: event.message };
    output.textContent = event.message;
  };
  output.textContent = '모델 로딩 및 추론 중';
  worker.postMessage({ audio, threads: Number(new URL(location.href).searchParams.get('threads')) || 1 });
} catch (error) {
  window.probeResult = { ok: false, error: String(error) };
  output.textContent = String(error);
}
