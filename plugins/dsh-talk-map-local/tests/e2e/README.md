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

1. paste an image → one image attachment with a `blob:` preview; the paste is consumed.
2. paste text + image → image attached **and** the paste is not consumed, so the textarea keeps its text.
3. drop a PDF → a generic-file card with name; no canvas image node is created.
4. drop the map's drawer-image payload (`application/x-talk-map-image`) → fetched into an image attachment; no canvas image node is created.
5. remove an attachment → the rail empties.
6. send an image-only draft → the draft is replaced by a session card, the drawer opens, and the sent image appears in the conversation.
7. send a file-only draft (empty textarea) → Send is enabled, a second session card appears, and the drawer shows the file name.
8. host refusal (a file declared `image/png` whose bytes are not an image) → the error row appears, the draft survives, and no session card is added.
9. Escape while a 20 MB upload is starting → the draft closes, no page error escapes, and the host is torn down cleanly.

The success scenarios really call the configured model (the prompt is accepted before the model replies); only the throwaway host is affected.

Failures write a screenshot to `tests/e2e/artifacts/` (git-ignored) and exit non-zero.

## Notes

- The app's locale is whatever Playwright's Chromium reports (English by default); selectors accept both `Talk Map`/`对话地图` and the drawer/close labels.
- The test PNG is a valid, fully decodable 64×64 image: the Host's `sharp` admission rejects header-only or CRC-broken 1×1 fixtures with `attachment-invalid`, which is exactly what scenario 8 exercises with deliberately corrupt bytes.
- `openDraft` retries a few known-empty canvas points: a double-click on an existing session card opens that Session full-screen (closing the map), and the helper reopens the map and tries the next point.
- Each run re-uploads the PNG to `/talk-map/images/upload` for the drawer-image scenario, so that path is exercised too.
