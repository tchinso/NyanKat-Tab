# Subtitle enhancements verification — 2026-11-02

The twelve requested additions are implemented without new permissions, external APIs, models or runtime dependencies. Reference projects informed the behavior; the extension uses its existing browser Translator and speech pipeline.

Automated coverage exercises language/track metadata through discovery and import, conservative language inference, per-work preferences, title parsing, glossary invalidation, persistent cache limits/deletion, display filtering, speech/file bilingual rendering, timing calibration, ZIP integrity/size limits and CP949 names, MicroDVD FPS, popup controls and portable settings. Run `node --test` from the repository root.

Final complete run: **394 passed, 0 failed, 0 skipped**. The Chrome smoke run reported no page JavaScript errors.

An isolated Chrome 156 profile loaded the production extension through `Extensions.loadUnpacked`. A local HTTP fixture supplied a real HTML video/canvas stream. Browser checks covered:

- Selecting a subtitle inside ZIP, then applying its actual bytes to the video.
- Korean source-language inference and visible Korean subtitles.
- In-video 0.2-second sync controls and cumulative feedback.
- Extracted Japanese metadata selecting Japanese in the popup.
- Restoring a seeded raw Korean translation through the production cache broker and translation host, without preparing a model.
- Original Japanese below the Korean translation.
- MicroDVD embedded FPS and file application.
- Clearing the persistent translation cache through the popup.
- Native-video fullscreen subtitle display, restoration after exit, interactive sync controls in container fullscreen, and Escape dismissal of the sync panel.

The cached Korean result was a test fixture, not a new native-model translation measurement. Existing real speech/model and live-site verification results were reused; no speech models were downloaded and no new recognition-quality benchmark was performed. See [speech verification](speech-verification-2026-11-02.md) and [site verification](subtitle-sites/verification-2026-10-10.md).

Native fullscreen of the `<video>` element makes outside UI inert in Chrome. The extension displays subtitles in the top layer, hides unavailable interactive controls, and restores them after fullscreen exit. Site-player container fullscreen retains the in-video controls. A modal overlay was deliberately avoided because it would disable the video's own controls.
