# NyanKatX3 Tab

Current release: **1.6.2**.

Chrome MV3 extension for:

- replacing the new tab page with `https://fav.ju.mp/`
- optionally leaving new tabs on the extension's blank page with **새 탭을 Favorites로 이동하지 않음** in **기본**
- falling back from `https://fav.ju.mp/` to `https://12tw.pages.dev/`, then to `https://tchinso.github.io/fav/` when navigation fails
- sending a `0` key event after YouTube watch pages load
- decoding selected Base64 text from the `NyanKatX3 Tab` right-click menu, including up to three nested Base64 layers
- decoding image QR codes locally with bundled ZXing JavaScript 0.23.0 from the image right-click menu; HTTP(S) results open immediately in the current tab, while other content is shown as copyable text. Bare domain names use HTTPS. If the source tab has navigated during decoding, the URL opens in a new tab instead. HTTP(S) and image data URLs are supported (20MB / 32MP limit); inaccessible, blob, and unrecognized images show an error. No additional permissions or runtime CDN code are needed.
- automatically decoding detected Base64 text on `kone.gg`, with nested decoding, clickable links, copy buttons, and original text reveal
- showing floating auto-scroll buttons with configurable opacity and site exclusions
- previewing links in a movable popup after a long click, long hover, or link drag
- translating dragged text selections into Korean when the drag ends with the browser's Language Detector and Translator APIs
- downloading detected soft subtitles and searching online under **자막 → 추출·검색**
- applying local subtitles to videos under **자막 → 오버레이**, with timing offset and playback-rate correction
- streaming subtitle translation into Korean using the browser's on-device Translator API, with a saved literal postprocessing dictionary
- saving every subtitle display option, including built-in/installed fonts, text spacing, gradient fills, outlines, backgrounds, and shadows, with up to 20 named style presets
- unlocking disabled `button` elements, closing newly opened tooltips and the Kiosk support popup, and showing detected `B/s)` download status text from `kio.ac` in the extension page `kiodownload.html`
- persisting the YouTube, kone.gg decoder, and floating scroll settings across browser restarts

Version **1.5.5** reorganizes settings and expands subtitle synchronization:

- The Basic tab follows the requested action order. Floating-scroll settings can show a red center drag handle that shares the buttons' opacity without changing their layout; the old position-mode action is removed.
- **자막** now contains **오버레이**, **스타일**, and **추출·검색**. Overlay timing adds a rate input, fine adjustments, reset, and six FPS presets, while preserving the offset and pending edits across tab changes.
- Both auto-scroll speeds keep moving on pages and panels with smooth-scroll CSS. Internal element focus changes no longer cancel auto-scroll.
- Cloudflare verification frames retain native fetch behavior without the subtitle probe, keeping their CSP checks out of the extension's fetch observer.

Version **1.5.4** fixes edge cases in playback, translation, previews, and settings:

- YouTube's load event and fallback timer reset playback only once per visit.
- Subtitle loading recognizes BOM-less UTF-16LE/BE and SRT separators containing spaces or tabs. Reapplying subtitles reconnects layout observers, rapid timing adjustments preserve pending input, and interrupted translations return to the original cue.
- Redirected subtitle manifests keep their final URL so relative segments resolve correctly. Leaving the extraction tab stops pending polling startup, and older list responses cannot replace newer results.
- Selected-text translation ignores model progress and failures belonging to an earlier selection.
- Long-click previews suppress navigation even after a prolonged hold, and hover previews do not start while dragging. Losing window focus cancels pending gestures.
- Scroll settings save only edited values, preserving button positions and unrelated settings changed elsewhere. Failed saves remain visible and are retried with the next edit.

Version **1.5.3** keeps five upcoming subtitle cues queued for translation while giving the visible cue priority, adds up to 20 saved subtitle styles, removes the redundant subtitle visibility checkbox, and loads subtitle and extraction code when those tabs are opened to reduce the popup's first-launch work.

Version **1.5.2** reorders the Basic tab actions, starts translation when a text drag ends without requiring a hover, and fixes repeated YouTube visits, Base64 decoding on changing page text, overlapping subtitle cues, failed setting saves and imports, and canceled fallback navigations.

Version **1.5.1** makes the drag-hover translation panel compact and movable, enables translation when its use button is pressed, prepares detection and the selected translation pair from one button, adds portable JSON settings backup, and translates five upcoming subtitle cues ahead of playback.

