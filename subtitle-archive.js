"use strict";

(() => {
  const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  const MAX_ENTRIES = 1024;
  const subtitleName = /\.(?:srt|vtt|ass|ssa|smi|sami|sub|txt)$/i;
  const crcTable = Uint32Array.from({ length: 256 }, (_, number) => {
    for (let bit = 0; bit < 8; bit++) number = (number >>> 1) ^ ((number & 1) ? 0xedb88320 : 0);
    return number >>> 0;
  });

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function fail(message) { throw new Error(message); }

  function readName(bytes, flags, extra) {
    const decode = (encoding, value) => new TextDecoder(encoding, { fatal: true }).decode(value);
    if (flags & 0x800) return decode("utf-8", bytes);
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    for (let offset = 0; offset + 4 <= extra.length;) {
      const id = view.getUint16(offset, true), size = view.getUint16(offset + 2, true);
      if (offset + 4 + size > extra.length) fail("ZIP 부가 정보가 손상되었습니다.");
      if (id === 0x7075 && size >= 5 && extra[offset + 4] === 1 && view.getUint32(offset + 5, true) === crc32(bytes)) {
        return decode("utf-8", extra.subarray(offset + 9, offset + 4 + size));
      }
      offset += 4 + size;
    }
    return new TextDecoder("euc-kr").decode(bytes);
  }

  function open(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length > MAX_ARCHIVE_BYTES) fail("ZIP은 32 MiB 이하만 열 수 있습니다.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
      if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === bytes.length) {
        end = index;
        break;
      }
    }
    if (end < 0) fail("올바른 ZIP 파일이 아닙니다.");
    const count = view.getUint16(end + 10, true);
    const directorySize = view.getUint32(end + 12, true);
    const directoryOffset = view.getUint32(end + 16, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
      fail("분할 ZIP과 ZIP64는 지원하지 않습니다.");
    }
    if (count > MAX_ENTRIES) fail("ZIP에 파일이 너무 많습니다 (최대 1,024개).");
    if (directoryOffset + directorySize > end) fail("ZIP 파일 목록이 손상되었습니다.");
    const entries = [];
    let offset = directoryOffset, total = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > directoryOffset + directorySize || view.getUint32(offset, true) !== 0x02014b50) fail("ZIP 파일 목록이 손상되었습니다.");
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
      const crc = view.getUint32(offset + 16, true), compressedSize = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
      const nameSize = view.getUint16(offset + 28, true), extraSize = view.getUint16(offset + 30, true), commentSize = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const next = offset + 46 + nameSize + extraSize + commentSize;
      if (next > directoryOffset + directorySize || view.getUint16(offset + 34, true) !== 0 || [size, compressedSize, localOffset].includes(0xffffffff)) fail("지원하지 않거나 손상된 ZIP입니다.");
      total += size;
      if (total > MAX_TOTAL_BYTES) fail("압축 해제 크기가 64 MiB를 초과합니다.");
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize);
      const name = readName(nameBytes, flags, bytes.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize));
      if (subtitleName.test(name) && !name.endsWith("/")) {
        if (/\0|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(name) || /^[\\/]|^[a-z]:/i.test(name)) fail("안전하지 않은 ZIP 파일명입니다.");
        entries.push(Object.freeze({ id: index, name, size, compressedSize, method, flags, crc, localOffset,
          unavailable: flags & (1 | 64) ? "암호화된 파일" : ![0, 8].includes(method) ? "지원하지 않는 압축 방식" : size > MAX_FILE_BYTES ? "8 MiB 크기 제한 초과" : "" }));
      }
      offset = next;
    }
    if (offset !== directoryOffset + directorySize) fail("ZIP 파일 목록 크기가 일치하지 않습니다.");

    async function extract(id) {
      const entry = entries.find(item => item.id === id);
      if (!entry || entry.unavailable) fail(entry?.unavailable || "자막 파일을 선택하세요.");
      const start = entry.localOffset;
      if (start + 30 > directoryOffset || view.getUint32(start, true) !== 0x04034b50 || view.getUint16(start + 6, true) !== entry.flags || view.getUint16(start + 8, true) !== entry.method) fail("ZIP 파일 헤더가 손상되었습니다.");
      const nameSize = view.getUint16(start + 26, true), extraSize = view.getUint16(start + 28, true);
      const dataOffset = start + 30 + nameSize + extraSize;
      if (dataOffset + entry.compressedSize > directoryOffset) fail("ZIP 파일 내용이 잘렸습니다.");
      const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
      let output;
      if (entry.method === 0) {
        if (compressed.length !== entry.size) fail("ZIP 파일 크기가 일치하지 않습니다.");
        output = compressed.slice();
      } else {
        let compressedOffset = 0;
        const source = new ReadableStream({ pull(controller) {
          if (compressedOffset >= compressed.length) { controller.close(); return; }
          controller.enqueue(compressed.subarray(compressedOffset, compressedOffset + 4096));
          compressedOffset += 4096;
        } });
        const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > entry.size || length > MAX_FILE_BYTES) fail("압축 해제 크기 제한을 초과했습니다.");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        if (length !== entry.size) fail("ZIP 파일 크기가 일치하지 않습니다.");
        output = new Uint8Array(length);
        let cursor = 0;
        for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length; }
      }
      if (crc32(output) !== entry.crc) fail("ZIP 파일의 무결성 검사에 실패했습니다.");
      return output;
    }
    return Object.freeze({ entries: Object.freeze(entries), extract });
  }

  window.NyanKatSubtitleArchive = Object.freeze({ open, MAX_ARCHIVE_BYTES, MAX_FILE_BYTES });
})();
