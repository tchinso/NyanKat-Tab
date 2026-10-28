"use strict";

(() => {
  const MAX_DICTIONARY_CHARS = 65536;
  const MAX_ENTRIES = 1000;

  function escapePattern(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function compile(dictionaryText) {
    const source = String(dictionaryText == null ? "" : dictionaryText).replace(/\r\n?/g, "\n");
    const errors = [];
    const rules = new Map();
    let bounded = source;
    if (source.length > MAX_DICTIONARY_CHARS) {
      // Never interpret a truncated final line as a replacement rule.
      const lastNewline = source.lastIndexOf("\n", MAX_DICTIONARY_CHARS - 1);
      bounded = lastNewline < 0 ? "" : source.slice(0, lastNewline);
      errors.push({ line: null, reason: "too-large", message: "치환 목록은 최대 65,536자입니다." });
    }
    for (const [index, line] of bounded.split("\n").entries()) {
      if (!line.trim()) continue;
      const separator = line.indexOf("=");
      const output = separator < 0 ? "" : line.slice(0, separator).trim();
      if (!output) {
        errors.push({ line: index + 1, reason: "invalid-rule", message: "출력=수정출력 형식에서 출력이 비어 있지 않아야 합니다." });
        continue;
      }
      if (rules.size >= MAX_ENTRIES && !rules.has(output)) {
        errors.push({ line: index + 1, reason: "too-many-entries", message: "치환 규칙은 최대 1,000개입니다." });
        continue;
      }
      rules.set(output, line.slice(separator + 1).trim());
    }
    // A literal alternation gives leftmost, longest matching. String.replace
    // scans only the original input: replacement text cannot trigger another
    // rule, and callback results preserve literal '$&', '$1', and '=' characters.
    const outputs = [...rules.keys()].sort((first, second) => second.length - first.length);
    const pattern = outputs.length ? new RegExp(outputs.map(escapePattern).join("|"), "gu") : null;
    return {
      count: rules.size,
      errors,
      dictionary: [...rules].map(([output, replacement]) => output + "=" + replacement).join("\n"),
      apply(text) {
        const input = String(text == null ? "" : text);
        return pattern ? input.replace(pattern, matched => rules.get(matched)) : input;
      }
    };
  }

  window.NyanKatSubtitlePostprocess = { compile, MAX_DICTIONARY_CHARS, MAX_ENTRIES };
})();
