# Embed Lab

A buildless HTML, CSS, and JavaScript demo for the supplied Google Drive video.

## Preview

Open `index.html` in a modern browser. No install or build step is required.
For a local HTTP preview with Node.js, run `node serve.mjs` and visit
<http://127.0.0.1:4173>. Stop the server with Ctrl+C.

The isolated progressive developer experiment is at
<http://127.0.0.1:4173/stream/>. It requires a restricted standard API key
entered locally; the original iframe viewer remains unchanged.

The new opt-in **local cache + P2P pilot** is at
<http://127.0.0.1:4173/stream/peer/>. A validated manifest for the current public
video is included; follow the setup below to populate a seed browser's cache.

## Local cache + P2P pilot: quick start

The video stays on **Google Drive**. Node serves the site, a trusted JSON hash
manifest, and ephemeral signalling only. It does not download/store/relay the MP4.
Do not deploy this loopback-only experiment as an internet service.

1. Run `node serve.mjs --p2p` with Node 24 (tested with 24.18.0). No install or
   build is needed. Keep the terminal open.
2. Open <http://127.0.0.1:4173/p2p/setup.html> in browser profile A. Enter the
   restricted standard key **there**, not in chat, source files, or a manifest.
   Consent to reading the actual approximately 162 MB Drive video once.
3. Wait for preparation and the before/after Drive-version check. Download
   **manifest.json**, and manually save it as **`p2p/manifest.json`** in this
   project (replace an older manifest only when deliberately updating the video).
   It contains metadata and SHA-256 block hashes, never the key or video.
   The repository includes a validated manifest for the current public video;
   regenerate and replace it only when the Drive source changes. Preparation
   also populates this browser's seed cache. No server restart is needed after
   publishing the JSON. Keys are still required for uncached Drive downloads;
   the manifest contains neither credentials nor the video itself.
4. In the **same profile A**, open <http://127.0.0.1:4173/stream/peer/> and choose
   **Prepare cached streaming**. The key is optional if all blocks are cached.
   Accept the upload/privacy notice, choose an **Upload limit (MiB/s)**, and
   choose **Enable peer sharing**. The local test default is **4 MiB/s**; the
   bounded range is 0.5–8 MiB/s. Disable sharing before changing the limit.
   The value is not persisted; reload restores 4 MiB/s.
5. Use a second, independent browser profile B on this computer. Prepare the
   pilot, optionally entering a key for missing-block Drive fallback. Enable
   sharing, allow the local connection to establish, then **Load video** and Play.
   Separate ordinary tabs in the same profile share storage; they are not an
   independent-peer test. A Web Lock admits only one sharing tab per profile.
6. Watch the cache / peers / Drive useful-block counters. Close and prepare
   again to test reuse. **Delete cached video** requires confirmation and stops
   this tab first. Disabling sharing does not delete your cache.

If the manifest was removed and preparation reports HTTP 404, restore the bundled
manifest or regenerate it from step 3. Do not remove key restrictions. If sharing
cannot connect, confirm `--p2p` is enabled. Missing blocks still use Drive when
a key is present. The original iframe and earlier progressive experiment remain
independent fallback pages.

### Data path and limits

`native <video> → scoped Service Worker → open tab → own IndexedDB → peer → Drive`

Only the last two sources are tried on a local miss. Every block must match the
operator-published manifest, including Drive fallback blocks. A mismatched Drive
block stops that source and requests a regenerated manifest. Peers cannot publish
or replace hashes. A sender reads **cached data only**; another viewer cannot
trigger it to fetch Drive on the viewer's behalf.

| Area | Pilot behavior |
| --- | --- |
| Storage | IndexedDB, 1 MiB blocks, 200 MiB useful-video cap per origin/profile. Browser quota/eviction can reduce this. No full-file RAM Blob. |
| Eviction | Oldest blocks of inactive content versions first; Web Locks protect open content. If safe eviction or writing is unavailable, playback continues without new saves. |
| Read-ahead | Demand-only; no independent prefetch task or whole-file preload. Native browser buffering can still request many blocks. At most four coalesced block loads run concurrently. |
| Sharing | Off by default; explicit bandwidth/battery/storage/IP notice. Open tab required. No background seed service. |
| Upload | One block upload at a time, configurable 0.5–8 MiB/s useful payload (4 MiB/s local default), and 200 MiB per sharing session. Protocol overhead is **additional bandwidth**. |
| Download peers | Up to four candidate connections, plus one incoming connection slot. One bounded peer attempt per missing block; otherwise Drive. Free-slot availability and observed block latency inform selection. |
| Peer failures | 1-second first-binary-byte deadline; 4-second block deadline. Invalid data rejects the peer, with a 60-second cooldown. No invalid bytes reach playback. |
| Data channel | Ordered/reliable, frames ≤16 KiB, bufferedAmount backpressure. Each block is fully hash-verified before delivery to the native player. |
| Local networking | Host ICE candidates only; empty STUN/TURN list. Coordinator bound to 127.0.0.1, not LAN devices. Cross-device/LAN and internet discovery/relay are outside this pilot. |
| Coordinator | Same-origin JSON/SSE, RAM-only anonymous bearer tokens, ≤100 sessions, 64 KiB JSON requests, 240 messages/min/session, 15-second heartbeat and 45-second expiry. No key or MP4 endpoints. |
| Keys | Only this tab's memory; header-only directly to Google. No IndexedDB/localStorage/sessionStorage persistence or peer/coordinator exchange. Developer tools can still inspect browser requests. |

