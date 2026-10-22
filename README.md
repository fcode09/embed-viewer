# Embed Lab

A buildless HTML, CSS, and JavaScript demo for the supplied Google Drive video.

## Preview

Open `index.html` in a modern browser. No install or build step is required.
For a local HTTP preview with Node.js, run `node serve.mjs` and visit
<http://127.0.0.1:4173>. Stop the server with Ctrl+C.

Click **Load video**, then press **Play inside the Google Drive player**.
Loading the iframe does not guarantee playback and does not request autoplay.
Cinema mode expands the viewing space; Fullscreen is shown when the browser
supports the Fullscreen API. Close player removes the iframe, stopping its playback.
Reload recreates it and loses the current playback position.

## Integration plan and boundaries

1. Use Drive's `/file/d/FILE_ID/preview` iframe rather than a download URL.
2. Create the iframe only on request: no Google requests, thumbnails, or fonts
   are needed for the initial page. Reserve its aspect ratio to prevent layout shift.
3. Keep Drive's accessible playback controls intact. Do not cover or crop them.
4. Control the surrounding presentation, not the third-party player.

The source is `E. Monitoreo de SIPCOP Parte 4.mp4`, file ID
`1-XFihL-VwXZK1J7o81nQwm5WuJyYExP9`. Change `previewUrl` in `app.js` and
the source links/title in `index.html` together to use another video.

Parent-page CSS and JavaScript cannot inspect or change a cross-origin iframe's
internal controls. This demo has no documented Drive playback API to rely on;
it does not send speculative `postMessage` commands or YouTube-only parameters
such as `controls=0`. An iframe `load` event is not proof of playable media:
permissions and playback errors must be read inside Drive itself.

For fully custom play/pause, seeking, volume, and control visibility, use an
HTML5 `<video>` with a directly hosted video source. That offers more control
but requires suitable media hosting/bandwidth. Drive download links are not
treated as a reliable streaming origin. Hidden controls are not copy protection.

The file must be shared with the intended viewers. Google documents possible
third-party-cookie requirements. This demo does not change sharing, download
the video, require credentials, or bypass Drive restrictions. CSS is used
instead of SCSS to avoid adding a compiler for this small static page.

## Checks

Run node --check app.js, node --check serve.mjs, and node --test tests/app.test.cjs.

### Anonymous Drive API experiment

The working iframe remains the default. A separate developer diagnostic is
available at <http://127.0.0.1:4173/drive-api-check.html> after `node serve.mjs`.

1. Select or create your Google Cloud project and enable **Google Drive API**.
2. Create a **standard API key**, without service-account binding. Restrict its
   API access to Google Drive API and its website referrer to
   `http://127.0.0.1:4173/*`. Do not remove restrictions to work around an error.
3. Confirm the file is already publicly shared. Paste the restricted key into
   the diagnostic page, not source code or chat, and click **Test 1 KB access**.

The key is cleared from the input on submission and not persisted by the app.
It is sent to Google in `X-Goog-Api-Key`, not the URL. Browser developer tools
can still inspect it. Do not use an owner token, refresh token, or private key.
If Google asks to enable billing, stop before accepting it; this experiment
does not require us to provision paid services automatically.

The diagnostic requests `files.get?alt=media` with `Range: bytes=0-1023`,
rejects non-206/non-MP4 responses before reading their bodies, and checks the
fragment length and MP4 signature. It has a 12-second timeout. If a server
ignores Range, the body is cancelled, although already in-flight network bytes
cannot be recalled. A successful fragment is not proof of full playback or
seeking; those remain the next gate. No key-backed live result has been
verified yet. Neither page creates a media proxy or changes file permissions.

To roll back only this experiment, remove `drive-api-check.html`,
`drive-api-check.js`, and `tests/drive-api-check.test.cjs`, remove their two
allowlisted routes from `serve.mjs`, and remove this diagnostic documentation.
Keep the existing viewer and its styles unchanged.

Setup references: [enable the API](https://developers.google.com/workspace/guides/enable-apis),
[create credentials](https://developers.google.com/workspace/guides/create-credentials#api-key),
and [restrict keys](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys).

### Next gate: native playback of a full browser-local copy

After a successful fragment check, visit
<http://127.0.0.1:4173/drive-player.html>. Enter the restricted standard key
locally again, explicitly consent to the approximately **162 MB** full download,
and click **Download & prepare video**. This transfer consumes viewer data and
temporary browser resources. It does not start automatically and can be
cancelled. There is a 200 MiB safety cap and a 30-second no-data timeout.

The key stays out of the URL, application storage, and source files. The
browser fetches directly from Google using `X-Goog-Api-Key`; after completion,
a temporary Blob URL feeds our own `<video>`. Custom controls cover play/pause,
seek, ±10 seconds, volume/mute, speed, fullscreen (when available), and cinema
mode. Native controls remain until metadata is valid. The page reports actual
playback advancement and position changes separately. Close releases the Blob
URL; leaving the page aborts a pending download. No permanent cache is created.

**This is not progressive streaming.** Local seeking does not prove remote
seeking. The fragment screenshot supplied by the user proves API byte access,
not this full playback path; live playback still requires the user's local key
and confirmation. A production page must separately configure a restricted
application key so visitors do not enter one. No real key has been requested
in chat, embedded in source, or recovered from an existing browser session.

This deliberately avoids exposing the key in a `<video src>` query string,
adding a media proxy, installing a demuxer, or registering a Service Worker.
The original iframe remains available at `index.html` as an explicit fallback.
The tradeoff is waiting for the complete file and using temporary resources.

Verify with `node --check drive-download.js`, `node --check drive-player.js`,
and `node --test tests/drive-download.test.cjs`. Browser tests must distinguish
synthetic fixtures from actual user-key-backed Drive playback. For the real
test, confirm the timer advances while playing, pause, seek to the middle,
change volume and speed, then close and confirm the player is unloaded.

To remove only this playback experiment, delete `drive-player.html`,
`drive-player.css`, `drive-player.js`, `drive-download.js`, and
`tests/drive-download.test.cjs`, remove their four routes from `serve.mjs`,
and remove its link from the diagnostic and this documentation. Keep the
existing viewer and fragment diagnostic.

For a browser check, confirm there are no Drive requests before Load video; test load, reload, close, cinema mode, fullscreen, and a narrow mobile viewport. Actual Drive playback depends on Google and the browser.

Rollback boundary: remove the original viewer assets, static server and viewer tests, and restore the initial README. Remove later experiments first if they depend on these assets. No dependencies or Git settings change.

## Research

- [MDN: same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
- [Google: store and play video in Drive](https://support.google.com/drive/answer/2423694?hl=en)
- [Google Drive API: file links](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [MDN: Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API)
