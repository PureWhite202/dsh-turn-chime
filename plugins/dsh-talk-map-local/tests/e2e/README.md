# Draft-card attachment E2E

`draft-attachments.e2e.mjs` boots a private DeepSeek Harness instance and drives the talk-map draft card with Playwright. It never touches the desktop profile or `~/.dsh` state: every run builds + packs this plugin, creates a throwaway `DSH_HOME` under the OS temp dir, installs the packed plugin into an `e2e` profile (`dsh-base` + `dsh-web-app` + this plugin), boots `dsh web` on an OS-assigned port with `--no-open`, runs the scenarios, then stops the host and deletes the temp home.

## Preconditions

- Node 24 (the script uses native ESM and `--port 0`)
- `pnpm` and `dsh` on `PATH`
- Playwright installed globally; if it is not discoverable, set `PLAYWRIGHT_MODULE=/path/to/playwright`
- `~/.dsh/.credentials.yaml` exists. It is copied into the temp home **at runtime only** so the fresh profile is signed in and the "Get started" dialog does not block the map. The copy is deleted with the temp home; nothing from it is printed or committed.

## Run

```sh
cd ~/.dsh/my-dsh/plugins/dsh-talk-map-local
node tests/e2e/draft-attachments.e2e.mjs
```

## Scenarios

0. macOS chrome: setting `data-platform=darwin` on `<html>` (as the desktop shell does) moves the map header below `--dsh-frame-top-clearance`, so the native traffic lights never cover the title.
0. double-click empty canvas → the conversation is created and opened in the drawer, with no draft box (the plain double-click no longer opens the form).
1. paste an image → one image attachment with a `blob:` preview; the paste is consumed.
2. paste text + image → image attached **and** the paste is not consumed, so the textarea keeps its text.
3. drop a PDF → a generic-file card with name; no canvas image node is created.
4. drop the map's drawer-image payload (`application/x-talk-map-image`) → fetched into an image attachment; no canvas image node is created.
5. remove an attachment → the rail empties.
6. send an image-only draft → the draft is replaced by a session card, the drawer opens, and the sent image appears in the conversation.
7. send a file-only draft (empty textarea) → Send is enabled, a second session card appears, and the drawer shows the file name.
8. host refusal (a file declared `image/png` whose bytes are not an image) → the error row appears, the draft survives, and no session card is added.
9. Escape while a 200 MB upload is starting → a second paste during the busy state is ignored, the draft closes, no page error escapes, and no session card is added for the aborted send.
10. send still works after an aborted draft → a fresh draft's first message creates a session card normally.

The macOS scenario only proves the CSS clearance in Chromium (it toggles the same `data-platform` attribute the desktop shell sets); the native traffic lights themselves only exist in the Electron window.

The success scenarios really call the configured model (the prompt is accepted before the model replies); only the throwaway host is affected. The Escape scenario uses 200 MB so the send is still in flight when the test pastes and closes the draft — a 20 MB upload can finish before the assertions.

Failures write a screenshot to `tests/e2e/artifacts/` (git-ignored) and exit non-zero.

## Notes

- The app's locale is whatever Playwright's Chromium reports (English by default); selectors accept both `Talk Map`/`对话地图` and the drawer/close labels.
- The test PNG is a valid, fully decodable 64×64 image: the Host's `sharp` admission rejects header-only or CRC-broken 1×1 fixtures with `attachment-invalid`, which is exactly what scenario 8 exercises with deliberately corrupt bytes.
- `openDraft` opens the form through the pane context menu ("New conversation (fill in first)…") and retries a few known-empty canvas points: a right-click on a card or frame opens that node's own menu, and the drawer covers the right edge of the canvas.
- Each run re-uploads the PNG to `/talk-map/images/upload` for the drawer-image scenario, so that path is exercised too.

# Right-button gesture E2E

`context-menu-gesture.e2e.mjs` runs the same private-host setup (build + pack, throwaway `DSH_HOME`/`e2e` profile, `dsh web --port 0`) but only exercises the board's right-button contract on a fresh, empty board:

1. a plain right click opens the context menu, anchored at the press point;
2. a jittery right click (a few pixels) still opens it;
3. a right drag pans the viewport and never opens the menu — not while the button is down, not after the release;
4. a right click after a drag still opens the menu (the drag leaves no sticky gesture behind).

It exists because Chromium raises `contextmenu` on the right-button **press**, before the pointer has moved: the board has to hold the request until the release to tell a click from a pan. Preconditions are the same as above.