Version **1.5.0** adds link previews and on-device selected-text translation. Link previews support three gestures, a five-button toolbar, and an optional outside-click close action. Translation model setup opens inside the active page so model downloads start from a direct click in the extension frame.

Version **1.3.4** refreshes kio.ac download detection every two seconds and lets each open download-status page request a fresh scan. When the detected `B/s)` count falls from a positive value to zero and stays there for one second, each open status page plays an approximately two-second chime generated with Web Audio. If the browser blocks automatic sound, click **완료음 켜기** on each status page to enable it.

## Permissions

- `contextMenus`: adds the `NyanKatX3 Tab > Base64 해독` menu for selected page text and `이 QR코드 해독` for images.
- `storage`: saves the popup and floating-scroll settings, and keeps the temporary kio.ac detection snapshot in session storage.
- `fontSettings`: lists fonts installed on the PC for the subtitle font selector.
- `webNavigation`: detects failed top-level navigations to the primary and first fallback URLs.
- `webRequest`: observes subtitle/manifest response URLs in the current tab, including embedded players and worker requests. It does not intercept video bodies.
- `downloads`: saves validated subtitle files after the user presses **다운로드**.
- `declarativeNetRequest`: while a link preview is open, removes frame-blocking response headers from subframe responses in that tab so linked pages can load and navigate inside the popup. The temporary rule is removed when the popup closes or the tab navigates.
- `host_permissions` for HTTP(S): reads discovered subtitle files, subtitle manifests, and images explicitly selected for QR decoding from their origins.
- `content_scripts.matches` for `https://www.youtube.com/*`: runs the YouTube watch-page helper.
- `content_scripts.matches` for `https://kone.gg/*` and `https://*.kone.gg/*`: runs the automatic Base64 decoder only on kone.gg pages.
- `content_scripts.matches` for `https://kio.ac/*` and `https://*.kio.ac/*`: unlocks disabled buttons, resets newly opened tooltip triggers, and detects `B/s)` text only on kio.ac pages.
- `content_scripts.matches` for `http://*/*` and `https://*/*`: displays the local Base64 decode result in the selected frame. The floating auto-scroll buttons are shown once in the top-level page on configured hosts or sites covered by the default scroll setting.

No `tabs`, `scripting`, `activeTab`, `clipboardWrite`, `notifications`, or remote-code permissions are requested. Subtitle discovery and parsing run locally; downloading only requests the discovered resources from their original sites/CDNs. Subtitle bodies are kept in a bounded page-memory cache, and temporary discovery metadata is kept in extension session storage. Nothing is uploaded to a separate extraction service.

Subtitle probing skips Cloudflare verification documents on `challenges.cloudflare.com` and its subdomains. Their native requests and CSP checks remain untouched, so their `data:,` connectivity tests are not attributed to the subtitle fetch observer.

## Link preview and selected-text translation

In **기본**, open **링크 미리보기 설정** below the kio.ac download-status button. Choose one activation gesture: long click, long hover, or link drag. Long-click and long-hover delays are saved in 50 ms steps. The preview toolbar groups **고정**, **확대**, **축소**, **최대화**, and **닫기** at the top. The close button is always available; closing by clicking outside is optional. **최대화** fills the page viewport rather than entering browser fullscreen. The popup can also be moved or resized.

In **기본**, **드래그 번역 켜기** enables translation and opens a compact setup popup inside the current HTTP(S) web page. Drag its top handle to uncover page content, and scroll inside the popup for the model controls. Choose a source language and click **번역 준비** to prepare both browser models in one action. Selecting text with a mouse drag opens a Korean translation tooltip when the drag ends. If a newly detected language needs a model, the tooltip offers a direct preparation button. Both APIs run in a browser extension frame inside the tab; selected text is not sent to Google Translate. API availability depends on the browser's model and policy state, which the setup popup reports.

In **기본**, **설정 내보내기** saves the persistent options, subtitle style, display options, source glossary, and postprocessing dictionary as JSON; **설정 불러오기** restores them. Translation cache and work-specific track history stay on this device. A PC-installed subtitle font is omitted from the file, and importing keeps the receiving PC's current font choice. Built-in extension font choices can be transferred.

## Soft-subtitle downloads

