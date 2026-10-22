# Embed Lab

A buildless HTML, CSS, and JavaScript demo for the supplied Google Drive video.

## Preview

Open `index.html` in a modern browser. No install or build step is required.
For a local HTTP preview with Node.js, run `node serve.mjs` and visit
<http://127.0.0.1:4173>. Stop the server with Ctrl+C.

The isolated progressive developer experiment is at
<http://127.0.0.1:4173/stream/>. It requires a restricted standard API key
entered locally; the original iframe viewer remains unchanged.

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

### Progressive playback: isolated browser range bridge

Open <http://127.0.0.1:4173/stream/>, enter the same restricted standard API key,
and click **Prepare streaming**. The first request checks exactly 1 KB and
requires HTTP 206, readable `Content-Length`, MP4 MIME type, and signature.
When CORS hides `Content-Range`, a bounded metadata request verifies the file
size so the worker can construct the local partial response correctly.
If that passes, the native video requests media ranges and can play before
the entire file arrives. Press Play once metadata is ready. No full-download
fallback is automatic. Use the original iframe explicitly if the gate fails.

The page registers a Service Worker with scope **only `/stream/`**. The worker
handles one fixed virtual media route, forwards native single-range requests
to the fixed Drive API endpoint with `X-Goog-Api-Key`, and streams validated
206 responses using backpressure. Google receives video requests directly
from the browser: `serve.mjs` remains a static allowlist, and the virtual media
route returns 404 from the server if no worker intercepts it. No dependency,
media conversion service, CDN, or backend media proxy is added.

Keys stay in the initiating tab's RAM until close/navigation. The input clears
on submission; every range obtains the key from that specific client through
a MessageChannel. A restarted worker can request it again from the still-open
tab. A tab cannot borrow another tab's key. Keys are never in virtual URLs,
source files, logs, Cache Storage, IndexedDB, localStorage, or sessionStorage.
Do not enter OAuth owner tokens or service-account/private credentials. The
browser's developer tools can inspect the application's API requests.

The worker registration itself may persist, **without storing keys or media**.
It has no `skipWaiting` and does not force an update into active playback.
Close streaming tabs and reopen the page to adopt an updated worker. Close
stream or leaving the page clears its key, aborts its own requests, unloads
the video, and leaves other tabs alone. Header, network, timeout, or decoding
failures stop the session and offer the existing viewer. The 200 MiB cap is a
source-file size limit, not a promise of a total-traffic or monetary limit.

Requires HTTPS in production or a secure local context, Service Workers, and
readable Google API Content-Length and either Content-Range or valid file-size
metadata. An invalid/mismatched response, ignored Range
(HTTP 200), access/quota errors, or unsupported browser fails closed. API
redirects are rejected rather than forwarding the key to another host. There
is a five-second key-response timeout, ten-second worker setup timeout, and
30-second timeout while waiting for upstream headers or body data. Stream
backpressure does not cause a timeout while the browser is not requesting data.

The native browser controls buffering (`preload="metadata"` is only a hint).
Repeated/overlapping ranges and seeks may transfer additional bytes. The UI
shows transferred bytes and range counts rather than a misleading whole-file
download percentage. Streaming does not remove project quota attribution or
guarantee zero costs. The user reports no linked billing account; no Cloud
billing, API restrictions, sharing, or quota settings are changed by this code.

The existing full-download page now uses the same reusable controls through
`media-controls.js`; its opt-in Blob-download behavior is preserved. Production
application-key configuration and broad cross-browser certification remain
outside this developer experiment.

#### If Network only shows a cancelled probe

An early worker failure used to trigger immediate probe cancellation, hiding
its local HTTP 502 response. The page now lets that response complete, preserves
the structured error code/stage, and clears the key when the failure is handled.
Manual Close still cancels immediately. This fixes error masking, not an
unverified underlying Drive access/playback problem.

The visible **Streaming diagnostics — no keys** panel sits above the video;
the same protocol metadata is logged with the console prefix `[Drive stream]`.
It reports worker state/version, HTTP status, and selected validated media
header values, not keys, full URLs, raw request headers, or response bodies.
Entries are capped at 30 per attempt. `MISSING_CONTENT_RANGE` specifically
means no readable range or validated metadata size was available; `UPSTREAM_HTTP` and
`UPSTREAM_ACCESS_FAILED` identify different failure stages. Do not infer those
causes from `(canceled)` alone or remove key restrictions as a workaround.

Close all `/stream/` tabs and reopen after a worker update. If the page reports
`UPDATE_WAITING`, close those tabs once more so the waiting worker can activate.
The current worker identifies itself as `range-metadata-v3`.
Share only the visible diagnostic lines and result, never the key or request
headers. The static server does not receive direct Google error details.

