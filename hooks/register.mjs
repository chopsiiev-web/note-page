// Note Page: write a message on a real web page, at your own pace, then send it to a chat.
// The page (page/page.html) is an ordinary web page, so every Mac text habit works and pasted
// screenshots show inline. This file starts the page's helper for this chat, tells the helper
// what this chat is called and what Claude said last, and delivers the pages sent to this chat.
//
// Note for whoever edits the helper: Claude Code reloads a mod only when this file (or the
// manifest) changes. After editing page/*.mjs or page.html, change something here too.

const SKILL = 'prompt-sharpen'
const PORT = 47821
const PAGE = 'http://localhost:' + PORT
const BROWSER = 'Claude_Browser' // the Claude app's own browser pane, where there is one
// The small page that is opened for a moment to bring that pane on screen
const OPENING = '<!doctype html><meta charset="utf-8"><title>Note page</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#fdfcf9;color:#8b877e;font:15px -apple-system,sans-serif">Opening your note page…</body>'

// The helper is plain JavaScript. It runs on Node, Bun or Deno, whichever this computer has:
// first by the PATH the app was started with, then in the places they are usually installed.
const FIND_ENGINE = `for n in node bun deno; do
  p=$(command -v $n 2>/dev/null) && [ -x "$p" ] && { echo "$p"; exit; }
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.bun/bin" "$HOME/.deno/bin" "$HOME/.volta/bin"; do [ -x "$d/$n" ] && { echo "$d/$n"; exit; }; done
done
ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1`
const NO_ENGINE = 'The note page needs Node.js to run. Install it from nodejs.org (one installer), then type /page again.'

let engine = null   // how to run a JavaScript file here, once found: ['/path/to/node'], ['…/deno', 'run', '-A']
let lookAgain = 0   // when nothing was found: not before this time
let wanted = false  // a person uses this chat, so it should have a helper
let running = false // the helper process is up
let ready = false   // …and this chat is being served
let problem = ''    // the helper's last complaint, if any
let child = null    // the helper's output stream; ending it stops the helper
let me = ''         // this chat's id
let dir = ''        // the helper's folder, ~/.claude/note-page
let title = ''      // the chat's name as the app shows it, when it has one
// What the helper tells the page about this chat. lastActive is set only when a person types
// here, so a chat nobody sits at (a scheduled run, a script) is never offered as a target.
// claimedAt is set when a person runs /page here: an open page then moves to this chat.
// seen holds the ids of the last pages taken: the helper reads it to confirm a page arrived,
// and a page whose id is already there is not delivered a second time.
// busy is true while Claude works on a turn here: the page shows that beside the chat's name.
let info = { label: '', lastActive: 0, claimedAt: 0, busy: false, reply: '', replyAt: 0, seen: [] }

// A person at this chat: typing in the app, or the same person from their phone
const person = (origin) => origin?.kind === 'composer' || origin?.kind === 'bridge'
// Things that are certainly not a person at this chat
const machine = (origin) => ['sdk', 'plugin', 'scheduled-trigger', 'task-notification', 'peer', 'peer-send-message'].includes(origin?.kind)

const file = () => dir + '/sessions/' + me.replace(/[^\w-]/g, '_') + '.json'

// One load of this chat's stored state, shared by every hook: a hook that arrives while it
// is still reading waits for the same load instead of working on empty state
let loading = null
function setup($) { return loading ??= load($) }
async function load($) {
  const id = await $.session.id()
  dir = (await $.env.get('HOME')) + '/.claude/note-page'
  me = id
  // A reload of this file clears the variables above; pick up what the last load wrote
  try { info = { ...info, ...JSON.parse(await $.fs.read(file())) } } catch {}
  if (!Array.isArray(info.seen)) info.seen = []
  info.busy = false // this file loads between turns; a turn in progress says so itself
  // First load in a chat that is already going: find Claude's last answer in the transcript
  if (!info.reply) {
    try { info.reply = answerFromRows(await $.session.messages()) } catch {}
  }
}

