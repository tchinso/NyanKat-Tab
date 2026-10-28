"use strict";
try {
  const result = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  history.replaceState(null, "", location.pathname);
  document.getElementById("status").textContent = result.ok ? "인식한 내용을 복사할 수 있습니다." : result.error;
  if (result.ok) {
    const output = document.getElementById("result");
    output.hidden = false;
    output.value = result.text;
    output.select();
  }
} catch {
  document.getElementById("status").textContent = "결과를 표시할 수 없습니다. 다시 시도해 주세요.";
}
