# Draft-card attachment E2E

`draft-attachments.e2e.mjs` boots a private DeepSeek Harness instance and drives the talk-map draft card with Playwright. It never touches the desktop profile or `~/.dsh` state: every run builds + packs this plugin, creates a throwaway `DSH_HOME` under the OS temp dir, installs the packed plugin into a `e2e` profile (`dsh-base` + `dsh-web-app` + this plugin), boots `dsh web` on an OS-assigned port with `--no-open`, runs the scenarios, then stops the host and deletes the temp home.

## Preconditions

- Node 24 (the script uses native TypeScript-free ESM and `--port 0`)
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

Failures write a screenshot to `tests/e2e/artifacts/` (git-ignored) and exit non-zero.

## Notes

- The app's locale is whatever Playwright's Chromium reports (English by default); selectors accept both `Talk Map` and `对话地图`.
- The scenarios exercise the intake UI only. Send-time uploads are covered after the upload path lands.
- Each run re-uploads a tiny PNG to `/talk-map/images/upload` for the drawer-image scenario, so that path is exercised too.
