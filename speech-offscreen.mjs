import { CACHE, Segmenter } from './speech-core.mjs';
let worker, stream, context, worklet, pending, busy = false, epoch = 0;
let state = { phase: 'idle', message: '음성 모델을 준비하세요.', target: null };
const notify = () => chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_EVENT', state }).catch(() => {});
function status(phase, message) { state = { ...state, phase, message }; notify(); }
function drain() {
  if (busy || !pending || state.phase !== 'running') return;
  const audio = pending; pending = null; busy = true;
  worker.postMessage({ type: 'recognize', audio, epoch }, [audio.buffer]);
}
const segmenter = new Segmenter(audio => { pending = audio; drain(); });
async function stop() {
  epoch++; pending = null; segmenter.reset();
  const target = state.target;
  state.target = null;
  if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); worklet = null; }
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  if (context) { const old = context; context = null; await old.close(); }
  if (target) chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_END', target }).catch(() => {});
  status(worker && !['loading', 'error'].includes(state.phase) ? 'ready' : 'idle', '음성인식을 중지했습니다.');
}
function prepare() {
  if (['loading', 'ready', 'running', 'paused'].includes(state.phase)) return;
  worker?.terminate(); busy = false;
  status('loading', '모델 준비 중… 최초 다운로드 약 656 MB');
  worker = new Worker('./speech-worker.mjs', { type: 'module' });
  const owner = worker;
  worker.onmessage = ({ data }) => {
    if (worker !== owner) return;
    if (data.type === 'progress') status('loading', '모델 다운로드 중… ' + Math.round(data.loaded / 1048576) + ' MB');
    if (data.type === 'ready') status('ready', '음성 모델 준비 완료');
    if (data.type === 'text') {
      busy = false;
      if (data.epoch === epoch && state.phase === 'running' && data.text) {
        state.message = '인식 중 · ' + (data.ms / 1000).toFixed(1) + '초 처리';
        chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_TEXT', target: state.target, text: data.text }).catch(() => {});
        notify();
      }
      drain();
    }
    if (data.type === 'error') fail(data.message);
  };
  worker.onerror = event => { if (worker === owner) void fail(event.message || '음성 모델 실행 실패'); };
  worker.postMessage({ type: 'prepare' });
}
async function fail(message) {
  worker?.terminate(); worker = null; busy = false;
  await stop(); status('error', message);
}
async function command(message) {
  if (message.action === 'status') return state;
  if (message.action === 'prepare') prepare();
  if (message.action === 'stop' || message.action === 'clear') {
    await stop();
    worker?.terminate(); worker = null; busy = false;
    if (message.action === 'clear') await caches.delete(CACHE);
    status('idle', message.action === 'clear' ? '음성 모델 캐시를 삭제했습니다.' : '중지됨 · 다시 사용하려면 모델 준비를 누르세요.');
  }
  if (message.action === 'start') {
    if (state.phase !== 'ready') throw Error('먼저 음성 모델을 준비하세요.');
    epoch++; state.target = message.target;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId
      } }, video: false });
      context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule('speech-worklet.js');
      const source = context.createMediaStreamSource(stream);
      source.connect(context.destination);
      worklet = new AudioWorkletNode(context, 'nyankat-capture');
      source.connect(worklet); worklet.connect(context.destination);
      worklet.port.onmessage = ({ data }) => { if (state.phase === 'running') segmenter.push(data); };
      stream.getAudioTracks()[0].onended = () => { if (stream) void fail('탭 오디오 캡처가 종료되었습니다.'); };
      await context.resume(); status('running', '일본어 음성 인식 중');
    } catch (error) { await fail(String(error.message || error)); throw error; }
  }
  if (message.action === 'flush' && state.target) {
    state.target = { ...state.target, revision: message.revision };
    epoch++; pending = null; segmenter.reset();
    status(message.paused ? 'paused' : 'running', message.paused ? '영상 일시정지' : '일본어 음성 인식 중');
  }
  return state;
}
let commands = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'NYANKAT_SPEECH_OFFSCREEN' || sender.id !== chrome.runtime.id || sender.tab) return;
  const result = commands.then(() => command(message));
  commands = result.catch(() => {});
  result.then(state => respond({ ok: true, state }), error => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