Reload the extension and the playback page after upgrading. Open the site's player, enable its subtitles, then open **자막 → 추출·검색** in the extension. The list updates while that subtab is open; **자막 다시 검색** also checks all player frames. Select a language and press **다운로드** to choose where to save the file. Reading and saving run in the background worker, so closing the popup does not cancel an already requested download.

The engine observes HTML tracks, loaded native cues, player configuration/JSON, fetch/XHR responses, caption Blobs, renderer messages, and streaming manifests. It handles ordinary and nested player frames, shadow roots, opaque URLs, and CDN responses with misleading MIME types. Known chapter/storyboard/thumbnail tracks and non-subtitle bodies are excluded. No host-specific allowlist is used.

- Direct VTT, SRT, ASS/SSA, TTML/DFXP, SMI/SAMI and SBV files retain their original text, including ASS styling. Timed JSON is exported to VTT.
- Complete HLS WebVTT subtitle playlists are gathered in playlist order and exported to one VTT with timestamp-map alignment and duplicate removal.
- DASH text adaptations can expose direct files or finite plain-text subtitle segments. Selected representations are gathered into VTT.
- Native cue exports explicitly show **로드된 구간만** when completeness cannot be established. Those files include `loaded-cues` in their names.
- Live/sliding playlists, encrypted streams, byte-range tracks, and subtitles in binary MP4 initialization/fragment streams are rejected rather than saved as a complete subtitle. Burned-in subtitles/OCR are outside this feature.

Each fetched resource is limited to 4 MiB; gathered subtitles are limited to 24 MiB. The engine validates timed content before saving, retries transient CDN errors, preserves the originating player context when reading captions, and clears stale discoveries on navigation. Sites that block a request may require enabling the desired caption language so the player loads it first.

Run the automated checks with `node --test`. See the [1.3.3 installed-extension verification](tests/fixtures/subtitle-sites/verification-2026-10-10.md) for extraction, actual downloads, native Korean overlays, and the remaining live-site limits across ten sites. Earlier [mechanism observations](tests/fixtures/subtitle-sites/README.md) document the sanitized player structures.

## Japanese speech subtitles

Open **자막 → 음성인식** (to the right of **추출·검색**), select a video,
press **음성·번역 모델 준비**, and wait for preparation to finish before pressing
**시작**. Keep the popup open until the browser's Japanese-to-Korean translation
model is ready. The first speech preparation downloads approximately 656 MB into the extension's
Cache Storage. Subsequent preparations reuse that cache. **중지** releases the
capture and model worker; **모델 캐시 삭제** also removes downloaded speech models.
The popup can close while recognition continues.

The fixed pipeline is Japanese Parakeet 0.6B INT8 CTC → Japanese text → the existing
browser Translator API → Korean overlay. If the browser cannot prepare translation
from the popup, retry there or click **번역 모델 준비** in the frame shown over the playback page. Japanese is
shown while translation is unavailable. Existing subtitle styles and the Korean
postprocessing dictionary apply. Starting speech replaces the selected video's
file subtitles; applying a subtitle file stops speech recognition for that video.

The extension captures all audio in the selected tab, not an isolated video track.
Only one tab can be recognized at a time. Pausing clears queued speech; resuming
restarts segmentation. Seeks discard stale audio and translation results. Closing
or navigating the target page stops capture. Silero VAD uses a 0.20 speech
threshold, a 0.2-second minimum unpadded speech span, and a 0.25-second
speech-end delay, and detects speech in a
separate worker while Parakeet processes completed segments. Both use local
single-threaded WASM SIMD; audio is not uploaded. The bounded recognition queue
discards its oldest waiting segment if it fills and reports the loss in the status.
Background music and model errors can still affect detection and transcription.
Segment collection, inference, and translation introduce delay.
Speech subtitles are processed in order, with each completed translation shown for
at least 0.5 seconds before the next one. Up to 24 recognized results can wait;
if that queue fills, the oldest waiting result is discarded. Rapid dialogue can
therefore make subtitles lag behind playback.

For optional diagnostics, stop recognition, open the extension offscreen
document's DevTools console, and run
`chrome.runtime.sendMessage({type:'NYANKAT_SPEECH_OFFSCREEN',action:'prepare',debug:true})`.
After starting recognition normally, query
`chrome.runtime.sendMessage({type:'NYANKAT_SPEECH_OFFSCREEN',action:'status'})`.
The returned `state.metrics` contains VAD frame count, mean and maximum inference
time, the estimated speech-end-to-queue delay, most recent Parakeet inference and
queue wait times, total and currently queued chunks, dropped chunks, and audio
losses. Times are in milliseconds. Diagnostics are disabled by default and are
reset when models are prepared again; the end-to-queue time is an estimate based
on the capture timeline, not a measurement of subtitle display or translation.

