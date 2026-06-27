"use strict";

const BASE64_RESULT_MESSAGE_TYPE = "nyankat-base64-decode-result";

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== BASE64_RESULT_MESSAGE_TYPE) {
    return;
  }

  if (!message.ok) {
    window.alert("NyanKatX3 Tab: 선택한 텍스트를 Base64로 디코딩할 수 없습니다.");
    return;
  }

  window.prompt(`NyanKatX3 Tab Base64 디코딩 결과 (${message.rounds}차)`, message.text);
});
