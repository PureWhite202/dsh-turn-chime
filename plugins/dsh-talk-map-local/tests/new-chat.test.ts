import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEW_CHAT_CARD_H,
  NEW_CHAT_CARD_W,
  defaultWorkspaceOption,
  newChatCardPosition,
  newChatFrameRect,
  newConversationWorkspace,
  snapToGrid,
  workspaceDirectoryName,
  type WorkspaceOption,
} from '../src/client/new-chat.ts'

function option(id: string, title: string, path: string): WorkspaceOption {
  return { id, title, path }
}

const DEFAULT_WS = option('ws-default', 'default-workspace', '/Users/me/Documents/deepseek-harness/default-workspace')

test('workspaceDirectoryName strips both separators and trailing slashes', () => {
  assert.equal(workspaceDirectoryName('/a/b/default-workspace/'), 'default-workspace')
  assert.equal(workspaceDirectoryName('C:\\Users\\me\\MyProject'), 'myproject')
  assert.equal(workspaceDirectoryName('plain'), 'plain')
})

test('default workspace is recognised by title, case/space insensitive', () => {
  const options = [option('ws-other', 'Other', '/tmp/other'), option('ws-default', '  Default-Workspace ', '/tmp/x')]
  assert.equal(defaultWorkspaceOption(options), 'ws-default')
})

test('default workspace is recognised by directory name', () => {
  const options = [option('ws-other', 'Other', '/tmp/other'), option('ws-default', '工作区', '/tmp/default-workspace')]
  assert.equal(defaultWorkspaceOption(options), 'ws-default')
})

test('no default workspace yields undefined', () => {
  assert.equal(defaultWorkspaceOption([option('ws-other', 'Other', '/tmp/other')]), undefined)
  assert.equal(defaultWorkspaceOption([]), undefined)
})

test('a click inside a workspace frame keeps that workspace', () => {
  const options = [option('ws-default', 'default-workspace', '/tmp/default-workspace'), option('ws-frame', 'Frame', '/tmp/frame')]
  assert.equal(newConversationWorkspace({ frameWorkspaceId: 'ws-frame', options }), 'ws-frame')
})

test('bare canvas falls back to the default workspace, then to the first one', () => {
  const withDefault = [option('ws-first', 'First', '/tmp/first'), option('ws-default', 'default-workspace', '/tmp/default-workspace')]
  assert.equal(newConversationWorkspace({ options: withDefault }), 'ws-default')
  const withoutDefault = [option('ws-first', 'First', '/tmp/first'), option('ws-second', 'Second', '/tmp/second')]
  assert.equal(newConversationWorkspace({ options: withoutDefault }), 'ws-first')
  assert.equal(newConversationWorkspace({ options: [] }), undefined)
})

test('an empty frame id never wins over the workspace rules', () => {
  const options = [option('ws-default', 'default-workspace', '/tmp/default-workspace')]
  assert.equal(newConversationWorkspace({ frameWorkspaceId: '', options }), 'ws-default')
})

test('new card position centres on the click and snaps to the grid', () => {
  const position = newChatCardPosition(500, 300)
  assert.deepEqual(position, {
    x: snapToGrid(500 - NEW_CHAT_CARD_W / 2),
    y: snapToGrid(300 - 40),
  })
  assert.equal(position.x % 16, 0)
  assert.equal(position.y % 16, 0)
  assert.equal(position.x, 368)
  assert.equal(position.y, 256)
})

test('frame rect wraps the card with padding and a label band', () => {
  const rect = newChatFrameRect(400, 200)
  assert.deepEqual(rect, {
    x: 400 - 32,
    y: 200 - 32 - 30,
    width: 224 + 32 * 2,
    height: NEW_CHAT_CARD_H + 32 * 2 + 30,
  })
})
