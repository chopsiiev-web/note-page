// Run with: claude plugin test <this mod's folder>
// One test per defect a review found in the mod file: each failed before its fix.
import { test, expect, mock } from 'claude-code/testing'

const HOME = '/home/u'
const ID = 'sess-1234-abcd-ef'
const dirOf = (id: string) => HOME + '/.claude/note-page/sessions/' + id + '.json'
const FILE = dirOf(ID)

function world(on: any, opts: any = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const log: any = { writes: [], spawns: [], submits: [], commands: [], toasts: [], runs: [], fetches: [], order: [], reads: [] }
  const state = { id: ID }
  mock.env(on, { HOME })
  on('session.id', () => ({ value: state.id }))
  on('session.root', () => ({ value: '/Users/x/Projects' }))
  on('session.cwd', () => ({ value: '/Users/x/Projects' }))
  on('fs.exists', (_$: any, e: any) => ({ value: [...files.keys()].some((k) => k === e.path || k.startsWith(e.path + '/')) }))
  on('session.messages', () => ({ value: opts.rows ?? [] }))
  on('fs.read', async (_$: any, e: any) => {
    log.reads.push(e.path)
    const had = files.get(e.path) // what the disk held when the read began
    if (opts.read) await opts.read(e)
    return had !== undefined ? { value: had } : { deny: 'ENOENT: ' + e.path }
  })
  on('fs.write', (_$: any, e: any) => { if (e.path.endsWith('/pane-trace.json')) { (log.traces ??= []).push(JSON.parse(e.text)); return { value: undefined } } if (e.path.endsWith('/note-page-opening.html')) { (log.temp ??= []).push(e.path); return { value: undefined } } files.set(e.path, e.text); log.writes.push({ path: e.path, data: JSON.parse(e.text) }); return { value: undefined } })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('command.list', async () => { if (opts.list) await opts.list(); return { value: opts.commands ?? [] } })
  on('ui.toast', (_$: any, e: any) => { log.toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', (_$: any, e: any) => { log.submits.push(e); log.order.push(e.text); return opts.submit ? opts.submit(e) : { text: e.text } })
  on('command.run', (_$: any, e: any) => { log.commands.push(e); log.order.push('/' + e.command + ' ' + e.args); return { text: '' } })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('process.run', (_$: any, e: any) => { if (e.argv[0] === '/bin/sh') return { value: { exitCode: 0, stdout: opts.engine ?? '/usr/local/bin/node\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }; (e.argv[0] === 'rm' || e.argv[0] === 'rmdir' ? (log.swept ??= []) : log.runs).push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('tool.call', (_$: any, e: any) => { (log.tools ??= []).push(e.tool); return opts.tool ? opts.tool(e) : { deny: 'not here' } })
  on('mcp.call', (_$: any, e: any) => { (log.mcp ??= []).push([e.server, e.tool, e.args]); return opts.mcp ? opts.mcp(e) : { deny: 'no such server' } })
  on('http.fetch', (_$: any, e: any) => { log.fetches.push(e.url); return { value: { status: 200, ok: true, headers: {}, text: '{"open":false}' } } })
  return { files, log, state }
}

const START = { cwd: '/Users/x/Projects', surface: null, isInteractive: false }
const typed = (text: string, kind = 'composer') => ({ text, wait: false, origin: { kind } as any })
const turn = (answer: string, more: any = {}) => ({ answer, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...more } as any)
function helper(log: any) {
  let wake: () => void = () => {}
  const queue: (string | null)[] = []
  const feed = (s: string | null) => { queue.push(s); wake() }
  const gen = async function* (_$: any, e: any) {
    log.spawns.push(e.argv)
    for (;;) {
      while (queue.length) {
        const s = queue.shift()
        if (s === null || s === undefined) return { value: { code: 0, signal: null } }
        yield { stream: 'stdout', text: s }
      }
      await new Promise<void>((r) => { wake = r })
    }
  }
  return { gen, feed }
}
const last = (log: any, path = FILE) => log.writes.filter((w: any) => w.path === path).at(-1)?.data

// D1: after a reload (module variables gone, no classic.SessionStart again) the chat's stored
// name must survive until the app says a new one
test('D1 reload keeps the chat name the page shows', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  const { log } = world(on, { files: { [FILE]: JSON.stringify({ label: 'Reel engine: hook rewrite', lastActive: 10, reply: 'r', replyAt: 1 }) } })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  expect(last(log).label).toBe('Reel engine: hook rewrite')
  h.feed(null)
})

// D2: a person's prompt that lands while a (re)load is still reading the session file must not
// have its lastActive pulled back to the stored, older one
test('D2 lastActive does not go backwards when a prompt lands during setup', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let first = true
  const { log } = world(on, {
    files: { [FILE]: JSON.stringify({ label: 'x', lastActive: 10, reply: 'old reply', replyAt: 1 }) },
    read: async (e: any) => { if (e.path === FILE && first) { first = false; await gate } },
  })
  const h = helper(log)
  on('process.spawn', h.gen)
  const starting = $.session.start(START) // the read of the session file is now in flight
  await clock.settle()
  const typing = $.prompt.submit(typed('typed during the reload'))
  await clock.settle()
  release()
  await starting
  await typing
  await clock.settle()
  expect(last(log).lastActive).toBe(9000)
  h.feed(null)
})

// D3: the same window, for the reply: a turn that completes while setup reads must not be
// replaced by the stored, older reply
test('D3 a newer reply is not overwritten by the stored one', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let first = true
  const { log } = world(on, {
    files: { [FILE]: JSON.stringify({ label: 'x', lastActive: 10, reply: 'old reply', replyAt: 1 }) },
    read: async (e: any) => { if (e.path === FILE && first) { first = false; await gate } },
  })
  const h = helper(log)
  on('process.spawn', h.gen)
  const starting = $.session.start(START)
  await clock.settle()
  const completing = $.turn.complete(turn('new reply'))
  await clock.settle()
  release()
  await starting
  await completing
  await clock.settle()
  expect(last(log).reply).toBe('new reply')
  h.feed(null)
})

// D4: /clear ends the conversation; the process goes on under a new id with no session.start.
// The reply offered for quoting must not be the cleared conversation's.
test('D4 after /clear the old conversation\'s reply is not offered', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  const { log, state } = world(on)
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await $.prompt.submit(typed('hi'))
  await $.turn.complete(turn('answer of the old conversation'))
  await clock.advance(1000)
  await ($ as any).session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } })
  state.id = 'sess-NEW-after-clear'
  await $.prompt.submit(typed('first prompt of the new conversation'))
  await clock.advance(1000)
  const now = log.writes.at(-1)
  expect(now.path).toBe(dirOf('sess-NEW-after-clear'))
  expect(now.data.reply).toBe('')
  h.feed(null)
})

