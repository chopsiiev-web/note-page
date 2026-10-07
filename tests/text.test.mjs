// Run with: node tests/text.test.mjs   (checks how the page becomes the text Claude reads)
import { toLines, toText, pointAbove, quoteHtml, isFrom } from '../page/text.mjs'
import assert from 'node:assert'
// tiny stand-ins for DOM nodes
const T = (v) => ({ nodeType: 3, nodeName: '#text', nodeValue: v, childNodes: [] })
const E = (name, ...kids) => ({ nodeType: 1, nodeName: name, childNodes: kids, dataset: {} })
const IMG = (src, path) => ({ nodeType: 1, nodeName: 'IMG', childNodes: [], dataset: { path }, getAttribute: (n) => (n === 'src' ? src : null) })
const BR = () => E('BR')
const page = (...kids) => E('DIV', ...kids)

// plain typing: first line bare, then one block per line, an empty block is a blank line
assert.equal(toText(page(T('one'), E('DIV', T('two')), E('DIV', BR()), E('DIV', T('four')))), 'one\ntwo\n\nfour')
// several blank lines fold to one; edges are trimmed
assert.equal(toText(page(E('DIV', BR()), E('DIV', T('a')), E('DIV', BR()), E('DIV', BR()), E('DIV', BR()), E('DIV', T('b')), E('DIV', BR()))), 'a\n\nb')
// shift+enter inside a block, and the placeholder br at a block's end
assert.equal(toText(page(E('DIV', T('a'), BR(), T('b'), BR()))), 'a\nb')
// newline characters inside a text node (pre-wrap)
assert.equal(toText(page(T('a\nb'))), 'a\nb')
// a picture sits on its own line, in place
assert.equal(toText(page(T('see:'), E('DIV', IMG('/shot/shot-1-ab.png'), T('after')))), 'see:\n[screenshot: shot-1-ab.png]\nafter')
// a picture is named only by its own address on the helper: a made-up path on it is ignored
assert.equal(toText(page(E('DIV', IMG('https://evil.example/x.png', '/Users/me/.ssh/id_ed25519')))), '[screenshot: a picture that could not be saved]')
assert.equal(toText(page(E('DIV', IMG('/shot/../key', '/etc/passwd')))), '[screenshot: a picture that could not be saved]')
// the first line keeps its indent; blank lines at the edges go
assert.equal(toText(page(E('DIV', BR()), E('DIV', T('    if x:')), E('DIV', T('        y()')), E('DIV', BR()))), '    if x:\n        y()')
assert.equal(toText(page(E('DIV', T('x'), E('SPAN', T('y'))))), 'xy')
// quotes: only the point right above an answer is kept
// a quote is a run of blocks with class q; they may sit inside a wrapper block
const Q = (l) => ({ ...E('DIV', l ? T(l) : BR()), className: 'q' })
const quote = (...ls) => E('DIV', ...ls.map(Q))
const oldQuote = (...ls) => E('BLOCKQUOTE', ...ls.map((l) => E('DIV', l ? T(l) : BR())))
assert.equal(
  toText(page(quote('Intro paragraph.', '', '- first idea', '- second idea'), E('DIV', T('yes to this')), quote('- third idea', '', 'Closing line.'))),
  '> - second idea\nyes to this')
assert.equal(
  toText(page(T('general note'), quote('# Title', 'para line one', 'para line two', ''), E('DIV', BR()), E('DIV', T('agree')), quote('unanswered'))),
  'general note\n\n> para line one\n> para line two\n\nagree')
// a quote wrapped in a block, as the browser sometimes nests it
assert.equal(toText(page(E('DIV', quote('1. do x')), E('DIV', T('ok')))), '> 1. do x\nok')
assert.equal(toText(page(quote('only a quote'))), '')
assert.deepEqual(pointAbove(['a', '', '']), ['a'])
assert.deepEqual(pointAbove(['', '']), [])
assert.equal(quoteHtml('## A <b>\n\n- **c** & d\n'), '<div class="q">A &lt;b&gt;</div><div class="q"><br></div><div class="q">- c &amp; d</div>')
// inside a code block nothing is cleaned up: # and ** are code there
assert.equal(quoteHtml('**Run**\n```sh\n# install\ny = x ** 2 ** 3\n```\n# Done'),
  ['Run', '```sh', '# install', 'y = x ** 2 ** 3', '```', 'Done'].map((l) => '<div class="q">' + l + '</div>').join(''))
// an answer opened inside a quote, flat at the top level, with a focus-mode mark on a line
assert.equal(toText(page(T('Alpha'), { ...Q('one'), className: 'q now' }, E('DIV', T('answer')), Q('two'), Q('three'), E('DIV', T('last')), Q('tail'))), 'Alpha\n\n> one\nanswer\n\n> two\n> three\nlast')
assert.equal(toText(page(oldQuote('old style'), E('DIV', T('ok')))), '> old style\nok')
assert.deepEqual(toLines(page(quote('q'), E('DIV', T('a')))).map((l) => [l.t, l.q]), [['q', true], ['a', false]])
// a part copied out of Claude's reply is recognised, though copying drops the bold stars, bullets and numbers
const reply = '**Would help you every day**\n- **Answer Claude point by point.** One button pulls my last reply into the page.\n- **Sharpen on send.** A switch that runs your sharpen step.\n\n1. Install it for every chat.\n2. Answer point by point.'
assert.equal(isFrom(reply, 'Sharpen on send. A switch that runs your sharpen step.'), true)
assert.equal(isFrom(reply, '• Answer Claude point by point. One button pulls my last reply into the page.\n• Sharpen on send. A switch that runs your sharpen step.'), true)
assert.equal(isFrom(reply, 'Install it for every chat.\nAnswer point by point.'), true)
assert.equal(isFrom(reply, 'pulls my last reply into'), true, 'a piece from the middle of a line')
assert.equal(isFrom(reply, 'my own thought about the timer and the launch date'), false)
assert.equal(isFrom(reply, 'Sharpen on send. A switch that runs your sharpen step.\nbut I would rather keep it off\nand also change the colour\nplus one more idea'), false, 'mostly my own words')
assert.equal(isFrom(reply, 'yes'), false, 'too short to tell')
assert.equal(isFrom('', 'anything at all here'), false)
console.log('text ok')
