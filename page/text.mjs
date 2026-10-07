// Turns the page into the plain text Claude reads. Pure functions over DOM-like nodes
// (childNodes, nodeType, nodeName, nodeValue, className, dataset), so they run in the page and in node tests.

const BLOCKS = new Set(['DIV', 'P', 'BLOCKQUOTE', 'LI', 'UL', 'OL', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s/
// A quoted line is a block with class "q". A <blockquote> counts too, in case one is pasted or restored.
const isQuote = (n) => n.nodeName === 'BLOCKQUOTE' || /(^|\s)q(\s|$)/.test(n.className || '')

// A pasted picture is named by its own address on the helper, never by anything else the page
// holds: the helper turns the name into the full file path when the page is sent
const shotName = (img) => (/^\/shot\/(shot-[\w-]+\.(?:png|jpe?g|gif|webp))$/.exec(img.getAttribute?.('src') || '') || [])[1] || 'a picture that could not be saved'

// The page top to bottom, one entry per line: { t: its text, q: true when quoted from Claude }
export function toLines(root) {
  const lines = [{ t: '', q: false }]
  let pending = false // a block just ended, so whatever comes next starts a new line
  const cur = () => lines[lines.length - 1]
  const fresh = (q) => { lines.push({ t: '', q }); pending = false }
  const walk = (node, q) => {
    const kids = [...node.childNodes]
    kids.forEach((n, i) => {
      if (n.nodeType === 3) {
        if (!n.nodeValue) return
        n.nodeValue.split('\n').forEach((piece, j) => {
          if (j > 0 || pending) fresh(q)
          cur().t += piece
          cur().q = q
        })
      } else if (n.nodeName === 'IMG') {
        if (pending || cur().t) fresh(q)
        cur().t = '[screenshot: ' + shotName(n) + ']'
        cur().q = q
        pending = true
      } else if (n.nodeName === 'BR') {
        // The browser keeps a <br> at the end of a block as a placeholder; it is not a line break
        if (i < kids.length - 1) fresh(q)
      } else if (BLOCKS.has(n.nodeName)) {
        const inner = q || isQuote(n)
        if (pending || cur().t) fresh(inner)
        cur().q = inner
        walk(n, inner)
        pending = true
      } else if (n.nodeType === 1) {
        walk(n, q) // inline wrappers: span, b, a, font
      }
    })
  }
  walk(root, false)
  return lines
}

// Of a run of quoted lines, the one point right above your answer: its last bullet, or its
// last paragraph. Claude already has its whole reply, so the point is only there as an anchor.
export function pointAbove(quoted) {
  let last = quoted.length - 1
  while (last >= 0 && !quoted[last].trim()) last--
  if (last < 0) return []
  let first = last
  if (!LIST_ITEM.test(quoted[last])) {
    const joins = (t) => t.trim() && !LIST_ITEM.test(t) && !/^\s*#/.test(t)
    while (first > 0 && last - first < 5 && joins(quoted[first - 1])) first--
  }
  return quoted.slice(first, last + 1)
}

// The message. Quoted lines are kept only where your own words follow them, and only the
// point you answered: a quote you wrote nothing under is left out.
export function toText(root) {
  const lines = toLines(root)
  const out = []
  for (let i = 0; i < lines.length;) {
    if (!lines[i].q) { out.push(lines[i++].t); continue }
    let end = i
    while (end < lines.length && lines[end].q) end++
    let next = end
    while (next < lines.length && !lines[next].q && !lines[next].t.trim()) next++
    if (next < lines.length && !lines[next].q) {
      if (out.length && out[out.length - 1].trim()) out.push('')
      out.push(...pointAbove(lines.slice(i, end).map((l) => l.t)).map((t) => '> ' + t))
    }
    i = end
  }
  // Blank lines at the edges go; the first line keeps its indent (pasted code, YAML)
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
}

// Claude's reply as quoted lines, one block per line, so an answer can be opened under any of them.
// Bold and heading marks are dropped as noise, but never inside a code block, where ** and #
// are part of the code.
export function quoteHtml(reply) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const plain = (l) => l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^(\s*)#+\s+/, '$1')
  let code = false
  return reply.replace(/\r/g, '').trim().split('\n').map((l) => {
    const fence = /^\s*(```|~~~)/.test(l)
    const shown = code || fence ? l : plain(l)
    if (fence) code = !code
    return '<div class="q">' + (esc(shown) || '<br>') + '</div>'
  }).join('')
}

// True when pasted text was copied out of Claude's reply: most of its lines are found in it.
// Copying from the chat drops the marks the reply was written with (bold stars, bullets,
// numbers, headings), so both sides are compared without them.
const bare = (s) => s.replace(/[*_`#>|]/g, '').replace(/^\s*([-•·–]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase()
export function isFrom(reply, pasted) {
  const whole = reply.split('\n').map(bare).join(' ')
  const lines = pasted.split('\n').map(bare).filter((l) => l.length > 3)
  if (lines.join(' ').length < 12) return false // too short to tell
  return lines.filter((l) => whole.includes(l)).length / lines.length >= 0.7
}
