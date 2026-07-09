#!/usr/bin/env python3
"""Write a note into an Obsidian vault WITH unread-changes attribution stamping.

This is the writer-side half of the unread-changes plugin: every write also appends a
machine-parsable entry (author, role, summary, unified diff) to the note's changelog
at `_changelog/<note path>`, so the plugin can show who changed what, in plain English,
with a diff — before the vault owner opens the note.

Server mode (default) writes via `sudo install` as the vault owner and triggers a
Nextcloud `occ files:scan` for the touched directories. Configure it with env vars or
`~/.config/vault-write/env` (KEY=VALUE lines):
  VAULT_WRITE_ROOT       absolute path of the vault on the server
  VAULT_WRITE_OWNER_UID  uid/gid that owns the vault files (default 33 = www-data)
  VAULT_WRITE_OCC_PATH   occ scan path (e.g. "<user>/files/Obsidian"); empty = skip scan
  VAULT_WRITE_CONTAINER  docker container running Nextcloud (default "nextcloud")

`--vault-root <dir> --direct` writes as the current user with no sudo/occ — for test
vaults, development, and non-Nextcloud setups.

Usage:
  vault_write.py "AtlasAI/Clients/Josh/Issues.md" \
      --content-file /path/staged.md \
      --summary "Reprioritised the fix wave after UAT feedback" \
      --author "claude (session xyz)" [--role agent] [--no-changelog]

  vault_write.py --self-test   # runs the built-in unit checks in a temp dir
"""
from __future__ import annotations

import argparse
import datetime
import difflib
import subprocess
import sys
import tempfile
from pathlib import Path

import os


def _load_config_file() -> None:
    """Layer ~/.config/vault-write/env under real env vars (env wins)."""
    cfg = Path.home() / ".config/vault-write/env"
    if not cfg.is_file():
        return
    for line in cfg.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_config_file()

VAULT_ROOT = Path(os.environ.get("VAULT_WRITE_ROOT", "/vault"))
CHANGELOG_FOLDER = "_changelog"
OCC_SCAN_PATH = os.environ.get("VAULT_WRITE_OCC_PATH", "")
OWNER_UID = os.environ.get("VAULT_WRITE_OWNER_UID", "33")
NEXTCLOUD_CONTAINER = os.environ.get("VAULT_WRITE_CONTAINER", "nextcloud")
MAX_DIFF_LINES = 400


class VaultWriteError(RuntimeError):
    pass


