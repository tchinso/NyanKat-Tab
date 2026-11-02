"use strict";

(() => {
  const MAX_BYTES = 10 * 1024;
  function byteLength(value) {
    let bytes = 0;
    for (const char of String(value ?? "")) {
      const code = char.codePointAt(0);
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
  }
  const validateSize = (pre, post) => byteLength(pre) + byteLength(post) <= MAX_BYTES;

  // Avoid regex engine size limits for large dictionaries. Match only original
  // text, keeping leftmost-longest and non-cascading replacement semantics.
  function matcher(rules, wordBoundaries) {
    const root = new Map();
    const latin = /^[\p{Script=Latin}\d\s'’.-]+$/u;
    const wordBefore = /[\p{L}\p{N}_]$/u;
    const wordAfter = /^[\p{L}\p{N}_]/u;
    // Compress shared paths: a multi-megabyte term must not allocate one Map
    // per character. Each edge stores a string and branches only when needed.
    for (const [term, replacement] of rules) {
      let children = root, remaining = term;
      const rule = { replacement, boundary: wordBoundaries && latin.test(term) };
      while (remaining) {
        const key = remaining[0];
        let node = children.get(key);
        if (!node) {
          children.set(key, { edge: remaining, children: new Map(), rule });
          break;
        }
        let shared = 0;
        while (shared < remaining.length && shared < node.edge.length && remaining[shared] === node.edge[shared]) shared++;
        if (shared < node.edge.length) {
          const branch = { edge: node.edge.slice(0, shared), children: new Map(), rule: null };
          node.edge = node.edge.slice(shared);
          branch.children.set(node.edge[0], node);
          children.set(key, branch);
          node = branch;
        }
        remaining = remaining.slice(shared);
        if (!remaining) node.rule = rule;
        children = node.children;
      }
    }
    return value => {
      const text = String(value ?? "");
      const output = [];
      for (let start = 0; start < text.length;) {
        let children = root, match = null, end = start, index = start;
        while (index < text.length) {
          const node = children.get(text[index]);
          if (!node || !text.startsWith(node.edge, index)) break;
          index += node.edge.length;
          const splitsSurrogate = index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);
          if (node.rule && !splitsSurrogate && (!node.rule.boundary ||
              (!wordBefore.test(text.slice(Math.max(0, start - 2), start)) && !wordAfter.test(text.slice(index, index + 2))))) {
            match = node.rule;
            end = index;
          }
          children = node.children;
        }
        const next = match ? end : start + (text.codePointAt(start) > 0xffff ? 2 : 1);
        output.push(match ? match.replacement : text.slice(start, next));
        start = next;
      }
      return output.join("");
    };
  }

  function compile(value, preprocessing = false) {
    const source = String(value ?? "").replace(/\r\n?/g, "\n");
    const errors = [];
    const rules = new Map();
    if (byteLength(value) > MAX_BYTES) {
      errors.push({ line: null, reason: "too-large", message: "전처리·후처리 사전은 합계 10 KiB까지 저장할 수 있습니다." });
    } else {
      for (const [index, line] of source.split("\n").entries()) {
        if (!line.trim() || (preprocessing && line.trimStart().startsWith("#"))) continue;
        const separator = line.indexOf("=");
        const term = separator < 0 ? "" : line.slice(0, separator).trim();
        const replacement = separator < 0 ? "" : line.slice(separator + 1).trim();
        if (!term || (preprocessing && !replacement)) {
          errors.push({ line: index + 1, reason: "invalid-rule", message: preprocessing
            ? "원문=원하는 한국어 표기 형식으로 양쪽을 입력하세요."
            : "출력=수정출력 형식에서 출력이 비어 있지 않아야 합니다." });
        } else rules.set(term, replacement);
      }
    }
    const entries = preprocessing
      ? [...rules].sort(([a], [b]) => b.length - a.length || a.localeCompare(b)) : [...rules];
    return { count: rules.size, errors,
      dictionary: entries.map(([term, replacement]) => term + "=" + replacement).join("\n"),
      apply: rules.size ? matcher(rules, preprocessing) : value => String(value ?? "") };
  }
  window.NyanKatSubtitleDictionary = { MAX_BYTES, byteLength, validateSize, compile };
})();
