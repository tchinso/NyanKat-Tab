"use strict";
(() => {
  const select = document.querySelector('#speechVideo');
  const status = document.querySelector('#speechStatus');
  const buttons = [...document.querySelectorAll('[data-speech-action]')];
  let targets = [], timer, busy = false, scanRevision = 0, currentState;
  let translation = { phase: 'idle', message: '' };
  const command = (action, extra = {}) => chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_COMMAND', action, ...extra });
  function render(state) {
    currentState = state;
    status.textContent = (state.message || state.phase) + (translation.message ? ' · ' + translation.message : '');
    for (const button of buttons) {
      const action = button.dataset.speechAction;
      button.disabled = busy || (action === 'start' ? state.phase !== 'ready' || !targets.length || translation.phase === 'loading'
        : action === 'prepare' ? ['loading', 'running', 'paused'].includes(state.phase) || translation.phase === 'loading' || (state.phase === 'ready' && translation.phase === 'ready')
        : action === 'stop' ? state.phase === 'idle' : false);
    }
    select.disabled = ['running', 'paused', 'loading'].includes(state.phase);
  }
  function setTranslation(phase, message) {
    translation = { phase, message };
    if (currentState) render(currentState);
  }
  function prepareTranslation() {
    if (translation.phase === 'loading' || translation.phase === 'ready') return;
    setTranslation('loading', '번역 모델 준비 중… 팝업을 열어 두세요');
    try {
      if (!globalThis.Translator || typeof globalThis.Translator.create !== 'function') throw Error('번역 API를 사용할 수 없습니다');
      // A language pack download requires activation in this document. Call
      // create directly in the button handler, before any asynchronous work.
      const request = globalThis.Translator.create({ sourceLanguage: 'ja', targetLanguage: 'ko', monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => {
          if (translation.phase === 'loading' && Number.isFinite(event.loaded)) setTranslation('loading', '번역 모델 다운로드 중… ' + Math.round(event.loaded * 100) + '% · 팝업을 열어 두세요');
        });
      } });
      Promise.resolve(request).then(translator => {
        try { translator.destroy(); } catch { /* Download has already completed. */ }
        setTranslation('ready', '번역 모델 준비 완료');
      }, () => setTranslation('error', '번역 모델 준비 실패 · 다시 준비하거나 영상에서 재시도하세요'));
    } catch {
      setTranslation('error', '번역 모델 준비 실패 · 다시 준비하거나 영상에서 재시도하세요');
    }
  }
  async function refresh() {
    try { const result = await command('status'); if (result.ok) render(result.state); }
    catch (error) { status.textContent = error.message; }
  }
  async function scan() {
    const revision = ++scanRevision;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }) || [];
    const found = await Promise.all(frames.map(async frame => {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'NYANKAT_SUBTITLE_PING' }, { frameId: frame.frameId });
        return (result?.videos || []).map(video => ({ tabId: tab.id, frameId: frame.frameId, videoId: video.id, ...video }));
      } catch { return []; }
    }));
    if (revision !== scanRevision) return;
    targets = found.flat().sort((a, b) => Number(b.playing) - Number(a.playing) || b.width * b.height - a.width * a.height);
    select.replaceChildren(...targets.map((target, i) => {
      const option = document.createElement('option'); option.value = String(i);
      option.textContent = `${i + 1}. ${target.width}×${target.height}${target.playing ? ' · 재생 중' : ''}`;
      return option;
    }));
    if (!targets.length) status.textContent = '재생 페이지를 새로고침하고 동영상을 재생해 주세요.';
  }
  document.querySelector('#speechRefresh').addEventListener('click', () => { void scan().then(refresh).catch(e => { status.textContent = e.message; }); });
  buttons.forEach(button => button.addEventListener('click', async () => {
    if (busy) return;
    busy = true; buttons.forEach(b => { b.disabled = true; });
    try {
      const action = button.dataset.speechAction;
      if (action === 'prepare') prepareTranslation();
      let extra = {};
      if (action === 'start') {
        const target = targets[Number(select.value)];
        if (!target) throw Error('동영상을 선택하세요.');
        extra = { target };
      }
      const result = await command(action, extra);
      if (!result.ok) throw Error(result.error || '음성인식 작업 실패');
      busy = false; render(result.state);
    } catch (error) { busy = false; await refresh(); status.textContent = error.message; }
  }));
  document.addEventListener('nyankat-popup-tab-shown', async event => {
    if (event.detail.subtitleView === 'speech') {
      const revision = scanRevision + 1;
      await scan().catch(() => {});
      if (revision !== scanRevision) return;
      await refresh();
      if (revision === scanRevision) timer = setInterval(refresh, 1000);
    }
  });
  document.addEventListener('nyankat-popup-tab-changing', () => { scanRevision++; clearInterval(timer); });
  window.addEventListener('pagehide', () => clearInterval(timer));
})();
