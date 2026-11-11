# dsh-talk-map · Talk Map

English | [中文](README.zh.md)

A visual conversation map plugin for DeepSeek Harness (dsh): every session becomes a card on an infinite whiteboard.

- **Spatial memory instead of working memory**: free placement + grid snapping, and nothing ever rearranges your cards — if you remember "that conversation was bottom-left", it stays bottom-left. Designed for ADHD users, useful for everyone.
- **Double-click to chat**: double-click empty canvas (or right-click → New conversation) and the session is created and opened on the spot — no form in the way. A dashed placeholder box appears immediately at the click point (not started, no context menu, no edge handles); the first message promotes it to a normal card carrying the main view's title, and closing the conversation without sending withdraws the box and archives the empty session.
- **Draw an edge to fork**: drop a line from a card's connection point onto empty space — a dashed marker appears there and the right-hand panel opens the fork setup: inheritance mode (none / digest / full history), an editable digest, workspace/model/preset, attachments and the first message. Nothing is created until 「开新对话」 creates the conversation and turns the marker into a card; closing the setup keeps the marker on the board, and clicking it reopens the setup.
- **Card front = resume surface**: title, the digest's "next step", relative time, running state. One glance tells you what to do next.
- **Pick a mode in the side panel**: while a conversation in the right-hand panel is still new, a mode picker sits beside the workspace picker (standard / PTC / minimal / creator, plus any custom modes your deployment ships); once the first message lands, the mode shows beside the panel title — the same split the main view uses. A mode decides the tool and prompt composition, so dsh only allows switching before the first message.
- **Automatic digests**: after a session goes idle, a three-field digest (summary / key findings / next step) is generated with your deployment's default model; hit ⟳ on a card to regenerate manually.
- **Bilingual interface**: the map's own copy renders in Chinese or English. The pill in the map header cycles Auto → 中文 → English; Auto follows dsh's own language, and the choice is remembered across restarts. (Digests stay in the language of the conversation they summarise.)
- **Provenance visible**: dsh's native fork/subagent lineage renders as dashed edges; your injection edges are solid.

## Install

```sh
# GitHub (built artifacts are committed — no build step, no allowBuilds needed)
dsh plugin --profile web add github:Tasihi89/dsh-talk-map
```

npm package (`dsh plugin --profile web add dsh-talk-map`) coming soon.

Restart `dsh web`; a map button appears at the sidebar foot.

## Usage

| Action | Effect |
|---|---|
| Sidebar map button / Esc | toggle the map |
| Drag a card | place it (16px grid snap, persisted) |
| Right-drag / middle-drag empty space | pan the board (a right-drag never opens the menu) |
| Double-click empty space | create a session there and open it; a dashed placeholder box marks the spot until the first message lands |
| Right-click → New conversation | same; the placeholder has no context menu until the conversation starts, and closing it withdraws the box plus archives the empty session |
| Shift+double-click empty space / right-click → New conversation (fill in first)… | open the draft box: pick workspace/model/preset, write the first message, attach files |
| Double-click a card | open that session |
| Click a card / click empty space | open that session in the right-hand panel / put the panel away (a pinned panel stays) |
| Paste or drop files into the draft box | send them as attachments with the first message |
| Drag from a card's connection point to empty space | a marker lands there and the fork setup opens in the right panel; 「开新对话」 creates the fork, and closing the setup keeps the marker |
| ⟳ on a card | regenerate the digest |
| Language pill in the map header | cycle Auto → 中文 → English |
| Drag the conversation panel's left edge | resize the right-hand panel (double-click resets, arrow keys nudge) |
| Mode chip on a new conversation in the right panel | switch that conversation's mode (before its first message; afterwards the badge beside the title is read-only) |

## Where data lives

- Canvas data (positions, edges, digests): `$DSH_HOME/storages/talk_map.json` via dsh's official storage-domain, atomically persisted.
- Sessions themselves stay fully owned by dsh — this plugin reads them, and creates new ones only through official APIs when forking.
- Digests use your configured default model through dsh's local LLM channel; there are no other external requests.

## Compatibility

Built against deepseek-harness `0.2.2-rc.1` (rc-stage APIs may drift). Draft-card attachments additionally require the `dsh-client-file-upload` and `dsh-client-ui-file-drag` client entries, which the 0.2.x `dsh-web-app` bundle ships. The structural contracts live in `src/client/dsh.ts` and `src/host/dsh-host.ts` — start there when upgrading.

## Roadmap

Multi-board shelf (project = board, WIP limit) · whole-board archive/shelve · timeline view (camera fly-back) · alias cards · multi-parent merge UI · selection-level injection · quick-ask on card · two-week fade.

## Development

```sh
pnpm install
pnpm run build        # host → lib/, client → client/client.js
dsh plugin --profile dev add /abs/path/dsh-talk-map
dsh --profile dev     # add a profile patch to change the port and coexist with your main instance
```

MIT License.
