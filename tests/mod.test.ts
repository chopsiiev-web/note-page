// Run with: claude plugin test <this mod's folder>   (the engine's own test kit)
// Every $ call the mod makes is answered by the stand-ins in world(): no process starts, no
// browser opens, nothing reaches a model.
import { test, expect, mock } from 'claude-code/testing'

const HOME = '/home/u'
const ID = 'sess-1234-abcd-ef'
const FILE = HOME + '/.claude/note-page/sessions/' + ID + '.json'
const KEYFILE = HOME + '/.claude/note-page/key'

// The world beneath the mod: every $ call it makes is answered here and recorded
function world(on: any, opts: any = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const log: any = { writes: [], spawns: [], submits: [], commands: [], toasts: [], runs: [], fetches: [], order: [], reads: [] }
  mock.env(on, { HOME })
  on('session.id', () => ({ value: ID }))
  on('session.root', () => ({ value: '/Users/x/Projects' }))
  on('session.cwd', () => ({ value: '/Users/x/Projects' }))
  on('fs.exists', (_$: any, e: any) => ({ value: [...files.keys()].some((k) => k === e.path || k.startsWith(e.path + '/')) }))
  on('session.messages', () => ({ value: opts.rows ?? [] }))
  on('fs.read', async (_$: any, e: any) => {
    log.reads.push(e.path)
    if (opts.read) await opts.read(e)
    return files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT: ' + e.path }
  })
  on('fs.write', (_$: any, e: any) => { if (e.path.endsWith('/pane-trace.json')) { (log.traces ??= []).push(JSON.parse(e.text).runs.at(-1)); files.set(e.path, e.text); return { value: undefined } } if (e.path.endsWith('/note-page-opening.html')) { (log.temp ??= []).push(e.path); return { value: undefined } } files.set(e.path, e.text); log.writes.push({ path: e.path, data: JSON.parse(e.text) }); return { value: undefined } })
  on('command.register', (_$: any, e: any) => { log.registered = e; return { value: { command: e.name } } })
  on('command.list', async () => { if (opts.list) await opts.list(); return { value: opts.commands ?? [] } })
  on('ui.toast', (_$: any, e: any) => { log.toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', (_$: any, e: any) => { log.submits.push(e); log.order.push('submit:' + e.text); return opts.submit ? opts.submit(e) : { text: e.text } })
  on('command.run', (_$: any, e: any) => { log.commands.push(e); log.order.push('command:' + e.command); return { text: '' } })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('process.run', (_$: any, e: any) => { if (e.argv[0] === '/bin/sh') return { value: { exitCode: 0, stdout: opts.engine ?? '/usr/local/bin/node\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }; (e.argv[0] === 'rm' || e.argv[0] === 'rmdir' ? (log.swept ??= []) : log.runs).push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('tool.call', (_$: any, e: any) => { (log.tools ??= []).push(e.tool); return opts.tool ? opts.tool(e) : { deny: 'not here' } })
  on('mcp.call', (_$: any, e: any) => { (log.mcp ??= []).push([e.server, e.tool, e.args]); return opts.mcp ? opts.mcp(e) : { deny: 'no such server' } })
  on('http.fetch', (_$: any, e: any) => { log.fetches.push(e.url); return { value: opts.fetch ? opts.fetch(e) : { status: 200, ok: true, headers: {}, text: '{"open":false}' } } })
  return { files, log }
}

const START = { cwd: '/Users/x/Projects', surface: null, isInteractive: false }
const typed = (text: string, kind = 'composer') => ({ text, wait: false, origin: { kind } as any })
const turn = (answer: string, more: any = {}) => ({ answer, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...more } as any)
const page = (kind = 'composer') => ({ command: 'page', args: '', origin: { kind } as any, presentation: { isFullscreen: false, columns: 80 } })
// A helper that stays up: says what the test feeds it, piece by piece, until released
function helper(log: any) {
  let push: (s: string | null) => void = () => {}
  const queue: (string | null)[] = []
  const feed = (s: string | null) => { queue.push(s); push(s) }
  const gen = async function* (_$: any, e: any) {
    log.spawns.push(e.argv)
    for (;;) {
      while (queue.length) {
        const s = queue.shift()
        if (s === null) return { value: { code: 0, signal: null } }
        yield { stream: 'stdout', text: s }
      }
      await new Promise<void>((r) => { push = () => r() })
    }
  }
  return { gen, feed }
}

test('fresh chat, nobody typed: no helper, no file', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const { log } = world(on)
  on('process.spawn', async function* (_$: any, e: any) { log.spawns.push(e.argv); return { value: { code: 0, signal: null } } })
  await $.session.start(START)
  await clock.advance(3000)
  expect(log.spawns).toHaveLength(0)
  expect(log.writes).toHaveLength(0)
  expect(log.registered).toMatchObject({ name: 'page', immediate: true })
})

test('sdk prompt does not mark the chat; composer prompt does, and the helper starts on the next tick', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const { log } = world(on)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await $.prompt.submit(typed('from a script', 'sdk'))
  await clock.advance(1500)
  expect(log.writes).toHaveLength(0)
  expect(log.spawns).toHaveLength(0)
  await $.prompt.submit(typed('hello'))
  await clock.settle()
  expect(log.writes.at(-1).data).toMatchObject({ lastActive: clock.now(), label: 'Projects · sess-123' })
  await clock.advance(1000)
  expect(log.spawns).toHaveLength(1)
  expect(log.spawns[0].at(-1)).toBe(ID)
  expect(log.spawns[0]).toEqual(['/usr/local/bin/node', expect.stringMatching(/page\/server\.mjs$/), ID])
  h.feed(null)
})

test('the helper runs on Deno when that is what the computer has; with no engine at all, /page says what to install', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const opts: any = { engine: '/Users/x/.deno/bin/deno\n', files: { [FILE]: JSON.stringify({ lastActive: 10 }) } }
  const { log } = world(on, opts)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  expect(log.spawns[0].slice(0, 3)).toEqual(['/Users/x/.deno/bin/deno', 'run', '-A'])
  h.feed(null)
})

test('no Node, Bun or Deno: nothing is started, the person is told once, and installing one is enough', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const opts: any = { engine: '', files: { [FILE]: JSON.stringify({ lastActive: 10 }) } }
  const { log } = world(on, opts)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.advance(5000)
  expect(log.spawns).toHaveLength(0)
  expect(log.toasts.filter((t: string) => /nodejs\.org/.test(t))).toHaveLength(1)
  opts.engine = '/usr/local/bin/node\n' // installed now
  await clock.advance(31000)
  expect(log.spawns).toHaveLength(1)
  h.feed(null)
})

test('a send line split across two pieces is delivered once, as the user; "/" text gets a plain lead', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const { log } = world(on, { files: { [FILE]: JSON.stringify({ label: 'x', lastActive: 10, reply: 'old', replyAt: 1 }) } })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  expect(log.spawns).toHaveLength(1)
  h.feed('{"role":"link","url":"http://localhost:47821/"}\n{"send":"hel')
  await clock.settle()
  expect(log.submits).toHaveLength(0)
  h.feed('lo\\nworld"}\n{"send":"/clear"}\n')
  await clock.settle()
  expect(log.submits.map((s: any) => s.text)).toEqual(['hello\nworld', 'From my note page:\n\n/clear'])
  expect(log.submits[0].origin).toMatchObject({ kind: 'plugin', name: 'note-page', asUser: true })
  // the page's own delivery is not "a person typed here"
  expect(log.writes.filter((w: any) => w.data.lastActive !== 10)).toHaveLength(0)
  h.feed(null)
})

test('sharpen: through the skill when it is a command, in plain words when it is not', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const { log } = world(on, { commands: [{ name: 'prompt-sharpen', description: '', source: 'user' }], files: { [FILE]: JSON.stringify({ lastActive: 10 }) } })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  h.feed('{"send":"make it better","sharpen":true}\n')
  await clock.settle()
  expect(log.commands).toHaveLength(1)
  expect(log.commands[0]).toMatchObject({ command: 'prompt-sharpen', args: 'make it better', origin: { kind: 'plugin', name: 'note-page' } })
  expect(log.submits).toHaveLength(0)
  h.feed(null)
})