#### CORS-hidden Content-Range

Real user diagnostics showed HTTP 206, video/mp4, and Content-Length 1024, but
Content-Range was not readable. The browser's default CORS response-header
safelist includes Content-Length, not Content-Range. The first implementation
incorrectly treated that missing exposure as an unusable media response.

Version `range-metadata-v3` requests only `id,size,mimeType` from the fixed
file's Drive API metadata endpoint when the range header is hidden. It validates
the identity, MP4 MIME type, safe size, and 200 MiB source cap, reading at most
4 KB of JSON. One size lookup is retained per client/playback in worker RAM,
not browser storage, and removed on Close. Worker restarts may repeat that
small lookup. This is an additional quota-counted API request, not a new paid
service or billing configuration.

The worker derives only its own response's Content-Range from that verified
size, the requested single range, HTTP 206 semantics, and exposed Content-Length.
It still rejects HTTP 200, unknown totals, contradictory lengths, malformed
exposed headers, and truncated or oversized bodies. It does not disable CORS,
read hidden headers, or guess the total from a partial length. The public source
file is assumed unchanged during a playback session; close and prepare again
after replacing it. Diagnostics distinguish `CONTENT_RANGE_FROM_METADATA`
from an upstream header. A metadata access failure is reported separately.

References: [Drive file size](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
[partial downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads#partial_download),
and [CORS response header exposure](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_response_header).

#### Checks and acceptance

- `node --test tests/*.test.cjs` covers both previous prototypes and new range
  parsing, exact headers, incremental streaming, cancellation, failure paths,
  fixed-route admission, and per-client key/stop isolation.
- Syntax-check `media-controls.js` and each script under `stream/` with
  `node --check`. Run `git diff --check`.
- For a real browser/key check, confirm Play advances with substantially fewer
  received bytes than the source size; seek outside the buffered interval and
  confirm a new remote range; test close, errors, and two independent tabs.
- Terminate only this worker through browser developer tools while the page
  is idle, then play/seek again: the restarted worker must obtain the key from
  the original tab without persisting it. Verify the main viewer has no worker
  controller, no key appears in URLs, and no media cache/storage entries exist.
- `node tests/stream-cors-browser.mjs` runs an optional clean-browser integration
  check, defaulting to installed Edge on Windows; pass a Chromium executable as
  its first argument elsewhere. It generates an MP4 locally and injects only a
  local fixture transport into the worker. Its separate-origin fixture omits
  Access-Control-Expose-Headers, reproducing hidden Content-Range. The check
  verifies metadata repair, actual native playback/seek, close, and no stored key.
  It uses no real key or Google data, and installs nothing. Temporary test
  browser profiles are placed in the OS temp directory.
- No real key-backed progressive playback is claimed by the unit/fixture tests.
  The earlier long browser harness was blocked by runtime policy. The subsequent
  focused CORS fixture check passes, but its small media can finish buffering
  before Play. Early playback before full transfer and a seek into unbuffered
  real content remain user-key acceptance checks, not claims from that fixture.

To roll back progressive playback only, close streaming tabs, unregister only
the worker whose scope is `/stream/`, remove the `stream/` files and their
static routes and diagnostic link, and remove the two stream test files.
Keep `media-controls.js` and its route/script reference: the full-download
prototype now uses that shared controller. Do not unregister unrelated workers.
## Verified browser cache and operator preparation

A validated p2p/manifest.json for the current public Drive video is included. It contains metadata and SHA-256 hashes, not the key or video. Regenerate it if Drive changes.

Open http://127.0.0.1:4173/p2p/setup.html, enter a restricted standard key locally, and consent to reading the real approximately 162 MB source once. Complete 1 MiB blocks are stored in IndexedDB under a 200 MiB payload cap; the source version is checked before and after. Download the manifest JSON and deliberately replace p2p/manifest.json only when updating the source. Never publish a key or MP4. Existing valid cached blocks survive a repeated preparation failure.

Run node --test tests/peer-core.test.cjs. Preparing a seed consumes browser storage and connection bandwidth; a bundled manifest does not populate a browser cache or remove the need for a key on missing Drive blocks. Rollback: remove the p2p core/cache/setup assets, manifest, their static routes and this section; keep prior players.

For a browser check, confirm there are no Drive requests before Load video; test load, reload, close, cinema mode, fullscreen, and a narrow mobile viewport. Actual Drive playback depends on Google and the browser.

Rollback boundary: remove the original viewer assets, static server and viewer tests, and restore the initial README. Remove later experiments first if they depend on these assets. No dependencies or Git settings change.

## Research

- [MDN: same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
- [Google: store and play video in Drive](https://support.google.com/drive/answer/2423694?hl=en)
- [Google Drive API: file links](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [MDN: Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API)
