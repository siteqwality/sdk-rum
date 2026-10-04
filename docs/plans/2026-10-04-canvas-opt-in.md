# Phase 7.1 canvas implementation plan

Goal: opt-in canvas frames for SDK 2.2.0, isolated from the verified SDK 2.1.0 candidate at 4ee5bc4414a1070b86c0b90b976df9f765bab59d.

Spec: SiteQwality docs/plans/2026-10-03-rum-world-class-design.md sections 5.5, 7.1 and WP 7.1. The user approved inline implementation with no additional agents.

## Constraints and design

- Disabled by default and always under Strict privacy, no consent, GPC, blocked URLs or blocked canvas/ancestors. No pixel scraping outside an opted-in recording.
- Lazy canvas module at most 6,144 bytes gzip. Preserve core 26,624 and recorder 30,720 byte gates. Keep parsing and capture logic in that module.
- Up to 2 fps per canvas, WebP quality at most 0.4, maximum side 1,280 pixels. Skip off-screen/hidden/zero-size canvases; catch taint/encoding failures without affecting the host app.
- Emit rrweb type 3/source 9/type 0 frames: clearRect then drawImage(ImageBitmap(Blob(ArrayBuffer(base64), image/webp)), 0, 0, originalWidth, originalHeight). Use current mirror IDs. No app drawing-command hooks or changes to WebGL context attributes.
- Stop all sampling on recorder halt and discard asynchronous results after halt, privacy changes or removal. Each checkout samples afresh.
- 20,000,000 bytes of serialized canvas frame events per session, including events captured into the error ring. Persistent counters and Web Locks serialize same-origin tab reservations. Overlapping sessions retain separate counters until their four-hour maximum lifetime passes, so a stale tab cannot overwrite a newer session's allowance. Without storage use the session's in-memory counter. Shared-storage capture fails closed if exclusive locking or storage is unavailable. Different origins cannot share a Web Lock, so global cross-subdomain enforcement remains a backend requirement.
- At cap, emit type 5 custom tag sq-canvas-cap with payload {limit: 20000000, bytes: used}. Keep DOM replay running. Player WP 7.2 must retain the last displayed canvas frame across subsequent checkouts and show the cap marker. Snapshot dataURLs remain disabled, so no unbudgeted pixel bypass exists.
- Player/compactor contract remains native rrweb CanvasMutation. Compactor already filters source 9 against effective canvas/privacy selectors and marks blocks has_canvas. Player must enable canvas only for such data; Erdos owns player implementation.

## Capture and player contract

Before an element's first accepted frame, emit rrweb type 5 custom tag `sq-canvas-ref`, payload
`{id: <current rrweb mirror ID>, key: <positive integer>}`. The key identifies that same canvas
element across recorder checkouts. Scope keys to the segment's `(s, w, p)` tuple; never carry
pixels across sessions or page loads. No host DOM attributes or drawing contexts are modified.

The next type 3 event has data `{source: 9, type: 0, id, commands}`. Commands are:

```json
[
  {"property":"clearRect","args":[0,0,"originalWidth","originalHeight"]},
  {"property":"drawImage","args":[
    {"rr_type":"ImageBitmap","args":[
      {"rr_type":"Blob","data":[{"rr_type":"ArrayBuffer","base64":"WebP bytes"}],"type":"image/webp"}
    ]},0,0,"originalWidth","originalHeight"
  ]}
]
```

The dimension placeholders above are numbers on the wire. The WebP bitmap itself has maximum
side 1,280 pixels. Source dimensions stay unchanged in the DOM. rrweb 2.1.4 renders both the 2D
and WebGL-derived payloads in the browser regression test.

At the byte cap, emit type 5 tag `sq-canvas-cap` with `{limit: 20000000, bytes: <reserved bytes>}`.
After later checkouts, known canvas elements emit `sq-canvas-ref` with their new mirror IDs and
the same keys, without reading any more pixels. These identity-only markers remain subject to
selection, Strict, visibility and block/ancestor checks. The player can retain the last bitmap
by key and apply it to the new ID. New page loads or newly created elements have no inherited
bitmap. Metadata markers do not spend the pixel-frame byte allowance.

WP7.2 must implement the reference/cap markers, cap UI, last-frame retention and seek tests.
Native rrweb alone ignores those custom markers. The browser test proves native bitmap playback,
not those future player features. Keep this candidate unpublished until that integration passes.

## Tasks

1. Write failing config/capture/budget tests, including malformed selectors, absent opt-in and Strict.
2. Implement lazy module, session accounting and bounded bitmap capture.
3. Connect to recorder start/halt with generation guards; preserve SDK 2.1 candidate and select 2.2.0 versioned artifacts.
4. Add real Chromium checks for 2D, WebGL, WebP dimensions, taint, off-screen pause, consent, cap/reload/session rotation, and default-off chunk loading.
5. Build and verify all unit, bundle, browser and fixture tests; enforce unchanged gates plus new canvas gate.
6. Independently self-review the final diff, push a separate draft PR and return exact tests and player contract. No merge or publication.

The PR body records completed validation and release prerequisites.

## Review focus

1. Late asynchronous frames must never escape a stopped recording or become a new session's pixels.
2. Invalid selectors must fail closed, including invalid block selectors and shadow ancestors.
3. A cap must survive restart/reload and concurrent same-origin tabs, without retaining session IDs after consent withdrawal.
4. A tainted or lost-context canvas must not stop unrelated canvases or mutate the application context.
5. Frame bytes and last-frame semantics must agree with compactor/player behavior, including seeking and new full snapshots.