// D5: a prompt the engine did not take (a hook dropped it) is told to the user
test('D5 a dropped page is reported', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  const { log } = world(on, { files: { [FILE]: JSON.stringify({ lastActive: 10 }) }, submit: () => ({ drop: 'blocked by a prompt hook' }) })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  h.feed('{"send":"my page"}\n')
  await clock.settle()
  expect(log.submits).toHaveLength(1)
  expect(log.toasts.join('|')).toMatch(/not sent/i)
  h.feed(null)
})

// D6: a helper that says an error and exits is restarted every second; the user must not get
// the same toast every second
test('D6 a failing helper does not toast every second', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  const { log } = world(on, { files: { [FILE]: JSON.stringify({ lastActive: 10 }) } })
  on('process.spawn', async function* (_$: any, e: any) {
    log.spawns.push(e.argv)
    yield { stream: 'stdout', text: '{"error":"The note page could not read its key file"}\n' }
    return { value: { code: 1, signal: null } }
  })
  await $.session.start(START)
  for (let i = 0; i < 10; i++) await clock.advance(1000)
  expect(log.spawns.length).toBeGreaterThan(5) // restarted each second, as written
  expect(log.toasts.length).toBeLessThan(3)
})

// D7: two pages sent one after the other arrive in the order they were sent
test('D7 a sharpened page does not fall behind the plain page sent after it', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const { log } = world(on, { files: { [FILE]: JSON.stringify({ lastActive: 10 }) }, commands: [{ name: 'prompt-sharpen', description: '', source: 'user' }], list: () => gate })
  const h = helper(log)
  on('process.spawn', h.gen)
  await $.session.start(START)
  await clock.settle()
  h.feed('{"send":"first, sharpened","sharpen":true}\n{"send":"second, plain"}\n')
  await clock.settle()
  release()
  await clock.settle()
  expect(log.order).toEqual(['/prompt-sharpen first, sharpened', 'second, plain'])
  h.feed(null)
})

// D8: the other order in the same window: a turn completes first, session.start second
test('D8 a used chat keeps its helper when turn.complete runs setup first', async ($, on) => {
  const clock = mock.clock(on, { now: 9000 })
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let first = true
  const { log } = world(on, {
    files: { [FILE]: JSON.stringify({ label: 'x', lastActive: 10, reply: 'old reply', replyAt: 1 }) },
    read: async (e: any) => { if (e.path === FILE && first) { first = false; await gate } },
  })
  const h = helper(log)
  on('process.spawn', h.gen)
  const completing = $.turn.complete(turn('new reply'))
  await clock.settle()
  const starting = $.session.start(START)
  await clock.settle()
  release()
  await completing
  await starting
  await clock.advance(3000)
  expect(log.spawns).toHaveLength(1)
  h.feed(null)
})