`tabCapture` and `offscreen` permissions support capture after an explicit start;
the local WASM runtime requires `wasm-unsafe-eval` in the extension CSP. Capture
plays the original tab audio through an AudioContext so the video remains audible.
Model URLs are pinned to revisions in `speech-core.mjs`. Attribution, runtime
license, and browser measurements are in [the probe documentation](tools/speech-probe/README.md)
and [the runtime notice](vendor/onnxruntime/README.md). These speech models originate
from NVIDIA NeMo (CC BY 4.0), with CTC conversion by sherpa-onnx and frontend export
by visuall. Silero VAD is from the Silero Team (MIT license). No RealTimeSubtitle
source code is incorporated.

## Subtitle display styles

Version **1.3.3** adds the **언어** selector between encoding and timing. This is the subtitle's source language; the target is always Korean. **한국어(번역하지 않음)** displays the original text. Korean, English, Chinese, Japanese, and Spanish stay at the top, followed by the other major languages documented by Chrome. The selected pair is checked against the current browser at runtime.

The native [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api) is supported on desktop Chrome 138+; [Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api) supports it from 148+. The first language-model download needs an internet connection and a direct click on **번역 모델 준비** in the playback page. Translation runs in an extension iframe in the top frame, so it continues after the popup closes and can serve subtitles in embedded players. The visible cue is translated first, then the next five cues are translated ahead of playback using `translateStreaming`, with completed lines cached locally. Seeks, new files, language changes, and subtitle removal cancel stale requests. A browser or site policy that blocks the API shows a preparation error and leaves the original subtitles usable.

For a translated language, **후처리 설정** opens a saved dictionary. Enter one `출력=후처리` rule per line, such as `플라스틱 뚜껑=플라흐타`. All literal matches in streaming/final translated text are replaced. Longer overlapping phrases take priority, and replacement text is not replaced again in the same pass. Dictionary edits also update the currently displayed translation. Original subtitles in **한국어(번역하지 않음)** are unaffected.

In **자막 → 추출·검색**, **번역** reads the selected subtitle into a local in-memory file and opens **오버레이**. The track's language code/label takes priority; without metadata, several dialogue lines are sampled conservatively. Japanese selects Japanese, Korean selects **한국어(번역하지 않음)**, and ambiguous text requires choosing a language before applying. Latin letters alone never imply English. Formats unsupported by the overlay are converted to VTT with their timing preserved. **다운로드** saves the original subtitle separately.

Tracks identify **전체 대사**, **표지판·노래**, and **강제 표시** when the metadata is explicit. Full dialogue moves ahead of partial-purpose tracks in the same language, while all choices remain available. **작품별로 선택한 언어·트랙 기억하기** is opt-in: up to 100 work profiles retain language, purpose and stable producer/label information, never expiring subtitle URLs. Only a unique matching candidate on a page with clear work/episode evidence is recommended; it is not applied automatically. Search suggestions separate title, season and episode from the page title, ignore opaque query IDs such as `?ep=12345`, and remain editable before Google/Naver search.

**번역 아래 원문 함께 보기** adds the original text below Korean for both file subtitles and Japanese speech. It is off by default and makes no extra translation request. Independent **효과음 설명 숨기기** and **화자명 숨기기** options filter only displayed text; ambiguous parenthetical dialogue and short exclamations are retained. Source files, downloads and translation input remain intact.

**번역 전처리 설정** accepts one `source=Korean` proper noun per line. Longest literal terms win without cascading replacement, and Latin terms respect word boundaries. The glossary is applied before translation; the existing **번역 후처리 설정** dictionary still applies afterward. Completed translations persist locally by exact cue content, language pair, canonical glossary and engine version. The dictionaries share one manager with a combined 10 KiB (10,240 bytes) UTF-8 budget and a **저장된 사전 삭제** button. The cache separately holds at most 4,000 lines / 3 MB (3,000,000 bytes), restores cached lines before model setup, and can be deleted from **번역 저장 관리**. Postprocessing edits do not invalidate raw cached translations; glossary changes do.

