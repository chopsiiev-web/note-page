# Request: let a mod bring the browser pane on screen

Ready to post as an issue on the Claude Code repository. Not sent yet.

**What happens today**

A mod can open a page in the desktop app's browser pane:

```js
await $.mcp.call('Claude_Browser', 'preview_start', { url: 'http://localhost:47821/' })
```

The tab opens, but the pane stays hidden. The person has to click the globe icon to see it.
The only call that brings the pane on screen is opening a local file (`preview_start` with a
`file://` address). So a mod that wants to show a web page has to open a small file first,
then switch to its page and close the file's tab.

**What would fix it**

Any one of these:

- `preview_start({ url, reveal: true })`
- the `ccd_view` `show_pane` tool accepting `"browser"` as a pane
- a `$.ui` call that shows a named pane

**Why it matters**

Mods that show a real web page (a writing page, a dashboard, a preview) need to open with one
action. Today that takes a workaround that any app update can break.

**Related**

A file outside the chat's working folder asks "open this file?" on every single open, also for
a file inside the mod's own folder. A "always allow for this plugin's own files" choice would
remove the need to write a temporary file into the project.