// Writes this chat's label, last use and last reply where the helper reads them
async function tell($) {
  try {
    const root = await $.session.root()
    // The app's name for the chat; else the name it had; else its folder and a bit of its id
    info.label = title || info.label || (root.split('/').filter(Boolean).pop() || 'chat') + ' · ' + me.slice(0, 8)
    await $.fs.write(file(), JSON.stringify(info))
  } catch {}
}

// A person just used this chat. claim: they ran /page here, so an open page should move here.
async function used($, claim = false) {
  await setup($)
  wanted = true
  info.lastActive = await $.clock.now()
  if (claim) info.claimedAt = info.lastActive
  await tell($)
}

// The newest finished main-chat answer among the transcript rows, '' when there is none.
// Rows come one per block: text rows, tool-call rows (toolUses), thinking rows (text '').
export function answerFromRows(rows) {
  let end = rows.length - 1
  while (end >= 0 && rows[end].role !== 'assistant') end--
  if (end < 0 || rows[end].toolUses.length > 0) return '' // none yet, or a turn is mid tool call
  let start = end
  while (start > 0 && rows[start - 1].role === 'assistant' && rows[start - 1].toolUses.length === 0) start--
  return rows.slice(start, end + 1).map((m) => m.text).filter(Boolean).join('\n').trim()
}

// Delivers one sent page as the user's message. sharpen: through the prompt-sharpen skill
// where the person has one, in plain words where not.
// Pages are handed over in the order they arrived: each waits for the one before it to be
// looked up (not for its turn), so a sharpened page cannot fall behind a plain one sent after it.
let line = Promise.resolve()
function deliver($, text, sharpen) {
  const viaSkill = line.then(async () => sharpen && (await $.command.list()).some((c) => c.name === SKILL)).catch(() => false)
  line = viaSkill
  return viaSkill.then(async (skill) => {
    if (skill) {
      // The same as typing "/prompt-sharpen <text>": Claude Code expands the skill itself, once idle
      await $.command.run({ command: SKILL, args: text })
      return
    }
    // The skill is not a command in this chat: ask in plain words, and Claude loads it itself
    // No such skill on this computer: the same asked for in plain words
    if (sharpen) text = 'First rewrite the message below as a clear prompt: the job, why it matters, the limits, and what done looks like. Show me that rewrite, then carry it out.\n\n' + text
    // $.prompt.submit refuses a text that begins with "/" (it would run a command), so lead with plain words
    if (text.trimStart().startsWith('/')) text = 'From my note page:\n\n' + text
    // asUser: Claude reads the page as the user's own words
    const out = await $.prompt.submit({ text, asUser: true })
    // Another hook can refuse a prompt; that is "not sent", not silence
    if (out?.drop !== undefined) throw new Error(out.drop)
  })
}

