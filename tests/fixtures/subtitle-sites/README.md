# Live subtitle mechanism observations

Observed on **2026-10-04 (Asia/Seoul)** using the ten episode URLs supplied for this task. These observations verify real site structures and selected subtitle responses. They **do not** establish that an installed build of the extension downloaded subtitles from all ten sites.

`observed-mechanisms.json` contains sanitized structural examples. URLs in those examples use `example.test`; opaque signatures, account/session credentials, and actual episode subtitle text are excluded.

| Site | Observed mechanism | Verification and remaining limit |
| --- | --- | --- |
| anikototv.to | Dynamically inserted megaplay.buzz iframe; JW Player caption settings | Player loaded and eleven caption choices were visible. Native video textTracks contained only ID3 metadata. Caption body retrieval remains unverified. Embed needed an anikototv.to referrer to load. |
| reanime.to | flixcloud.cc iframe; inline `subtitles` objects with `url`, `language`, `format`, `default` | Eleven ASS/SRT choices found. English ASS retrieved HTTP 200 with 369 dialogue lines. Initial no-server placeholder disappeared after hydration. |
| www.miruro.cx | `strmcx-embed` shadow iframe at strm.cx; MessagePort configuration; native track nodes | Eleven subtitle tracks found. English proxy VTT retrieved HTTP 200, `text/vtt`, 369 cues. Source API is encoded binary, so native track/config discovery is useful. |
| anizone.to | Escaped JSON inside `x-data="vidstackPlayer(JSON.parse(...))"`; ASS/SRT array | Seventeen subtitle tracks found. English ASS retrieved HTTP 200 with 369 dialogue lines; SDH SRT retrieved HTTP 200 with 405 cues. Storyboard and chapter VTT are separate non-caption resources. |
| kaa.lt | krussdomi.com iframe; Astro tuple props; hydrated native subtitles | English VTT retrieved HTTP 200 with 366 cues when using the iframe origin as Referer and Origin. No-referrer request returned 403. Browser captions were visible. |
| anime.nexus | Track objects `{id, src, label, srcLang, type}`; ASS renderer `subUrl`, worker initialization, `setTrackByUrl` | HTML, player wrapper, and subtitle renderer JS retrieved HTTP 200. Static player source established the shape. Direct stream API returned 403. Browser navigated to google.com before subtitle capture, without an agent action. Cause unconfirmed; subtitle body and extension behavior remain unverified. |
| ani.pm | embed.settlar.io iframe; native tracks; signed extensionless media.settlar.io URLs | Two English tracks found and captions enabled in the live player. One track had an empty src, the other a signed `/v1/object/v2...` src. Direct HTTP retrieval returned Cloudflare 403; body download remains unverified. |
| www.animeonsen.xyz | Site-session XHR response `data.uri.subtitles` language map; SubtitlesOctopus ASS worker/canvas | Nine-language selector and ready renderer observed. Video had no native subtitle tracks. Session-free API request returned 401; subtitle response body remains unverified. |
| animex.one | plyr.animex.one iframe; thirteen native tracks; encoded extensionless URLs | English VTT retrieved HTTP 200 with 366 cues, despite a misleading `image/jpeg` response MIME. Initial unavailable placeholder disappeared after hydration. |
| lunarx.to | Episode loading page | Direct HTTP returned 403. Browser loaded the episode screen, then navigated to about:blank. One fresh navigation repeated that result. Cause unconfirmed; source/track discovery remains unverified. |

Coverage implications: observe all frames, native and programmatic tracks, open shadow roots, player configuration and messaging, escaped JSON/attributes, subtitle language maps, and response body signatures. Preserve the subtitle's originating player frame referrer. An extension or MIME allowlist alone would miss the real Ani.pm and AnimeX tracks. Do not classify chapter/storyboard VTT as episode captions.
