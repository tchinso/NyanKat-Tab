# Speech integration verification — 2026-11-02

Environment: Windows, Chrome 156, AMD Ryzen 5 4500U. Loaded the unpacked
extension into an isolated test browser profile using Chrome's extension debugging
protocol. The user's normal browser profile was not modified.

Verified with the production extension files:

- The fourth subtitle subtab is 음성인식, immediately after 추출·검색.
- A video in an HTTP page is found and offered in the speech selector.
- The pinned Japanese INT8 model and frontend download through the extension
  worker, enter Cache Storage, and reach the ready state inside an offscreen document.
- A subsequent run reaches ready using the cached model without downloading again.
- Invoking the extension action on the playback tab permits the service worker to
  acquire a tabCapture stream; the offscreen AudioContext consumes that stream.
- Playback of the upstream `test_ja_1.wav` through an HTML video produces Japanese
  ASR events and visible text in the existing subtitle overlay, including
  `日本語ちゃんと聞っといてますか?` and `ちゃんと聞こえてんの?`.
- Repeated playback invalidates prior work on seeking and resumes transcription.
- Stop reports the stopped state; resource teardown and rejection of stale worker
  messages are additionally covered by automated lifecycle tests.

The first browser harness used Chromium's headless shell, which does not load
extensions. Verification used full Chrome instead. Chrome's `--mute-audio` test
default was removed for the audio capture run. No fake audio or fake ASR engine
was used for that run. Models were downloaded from their pinned upstream URLs.

This fresh browser profile did not have a Japanese→Korean translation model
prepared. Live verification therefore covered the Japanese fallback display.
Japanese→Korean requests, streamed Korean display, style reuse, and stale-result
handling were verified with the existing translation port test harness. Downloading
the native translation model still requires the playback-page preparation button.

Remaining quality limits: amplitude-based segmentation is affected by music;
short/chopped phrases can be misrecognized. This run does not establish long-run
accuracy, memory stability, or compatibility with every streaming site. The original
13-second model benchmark and model attribution are documented in
`tools/speech-probe/README.md`.