def normalize_vault_path(value: str) -> str:
    parts = [p for p in value.replace("\\", "/").strip("/").split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        raise VaultWriteError(f"vault-relative path must not be empty or contain traversal: {value}")
    return "/".join(parts)


def unified_diff(old: str, new: str, path: str) -> str:
    lines = list(
        difflib.unified_diff(
            old.splitlines(), new.splitlines(), fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="", n=2,
        )
    )
    if len(lines) > MAX_DIFF_LINES:
        lines = lines[:MAX_DIFF_LINES] + [f"… diff truncated at {MAX_DIFF_LINES} lines …"]
    return "\n".join(lines)


def format_entry(timestamp: str, author: str, role: str, summary: str, diff: str | None) -> str:
    """MUST stay in lock-step with parseChangelog() in src/core/changelog.ts."""
    if "\n" in summary:
        summary = " ".join(summary.split())
    if " — " in author or " · " in author:
        raise VaultWriteError("author must not contain ' — ' or ' · ' (breaks the changelog parser)")
    out = f"## {timestamp} — {author} · {role}\n**Summary:** {summary}\n"
    if diff:
        out += f"\n<details><summary>Diff</summary>\n\n```diff\n{diff}\n```\n\n</details>\n"
    return out


def insert_entry(existing: str | None, entry: str, target: str) -> str:
    """Newest entry first, after the frontmatter; creates the file shape if absent."""
    if existing is None or not existing.strip():
        return f'---\ntarget: "{target}"\n---\n{entry}'
    lines = existing.split("\n")
    insert_at = 0
    if lines and lines[0] == "---":
        for i in range(1, len(lines)):
            if lines[i] == "---":
                insert_at = i + 1
                break
    head = "\n".join(lines[:insert_at])
    tail = "\n".join(lines[insert_at:]).lstrip("\n")
    return f"{head}\n{entry}\n{tail}" if head else f"{entry}\n{tail}"


def install_file(content: str, dest: Path, direct: bool) -> None:
    if direct:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as tmp:
        tmp.write(content)
        staged = tmp.name
    # NOT install -D: it creates intermediate dirs as root, and Nextcloud
    # (www-data) cannot then write/rename inside them — device sync breaks.
    if not dest.parent.is_dir():
        subprocess.run(
            ["sudo", "install", "-d", "-o", OWNER_UID, "-g", OWNER_UID, "-m", "755"]
            + [str(d) for d in sorted(set(dest.parents) - set(dest.parents[-3:]), key=lambda x: len(str(x))) if not d.is_dir()],
            check=True,
        )
    subprocess.run(
        ["sudo", "install", "-o", OWNER_UID, "-g", OWNER_UID, "-m", "644", staged, str(dest)],
        check=True,
    )
    Path(staged).unlink(missing_ok=True)


def occ_rescan(touched: list[str]) -> None:
    """Scan only the directories actually touched (full-vault scans serialize badly)."""
    if not OCC_SCAN_PATH:
        return
    dirs = sorted({str(Path(t).parent).replace("\\", "/").strip("/.") for t in touched})
    for d in dirs or [""]:
        scan_path = f"{OCC_SCAN_PATH}/{d}".rstrip("/")
        subprocess.run(
            ["docker", "exec", "-u", "www-data", NEXTCLOUD_CONTAINER, "php", "occ", "files:scan", f"--path={scan_path}", "--shallow"],
            check=True,
            stdout=subprocess.DEVNULL,
        )


def write_note(
    vault_root: Path,
    note_path: str,
    content: str,
    summary: str,
    author: str,
    role: str,
    *,
    direct: bool,
    changelog: bool = True,
    changelog_folder: str = CHANGELOG_FOLDER,
    now: datetime.datetime | None = None,
) -> dict:
    note_path = normalize_vault_path(note_path)
    dest = vault_root / note_path
    old = dest.read_text(encoding="utf-8") if dest.is_file() else None

    if old == content:
        return {"note": str(dest), "changed": False, "changelog": None}

    result: dict = {"note": str(dest), "changed": True, "changelog": None}
    install_file(content, dest, direct)
    touched = [note_path]

    if changelog:
        timestamp = (now or datetime.datetime.now().astimezone()).isoformat(timespec="seconds")
        diff = unified_diff(old or "", content, note_path)
        entry = format_entry(timestamp, author, role, summary, diff)
        changelog_rel = f"{changelog_folder.strip('/')}/{note_path}"
        changelog_path = vault_root / changelog_rel
        existing = changelog_path.read_text(encoding="utf-8") if changelog_path.is_file() else None
        install_file(insert_entry(existing, entry, note_path), changelog_path, direct)
        result["changelog"] = str(changelog_path)
        touched.append(changelog_rel)

    if not direct:
        occ_rescan(touched)
    return result


def self_test() -> int:
    import json

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        ts = datetime.datetime(2026, 7, 9, 14, 30, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))

        # 1. new note → note + changelog created, diff is all-additions
        r1 = write_note(root, "A/B.md", "# Hello\nline\n", "Created the note", "claude (test)", "agent", direct=True, now=ts)
        assert r1["changed"] and Path(r1["note"]).read_text() == "# Hello\nline\n"
        cl = Path(r1["changelog"]).read_text()
        assert cl.startswith('---\ntarget: "A/B.md"\n---\n## 2026-07-09T14:30:00+08:00 — claude (test) · agent\n'), cl
        assert "**Summary:** Created the note" in cl and "+# Hello" in cl

        # 2. edit → new entry INSERTED ABOVE the old one, after frontmatter
        r2 = write_note(root, "A/B.md", "# Hello\nline2\n", "Changed the line", "claude (test)", "agent", direct=True, now=ts + datetime.timedelta(hours=1))
        cl2 = Path(r2["changelog"]).read_text()
        assert cl2.index("15:30:00") < cl2.index("14:30:00"), "newest entry must be first"
        assert cl2.count('target: "A/B.md"') == 1
        assert "-line\n" in cl2 and "+line2" in cl2

        # 3. identical write → no-op, no changelog entry
        r3 = write_note(root, "A/B.md", "# Hello\nline2\n", "No-op", "claude (test)", "agent", direct=True, now=ts)
        assert not r3["changed"] and Path(r2["changelog"]).read_text() == cl2

        # 4. traversal guard
        try:
            write_note(root, "../evil.md", "x", "s", "a", "agent", direct=True)
            raise AssertionError("traversal must raise")
        except VaultWriteError:
            pass

        # 5. author guard (would break plugin parser)
        try:
            format_entry("t", "bad · author", "agent", "s", None)
            raise AssertionError("author guard must raise")
        except VaultWriteError:
            pass

        # 6. summary with newlines is flattened
        entry = format_entry("2026-07-09T14:30:00+08:00", "a", "agent", "line1\nline2", None)
        assert "**Summary:** line1 line2" in entry

        # 7. custom changelog folder is honoured
        r7 = write_note(root, "C.md", "x\n", "s", "a", "agent", direct=True, now=ts, changelog_folder="Meta/_changelog")
        assert r7["changelog"].endswith("Meta/_changelog/C.md"), r7

        print(json.dumps({"self_test": "ok", "checks": 7}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("vault_relative_path", nargs="?")
    parser.add_argument("--content-file", help="file with the FULL new note content (default: stdin)")
    parser.add_argument("--summary", help="plain-English one-liner: what changed and why (required)")
    parser.add_argument("--author", default="claude", help="attribution, e.g. 'claude (session foo)'")
    parser.add_argument("--role", default="agent", choices=["agent", "human", "automation"])
    parser.add_argument("--vault-root", default=str(VAULT_ROOT))
    parser.add_argument("--direct", action="store_true", help="plain filesystem write, no sudo/occ (test vaults)")
    parser.add_argument("--no-changelog", action="store_true", help="skip the changelog entry (bulk/scratch writes)")
    parser.add_argument("--changelog-folder", default=CHANGELOG_FOLDER, help="MUST match the plugin's 'Changelog folder' setting")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.vault_relative_path:
        parser.error("vault_relative_path is required")
    if not args.summary and not args.no_changelog:
        parser.error("--summary is required (or pass --no-changelog for scratch writes)")

    content = Path(args.content_file).read_text(encoding="utf-8") if args.content_file else sys.stdin.read()
    try:
        result = write_note(
            Path(args.vault_root),
            args.vault_relative_path,
            content,
            args.summary or "",
            args.author,
            args.role,
            direct=args.direct,
            changelog=not args.no_changelog,
            changelog_folder=args.changelog_folder,
        )
    except (VaultWriteError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