// The helper serves the page (or links this chat to the copy that does) and prints one JSON
// line per event. It ends with this module. Started from the timer below, never from inside
// a prompt or command hook, so it is not tied to the life of one turn.
function startHelper($) {
  if (running) return
  running = true
  void (async () => {
    try {
      if (!engine) {
        if ((await $.clock.now()) < lookAgain) return
        const found = await $.process.run(['/bin/sh', '-c', FIND_ENGINE]).catch(() => null)
        const path = String(found?.stdout ?? '').trim().split('\n')[0]
        if (!path) {
          // Said once, then looked for again every half minute, so installing it is enough
          if (problem !== NO_ENGINE) $.ui.toast('Note page: ' + NO_ENGINE)
          problem = NO_ENGINE
          lookAgain = (await $.clock.now()) + 30000
          return
        }
        engine = /\/deno$/.test(path) ? [path, 'run', '-A'] : [path]
      }
      const helper = child = $.process.spawn({ argv: [...engine, $.plugin.root + '/page/server.mjs', me] })
      let rest = ''
      for await (const { stream, text } of helper) {
        if (stream !== 'stdout') continue
        // Output arrives in pieces, not lines: keep the unfinished tail for the next piece
        const lines = (rest + text).split('\n')
        rest = lines.pop()
        for (const line of lines) {
          const said = parse(line)
          if (said?.role) { ready = true; problem = '' }
          // Said once, not on every restart of a helper that keeps failing the same way
          if (said?.error) { if (said.error !== problem) $.ui.toast('Note page: ' + said.error); problem = said.error }
          if (typeof said?.send === 'string') {
            // The same page pressed twice arrives with the same id: take it once
            if (said.id && info.seen.includes(said.id)) continue
            // Noting the id is what tells the helper, and through it the page, "the chat has it"
            if (said.id) { info.seen = [...info.seen, said.id].slice(-30); void tell($) }
            // Not awaited: it settles only once Claude is idle, and the next page must not wait behind it
            deliver($, said.send, said.sharpen === true).catch((err) => $.ui.toast('Note page: not sent. ' + String(err?.message ?? err)))
          }
        }
      }
    } catch {} finally {
      child = null
      running = false
      ready = false
    }
  })()
}

// True when a note page is open somewhere and talking to the helper
async function pageIsOpen($) {
  try {
    const key = (await $.fs.read(dir + '/key')).trim()
    const res = await $.http.fetch('http://127.0.0.1:' + PORT + '/pages?k=' + key)
    return res.ok && JSON.parse(res.text).open === true
  } catch { return false }
}