test('sharpen without the skill falls back to a plain prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const { log } = world(on, { commands: [], files: { [FILE]: JSON.stringify({ lastActive: 10 }) } })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  h.feed('{"send":"make it better","sharpen":true}\n')
  await clock.settle()
  expect(log.commands).toHaveLength(0)
  expect(log.submits[0].text).toMatch(/^First rewrite the message below as a clear prompt/)
  h.feed(null)
})

test('turn.complete stores the reply for a used chat only', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const { log } = world(on)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await $.turn.complete(turn('first answer'))
  await clock.settle()
  expect(log.writes).toHaveLength(0)
  await $.prompt.submit(typed('hi'))
  await clock.settle()
  expect(log.writes.at(-1).data).toMatchObject({ reply: 'first answer', lastActive: 5000 })
  await $.turn.complete(turn('sub', { agentId: 'a1' }))
  await $.turn.complete(turn('', { reason: 'aborted', isAborted: true }))
  await $.turn.complete(turn('second answer'))
  await clock.settle()
  expect(log.writes.at(-1).data).toMatchObject({ reply: 'second answer', replyAt: 5000 })
  h.feed(null)
})

test('/page: sdk refused; a person with no helper line yet waits four seconds then says why', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const { log } = world(on)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  expect((await $.command.run(page('sdk'))).text).toMatch(/only opens for a person/)
  expect(log.writes).toHaveLength(0)
  let out: any
  const run = $.command.run(page()).then((r) => { out = r })
  for (let i = 0; i < 25 && !out; i++) await clock.advance(200)
  await run
  expect(log.spawns).toHaveLength(1)
  expect(out.text).toMatch(/did not start/)
  h.feed(null)
})

