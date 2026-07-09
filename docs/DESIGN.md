# Unread Changes — architecture & design

Unread-message awareness for an Obsidian vault that is edited by more than one
writer — you on several devices, collaborators, automations, or AI agents — and
synchronised by tools like remotely-save or a Nextcloud/Syncthing folder sync.

The goal: when a note changes and *you weren't the one who changed it here*, it
behaves like an unread message — badge, attribution, plain-English summary, diff,
and an auto-clearing read-state that follows you across devices.

## 1. Design decisions

| Fork | Decision |
|---|---|
| Read-state scope | **Synced across devices** via conflict-free per-device files (validated below, §3.1) |
| Changelog home | **Visible vault folder** (`_changelog/`), one changelog note per note — plain markdown, browsable/linkable, works without the plugin |
| Note "header" | **Virtual banner** rendered by the plugin above changed notes; note files are never modified |
| Change summaries | **Writer-stamped**: the agent/automation making the edit writes summary + diff into the changelog at write time (see `scripts/vault_write.py`) |
| Mark-as-read | Dwell: note open and active ~3 s (configurable; instant / dwell / manual-only), plus explicit mark read/unread commands |
| Attribution of local edits | Automatic: local editor activity whose buffer matches the saved content ⇒ your edit, never unread on this device; external arrival with a matching changelog entry ⇒ stamped author; otherwise "unattributed external change" |

## 2. Architecture

```
┌─ Obsidian plugin (each device) ──────────────────────────────┐
│ ChangeDetector → UnreadStore → UI (badges, banner, inbox,    │
│ diff modal) ← ChangelogReader                                │
└──────────────────────────────────────────────────────────────┘
        ▲ file sync (remotely-save / folder sync)  ▲
┌─ Vault (synced state) ───────────────────────────────────────┐
│ notes/**            — your content (never touched)           │
│ _changelog/**       — per-note changelog notes               │
│ _unread/state/*.json— per-device read logs (1 writer each)   │
└──────────────────────────────────────────────────────────────┘
        ▲ any server-side / scripted writer
┌─ Writer-side stamping ───────────────────────────────────────┐
│ vault_write.py — writes note, appends changelog entry        │
│ (author, ISO time, summary, unified diff)                    │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 Read-state model (validated against sync-tool semantics)

**Validation summary** (from source-level review of remotely-save @ 34db181 and
Nextcloud behavior): one state file per device, written only by its owning device,
never conflicts — remotely-save's three-way prevSync algorithm sees each file modified
on exactly one side (clean push/pull; `keep_newer` never engages in steady state), the
Nextcloud desktop client only conflict-copies when both sides change the same file, and
Nextcloud serializes concurrent PUTs per path with atomic `.part`-file renames (no torn
JSON). Four commitments convert "mostly avoided" into "avoided":

1. State files live in a **visible vault folder** (`_unread/state/`), not `.obsidian/`
   — hidden files don't sync by default under common sync tools, and visible files are
   TFiles that fire vault events (which drives cross-device badge refresh).
2. **Device ID stored outside the vault** (`localStorage`, keyed per app install),
   collision-resistant (random suffix), so a vault copy/restore can't create two
   writers of the same file. All other devices' files are read-only.
3. **Merge-monotonic format**: per-note read events; merging is union + newest-wins per
   note. A rare rollback (sync-tool state-DB loss) loses at most recency, never
   integrity.
4. Refresh on vault events for `_unread/state/` (they fire for remotely-save downloads,
   which write via `vault.adapter.writeBinary`) + opportunistic `remotely-save`
   `SYNC_DONE` hook; self-filter events for our own device file.

**Content identity is the hash, never the mtime.** remotely-save rewrites mtimes to
sync-times (it sends no `X-OC-MTime` over WebDAV), so a read recorded on one device is
meaningless on another unless keyed by content. A note is **unread** iff
`hash(current content) ≠ hash recorded by the latest read event across all devices`
(or an explicit mark-unread is newer than the latest read).

State file `_unread/state/<deviceId>.json` (own-device writes only, debounced):

```json
{ "version": 1, "deviceId": "d-9f2c…", "deviceName": "Desktop",
  "notes": { "Projects/Plan.md": { "readAt": 1783574000000, "hash": "sha256:…" } },
  "unread": { "Inbox/Later.md": 1783574100000 } }