P2P does **not** remove bandwidth use. It shifts useful video bytes from Drive
to a participating browser's connection; both upload and download matter. A
seed can deliver less than its configured cap, and less than the video's bitrate,
so the pilot can buffer/stall even when P2P succeeds. The 4 MiB/s default is a
local test setting (about 34 Mbps of payload at full speed, before overhead), not
a guarantee of smooth production playback or a substitute for media hosting.
Closing/suspending a seed triggers fallback only for missing blocks. A browser
can evict saved blocks; this is not a durable backup or guaranteed offline app.

Production sizing remains a separate, unimplemented policy. Measure the video's
sustained/peak bitrate and actual sender upload; as an initial engineering
heuristic, target roughly 30–50% playback-throughput headroom without consuming
the sender's entire connection. Respect the user's chosen total upload budget;
do not raise it automatically to meet a video's demands. If that budget cannot
sustain playback, use origin fallback rather than promise peer-only fluidity.
Any future simultaneous uploads must share the total budget, not each receive
the entire cap. The browser's `navigator.connection.downlink` is a download
estimate, **not** an upload-speed test. Same-computer P2P tests do not establish
internet throughput. No adaptive upload controller is implemented here.

This narrower worker controls only `/stream/peer/`, not the existing `/stream/`
player. Updates do not force-activate over open sessions: if an update is waiting,
close all peer-pilot tabs and reopen. Closing clears the active tab key and
sharing session, but saved blocks and the worker registration remain. Cache
erasure stops this tab's outstanding work before deleting pilot video data;
other open tabs may save blocks again.

### Verification and remaining real-Drive gate

Run:

```powershell
node --test tests/*.test.cjs
node tests/peer-browser.mjs
node tests/stream-cors-browser.mjs
```

The optional browser scripts use the installed Edge executable by default; pass
an installed Chromium browser path as the first argument if needed. They launch
fresh disposable profiles, use **synthetic local media**, and leave those temporary
profile directories in the OS temp folder for inspection. They do not access your
normal browser profile, API key, or Google account, and do not install packages.

Observed local checks: real WebRTC between independent profiles; operator
bootstrap/export; verified block transfer without a duplicate origin range;
IndexedDB reuse after reload; missing-block-only origin fallback; upload pacing;
one sharing owner per profile; native Service Worker playback/seek; confirmed
cache deletion; and the prior progressive CORS-hidden Content-Range regression.
The browser fixture is small and padded; it does **not** establish real-video
throughput, playback-before-complete, or unbuffered seek against Drive.

**Still pending with the real video:** perform steps 2–6; confirm B receives
peer bytes without a Drive range for those blocks, reload B to verify local
reuse, disconnect A and seek to an uncached position to check Drive fallback.
Confirm native Play advances before the complete approximately 162 MB video
arrives, and seek into unbuffered content. Do not accept synthetic-media results
as evidence for these checks. No paid service or Google quota/billing change was
made. Existing Google limits/restrictions still apply to origin downloads.

Rollback boundary: disable peer use by omitting `--p2p` and use the original
players. Full removal can remove `p2p/`, `stream/peer/`, `tests/peer-*.test.cjs`,
and `tests/peer-browser.mjs`, plus their additions/imports in `serve.mjs`, the
pilot link in `stream/index.html`, and this documentation section. Do not remove
the earlier `/stream/` worker or players. Remove the `/stream/peer/` worker
registration and `embed-peer-cache-v1` IndexedDB database through this origin's
browser tools only if you also want local pilot data removed.

References: [Drive partial downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads),
[Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API),
and [DataChannel backpressure](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount).
See also [the downlink estimate](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation/downlink).

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

### Local checks

Run `node --check app.js`, `node --check serve.mjs`, and `node --test tests/app.test.cjs`.
Also run `node --check drive-api-check.js` and `node --test tests/drive-api-check.test.cjs`.

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
For a browser check, confirm there are no Drive requests before Load video;
test load, reload, close, cinema mode, fullscreen, and a narrow mobile viewport.
Actual Drive playback also depends on its service and the viewer's browser.

Rollback boundary: remove `index.html`, `styles.css`, `app.js`, `serve.mjs`, and
`tests/app.test.cjs`, and restore this README. No dependencies or Git settings change.

## Research

- [MDN: same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
- [Google: store and play video in Drive](https://support.google.com/drive/answer/2423694?hl=en)
- [Google Drive API: file links](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [MDN: Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API)
