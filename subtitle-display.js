"use strict";

(() => {
  const DEFAULT_OPTIONS = Object.freeze({ showOriginal: false, hideSoundEffects: false, hideSpeakers: false });
  const SOUND_LABEL = /^(?:(?:.*?)(?:音|声|ため息|笑い|笑い声|泣き声|悲鳴|咳|咳払い|拍手|歓声|鼻歌|舌打ち|いびき|あくび|くしゃみ|うめき|ノック|チャイム|ベル|着信|音楽)|(?:.+?\s)?(?:박수|한숨|웃음|웃음소리|울음|울음소리|비명|기침|발소리|문소리|효과음|음악|전화벨|노크)(?:\s*소리)?|(?:\w+[ '’-])*?(?:laughs?|laughing|laughter|sighs?|sighing|gasps?|gasping|sobs?|sobbing|crying|screams?|screaming|coughs?|coughing|applause|cheering|footsteps|knocking|ringing|music|door (?:opens?|closes?)|phone rings?)|BGM)$/iu;
  const SPEAKER_ROLE = /^(?:男の子|女の子|男性|女性|男子|女子|子供|お母さん|お父さん|ナレーション|남자|여자|소년|소녀|아이|엄마|아빠|해설|내레이터|man|woman|boy|girl|narrator|speaker(?:\s*\d+)?)$/iu;

  function normalizeOptions(value) {
    return Object.fromEntries(Object.keys(DEFAULT_OPTIONS).map(key => [key, value?.[key] === true]));
  }

  function isSpeaker(value, allowHangul = false) {
    return SPEAKER_ROLE.test(value) || /^[A-Z][A-Z\d .’'-]{0,30}$/.test(value) ||
      /^[\p{Script=Han}\p{Script=Katakana}ー・々]{1,16}$/u.test(value) || (allowHangul && /^[가-힣]{2,4}$/.test(value));
  }

  function filterText(text, options = DEFAULT_OPTIONS) {
    if (!options.hideSoundEffects && !options.hideSpeakers) return String(text || "");
    return String(text || "").split(/\r?\n/).map(line => {
      let value = line;
      if (options.hideSoundEffects) {
        value = value.replace(/\[([^\]\n]{1,100})\]|\(([^)\n]{1,100})\)|（([^）\n]{1,100})）/g,
          (whole, square, round, full) => SOUND_LABEL.test((square || round || full).trim()) ? "" : whole);
      }
      if (options.hideSpeakers) {
        value = value.replace(/^(\s*[-–—]?\s*)(?:\[([^\]\n]{1,32})\]|\(([^)\n]{1,32})\)|（([^）\n]{1,32})）)\s*(?=\S)/,
          (whole, prefix, square, round, full) => isSpeaker((square || round || full).trim()) ? prefix : whole);
        value = value.replace(/^(\s*[-–—]?\s*)([^:：\n]{1,32})[:：]\s*/,
          (whole, prefix, name) => isSpeaker(name.trim(), true) ? prefix : whole);
      }
      return value.trim();
    }).filter(Boolean).join("\n");
  }

  function calibrate(first, second) {
    const points = [first, second];
    if (points.some(point => !point || !Number.isFinite(point.subtitleTime) || !Number.isFinite(point.videoTime) ||
      point.subtitleTime < 0 || point.videoTime < 0)) throw new Error("두 지점의 자막 시간과 영상 시간을 확인해 주세요.");
    const subtitleSpan = second.subtitleTime - first.subtitleTime;
    const videoSpan = second.videoTime - first.videoTime;
    if (subtitleSpan < 1 || videoSpan < 1) throw new Error("둘째 지점은 첫 지점보다 뒤의 다른 대사를 골라 주세요.");
    const syncRate = subtitleSpan / videoSpan;
    const offsetMs = (first.videoTime - first.subtitleTime / syncRate) * 1000;
    if (syncRate < 0.1 || syncRate > 10 || Math.abs(offsetMs) > 3600000) {
      throw new Error("보정 범위를 벗어났습니다. 선택한 두 대사와 영상 시점을 확인해 주세요.");
    }
    return { syncRate, offsetMs };
  }

  window.NyanKatSubtitleDisplay = { DEFAULT_OPTIONS, normalizeOptions, filterText, calibrate };
})();