```

Local per-device data (IndexedDB via localforage, *not* synced): a baseline map of
`path → {mtime, size, hash}` as of the last scan (lets the startup reconcile re-hash
only files whose stat changed), and last-read content snapshots for diffing.

### 3.2 Change detection (three layers, all mobile-safe)

1. **Startup reconcile** (`onLayoutReady`): walk `vault.getMarkdownFiles()`, compare
   `file.stat.{mtime,size}` against the local baseline with **inequality** (never
   `>` — sync moves mtimes backwards); re-hash changed candidates in parallel chunks;
   recompute the unread set; prune read-state for files deleted while the app was
   closed. The only mechanism that catches closed-app changes (critical on iOS, which
   has no foreground rescan).
2. **Live events**: `vault.on('modify'|'create'|'delete'|'rename')` registered inside
   `onLayoutReady` (a `create` flood fires for every file at load otherwise). These
   fire for user edits, other plugins, and sync-tool downloads on both platforms.
   Delete+create of the same path within a short grace window is treated as a modify
   (atomic-replace pattern); `rename` transfers read-state, snapshots, and moves the
   changelog sidecar. Own state-file writes are suppressed via a pending-echo set.
3. **Content layer**: `metadataCache.on('changed')` supplies updated content for diff
   and banner refresh.

Self-edit detection: a modify counts as *your* edit only when the editor was recently
active on that path **and** the saved content matches an open editor buffer — a sync
write landing mid-typing differs from your buffer and stays external/unread.

Edge cases honoured: mtime+size-identical edits are invisible to Obsidian's watcher
(accepted; rare), first install seeds **everything as read** with snapshots (no
"Christmas tree", and first changes still get diffs), a manual "Rescan vault" command
re-runs layer 1.

### 3.3 UI surfaces

- **Explorer badges**: dot on unread files, rolled-up count on ancestor folders.
  Technique (proven across community plugins): `getLeavesOfType('file-explorer')` →
  `await leaf.loadIfDeferred()` (≥1.7.2) → `view.fileItems[path].selfEl` → toggle CSS
  class / `data-uc-count` attr, styled by `::before`/`attr()`. Rollups computed from
  the vault model, never the DOM. Refresh coalesced with `requestAnimationFrame`;
  re-applied on vault events, `layout-change`, and a childList MutationObserver.
- **Banner** (virtual): one wrapper div inserted as first child of `view.contentEl`,
  `position: sticky; top: 0` — covers reading, live-preview and source modes with a
  single element. Reconciled on debounced `active-leaf-change` + `layout-change`;
  the read-state timestamp is captured when the banner first appears so attribution
  survives the dwell mark-read; all elements removed in `onunload`.
- **Inbox pane** (right sidebar `ItemView`): all unread notes, newest first, with
  attribution + summary line; async redraws are generation-guarded against
  interleaving; click opens the note.
- **Diff modal**: current content vs the last-read snapshot, word/line diff via the
  `diff` package; falls back to the newest changelog diff.
- **Commands / file menu**: mark read / mark unread (file, folder, vault), open inbox,
  rescan vault, open changelog, show diff.

### 3.4 Changelog + attribution

`_changelog/<note path>.md` mirrors the note tree. Newest entry first,
machine-parsable headings (fence-aware parser — `##` inside diff blocks is content):

```markdown
---
target: "Projects/Plan.md"
---
## 2026-07-09T12:45:39+08:00 — claude (session xyz) · agent
**Summary:** Added the staging feedback; reprioritised the fix wave.

<details><summary>Diff</summary>

```diff
@@ -12,6 +12,9 @@
…
```

</details>
```

- **Scripted/AI writes**: `scripts/vault_write.py` computes the diff against the
  existing note, writes the note, prepends the changelog entry (author, role tag,
  summary), and (in server mode) triggers the file-index rescan. Its output format is
  contract-locked with the plugin parser (`src/core/changelog.ts`) — round-trip tested
  on both sides.
- **Human edits**: local edits are read-by-definition on the device that made them; an
  external change with no matching changelog entry shows as *"unattributed external
  change"*. (Phase 2: the plugin writes lightweight changelog entries for local human
  edits so *other* devices show "You (Desktop)" with a diff.)
- `_changelog/**` and `_unread/**` are excluded from unread tracking (exact folder
  paths, so nesting them under a content folder never untracks the content), plus a
  user-configurable exclusion list.
- Audit trail = the `_changelog/` tree itself: plain markdown, browsable, searchable.

## 4. What syncs where

| Data | Location | Synced? | Writers |
|---|---|---|---|
| Read events + unread marks | `_unread/state/<device>.json` | yes | that device only |
| Baseline + snapshots | plugin IndexedDB | no (per-device) | that device |
| Device id/name | localStorage | no (per-device) | that device |
| Changelog + summaries + diffs | `_changelog/**` | yes | stamping writers (+ plugins, phase 2) |
| Settings | plugin `data.json` | only if config-dir sync is enabled | each device |

## 5. Cut-line: built vs designed

**Built (v1):**
- 3-layer change detection, hash-keyed read-state, per-device synced state files,
  seeding with snapshots, rename/delete/atomic-replace handling, own-write and
  self-edit suppression.
- Explorer badges + folder rollups; unread inbox; virtual banner; dwell/instant/manual
  mark-as-read; diff modal; changelog attribution; settings; commands + file menu.
- `vault_write.py` writer-side stamping (env-configurable server mode + `--direct`).
- 41 unit tests (vitest, obsidian stubbed); verified end-to-end in Obsidian 1.12.7,
  including an 8-angle adversarial review wave (27 confirmed findings, 24 fixed).

**Designed, not built (phase 2+):**
- Plugin-side changelog entries for local human edits (cross-device human attribution).
- Watcher/agent-generated AI prose summaries for unattributed edits.
- Daily digest index note and richer audit-trail browsing (filter by author/date).
- Content-identity (hash-anchored) changelog↔read matching; currently newest-entry
  fallback covers the wall-clock edge.

## 6. Known trade-offs

- **Internal APIs** (`view.fileItems`, deferred views, `leaf.id`): isolated behind
  helpers; degrade to no-badges rather than crash; the inbox pane (public API) always
  works.
- **Cross-device badge latency** is bounded by sync cadence (remotely-save defaults to
  manual sync — enable scheduled/sync-on-save).
- **`_unread/` and `_changelog/` are visible folders** by design (hidden folders don't
  sync and don't fire vault events); both names are configurable.
- Badge refresh iterates the explorer's `fileItems` map; coalesced via rAF — fine into
  the thousands of notes, revisit for very large vaults.
