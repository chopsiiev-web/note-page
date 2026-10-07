// The helper behind the note page. Every chat that runs the mod starts one copy of this file.
// The first copy to get the port is the hub: it serves the page and hands each sent page to
// the chat it is meant for. Every other copy is a link: it stays connected to the hub and
// prints what is meant for its own chat. When the hub's chat closes, a link takes over.
//
// The mod reads this program's output, one JSON object per line:
//   {"role":"hub"|"link"|"spare","url":…}   this chat is served, and where the page is
//   {"send":text,"id":…,"sharpen":true?}     a page for this chat; the mod notes the id in
//                                             the chat's session file, which is how the helper
//                                             knows the page was taken before it says "sent"
//   {"error":text}                            something the user should know
//
// Who may do what. Everything here trusts one thing: being able to read the key file, which
// only this Mac account can. A browser gets the key by opening the door file once (the /page
// command does that); the page is served to anyone, but without the key it can do nothing.
// So another website, and a local program that can reach the port but not this account's
// files, can neither read anything nor put a page into a chat.

import { createServer, get } from 'node:http'
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, readdirSync, unlinkSync, realpathSync, chmodSync, utimesSync } from 'node:fs'
import { randomBytes, createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.NOTE_PAGE_HOME || join(homedir(), '.claude', 'note-page')
const shots = process.env.NOTE_PAGE_SHOTS || join(homedir(), '.claude', 'note-page-shots')
// One fixed port, so the page has one address that can be typed and bookmarked
const port = Number(process.env.NOTE_PAGE_PORT) || 47821
const url = 'http://localhost:' + port + '/'
const hosts = ['localhost:' + port, '127.0.0.1:' + port]

const SHOT = /^shot-[\w-]+\.(png|jpe?g|gif|webp)$/
const IMAGE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const HISTORY = 30
// Pasted pictures and sent pages are kept this long, then removed, so nothing piles up for ever
const KEEP = 30 * 864e5

export const sessionFile = (dir, id) => join(dir, 'sessions', String(id).replace(/[^\w-]/g, '_') + '.json')
// The chat that was used last comes first: that is where a page goes unless you pick another
export const newestFirst = (list) => [...list].sort((a, b) => b.lastActive - a.lastActive)
// The page names a pasted picture by its file name only; the full path is filled in here,
// so nothing the page holds can point Claude at some other file
const NAMED = /^\[screenshot: (shot-[\w-]+\.(?:png|jpe?g|gif|webp))\]$/gm
export const withShotPaths = (text, dir) => text.replace(NAMED, (_, name) => '[screenshot: ' + join(dir, name) + ']')
export const shotNames = (text) => [...text.matchAll(NAMED)].map((m) => m[1])

// Run only when started as a program, not when a test imports the helpers above
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv[2] || 'chat-' + process.pid)

