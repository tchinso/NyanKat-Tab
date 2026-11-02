# 1.6.1 release verification — 2026-11-02

## Automated verification

- Full Node suite: 414 / 414 passing.
- Runtime syntax: all 46 root JavaScript / MJS files pass `node --check`.
- `git diff --check`: passing.
- Web Store package: `dist/NyanKatTab-1.6.1.zip`, version 1.6.1, 97 files, 9,735,060 bytes.
- Package SHA-256: `b2d8198e1cb47dc81bef7806844f06cca9f406051990ff88dfd380928ab1ff0d`.
- Build verification checks ZIP integrity, manifest and HTML dependencies, and exclusion of README / Markdown, tests, scripts, tools, source maps, ICO files, and model files. Required license notices remain included.

## Browser smoke verification

Executed with Google Chrome 156.0.8078.76, headless, a dedicated temporary profile, Playwright over CDP, and `Extensions.loadUnpacked`. The installed Playwright Chromium 151 binary could not launch because of a Windows side-by-side configuration error; installed Chrome was used successfully instead.

Passed against the actual extension pages and content scripts:

1. Selecting Korean hides the translation-settings container; selecting Japanese shows it.
2. Preprocessing and postprocessing buttons open the same dictionary dialog and focus their respective textareas.
3. Saving both dictionaries persists both values; reopening restores them; deleting saved dictionaries clears both values together.
4. The permanent sync-menu checkbox persists across popup reload.
5. On a local HTTP video fixture, permanently hiding the sync menu hides its controls; changing the saved setting updates an already loaded overlay immediately.
6. The episode-only hide button hides the controls. A subsequent `loadedmetadata` event restores them. The permanent hide setting still wins after that event.
7. The shared dictionary runtime loads successfully in the popup, subtitle translation host, and content overlay; subtitle loading through the real extension messaging path succeeds.
8. No JavaScript page errors were recorded in these scenarios.

The local fixture exercises DOM, extension messaging, storage propagation, and the episode-reset event; its `loadedmetadata` event is dispatched by the test. It does not validate video decoding or a real streaming service's episode transitions. AI model downloads and external-site tests were not repeated.

## Additional feature review

Background routing, link previews, drag translation and its model host/settings, new-tab navigation, and YouTube handling were reviewed. Added regressions cover delayed startup storage responses overriding newer settings in link previews, drag translation, and YouTube. YouTube now waits for its saved setting before resetting playback. The related final targeted suite passed all 16 tests; the broader pre-change review suite passed 28 tests.

## Storage quota adjustment

The shared dictionary budget is now 10 KiB (10,240 UTF-8 bytes); the translation cache budget is 3 MB (3,000,000 bytes). Popup labels, backup/import validation and cache request validation use these limits. The full 414-test suite passed again and the 1.6.1 ZIP was rebuilt and integrity-checked. Browser smoke results above were reused because this follow-up changes quotas and labels only.

## Subtitle action placement

Moved Apply/Remove subtitle buttons immediately above subtitle sync. Verified unique button IDs and document order; popup/startup tests passed 51/51. Reused the previous full-suite results for this HTML-only move. Rebuilt and integrity-checked the ZIP.

Shortened sync visibility labels to “이번 화 싱크 버튼 숨기기” and “재생화면 싱크 버튼 항상 숨기기”. Verified both strings inside the rebuilt ZIP; reused behavior tests because only labels changed.
