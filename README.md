# Unread Changes — Obsidian plugin

Unread-message awareness for a vault co-edited by humans and AI agents. When anyone
(or anything) other than you changes a note, it behaves like an unread message:

- 🔵 **Unread dot** on the note in the file explorer, with rollup counts on folders
- 📥 **Unread inbox** side pane: every unread note with who changed it and a
  plain-English summary
- 📄 **Banner** above changed notes (virtual — your files are never modified):
  *"Changed by claude (session xyz) · 2 h ago — reprioritised the fix wave"* with
  **[Changelog] [Diff] [Mark read]** actions
- 🔍 **Diff** of the note vs the version you last read (per-device snapshots), plus
  exact per-write diffs from the changelog
- 👤 **Attribution**: AI writes are stamped by the writer; your own edits never light
  up; unattributed external changes are labelled as such
- ✅ **Auto mark-as-read** after a configurable dwell (or instant / manual-only), with
  read-state **synced across your devices** conflict-free
- 🗂 **Audit trail**: every stamped change appends to `_changelog/<note path>` — plain
  markdown notes you can browse, search, and link like anything else

Design doc: [docs/DESIGN.md](docs/DESIGN.md) (architecture, validated sync model,
built-vs-designed cut-line).

## Why

As vaults become shared context layers — synced across devices, edited by
collaborators and increasingly by AI agents — sync alone gives you the latest
version of every file but no confidence you've actually *seen* it. Important
edits get silently missed, and there's no record of who changed what or why.
This plugin makes awareness sync along with the files: what changed, who changed
it, why, and whether you've reviewed it.

## How it works (short version)

- **Change detection** is content-hash based, never `mtime >` (sync tools rewrite
  mtimes): a persisted per-device baseline catches changes made while Obsidian was
  closed; vault events catch live ones; both feed one unread set.
- **Read-state** lives in `_unread/state/<deviceId>.json` — one file per device, each
  written only by its own device, merged newest-wins on read. No sync conflicts by
  construction (validated against remotely-save and Nextcloud desktop client
  semantics — see DESIGN.md §3.1).
- **Attribution** comes from `_changelog/<note path>` entries with the format:

  ```markdown
  ## 2026-07-09T14:30:00+08:00 — claude (session xyz) · agent
  **Summary:** Closed milestone 2 and scoped milestone 4.

  <details><summary>Diff</summary>

  ```diff
  …
  ```

  </details>
  ```

  Agents, scripts, or automations writing to the vault stamp these via
  [`scripts/vault_write.py`](scripts/vault_write.py). The format contract lives in
  `src/core/changelog.ts` + `vault_write.py` — keep them in sync.

## Install (per device)

1. Copy `main.js`, `manifest.json`, `styles.css` into
   `<vault>/.obsidian/plugins/unread-changes/`
2. Enable **Unread Changes** in Settings → Community plugins
3. First run seeds every note as *read* — badges appear only for changes after install.

Mobile (iOS/Android) is supported (`isDesktopOnly: false`, no Node APIs, no git).
If you sync with remotely-save, enable scheduled sync or sync-on-save — badge
propagation across devices is bounded by sync cadence.

## Development

```bash
npm install
npm run dev      # watch build (set OUTDIR=<vault>/.obsidian/plugins/unread-changes to build into a test vault)
npm test         # vitest unit tests (obsidian module stubbed)
npm run build    # typecheck + production bundle
python3 scripts/vault_write.py --self-test
```

Develop against a disposable test vault (there's a gitignored `dev-vault/`), never a
live one. End-to-end verification runs a real Obsidian with
`--remote-debugging-port=9222` and drives/inspects it over CDP.

## Status

v1 core (badges, read-state sync, inbox, banner, diffs, attribution, AI-side stamping)
is built and verified end-to-end in Obsidian 1.12.7. Phase-2 items (plugin-side
changelog entries for human edits, watcher-generated summaries for unattributed
changes, digest notes, store packaging) are designed in DESIGN.md §5.
