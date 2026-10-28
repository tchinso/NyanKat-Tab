"use strict";

globalThis.NyanKatQR = (() => {
  const pendingTabs = new Set();
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_PIXELS = 32 * 1024 * 1024;

  function webUrl(text) {
    const value = text.trim();
    if (/\s/.test(value)) return "";
    const candidate = /^https?:\/\//i.test(value) ? value :
      /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value) ? "https://" + value : "";
    try {
      const url = new URL(candidate);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch {
      return "";
    }
  }

  function decodePixels(data, width, height) {
    // RGBLuminanceSource expects luminance bytes, not an RGBA byte array.
    const luminance = new Uint8ClampedArray(width * height);
    for (let i = 0; i < luminance.length; i++) {
      const offset = i * 4;
      const alpha = data[offset + 3] / 255;
      luminance[i] = ((data[offset] + 2 * data[offset + 1] + data[offset + 2]) / 4) * alpha + 255 * (1 - alpha);
    }
    const source = new ZXing.RGBLuminanceSource(luminance, width, height);
    const hints = new Map([[ZXing.DecodeHintType.TRY_HARDER, true]]);
    for (const input of [source, source.invert()]) {
      for (const Binarizer of [ZXing.HybridBinarizer, ZXing.GlobalHistogramBinarizer]) {
        try {
          return new ZXing.QRCodeReader().decode(new ZXing.BinaryBitmap(new Binarizer(input)), hints).getText();
        } catch (error) {
          if (!(error instanceof ZXing.NotFoundException || error instanceof ZXing.ChecksumException ||
                error instanceof ZXing.FormatException)) throw error;
        }
      }
    }
    throw new Error("이미지에서 QR코드를 인식하지 못했습니다.");
  }

  async function decodeImage(srcUrl) {
    if (!/^(https?:|data:image\/)/i.test(srcUrl || "")) {
      throw new Error("이 이미지 주소는 읽을 수 없습니다. 이미지를 HTTP(S) 페이지에서 열어 다시 시도해 주세요.");
    }
    let bitmap;
    try {
      const response = await fetch(srcUrl, { credentials: "omit", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("이미지를 불러오지 못했습니다 (HTTP " + response.status + ").");
      if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("이미지가 너무 큽니다 (최대 20MB).");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error("이미지가 너무 큽니다 (최대 20MB).");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      bitmap = await createImageBitmap(new Blob(chunks));
      if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error("이미지 해상도가 너무 큽니다 (최대 32MP).");
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      return decodePixels(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
    } finally {
      bitmap?.close();
    }
  }

  async function showResult(tab, frameId, result) {
    let current;
    try { current = await chrome.tabs.get(tab.id); }
    catch { return; } // Closing the source tab cancels its result UI.
    if (current.url === tab.url && !current.pendingUrl) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "nyankat-qr-decode-result", ...result },
          { frameId: Number.isInteger(frameId) ? frameId : 0 });
        return;
      } catch {
        // Image-only documents and tabs opened before installation may have no receiver.
      }
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL("qr-result.html") + "#" +
      encodeURIComponent(JSON.stringify(result)) });
  }

  async function handleClick(info, tab) {
    if (pendingTabs.has(tab.id)) return;
    pendingTabs.add(tab.id);
    try {
      const text = await decodeImage(info.srcUrl);
      const url = webUrl(text);
      if (url) {
        // Do not replace an unrelated page if the user navigated during the fetch.
        const current = await chrome.tabs.get(tab.id);
        if (current.url === tab.url && !current.pendingUrl) await chrome.tabs.update(tab.id, { url });
        else await chrome.tabs.create({ url });
      } else {
        await showResult(tab, info.frameId, { ok: true, text });
      }
    } catch (error) {
      const errorText = /[가-힣]/.test(error.message) ? error.message :
        "이미지를 읽을 수 없습니다. 연결 상태와 이미지 접근 권한을 확인해 주세요.";
      await showResult(tab, info.frameId, { ok: false, error: errorText }).catch(() => {});
    } finally {
      pendingTabs.delete(tab.id);
    }
  }

  return { webUrl, decodePixels, decodeImage, handleClick };
})();