The file picker also opens ZIP archives and text MicroDVD `.sub` files. ZIP shows subtitle filenames and uncompressed sizes before extracting the selected entry. UTF-8 flags/Unicode path metadata and legacy CP949 names are supported. Limits are 32 MiB per ZIP, 1,024 entries, 64 MiB declared expanded total and 8 MiB per selected subtitle; encrypted, split and ZIP64 archives are not supported. Size and CRC checks run during extraction. MicroDVD uses embedded FPS when present, otherwise requires an explicit FPS. Image-based `.sub` subtitles are rejected.

Floating scroll defaults are **🔽 7.5**, **⏬ 45**, and **⬇️ 95%** of the scrollable distance. Previously saved custom speeds are preserved.

In the floating-scroll settings, **위치 조절 핸들 표시** is enabled by default to show a red circle in the center gap. Drag it to reposition the controls. It shares the scroll buttons' opacity. Thinner button backgrounds make room for the larger 24px handle while preserving the group dimensions and icon sizes.

Auto-scroll uses immediate per-frame movement, including inside scrollable panels, so a site's smooth-scroll CSS cannot stop it after the first movement. Clicking outside the controls, switching away from the page/window, or starting a position drag stops auto-scroll; a page element losing focus does not stop it.

The **자막** tab contains **오버레이**, **스타일**, and **추출·검색** subtabs. **스타일** saves all display options automatically in extension local storage, even without a selected video. The saved style is restored when reopening the popup and applies to subsequent subtitles. Existing saved font selections are migrated. File selection, subtitle timing offsets, and subtitle rates remain specific to the current subtitle/video.

In **오버레이**, positive `offsetMs` delays subtitles and negative values advance them. The default `syncRate` is `1.000000`, and subtitle time is `(video.currentTime - offsetMs / 1000) * syncRate`. The rate input steps by `0.00001`; adjustment buttons change it by `±0.0001` or `±0.001`, and **초기화** restores `1.000000`. FPS presets are `0.95905`, `0.96000`, `0.99900`, `1.00100`, `1.04167`, and `1.04271`.

With a file subtitle applied, the video's **싱크** control works even after closing the popup: advance/delay by 0.2 seconds and see the cumulative offset briefly. **두 지점 보정** lets you choose an early dialogue cue and capture the actual video time, then repeat for a later cue. It previews the calculated offset/rate before applying. This corrects gradual drift, not abrupt changes caused by advertising or different edits. Controls belong to the selected video and install no global keyboard shortcuts.

Site-player container fullscreen retains these controls. Chrome's native fullscreen of the video element makes outside controls inert: subtitles remain visible, while sync controls and translation-model preparation resume after leaving fullscreen.

The font selector includes **깔끔한** and **귀여운** groups with 11 supplied fonts, alongside **PC에 설치된 글꼴**. Eight font files ship with the extension; Binggrae, Moneygraphy Rounded, and Tmoney RoundWind load as web fonts and need an internet connection. See [font sources and licenses](fonts/README.md).

Style controls include font size, letter spacing, line height, vertical position, solid or two-color gradient fills and direction, none/basic/double/neon outlines, and no/simple rectangle/box/pill backgrounds. Double outlines have separate inner/outer colors and widths. Background fill, border, padding, border width and transparency are independent of the text. Shadows can be disabled or configured with color, blur, and X/Y offsets. Background transparency ranges from 0% (opaque) to 100% (invisible).

## Chrome Web Store notes

- Keep the Web Store listing and privacy fields aligned with the shipped behavior, including subtitle detection/downloads and their HTTP(S), webRequest, and downloads permissions.

## Icons

The extension uses PNG files extracted directly from the supplied `.ico` icon files so Chrome UI and Chrome Web Store rendering do not fall back to the default extension icon.

### 1.6.1 settings and reliability

Translation dictionary settings, speaker/effect filters and bilingual display controls are hidden for Korean source subtitles; Korean display bypasses those filters. The sync settings can permanently hide the in-video sync menu. Its **이번 화 싱크 버튼 숨기기** action lasts until the next media source or subtitle load. Online subtitle search uses the dedicated search site only.

Release review fixed shared globals between auto-scroll and the KONE decoder, stale initial settings in link previews/hover translation/YouTube, and unused translation sessions after language changes. Large dictionaries use literal trie matching and are compiled only when their contents change.
