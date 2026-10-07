// Run with: node tests/hub.test.mjs   (and again with NOTE_PAGE_RUNTIME=bun, NOTE_PAGE_RUNTIME="deno run -A")
// Starts real copies of the helper on a test port with a throw-away home folder: routing between
// chats, the guards against other websites, pictures, takeover when a chat closes, updates.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, utimesSync, readdirSync, statSync, rmSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../page', import.meta.url))
const PORT = 47991
// The helper must run the same on every engine the mod may find: NOTE_PAGE_RUNTIME="bun" or "deno run -A"
const RUN = (process.env.NOTE_PAGE_RUNTIME || 'node').split(' ')
const home = mkdtempSync(join(tmpdir(), 'note-page-test-'))
const env = { ...process.env, NOTE_PAGE_HOME: home, NOTE_PAGE_SHOTS: join(home, 'shots'), NOTE_PAGE_PORT: String(PORT) }
const procs = []
function start(id, dir = SRC) {
  const p = spawn(RUN[0], [...RUN.slice(1), join(dir, 'server.mjs'), id], { env })
  p.lines = []
  let buf = ''
  p.stdout.on('data', (c) => {
    buf += c
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      p.lines.push(line)
      // Play the mod's part: note the page's id in the chat's session file, which is what
      // tells the helper the chat has taken the page (p.deaf: a mod that takes nothing)
      if (line.send !== undefined && !p.deaf) {
        const file = join(home, 'sessions', id + '.json')
        let info = {}
        try { info = JSON.parse(readFileSync(file, 'utf8')) } catch {}
        writeFileSync(file, JSON.stringify({ ...info, seen: [...(info.seen || []), line.id] }))
      }
    }
  })
  p.stderr.on('data', (c) => process.stderr.write('[' + id + '] ' + c))
  procs.push(p)
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, test, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = await test(); if (v) return v }
  throw new Error('timed out: ' + what)
}
const role = (p) => p.lines.filter((l) => l.role).at(-1)?.role
const base = 'http://localhost:' + PORT
const origin = { origin: base }