test('/page: helper answers; no page open -> Chrome app window; page open -> says so', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  let open = false
  const { log } = world(on, { files: { [KEYFILE]: 'k'.repeat(32) + '\n' }, fetch: () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify({ open }) }) })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  let out: any
  let run = $.command.run(page()).then((r) => { out = r })
  await clock.advance(1000)
  h.feed('{"role":"hub","url":"http://localhost:47821/"}\n')
  for (let i = 0; i < 25 && !out; i++) await clock.advance(200)
  await run
  expect(out).toEqual({})
  expect(log.fetches[0]).toBe('http://127.0.0.1:47821/pages?k=' + 'k'.repeat(32))
  // the window opens the door file, which lets that browser in and lands on the page
  expect(log.runs[0]).toEqual(['open', '-na', 'Google Chrome', '--args', '--app=file:///home/u/.claude/note-page/open.html', '--window-size=900,1000'])
  // /page claims the page for this chat: an open page moves here
  expect(log.writes.at(-1).data.claimedAt).toBe(log.writes.at(-1).data.lastActive)
  expect(log.writes.at(-1).data.claimedAt).toBeGreaterThan(0)
  open = true
  out = undefined
  run = $.command.run(page()).then((r) => { out = r })
  await clock.settle()
  await run
  expect(out.text).toMatch(/now goes to this chat/)
  expect(log.runs).toHaveLength(1)
  h.feed(null)
})

test('a slash command typed by a person counts as using the chat; one run by a plugin does not', async ($, on) => {
  const clock = mock.clock(on, { now: 7000 })
  const { log } = world(on)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await $.command.run({ command: 'banger', args: 'story', origin: { kind: 'plugin', name: 'x' } as any, presentation: { isFullscreen: false, columns: 80 } })
  await clock.advance(1500)
  expect(log.writes).toHaveLength(0)
  expect(log.spawns).toHaveLength(0)
  await $.command.run({ command: 'banger', args: 'story', origin: { kind: 'composer' } as any, presentation: { isFullscreen: false, columns: 80 } })
  await clock.advance(1500)
  expect(log.writes.at(-1).data.lastActive).toBeGreaterThan(0)
  expect(log.writes.at(-1).data.claimedAt).toBe(0)
  expect(log.spawns).toHaveLength(1)
  h.feed(null)
})