function main(me) {
  const say = (o) => console.log(JSON.stringify(o))
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(shots, { recursive: true })

  // ---- the key every copy shares ----

  const keyFile = join(home, 'key')
  const good = (k) => /^[0-9a-f]{32}$/.test(k)
  const onDisk = () => { try { return readFileSync(keyFile, 'utf8').trim() } catch { return '' } }
  try { writeFileSync(keyFile, randomBytes(16).toString('hex'), { flag: 'wx', mode: 0o600 }) } catch {}
  let key = ''
  for (let i = 0; i < 20 && !good(key); i++) {
    if (i) sleep(25) // another copy may be writing it this instant
    key = onDisk()
  }
  if (!good(key)) {
    // The file stayed empty or broken (its first write failed once): replace it whole
    key = randomBytes(16).toString('hex')
    try { writeFileSync(keyFile + '.' + process.pid, key, { mode: 0o600 }); renameSync(keyFile + '.' + process.pid, keyFile) } catch {}
    if (onDisk() !== key) { say({ error: 'The note page could not write its key file' }); process.exit(1) }
  }
  // Proof of knowing the key, without sending it: what a link and the hub show each other
  const proof = (who, id, nonce) => createHmac('sha256', key).update(who + '\n' + id + '\n' + nonce).digest('hex')

  // The door: a file only this account can read. Opening it in a browser hands that browser
  // the key (after the #, which is never sent over the network) and lands on the page.
  const door = join(home, 'open.html')
  try {
    writeFileSync(door, '<!doctype html><meta charset="utf-8"><title>Note page</title><script>location.replace(' + JSON.stringify(url + '#' + key) + ')</script>', { mode: 0o600 })
    chmodSync(door, 0o600)
  } catch {}

  // The page as it was when this copy started, so one copy never serves a mix of versions
  const names = ['server.mjs', 'page.html', 'text.mjs'] // reveal.html is the mod's, not served
  const files = Object.fromEntries(names.map((n) => [n, readFileSync(join(here, n), 'utf8')]))
  const version = createHash('sha1').update(names.map((n) => files[n]).join('\0')).digest('hex').slice(0, 12)
  const built = Math.max(...names.map((n) => Math.floor(statSync(join(here, n)).mtimeMs)))

  const info = (id) => { try { return JSON.parse(readFileSync(sessionFile(home, id), 'utf8')) || {} } catch { return {} } }
  const historyFile = join(home, 'history.json')
  const history = () => { try { const list = JSON.parse(readFileSync(historyFile, 'utf8')); return Array.isArray(list) ? list : [] } catch { return [] } }
  const saveHistory = (list) => { writeFileSync(historyFile + '.tmp', JSON.stringify(list)); renameSync(historyFile + '.tmp', historyFile) }
  const pictures = () => { try { return readdirSync(shots).filter((n) => SHOT.test(n)) } catch { return [] } }
  // What is older than 30 days goes by itself
  const sweep = () => {
    const old = Date.now() - KEEP
    for (const name of pictures()) { try { if (statSync(join(shots, name)).mtimeMs < old) unlinkSync(join(shots, name)) } catch {} }
    try { const list = history(), young = list.filter((e) => e.at > old); if (young.length < list.length) saveHistory(young) } catch {}
  }

  // ---- the hub ----

  let server = null
  const streams = new Map() // chat id -> the open connection of that chat's link
  const pages = new Set()   // the open connection of every note page that is open right now
  // The chats a page can go to: connected, and used by a person (the mod sets lastActive only
  // when someone types there, so a scheduled run or a script never shows up here)
  const live = () => newestFirst([me, ...streams.keys()].map((id) => {
    const { label, lastActive, claimedAt, replyAt, busy } = info(id)
    return { id, label: String(label || 'Claude chat'), lastActive: Number(lastActive) || 0, claimedAt: Number(claimedAt) || 0, replyAt: Number(replyAt) || 0, busy: busy === true }
  }).filter((c) => c.lastActive > 0))
  const deliver = (id, o) => {
    if (id === me) { say(o); return true }
    const stream = streams.get(id)
    if (!stream || stream.destroyed) return false
    stream.write(JSON.stringify(o) + '\n')
    return true
  }
  // A page counts as sent only once the chat's mod has taken it. The mod writes the page's id
  // into the chat's session file; the helper copy of that chat watches for it.
  const taken = (id, page) => { const { seen } = info(id); return Array.isArray(seen) && seen.includes(page) }
  const untilTaken = (id, page, then) => {
    const end = Date.now() + 2500
    const timer = setInterval(() => {
      const ok = taken(id, page)
      if (ok || Date.now() > end) { clearInterval(timer); then(ok) }
    }, 60)
  }
  const waiting = new Map() // page id -> what to do when the chat's link confirms it
  const asked = new Set()   // one-time words handed to copies that ask to be linked
  let hubSince = 0          // when this copy became the hub
  const beat = setInterval(() => { for (const s of [...streams.values(), ...pages]) s.write('\n') }, 10000)
  beat.unref()
  // Keeps a request open, and runs `gone` when the other side goes away. Both signals are
  // listened for: Node gives the first, Bun only the second.
  const hold = (req, res, headers, gone) => {
    res.writeHead(200, { 'cache-control': 'no-store', ...headers })
    res.write('\n')
    req.socket.setTimeout(0)
    res.on('close', gone)
    req.socket.on('close', gone)
  }

  function handle(req, res) {
    const reply = (code, body, type = 'application/json', more = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...more })
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }
    let at
    try { at = new URL(req.url, 'http://x') } catch { return reply(400, {}) } // "//" and the like do not parse
    const path = at.pathname
    // Only answer when addressed as this Mac, so a look-alike web address can't read anything
    if (!hosts.includes(req.headers.host)) return reply(403, {})

    if (req.method === 'GET' && path === '/') {
      // Only this page's own script may run: nothing typed, pasted or restored into it can
      const nonce = randomBytes(12).toString('base64')
      const csp = "default-src 'self'; script-src 'self' 'nonce-" + nonce + "'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      const html = files['page.html'].replace('__VERSION__', version).replace('__NONCE__', nonce).replace('__DOOR__', pathToFileURL(door).href)
      return reply(200, html, 'text/html; charset=utf-8', { 'content-security-policy': csp })
    }
    if (req.method === 'GET' && path === '/text.mjs') return reply(200, files['text.mjs'], 'text/javascript; charset=utf-8')
    if (req.method === 'GET' && path === '/version') return reply(200, version, 'text/plain')
    if (req.method === 'GET' && path.startsWith('/shot/')) {
      // A pasted picture, by its file name only: the pattern allows no folders
      const name = path.slice(6)
      if (!SHOT.test(name)) return reply(404, {})
      try {
        const ext = name.split('.').pop().replace('jpeg', 'jpg')
        const type = Object.keys(IMAGE).find((t) => IMAGE[t] === ext)
        return reply(200, readFileSync(join(shots, name)), type, { 'cache-control': 'private, max-age=31536000', 'cross-origin-resource-policy': 'same-origin' })
      } catch { return reply(404, {}) }
    }

    if (req.method === 'GET' && path === '/stream') {
      // Another chat's copy of this helper asks to be linked. It proves it knows the key,
      // and gets the hub's proof back, so neither side talks to a stranger on this port.
      const id = at.searchParams.get('session') || ''
      const nonce = at.searchParams.get('n') || ''
      if (!id || nonce.length !== 32) return reply(403, {})
      const mine = { 'x-proof': proof('hub', id, nonce) }
      // The link signs a one-time word this hub gave it, so an answer overheard once by
      // whoever held the port before cannot be played back to get linked as that chat
      const word = at.searchParams.get('c') || ''
      if (!asked.delete(word) || at.searchParams.get('p') !== proof('link', id, word)) {
        const fresh = randomBytes(16).toString('hex')
        if (asked.size < 1000) { asked.add(fresh); setTimeout(() => asked.delete(fresh), 10000).unref() }
        return reply(401, {}, 'application/json', { ...mine, 'x-ask': fresh })
      }
      // One link per chat. A second copy for the same chat waits its turn.
      if (id === me || streams.has(id)) return reply(409, {}, 'application/json', mine)
      hold(req, res, { 'content-type': 'application/x-ndjson', 'x-built': String(built), ...mine }, () => { if (streams.get(id) === res) streams.delete(id) })
      streams.set(id, res)
      // A link running newer code than this hub takes over, so an update reaches the page
      if (Number(at.searchParams.get('built')) > built) setTimeout(stepDown, 50)
      return
    }

    if (req.method === 'GET' && path === '/ack') {
      // A link confirms that its chat's mod has taken a page
      const id = at.searchParams.get('session') || '', page = at.searchParams.get('id') || '', nonce = at.searchParams.get('n') || ''
      if (nonce.length !== 32 || at.searchParams.get('p') !== proof('ack', id + '\n' + page, nonce)) return reply(403, {})
      waiting.get(page)?.(true)
      return reply(200, {})
    }

    if (at.searchParams.get('k') !== key) return reply(403, { error: 'This browser has not been let in' })

    if (req.method === 'GET') {
      if (path === '/sessions') return reply(200, { version, sessions: live() })
      if (path === '/reply') {
        const { reply: text, replyAt } = info(at.searchParams.get('session') || '')
        return reply(200, { text: String(text || ''), at: Number(replyAt) || 0 })
      }
      if (path === '/history') return reply(200, history())
      // An open page keeps this one request open, so the hub knows a page is open even while
      // its window is hidden. The mod's /page command asks /pages before opening a second one.
      if (path === '/watch') {
        hold(req, res, { 'content-type': 'text/plain' }, () => pages.delete(res))
        pages.add(res)
        return
      }
      if (path === '/pages') {
        // A hub that has just taken the port may not have heard from an open page yet (a page
        // reconnects within a second or so): only say "none" once this hub is old enough
        const check = () => (pages.size > 0 || Date.now() - hubSince > 1500 ? reply(200, { open: pages.size > 0 }) : setTimeout(check, 100))
        return void check()
      }
      return reply(404, {})
    }

    // Changes come only from the page itself: its own address, plus the key checked above
    if (req.method !== 'POST' || !hosts.some((h) => req.headers.origin === 'http://' + h)) return reply(403, {})
    const isShot = path === '/shot'
    const limit = isShot ? 30e6 : 4e6
    const chunks = []
    let size = 0
    req.on('data', (c) => { size += c.length; if (size > limit) { reply(413, { error: 'Too big' }); req.destroy() } else chunks.push(c) })
    req.on('end', () => {
      if (res.writableEnded) return
      try {
        const body = Buffer.concat(chunks)
        if (isShot) {
          const ext = IMAGE[String(req.headers['content-type']).split(';')[0].trim()]
          if (!ext || !body.length) return reply(415, { error: 'Not a picture' })
          const name = 'shot-' + Date.now() + '-' + randomBytes(4).toString('hex') + '.' + ext
          writeFileSync(join(shots, name), body)
          return reply(200, { url: '/shot/' + name })
        }
        if (path === '/send') {
          const { text, html, session, sharpen, id } = JSON.parse(body.toString('utf8')) || {}
          const message = withShotPaths(String(text || ''), shots).replace(/^\n+/, '').replace(/\s+$/, '')
          if (!message) return reply(200, { ok: false, error: 'Nothing to send' })
          // Every picture on the page must still be stored (a draft can outlive the 30 days).
          // Its 30 days start again now, so a picture lasts as long as the sent page it is on.
          // ponytail: a draft older than 30 days is only caught here, at Send, not while writing
          for (const name of shotNames(String(text || ''))) {
            try { const now = new Date(); utimesSync(join(shots, name), now, now) } catch { return reply(200, { ok: false, error: 'A picture on this page is no longer stored. Paste it again, then send.' }) }
          }
          // A page is never sent to a different chat than the one named on it
          const target = live().find((c) => c.id === session)
          const closed = { ok: false, error: 'That chat is not connected right now. Try again, or pick another in "To".' }
          if (!target) return reply(200, closed)
          // The page's own id travels with it: the mod delivers one id once, so pressing Send
          // again after an unconfirmed try can never put the same page into the chat twice
          const page = typeof id === 'string' && /^[\w-]{8,64}$/.test(id) ? id : randomBytes(12).toString('hex')
          if (!deliver(target.id, { send: message, id: page, ...(sharpen && { sharpen: true }) })) return reply(200, closed)
          let answered = false
          const finish = (ok) => {
            if (answered) return
            answered = true
            waiting.delete(page)
            if (!ok) return reply(200, { ok: false, error: 'That chat did not confirm the page. It may be restarting. Press Send again.' })
            // The chat has the page now. Keeping a copy for "Sent pages" must not turn that into "not sent".
            try {
              const entry = { at: Date.now(), text: message, session: target.id, label: target.label }
              if (typeof html === 'string' && html.length < 300000) entry.html = html
              saveHistory([entry, ...history()].slice(0, HISTORY))
            } catch {}
            reply(200, { ok: true, label: target.label })
          }
          if (target.id === me) return untilTaken(me, page, finish)
          waiting.set(page, finish)
          setTimeout(() => finish(false), 3200)
          return
        }
        if (path === '/wipe') {
          // "Delete all now": every stored picture and every sent page. The pictures on the
          // page being written are named by it and stay, so the draft is not broken.
          const { keep } = JSON.parse(body.toString('utf8') || '{}') || {}
          const spare = new Set(Array.isArray(keep) ? keep : [])
          let gone = 0
          for (const name of pictures()) if (!spare.has(name)) { try { unlinkSync(join(shots, name)); gone++ } catch {} }
          try { unlinkSync(historyFile) } catch {}
          return reply(200, { ok: true, pictures: gone })
        }
        reply(404, {})
      } catch (err) {
        reply(400, { error: String(err.message) })
      }
    })
  }

  function stepDown() {
    if (!server) return
    const old = server
    server = null
    for (const s of [...streams.values(), ...pages]) s.destroy()
    streams.clear()
    pages.clear()
    old.close()
    old.closeAllConnections?.()
    setTimeout(become, 700) // long enough for the newer link to take the port first
  }

  // ---- a link ----

  let role = ''
  let fails = 0
  const ready = (r) => { fails = 0; if (role !== r) { role = r; say({ role: r, url }) } }

  function link(word = '') {
    let hubBuilt = Infinity // unknown until a real hub has answered
    let done = false
    let quiet
    const again = (ms) => { if (done) return; done = true; clearTimeout(quiet); req.destroy(); setTimeout(become, ms) }
    // Whoever runs newer code than the hub goes first when the port frees up
    const retry = () => again(built > hubBuilt ? 0 : 300 + Math.random() * 300)
    const nonce = randomBytes(16).toString('hex')
    const signed = word && '&c=' + word + '&p=' + proof('link', me, word)
    const req = get({ host: '127.0.0.1', port, path: '/stream?session=' + encodeURIComponent(me) + '&built=' + built + '&n=' + nonce + signed, headers: { host: hosts[0] } }, (res) => {
      req.setTimeout(0)
      const isHub = res.headers['x-proof'] === proof('hub', me, nonce)
      // A real hub first hands out a one-time word to sign: ask again with it, once
      if (isHub && res.statusCode === 401 && res.headers['x-ask'] && !word) {
        res.resume()
        done = true
        req.destroy()
        return link(String(res.headers['x-ask']))
      }
      if (!isHub || res.statusCode !== 200) {
        res.resume()
        // 409 from a real hub: another copy of the helper already serves this chat, so this one
        // only stands by (after a reload of the mod that is the old copy, about to be stopped)
        if (isHub && res.statusCode === 409) { ready('spare'); return again(1500) }
        // Anything else is not a note-page hub that shares our key. Never print what it says.
        if (++fails === 4) say({ error: 'Port ' + port + ' is used by another program, so the note page cannot start' })
        return again(3000)
      }
      hubBuilt = Number(res.headers['x-built']) || 0
      ready('link')
      // The hub sends an empty line every 10 seconds; silence means it is gone
      const hush = () => { clearTimeout(quiet); quiet = setTimeout(retry, 30000) }
      hush()
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        hush()
        buffer += chunk
        for (let i; (i = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, i).trim()
          buffer = buffer.slice(i + 1)
          if (!line) continue
          // Only a page is passed on to the mod, and only in the shape a page has
          let o
          try { o = JSON.parse(line) } catch { continue }
          if (!o || typeof o.send !== 'string' || typeof o.id !== 'string') continue
          say({ send: o.send, id: o.id, ...(o.sharpen === true && { sharpen: true }) })
          // Tell the hub once this chat's mod has taken it
          untilTaken(me, o.id, (ok) => {
            if (!ok) return
            const n = randomBytes(16).toString('hex')
            get({ host: '127.0.0.1', port, path: '/ack?session=' + encodeURIComponent(me) + '&id=' + encodeURIComponent(o.id) + '&n=' + n + '&p=' + proof('ack', me + '\n' + o.id, n), headers: { host: hosts[0] } }, (r) => r.resume()).on('error', () => {})
          })
        }
      })
      res.on('close', retry)
    })
    // Something holds the port but never answers: do not wait on it for ever
    req.setTimeout(5000, () => { if (++fails === 4) say({ error: 'Port ' + port + ' is used by another program, so the note page cannot start' }); again(3000) })
    req.on('error', () => again(300 + Math.random() * 300))
  }

  function become() {
    const next = createServer(handle)
    next.once('error', (err) => {
      if (err.code === 'EADDRINUSE') return link()
      say({ error: 'The note page could not start: ' + err.message })
      setTimeout(become, 5000)
    })
    next.listen(port, '127.0.0.1', () => {
      server = next
      hubSince = Date.now()
      ready('hub')
    })
  }

  // The helper's own small cache of each chat's label and last reply: drop week-old ones
  try {
    for (const name of readdirSync(join(home, 'sessions'))) {
      const file = join(home, 'sessions', name)
      if (name.endsWith('.json') && Date.now() - statSync(file).mtimeMs > 7 * 864e5) unlinkSync(file)
    }
  } catch {}

  sweep()
  setInterval(sweep, 6 * 3600e3).unref()

  const parent = process.ppid
  setInterval(() => {
    // Stop when the chat that started this copy goes away
    if (process.ppid !== parent) process.exit(0)
    // Every copy follows the key file: put ours back if it is gone; if a different one is
    // there, stop, and the mod starts a fresh copy that reads it
    const disk = onDisk()
    if (!disk) { try { mkdirSync(home, { recursive: true }); writeFileSync(keyFile, key, { flag: 'wx', mode: 0o600 }) } catch {} }
    else if (good(disk) && disk !== key) process.exit(0)
  }, 2000)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))
  // Nobody reads this copy's output any more (its chat is gone): it must not go on taking pages
  process.stdout.on('error', () => process.exit(0))

  become()
}
