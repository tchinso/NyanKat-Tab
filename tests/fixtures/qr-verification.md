# QR verification — 2026-10-28

- Loaded the unpacked MV3 extension into a fresh, headless Microsoft Edge 156.0.4314.42 profile with Playwright.
- Source: https://img.yejiang233.com/file/%E4%BA%8C%E7%BB%B4%E7%A0%81/har-26.10.1.webp
- Decoded using the packaged ZXing 0.23.0 and production `NyanKatQR.decodeImage` inside the real extension service worker.
- Result: `https://pan.baidu.com/s/18N0JuRdtIaI2fy-vnojXPQ`
- Confirmed the image context menu was registered using `chrome.contextMenus.update`, then invoked its production `handleContextMenuClick` handler with the source tab/image. This is an integration test, not a native mouse-menu click simulation.
- Observed an actual main-frame request to the decoded URL and navigation to Baidu's redirect target: `https://pan.baidu.com/share/init?surl=8N0JuRdtIaI2fy-vnojXPQ`.
- `node --test`: 330 passed, 0 failed, including generated normal/inverted QR images, plain text, blank images, URL scheme filtering, source URL rejection, frame-specific result delivery, closed/navigated source tabs, persistent failure messages, translation toggle rollback, and merging/retrying preview settings edits.
- Checked the renamed popup, scroll settings, link preview settings, translation settings, and QR result page in the loaded extension. No page JavaScript errors or horizontal overflow at the tested widths (400 / 700 / 300 pixels); inspected screenshots of the popup and both preview/translation settings. The QR result displayed HTML-like content as literal text.

Reproduce with Playwright available on `NODE_PATH`:

```powershell
$env:QR_CHROMIUM_EXECUTABLE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node scripts/verify-qr.cjs
```

Without the executable override the script uses Playwright's Chromium. The locally downloaded Chromium 151 could not start because of a Windows side-by-side assembly error; Edge was used successfully instead. The test uses a temporary profile and closes it afterward. The remote fixture is fetched live, so network availability and changes to the image/destination can affect future runs.