test('a page is noted as taken, which is what lets the page say "sent"; the same page pressed twice is delivered once', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  const { log } = world(on)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await $.prompt.submit(typed('hi'))
  await clock.advance(1500)
  h.feed('{"role":"hub","url":"http://localhost:47821/"}\n')
  h.feed('{"send":"once","id":"page-0001"}\n')
  h.feed('{"send":"once","id":"page-0001"}\n')
  await clock.settle()
  expect(log.submits.filter((e: any) => e.origin.kind === 'plugin').map((e: any) => e.text)).toEqual(['once'])
  expect(log.writes.at(-1).data.seen).toEqual(['page-0001'])
  h.feed(null)
})

// A stand-in for the Claude app's browser pane. It behaves as the real one was seen to: a web
// page opened by a mod creates its tab but leaves the pane tucked away; opening a local file
// brings the pane on screen ('stuck': not even that does).
function paneStandIn(start: 'closed' | 'shown' | 'hidden' | 'stuck') {
  const NOTE = 'http://localhost:47821'
  const pane = { tabs: start === 'closed' ? [] as any[] : [{ tabId: 'tab-7', origin: NOTE, isActive: true }], state: start === 'closed' ? 'hidden' : start, n: 7 }
  const answer = (text: string) => ({ value: { content: [{ type: 'text', text }], isError: false } })
  const mcp = (e: any) => {
    if (e.tool === 'tabs_context') {
      // word for word what the real pane says in each state; the "isn't open yet" sentence has braces in it
      const line = pane.tabs.length === 0 ? 'The Browser pane isn\'t open yet, so there are no tabs. Call preview_start or navigate with {"url": "https://…"} to open it.' : pane.state === 'shown' ? 'The Browser pane is currently displayed.' : 'The Browser pane is currently hidden.'
      return answer(JSON.stringify({ browserOpen: pane.tabs.length > 0, tabs: pane.tabs }, null, 2) + '\n' + line)
    }
    if (e.tool === 'tabs_close') pane.tabs = pane.tabs.filter((t: any) => t.tabId !== e.args.tabId)
    if (e.tool === 'preview_start') {
      const file = String(e.args.url).startsWith('file://')
      // a file opened on a closed pane: the real pane starts with a blank tab, then adds the file's
      if (file && pane.tabs.length === 0) pane.tabs.push({ tabId: 'seed', origin: '', isActive: false })
      pane.tabs.push({ tabId: 'tab-' + ++pane.n, origin: file ? e.args.url : NOTE, isActive: true })
      if (file && pane.state !== 'stuck') pane.state = 'shown'
    }
    return answer('ok')
  }
  return { pane, mcp }
}