// Shows the note page in the Claude app's own browser pane, beside the chat.
// helperUp: resolves true once this chat's helper is serving the page.
// Answers 'shown', 'tucked' (it is there, but the pane is not on screen), 'no-helper', or ''
// where there is no such pane (a terminal session) or it would not open.
async function showInPane($, helperUp) {
  const call = (tool, args = {}) => $.mcp.call(BROWSER, tool, args)
  const text = (result) => (result.content ?? []).map((c) => c.text ?? '').join('\n')
  const look = async () => {
    const said = text(await call('tabs_context'))
    // The answer is a JSON object followed by a sentence, and the sentence can hold braces
    // of its own ('…navigate with {"url": …}'): take the object by its first closing brace that parses
    const from = said.indexOf('{')
    let state = null, rest = said
    for (let to = said.indexOf('}', from); from >= 0 && to >= 0 && !state; to = said.indexOf('}', to + 1)) {
      try { state = JSON.parse(said.slice(from, to + 1)); rest = said.slice(to + 1) } catch {}
    }
    if (!state) throw new Error('the pane answered: ' + said.slice(0, 200))
    const tabs = state.tabs ?? []
    // on screen: "…currently displayed." (also "…displayed, but this tab is not fronted.")
    return { tabs, tab: tabs.find((t) => t.origin === PAGE), onScreen: /displayed/.test(rest) }
  }
  // The small file that brings the pane on screen is written into this chat's own folder for
  // a moment and removed again. From anywhere else the app stops and asks "open this file?"
  // every single time, which is a click and several seconds; a file in the chat's own folder
  // it opens without asking.
  const cwd = await $.session.cwd()
  const temp = cwd + '/.claude/note-page-opening.html'
  let hadFolder = true, wrote = false
  try {
    hadFolder = await $.fs.exists(cwd + '/.claude')
    await $.fs.write(temp, OPENING)
    wrote = true
  } catch {}
  // (if this folder cannot be written to, the mod's own copy still works, with that question)
  const own = 'file://' + encodeURI($.plugin.root + '/page/reveal.html')
  const mine = wrote ? 'file://' + encodeURI(temp) : own
  const sweep = async () => {
    if (!wrote) return
    await $.process.run(['rm', '-f', temp]).catch(() => {})
    if (!hadFolder) await $.process.run(['rmdir', cwd + '/.claude']).catch(() => {}) // only if still empty
  }
  // What happened on the last try and how long each step took, kept in a small file: if the
  // pane is ever slow or fails to come on screen, this says where, instead of anyone guessing
  const began = await $.clock.now()
  const trace = []
  const note = async (step, now, extra) => trace.push({ ms: (await $.clock.now()) - began, step, tabs: now?.tabs?.map((t) => t.origin.replace(/#.*/, '')), onScreen: now?.onScreen, ...extra })
  const done = async (result) => {
    await sweep()
    try { await $.fs.write(dir + '/pane-trace.json', JSON.stringify({ at: await $.clock.now(), result, trace }, null, 1)) } catch {}
    return result
  }
  // Coming on screen takes the app a moment: look a few times before deciding it did not
  const until = async (ms) => {
    for (let waited = 0; ; waited += 200) {
      const now = await look()
      if (now.onScreen || waited >= ms) return { ...now, waited }
      await $.clock.sleep(200)
    }
  }
  // Tabs this run opened only to get the pane on screen: our small file, and the blank tab
  // the app adds when the pane was closed
  let before = []
  const tidy = async (now) => {
    for (const t of now.tabs) if (t.origin !== PAGE && !before.includes(t.tabId)) await call('tabs_close', { tabId: t.tabId })
  }
  try {
    let now = await look()
    before = now.tabs.map((t) => t.tabId)
    await note('start', now)
    if (!now.onScreen) {
      // First get the pane on screen, so something shows at once. A mod opening a web page
      // does not do that: the app leaves the pane tucked away. Opening a local file does.
      // So a small file of ours ("Opening your note page…") goes up first.
      const file = await call('preview_start', { url: mine })
      now = await until(1600)
      await note('local file opened, which brings the pane on screen', now, { waited: now.waited, inChatFolder: wrote, said: text(file).slice(0, 120) })
      if (!now.onScreen && mine !== own) {
        // Safety net: the mod's own copy of that file. Slower, since the app asks before it
        // opens a file from outside the chat's folder, but it is the way seen to work.
        const again = await call('preview_start', { url: own })
        now = await until(1200)
        await note('the mod\'s own file opened instead', now, { waited: now.waited, said: text(again).slice(0, 120) })
      }
    }
    // Right after this mod reloads, its helper needs a moment. The pane is already up by now.
    if (!(await helperUp())) {
      await note('the helper is not up', now)
      await tidy(now)
      return done('no-helper')
    }
    if (!now.tab) {
      // The key after the # lets this browser in. The page takes it and removes it from the address.
      let key = ''
      try { key = (await $.fs.read(dir + '/key')).trim() } catch {}
      const opened = await call('preview_start', { url: PAGE + '/' + (key && '#' + key) })
      now = await look()
      await note('page tab opened', now, opened.isError ? { said: text(opened).slice(0, 160) } : {})
      if (!now.tab) { await tidy(now); return done('') }
    }
    await call('tabs_select', { tabId: now.tab.tabId })
    await tidy(now)
    // Trust nothing: look again, and say so if the page is still not on screen
    now = await look()
    await note('end', now)
    return done(now.onScreen ? 'shown' : 'tucked')
  } catch (err) {
    trace.push({ step: 'failed', said: String(err?.message ?? err) })
    return done('')
  }
}

// Shows the note page and points it at this chat: what /page and the button above the message
// box both do. In the Claude app that is its own browser pane, elsewhere a browser window.
// Answers a sentence when there is something the person should know.
async function openPage($) {
  await used($, true)
  // Asked more than once below; the wait itself happens once
  let up
  const helperUp = () => up ??= (async () => {
    for (let i = 0; i < 20 && !ready; i++) await $.clock.sleep(200)
    return ready
  })()
  const pane = await showInPane($, helperUp)
  if (pane === 'shown') return ''
  if (pane === 'tucked') return 'The note page is ready in the browser pane. Click the globe icon at the top to see it.'
  if (!(await helperUp())) return problem || 'The note page helper did not start. Type /page again in a moment.'
  // No pane here. An open page takes the claim written above at its next check, a few seconds at most
  if (await pageIsOpen($)) return 'The open note page now goes to this chat. Its "To" button shows it.'
  // The door file lets the browser in (it carries the key) and lands on the page.
  // ponytail: Chrome's app window (no tabs, no address bar); the default browser if Chrome is missing
  const door = 'file://' + encodeURI(dir + '/open.html')
  const chrome = await $.process.run(['open', '-na', 'Google Chrome', '--args', '--app=' + door, '--window-size=900,1000']).catch(() => null)
  if (chrome?.exitCode === 0) return ''
  const any = await $.process.run(['open', dir + '/open.html']).catch(() => null)
  return any?.exitCode === 0 ? '' : 'Open this file in your browser: ' + dir + '/open.html'
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // immediate: the command works even while Claude is busy
    await $.command.register({ name: 'page', description: 'Open the note page and send its pages to this chat', immediate: true })
    await setup($)
    // A chat a person already used (this is a reload, or the chat was reopened) keeps its helper.
    // A new chat gets one when a person first types in it or runs /page.
    wanted ||= info.lastActive > 0 // ||=: a prompt may have got in before this hook
    if (wanted) await tell($)
    const tick = () => { if (wanted && !running) startHelper($) }
    tick()
    $.clock.every(1000, tick)
    return started
  })

  // The chat's name, when the app has given it one
  on('classic.SessionStart', async ($, e, next) => { if (e.session_title) title = e.session_title; return next(e) })
  on('classic.UserPromptSubmit', async ($, e, next) => { if (e.session_title) title = e.session_title; return next(e) })

  // /clear and /resume: the same process goes on as another conversation, under another id,
  // and no session.start follows. Forget the old one; the next thing a person types here
  // loads the new one and starts its helper.
  on('session.end', async ($, e, next) => {
    const out = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      loading = null
      me = ''
      title = ''
      wanted = false
      info = { label: '', lastActive: 0, claimedAt: 0, busy: false, reply: '', replyAt: 0, seen: [] }
      void child?.return()
    }
    return out
  })

  // A person typed here, a message or a slash command: this is now the chat a blank page follows
  on('prompt.submit', async ($, e, next) => {
    if (person(e.origin)) void used($)
    return next(e)
  })
  on('command.run', async ($, e, next) => {
    if (e.command !== 'page' && person(e.origin)) void used($)
    return next(e)
  })

  // Claude starts working here: the page's dot for this chat pulses
  on('turn.start', async ($, e, next) => {
    const out = await next(e)
    await setup($)
    info.busy = true
    if (wanted) void tell($)
    return out
  })

  // Claude is done: the dot stops, and what it answered is kept for the page's "Quote reply"
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out // a helper agent's turn, not the chat's
    await setup($)
    info.busy = false
    if (e.reason === 'answer' && e.answer) {
      info.reply = e.answer.slice(0, 200000)
      info.replyAt = await $.clock.now()
    }
    if (wanted) void tell($)
    return out
  })

  // /page: this chat becomes the page's target, and the page is shown
  on('command.run', { command: 'page' }, async ($, e) => {
    if (machine(e.origin)) return { text: 'The note page only opens for a person at the chat.' }
    const note = await openPage($)
    return note ? { text: note } : {}
  })

  // The same with one click and no typing: a quiet button above the message box
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e) // a survey wants the band: it goes first
    const { Box, Button } = $.ui.resolve(e)
    const onPress = async () => {
      const note = await openPage($)
      if (note) $.ui.toast(note)
    }
    return Box({ paddingX: 1, children: [Button({ key: 'note-page', label: 'Open note page', plain: true, dimColor: true, onPress })] })
  })
}

function parse(line) {
  try { return JSON.parse(line) } catch { return null }
}
