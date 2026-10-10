"use strict";

const preview = document.querySelector("#preview");
const rawUrl = new URL(location.href).searchParams.get("url");

try {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Unsupported preview URL");
  }
  preview.src = url.href;
} catch {
  document.body.textContent = "이 링크는 미리볼 수 없습니다.";
}

preview.addEventListener("load", () => {
  parent.postMessage({ type: "NYANKAT_LINK_PREVIEW_LOADED" }, "*");
});