test('typing "/pa…" brings the pane up before Enter, once, and only when it can mean nothing but /page', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const stand = paneStandIn('hidden')
  const opts: any = { mcp: stand.mcp, commands: [{ name: 'page', description: '', source: 'plugin' }, { name: 'pause', description: '', source: 'user' }], files: { [FILE]: JSON.stringify({ lastActive: 10 }), ['/home/u/.claude/note-page/key']: 'k'.repeat(32) } }
  const { log } = world(on, opts)
  const acts: any[] = (log.mcp = [])
  // the engine's own part of an edit: the splice applied
  on('prompt.edit', (_$: any, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  h.feed('{"role":"hub","url":"http://localhost:47821/"}\n')
  await clock.settle()
  const type = async (before: string, ch: string) => { const box = await $.prompt.edit({ origin: { kind: 'composer' }, text: before, cursor: before.length, start: before.length, end: before.length, inputText: ch }); await clock.advance(400); return box }
  // the key itself always goes through unchanged
  expect(await type('', '/')).toMatchObject({ text: '/' })
  expect(await type('/', 'p')).toMatchObject({ text: '/p' })
  // "/pa" could still become /pause: nothing yet
  await type('/p', 'a')
  expect(acts.filter((a) => a[1] === 'preview_start')).toHaveLength(0)
  // "/pag" can only be /page: the pane comes up now, with no toast and no claim on the chat
  await type('/pa', 'g')
  expect(acts.filter((a) => a[1] === 'preview_start').map((a) => String(a[2].url))).toEqual(['file:///Users/x/Projects/.claude/note-page-opening.html'])
  expect(stand.pane.state).toBe('shown')
  expect(log.traces.at(-1)).toMatchObject({ via: 'typing', result: 'shown' })
  expect(log.toasts).toHaveLength(0)
  expect(log.writes.some((w: any) => w.data.claimedAt > 0)).toBe(false)
  // the last letter does not start a second one
  const before = acts.length
  await type('/pag', 'e')
  expect(acts.length).toBe(before)
  // Enter: the pane is already on screen, so /page opens no file, and now the chat is claimed
  const out = await $.command.run({ command: 'page', args: '', origin: { kind: 'composer' } })
  expect(out).toEqual({})
  expect(acts.slice(before).filter((a) => a[1] === 'preview_start')).toHaveLength(0)
  expect(log.traces.at(-1)).toMatchObject({ via: 'command', result: 'shown' })
  expect(log.writes.at(-1).data.claimedAt).toBeGreaterThan(0)
  // other text in the box never does any of this
  for (const [b, c] of [['', 'h'], ['h', 'i'], ['/', 'x'], ['/pagex', 'y'], ['say /pa', 'g']]) await type(b, c)
  expect(acts.slice(before).filter((a) => a[1] === 'preview_start')).toHaveLength(0)
  h.feed(null)
})

test('/page in the Claude app shows the page in the app\'s own browser pane, and opens no other window', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const stand = paneStandIn('closed')
  const { log } = world(on, { files: { [KEYFILE]: 'k'.repeat(32) + '\n' }, mcp: stand.mcp })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  let out: any
  let run = $.command.run(page()).then((r) => { out = r })
  await clock.advance(1000)
  h.feed('{"role":"hub","url":"http://localhost:47821/"}\n')
  for (let i = 0; i < 25 && !out; i++) await clock.advance(200)
  await run
  expect(out).toEqual({})
  // pane closed: a local file goes up first, which brings the pane on screen at once; then the
  // page's tab is opened with the key after the #, fronted, and the helper tabs are closed
  // (how many times it looks at the pane in between does not matter)
  const acts = log.mcp.filter((c: any) => c[1] !== 'tabs_context')
  expect(acts.map((c: any) => c[1] + (c[1] === 'preview_start' ? (String(c[2].url).startsWith('file://') ? ':file' : ':page') : ''))).toEqual(['preview_start:file', 'preview_start:page', 'tabs_select', 'tabs_close', 'tabs_close'])
  // the file that brings the pane forward lives in the chat's own folder for a moment (the app
  // opens that without asking) and is removed again; the folder made for it too
  expect(String(acts[0][2].url)).toBe('file:///Users/x/Projects/.claude/note-page-opening.html')
  expect(log.temp).toEqual(['/Users/x/Projects/.claude/note-page-opening.html'])
  expect(log.swept).toEqual([['rm', '-f', '/Users/x/Projects/.claude/note-page-opening.html'], ['rmdir', '/Users/x/Projects/.claude']])
  expect(acts[1][2]).toEqual({ url: 'http://localhost:47821/#' + 'k'.repeat(32) })
  expect(stand.pane.state).toBe('shown')
  expect(stand.pane.tabs.map((t: any) => t.origin)).toEqual(['http://localhost:47821']) // only the page's tab is left
  // each try leaves a short trace on disk, without the key in it
  expect(log.traces.at(-1).result).toBe('shown')
  expect(JSON.stringify(log.traces)).not.toContain('k'.repeat(32))
  expect(log.runs).toHaveLength(0) // no Chrome window
  expect(log.writes.at(-1).data.claimedAt).toBeGreaterThan(0) // and the page is pointed at this chat

  // the page is already in the pane and on screen: its tab comes to the front, nothing new opens
  log.mcp.length = 0
  out = undefined
  run = $.command.run(page()).then((r) => { out = r })
  await clock.settle()
  await run
  expect(log.mcp.map((c: any) => c[1])).toEqual(['tabs_context', 'tabs_select', 'tabs_context'])
  expect(out).toEqual({})

  // the pane is tucked away with the page in it: only the local file is opened, to bring it back
  stand.pane.state = 'hidden'
  log.mcp.length = 0
  out = undefined
  run = $.command.run(page()).then((r) => { out = r })
  await clock.settle()
  await run
  expect(log.mcp.filter((c: any) => c[1] !== 'tabs_context').map((c: any) => c[1])).toEqual(['preview_start', 'tabs_select', 'tabs_close'])
  expect(stand.pane.state).toBe('shown')
  expect(out).toEqual({})

  // the pane would not come on screen at all: the person is told where to click, instead of silence
  stand.pane.state = 'stuck'
  out = undefined
  run = $.command.run(page()).then((r) => { out = r })
  for (let i = 0; i < 60 && !out; i++) await clock.advance(200) // it gives the app eight seconds before giving up
  await run
  expect(out.text).toMatch(/globe icon/)
  // no second file from outside the chat's folder: that one makes the app ask "allow?" every time
  expect(log.traces.at(-1).trace.map((t: any) => t.step)).toEqual(['start', 'local file opened, which brings the pane on screen', 'end'])
  expect(log.mcp.filter((a: any) => a[1] === 'preview_start' && /reveal\.html/.test(String(a[2].url)))).toHaveLength(0)
  expect(log.traces.at(-1).trace.every((t: any) => typeof t.ms === 'number')).toBe(true) // each step is timed
  expect(log.runs).toHaveLength(0)
  h.feed(null)
})

