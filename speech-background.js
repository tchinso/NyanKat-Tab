"use strict";
(() => {
  const page = chrome.runtime.getURL('speech-offscreen.html');
  let creating, actions = Promise.resolve();
  async function exists() {
    return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [page] })).length > 0;
  }
  async function ensure() {
    if (!creating) creating = (async () => {
      if (!await exists()) await chrome.offscreen.createDocument({ url: 'speech-offscreen.html',
        reasons: ['USER_MEDIA', 'WORKERS'], justification: 'Capture selected tab audio and recognize Japanese speech locally.' });
    })().finally(() => { creating = null; });
    await creating;
  }
  const call = (action, payload = {}) => chrome.runtime.sendMessage({ type: 'NYANKAT_SPEECH_OFFSCREEN', action, ...payload });
  async function current() { return await exists() ? call('status') : { ok: true, state: { phase: 'idle', message: '음성 모델을 준비하세요.', target: null } }; }
  function send(target, action, extra = {}) {
    return chrome.tabs.sendMessage(target.tabId, { type: 'NYANKAT_SUBTITLE_SPEECH',
      payload: { videoId: target.videoId, session: target.session, revision: target.revision || 0, action, ...extra } }, { frameId: target.frameId });
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string' || !message.type.startsWith('NYANKAT_SPEECH_') || message.type === 'NYANKAT_SPEECH_OFFSCREEN') return;
    const offscreen = sender.url === page && !sender.tab;
    const popup = sender.url === chrome.runtime.getURL('popup.html');
    const task = async () => {
      if (offscreen) {
        if (message.type === 'NYANKAT_SPEECH_TEXT' && message.target) await send(message.target, 'text', { text: String(message.text).slice(0, 8192) });
        if (message.type === 'NYANKAT_SPEECH_END' && message.target) await send(message.target, 'end').catch(() => {});
        return { ok: true };
      }
      if (message.type === 'NYANKAT_SPEECH_CONTROL' && sender.tab) {
        const { state } = await current();
        const target = state.target;
        if (!target || target.tabId !== sender.tab.id || target.frameId !== sender.frameId || target.session !== message.session) return { ok: false };
        return call(message.stop ? 'stop' : 'flush', { paused: message.paused === true, revision: message.revision });
      }
      if (!popup || message.type !== 'NYANKAT_SPEECH_COMMAND') return { ok: false };
      if (message.action === 'status') return current();
      if (!['prepare', 'start', 'stop', 'clear'].includes(message.action)) return { ok: false };
      await ensure();
      if (message.action !== 'start') return call(message.action);
      const { state } = await current();
      if (state.phase !== 'ready') throw Error('음성 모델 준비 완료 후 시작하세요.');
      const target = { ...message.target, session: crypto.randomUUID() };
      if (!Number.isInteger(target.tabId) || !Number.isInteger(target.frameId) || typeof target.videoId !== 'string') throw Error('동영상을 선택하세요.');
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
      const activated = await send(target, 'begin');
      if (!activated?.ok) throw Error('영상 페이지를 새로고침하고 다시 선택하세요.');
      const result = await call('start', { target, streamId });
      if (!result.ok) await send(target, 'end').catch(() => {});
      return result;
    };
    const result = popup && message.action !== 'status' ? actions.then(task) : task();
    if (popup && message.action !== 'status') actions = result.catch(() => {});
    result.then(respond, error => respond({ ok: false, error: String(error.message || error) }));
    return true;
  });
  async function stopTab(tabId, frameId) {
    const { state } = await current();
    if (state.target?.tabId === tabId && (frameId === undefined || state.target.frameId === frameId || frameId === 0)) await call('stop');
  }
  chrome.tabs.onRemoved.addListener(id => { void stopTab(id).catch(() => {}); });
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => { void stopTab(tabId, frameId).catch(() => {}); });
})();
