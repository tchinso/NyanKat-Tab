import { CACHE } from './speech-core.mjs';
const MAX_QUEUE = 24, MAX_AUDIO_BLOCKS = 64;
let worker, vad, stream, context, worklet, busy = false, inFlight = null, epoch = 0;
let pending = [], audioQueue = [], audioBusy = false, audioReset = false;
let sequence = 0, previous = null, dropped = 0, audioLosses = 0, debug = false, captureStart = null;
let metrics = null, ready = { stt: false, vad: false };
let state = { phase: 'idle', message: '음성 모델을 준비하세요.', target: null };
const notify = () => chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_EVENT', state }).catch(() => {});
function status(phase, message) {
  state = { ...state, phase, message: message + (dropped ? ` · 누락된 청크 ${dropped}개` : '') + (audioLosses ? ` · 오디오 누락 ${audioLosses}회` : '') };
  if (debug) state.metrics = { ...metrics, droppedChunks: dropped, audioLosses, queuedChunks: pending.length };
  else delete state.metrics;
  notify();
}
function clearTimeline() {
  epoch++; pending = []; audioQueue = []; previous = null; sequence = 0; captureStart = null;
  worklet?.port.postMessage({ type: 'reset', epoch });
  audioReset = true;
  pumpAudio();
}
function pumpAudio() {
  if (!vad || audioBusy) return;
  if (audioReset) { vad.postMessage({ type: 'reset', epoch }); audioReset = false; }
  if (!audioQueue.length || state.phase !== 'running') return;
  const audio = audioQueue.shift(); audioBusy = true;
  vad.postMessage({ type: 'audio', audio, epoch }, [audio.buffer]);
}
function drain() {
  if (busy || !pending.length || state.phase !== 'running') return;
  const item = pending.shift(); busy = true; inFlight = item;
  if (debug) { metrics.queueWaitMs = performance.now() - item.queuedAt; metrics.queuedChunks = pending.length; }
  worker.postMessage({ type: 'recognize', audio: item.audio, epoch: item.epoch }, [item.audio.buffer]);
}
function enqueue(data) {
  if (data.epoch !== epoch || state.phase !== 'running') return;
  const item = { audio: data.audio, epoch, metadata: data.metadata || {}, sequence: sequence++ };
  if (debug) {
    item.queuedAt = performance.now();
    metrics.totalChunks++;
    if (captureStart !== null && Number.isFinite(item.metadata.speechEndSample)) {
      metrics.endToQueueMs = Math.max(0, item.queuedAt - (captureStart + item.metadata.speechEndSample / 16));
    }
  }
  if (pending.length >= MAX_QUEUE) {
    pending.shift(); dropped++;
    status('running', '인식 대기열 초과');
  }
  pending.push(item); drain();
}
function withoutOverlap(text, prior) {
  const max = Math.min(text.length, prior.length);
  for (let n = max; n > 0; n--) if (prior.endsWith(text.slice(0, n))) return text.slice(n).trimStart();
  return text;
}
async function stop() {
  clearTimeline();
  const target = state.target;
  state.target = null;
  if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); worklet = null; }
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  if (context) { const old = context; context = null; await old.close(); }
  if (target) chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_END', target }).catch(() => {});
  status(worker && vad && !['loading', 'error'].includes(state.phase) ? 'ready' : 'idle', '음성인식을 중지했습니다.');
}
function prepare() {
  if (['loading', 'ready', 'running', 'paused'].includes(state.phase)) return;
  worker?.terminate(); vad?.terminate(); busy = false; inFlight = null; audioBusy = false; audioReset = false;
  ready = { stt: false, vad: false };
  metrics = { totalChunks: 0, queueWaitMs: 0, endToQueueMs: 0, sttMs: 0, vadFrames: 0, vadAvgMs: 0, vadMaxMs: 0 };
  status('loading', '모델 준비 중… 최초 다운로드 약 656 MB');
  worker = new Worker('./speech-worker.mjs', { type: 'module' });
  vad = new Worker('./speech-vad-worker.mjs', { type: 'module' });
  const sttOwner = worker, vadOwner = vad;
  const markReady = name => {
    ready[name] = true;
    if (ready.stt && ready.vad) status('ready', '음성 모델 준비 완료');
  };
  worker.onmessage = ({ data }) => {
    if (worker !== sttOwner) return;
    if (data.type === 'progress') status('loading', '모델 다운로드 중… ' + Math.round(data.loaded / 1048576) + ' MB');
    if (data.type === 'ready') markReady('stt');
    if (data.type === 'text') {
      const item = inFlight; inFlight = null; busy = false;
      if (item && data.epoch === epoch && item.epoch === epoch && state.phase === 'running') {
        if (debug) metrics.sttMs = data.ms;
        const raw = data.text || '';
        const text = item.metadata.overlap && previous && previous.sequence === item.sequence - 1
          ? withoutOverlap(raw, previous.text) : raw;
        previous = { sequence: item.sequence, text: raw };
        if (text) chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_TEXT', target: state.target, text }).catch(() => {});
        status('running', '인식 중 · ' + (data.ms / 1000).toFixed(1) + '초 처리');
      }
      drain();
    }
    if (data.type === 'error') void fail(data.message);
  };
  vad.onmessage = ({ data }) => {
    if (vad !== vadOwner) return;
    if (data.type === 'progress') status('loading', '음성 구간 모델 다운로드 중…');
    if (data.type === 'ready') markReady('vad');
    if (data.type === 'chunk') enqueue(data);
    if (data.type === 'audio-done') { audioBusy = false; pumpAudio(); }
    if (data.type === 'metrics' && debug && data.epoch === epoch) {
      metrics.vadFrames = data.frames; metrics.vadAvgMs = data.avgMs; metrics.vadMaxMs = data.maxMs;
    }
    if (data.type === 'error' && (data.epoch === undefined || data.epoch === epoch)) void fail(data.message);
  };
  worker.onerror = event => { if (worker === sttOwner) void fail(event.message || '음성 모델 실행 실패'); };
  vad.onerror = event => { if (vad === vadOwner) void fail(event.message || '음성 구간 모델 실행 실패'); };
  worker.postMessage({ type: 'prepare' });
  vad.postMessage({ type: 'prepare', debug });
}
async function fail(message) {
  worker?.terminate(); vad?.terminate(); worker = null; vad = null; busy = false; inFlight = null; audioBusy = false;
  await stop(); status('error', message);
}
async function command(message) {
  if (message.action === 'status') {
    if (debug) state.metrics = { ...metrics, droppedChunks: dropped, audioLosses, queuedChunks: pending.length };
    return state;
  }
  if (message.action === 'prepare' && !['loading', 'ready', 'running', 'paused'].includes(state.phase)) {
    debug = message.debug === true; dropped = 0; audioLosses = 0; prepare();
  }
  if (message.action === 'stop' || message.action === 'clear') {
    await stop();
    worker?.terminate(); vad?.terminate(); worker = null; vad = null; busy = false; inFlight = null; audioBusy = false;
    if (message.action === 'clear') await caches.delete(CACHE);
    status('idle', message.action === 'clear' ? '음성 모델 캐시를 삭제했습니다.' : '중지됨 · 다시 사용하려면 모델 준비를 누르세요.');
  }
  if (message.action === 'start') {
    if (state.phase !== 'ready') throw Error('먼저 음성 모델을 준비하세요.');
    dropped = 0; audioLosses = 0; clearTimeline(); state.target = message.target;
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
      worklet.port.onmessage = ({ data }) => {
        if (state.phase !== 'running' || data.epoch !== epoch) return;
        const audio = data.audio;
        if (debug && captureStart === null) captureStart = performance.now() - audio.length / 16;
        if (audioQueue.length >= MAX_AUDIO_BLOCKS) {
          dropped += pending.length + (inFlight?.epoch === epoch ? 1 : 0);
          audioLosses++; clearTimeline();
          status('running', '음성 구간 처리 지연으로 오디오 누락');
          return;
        }
        audioQueue.push(audio); pumpAudio();
      };
      worklet.port.postMessage({ type: 'reset', epoch });
      stream.getAudioTracks()[0].onended = () => { if (stream) void fail('탭 오디오 캡처가 종료되었습니다.'); };
      await context.resume(); status('running', '일본어 음성 인식 중'); pumpAudio();
    } catch (error) { await fail(String(error.message || error)); throw error; }
  }
  if (message.action === 'flush' && state.target) {
    state.target = { ...state.target, revision: message.revision };
    clearTimeline();
    status(message.paused ? 'paused' : 'running', message.paused ? '영상 일시정지' : '일본어 음성 인식 중');
    pumpAudio();
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