test('the button above the message box opens the page with one click, on both surfaces', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  const stand = paneStandIn('closed')
  const { log } = world(on, { files: { [KEYFILE]: 'k'.repeat(32) + '\n' }, mcp: stand.mcp })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'note-page', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } } as any)
    log.mcp = []
    let done = false
    const pressing = ui.press({ key: 'note-page' }).then(() => { done = true })
    await clock.advance(1000)
    h.feed('{"role":"hub","url":"http://localhost:47821/"}\n')
    for (let i = 0; i < 25 && !done; i++) await clock.advance(200)
    await pressing
    expect(log.mcp.map((c: any) => c[1])).toContain('tabs_context')
    expect(stand.pane.state).toBe('shown')
    expect(log.runs).toHaveLength(0)
    expect(log.writes.at(-1).data.claimedAt).toBeGreaterThan(0)
    await ui.unmount()
  }
  h.feed(null)
})

test('the page is told when Claude is working and when it has answered', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  const { log } = world(on)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await $.prompt.submit(typed('do the thing'))
  await clock.settle()
  await $.turn.start({ text: 'do the thing', turnId: 't1' } as any)
  await clock.settle()
  expect(log.writes.at(-1).data.busy).toBe(true)
  // a helper agent finishing does not end the chat's turn
  await $.turn.complete(turn('sub answer', { agentId: 'agent-1' }))
  await clock.settle()
  expect(log.writes.at(-1).data.busy).toBe(true)
  await $.turn.complete(turn('the answer'))
  await clock.settle()
  expect(log.writes.at(-1).data).toMatchObject({ busy: false, reply: 'the answer' })
  // an interrupted turn also ends the "working" state, and keeps the last real answer
  await $.turn.start({ text: 'again', turnId: 't2' } as any)
  await $.turn.complete(turn('half', { reason: 'aborted', isAborted: true }))
  await clock.settle()
  expect(log.writes.at(-1).data).toMatchObject({ busy: false, reply: 'the answer' })
  h.feed(null)
})