try {
  // what was stored more than 30 days ago is removed when a helper starts; the rest stays
  mkdirSync(join(home, 'shots'), { recursive: true })
  const longAgo = new Date(Date.now() - 31 * 864e5)
  for (const n of ['shot-old-1.png', 'shot-new-1.png', 'not-ours.txt']) writeFileSync(join(home, 'shots', n), 'x')
  for (const n of ['shot-old-1.png', 'not-ours.txt']) utimesSync(join(home, 'shots', n), longAgo, longAgo)
  writeFileSync(join(home, 'history.json'), JSON.stringify([{ at: Date.now() - 1000, text: 'young' }, { at: longAgo.getTime(), text: 'old' }]))
  const A = start('chatA')
  await until('A is the hub', () => role(A) === 'hub')
  const B = start('chatB')
  await until('B links', () => role(B) === 'link')
  writeFileSync(join(home, 'sessions', 'chatA.json'), JSON.stringify({ label: 'Chat A', lastActive: 100 }))
  writeFileSync(join(home, 'sessions', 'chatB.json'), JSON.stringify({ label: 'Chat B', lastActive: 200, reply: 'Hello from Claude', replyAt: 5 }))

  assert.deepEqual(readdirSync(join(home, 'shots')).sort(), ['not-ours.txt', 'shot-new-1.png'], 'only our own old pictures go')
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'history.json'), 'utf8')).map((h) => h.text), ['young'])
  rmSync(join(home, 'history.json'))

  // the page, its key, and its guards
  const pageRes = await fetch(base + '/')
  const html = await pageRes.text()
  // the page is served to anyone but carries no key: a browser gets the key from the door file,
  // which only this account can read
  const key = readFileSync(join(home, 'key'), 'utf8')
  assert.match(key, /^[0-9a-f]{32}$/)
  assert.ok(!html.includes(key), 'the key is not in the page')
  const door = readFileSync(join(home, 'open.html'), 'utf8')
  assert.ok(door.includes(base + '/#' + key), 'the door leads to the page with the key after the #')
  assert.equal(statSync(join(home, 'open.html')).mode & 0o777, 0o600)
  assert.equal(statSync(join(home, 'key')).mode & 0o777, 0o600)
  assert.match(pageRes.headers.get('content-security-policy'), /script-src 'self' 'nonce-/)
  assert.ok(html.includes('nonce="' + /'nonce-([^']+)'/.exec(pageRes.headers.get('content-security-policy'))[1] + '"'))
  assert.ok(!html.includes('__'), 'no placeholder left in the page')
  assert.equal((await fetch(base + '/text.mjs')).status, 200)
  const k = '?k=' + key
  const post = (path, body, headers = origin) => fetch(base + path, { method: 'POST', headers, body })

  assert.equal((await fetch(base + '/sessions')).status, 403, 'no key')
  assert.equal((await post('/send' + k, '{"text":"x"}', { origin: 'http://evil.example' })).status, 403, 'foreign origin')
  assert.equal((await post('/send' + k, '{"text":"x"}', {})).status, 403, 'no origin')
  assert.equal((await post('/send?k=nope', '{"text":"x"}')).status, 403, 'bad key')
  // fetch will not send a made-up Host header or an odd path, so these go through node's plain http
  const raw = (path, headers = {}) => new Promise((done) => get({ host: '127.0.0.1', port: PORT, path, headers }, (r) => { r.resume(); done(r.statusCode) }).on('error', () => done(0)))
  assert.equal(await raw('/', { host: 'evil.example' }), 403, 'foreign host')
  // addresses that do not parse are refused, and the hub stays up
  for (const bad of ['//', '/\\\\', '//?x', '//[']) assert.equal(await raw(bad, { host: 'localhost:' + PORT }), 400, bad)
  assert.equal(await raw('/version', { host: 'localhost:' + PORT }), 200, 'still up')
  // a stranger cannot link itself as a chat: that takes proof of the key, not a guess
  assert.equal(await raw('/stream?session=evil&built=0&n=' + 'a'.repeat(32), { host: 'localhost:' + PORT }), 401, 'asked to sign a one-time word first')
  assert.equal(await raw('/stream?session=evil&built=0&n=' + 'a'.repeat(32) + '&c=' + 'd'.repeat(32) + '&p=' + 'b'.repeat(64), { host: 'localhost:' + PORT }), 401, 'a made-up word and signature get nowhere')
  assert.equal(await raw('/stream?session=evil&k=' + key, { host: 'localhost:' + PORT }), 403, 'the key itself is not accepted there')

  // chats, newest first
  const { sessions, version } = await (await fetch(base + '/sessions' + k)).json()
  assert.deepEqual(sessions.map((s) => [s.label, s.claimedAt, s.replyAt, s.busy]), [['Chat B', 0, 5, false], ['Chat A', 0, 0, false]])
  assert.equal(version, await (await fetch(base + '/version')).text())
  assert.equal((await (await fetch(base + '/reply' + k + '&session=chatB')).json()).text, 'Hello from Claude')

  // sending: default chat, a picked chat, a closed chat, an empty page
  // a page that names no chat is refused: the hub never chooses one
  let out = await (await post('/send' + k, JSON.stringify({ text: 'no chat named' }))).json()
  assert.equal(out.ok, false)
  out = await (await post('/send' + k, JSON.stringify({ text: 'to the last used chat', html: '<div>h</div>', session: sessions[0].id }))).json()
  assert.deepEqual(out, { ok: true, label: 'Chat B' })
  await until('B got it', () => B.lines.some((l) => l.send === 'to the last used chat'))
  out = await (await post('/send' + k, JSON.stringify({ text: '\n\npicked \n', session: 'chatA', sharpen: true }))).json()
  assert.deepEqual(out, { ok: true, label: 'Chat A' })
  await until('A got it', () => A.lines.some((l) => l.send === 'picked' && l.sharpen === true))
  assert.ok(!B.lines.some((l) => l.send === 'picked'), 'only the picked chat gets it')
  out = await (await post('/send' + k, JSON.stringify({ text: 'x', session: 'gone' }))).json()
  assert.equal(out.ok, false)
  out = await (await post('/send' + k, JSON.stringify({ text: '  ' }))).json()
  assert.equal(out.ok, false)
  const hist = await (await fetch(base + '/history' + k)).json()
  assert.deepEqual(hist.map((h) => [h.text, h.label, h.html]), [['picked', 'Chat A', undefined], ['to the last used chat', 'Chat B', '<div>h</div>']])
  // "sent" means the chat's mod took the page. A chat that takes nothing gets "did not confirm",
  // the page keeps its text, and pressing Send again with the same id is answered at once
  // because the id is already noted: nothing is delivered twice.
  B.deaf = true
  out = await (await post('/send' + k, JSON.stringify({ text: 'is anyone there', session: 'chatB', id: 'page-0001' }))).json()
  assert.equal(out.ok, false)
  assert.match(out.error, /did not confirm/)
  assert.ok(!(await (await fetch(base + '/history' + k)).json()).some((h) => h.text === 'is anyone there'), 'not kept as sent')
  B.deaf = false
  out = await (await post('/send' + k, JSON.stringify({ text: 'is anyone there', session: 'chatB', id: 'page-0001' }))).json()
  assert.deepEqual(out, { ok: true, label: 'Chat B' })
  assert.deepEqual(B.lines.filter((l) => l.send === 'is anyone there').map((l) => l.id), ['page-0001', 'page-0001'], 'the mod sees the same id twice and takes it once')
  // the same for the hub's own chat
  A.deaf = true
  out = await (await post('/send' + k, JSON.stringify({ text: 'hub chat, deaf', session: 'chatA' }))).json()
  assert.equal(out.ok, false)
  A.deaf = false

  // a history that cannot be saved does not turn a delivered page into "not sent"
  mkdirSync(join(home, 'history.json.tmp'))
  out = await (await post('/send' + k, JSON.stringify({ text: 'delivered once', session: 'chatA' }))).json()
  assert.deepEqual(out, { ok: true, label: 'Chat A' })
  await until('A got it', () => A.lines.filter((l) => l.send === 'delivered once').length === 1)
  rmSync(join(home, 'history.json.tmp'), { recursive: true })
  // the first line keeps its indent
  await post('/send' + k, JSON.stringify({ text: '\n    indented\nnext\n\n', session: 'chatA' }))
  await until('indent kept', () => A.lines.some((l) => l.send === '    indented\nnext'))

  // pictures
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const shot = await (await post('/shot' + k, png, { ...origin, 'content-type': 'image/png' })).json()
  const shotName = shot.url.slice(6)
  assert.deepEqual(Object.keys(shot), ['url'])
  assert.ok(existsSync(join(home, 'shots', shotName)))
  // the page names a picture by file name only; the hub fills in the full path, and only for its own pictures
  await post('/send' + k, JSON.stringify({ text: 'see\n[screenshot: ' + shotName + ']\n[screenshot: /etc/passwd]', session: 'chatA' }))
  await until('paths filled in', () => A.lines.some((l) => l.send === 'see\n[screenshot: ' + join(home, 'shots', shotName) + ']\n[screenshot: /etc/passwd]'))
  const got = await fetch(base + shot.url)
  assert.equal(got.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png)
  assert.equal((await post('/shot' + k, 'hello', { ...origin, 'content-type': 'text/plain' })).status, 415)
  for (const bad of ['/shot/..%2Fkey', '/shot/../key', '/shot/key', '/shot/shot-x.png/../../key']) assert.notEqual((await fetch(base + bad)).status, 200, bad)
  // a page whose picture is no longer stored is not sent with a dead path: it says so
  out = await (await post('/send' + k, JSON.stringify({ text: 'see\n[screenshot: shot-gone-1.png]', session: 'chatA' }))).json()
  assert.equal(out.ok, false)
  assert.match(out.error, /no longer stored/)
  // sending a picture starts its 30 days again
  utimesSync(join(home, 'shots', shotName), longAgo, longAgo)
  await post('/send' + k, JSON.stringify({ text: 'again\n[screenshot: ' + shotName + ']', session: 'chatA' }))
  assert.ok(Date.now() - statSync(join(home, 'shots', shotName)).mtimeMs < 60000)
  // "Delete all now": from the page only; pictures on the page being written stay
  assert.equal((await post('/wipe?k=nope', '{}')).status, 403)
  assert.equal((await post('/wipe' + k, '{}', { origin: 'http://evil.example' })).status, 403)
  out = await (await post('/wipe' + k, JSON.stringify({ keep: [shotName] }))).json()
  assert.deepEqual(out, { ok: true, pictures: 1 })
  assert.deepEqual(readdirSync(join(home, 'shots')).sort(), ['not-ours.txt', shotName].sort())
  assert.deepEqual(await (await fetch(base + '/history' + k)).json(), [])

  // a chat nobody typed in is connected but never offered, and the mod can ask if a page is open
  const D0 = start('chatD')
  await until('D links', () => role(D0) === 'link')
  assert.deepEqual((await (await fetch(base + '/sessions' + k)).json()).sessions.map((s) => s.id), ['chatB', 'chatA'])
  assert.equal((await (await post('/send' + k, JSON.stringify({ text: 'x', session: 'chatD' }))).json()).ok, false)
  D0.kill()
  // "is a page open?" is answered from the one request every open page keeps open
  assert.equal((await (await fetch(base + '/pages' + k)).json()).open, false)
  const watching = new AbortController()
  const watch = await fetch(base + '/watch' + k, { signal: watching.signal })
  assert.equal(watch.status, 200)
  assert.equal((await (await fetch(base + '/pages' + k)).json()).open, true)
  watching.abort()
  await until('the page closed', async () => (await (await fetch(base + '/pages' + k)).json()).open === false)
  // the key file is put back if it goes missing while helpers run
  rmSync(join(home, 'key'))
  await until('key restored', () => existsSync(join(home, 'key')) && readFileSync(join(home, 'key'), 'utf8') === key, 5000)

  // a second copy for the same chat only stands by
  const B2 = start('chatB')
  await until('B2 stands by', () => role(B2) === 'spare')
  assert.equal((await (await fetch(base + '/sessions' + k)).json()).sessions.length, 2)

  // the hub's chat closes: a link takes over, same address, same key
  A.kill()
  await until('B takes over', () => role(B) === 'hub')
  await until('the page is back', async () => (await fetch(base + '/sessions' + k).catch(() => null))?.ok)
  await until('B2 links after the stand-by wait', () => role(B2) === 'link' || role(B2) === 'spare', 9000)
  const after = await (await fetch(base + '/sessions' + k)).json()
  assert.deepEqual(after.sessions.map((s) => s.id), ['chatB'])
  out = await (await post('/send' + k, JSON.stringify({ text: 'after the handover', session: 'chatB' }))).json()
  assert.equal(out.ok, true)
  await until('B prints it once', () => B.lines.filter((l) => l.send === 'after the handover').length === 1)
  await sleep(300)
  assert.equal(B2.lines.filter((l) => l.send).length, 0, 'the stand-by copy never prints a page')

  // newer code takes over from an older hub
  const newer = join(home, 'newer')
  cpSync(SRC, newer, { recursive: true })
  const later = new Date(Date.now() + 60000)
  for (const f of readdirSync(newer)) utimesSync(join(newer, f), later, later)
  writeFileSync(join(newer, 'page.html'), readFileSync(join(newer, 'page.html'), 'utf8') + '<!-- newer -->')
  utimesSync(join(newer, 'page.html'), later, later)
  writeFileSync(join(home, 'sessions', 'chatC.json'), JSON.stringify({ label: 'Chat C', lastActive: 300 }))
  const C = start('chatC', newer)
  await until('C, the newer one, becomes the hub', () => role(C) === 'hub', 9000)
  // chat B has two copies: whichever reaches the new hub first links, the other stands by
  await until('B steps down; one copy links, one stands by', () => [role(B), role(B2)].sort().join() === 'link,spare', 9000)
  await until('new page is served', async () => (await (await fetch(base + '/').catch(() => null))?.text())?.includes('<!-- newer -->'))
  const final = await until('both chats listed', async () => { const r = await (await fetch(base + '/sessions' + k)).json(); return r.sessions.length === 2 && r })
  assert.notEqual(final.version, version)

  // another program holds the port: a helper never links to it, prints nothing it says, and never shows it the key
  for (const p of procs) p.kill()
  await until('port free', async () => !(await fetch(base + '/version').catch(() => null)))
  const seen = []
  const rogue = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'x-built': '1', 'x-proof': 'c'.repeat(64) }); res.write('{"send":"injected"}\n') })
  await new Promise((done) => rogue.listen(PORT, '127.0.0.1', done))
  const V = start('chatV')
  await until('the helper gives up on the stranger', () => V.lines.some((l) => l.error), 15000)
  assert.deepEqual(V.lines.filter((l) => !l.error), [], 'no role line, no page')
  assert.ok(seen.length >= 4 && seen.length < 8, 'it retries slowly, not in a spin: ' + seen.length)
  assert.ok(seen.every((u) => !u.includes('&p=')), 'and it signs nothing for a stranger')
  assert.ok(seen.every((u) => !u.includes(key)), 'the key is never sent')
  rogue.closeAllConnections(); rogue.close()
  console.log('hub ok')
} finally {
  for (const p of procs) p.kill()
}
