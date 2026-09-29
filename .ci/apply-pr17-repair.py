"""Apply only reviewed, blob-pinned operations in a disposable CI checkout."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

packet = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
mode = sys.argv[2]
if mode not in {"apply", "verify"}:
    raise SystemExit("Expected apply or verify")

def git(*args):
    return subprocess.check_output(["git", *args])

def blob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()

head = git("rev-parse", "HEAD").decode().strip()
if head != packet["head"]:
    raise SystemExit("Checkout head changed")
expected = {}
for name, before, after, edits in packet["files"]:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or path.is_symlink() or name in expected:
        raise SystemExit("Unsafe or duplicate repair path: " + name)
    expected[name] = after
    if mode == "apply":
        if before:
            raw = git("show", "HEAD:" + name)
            if blob(raw) != before:
                raise SystemExit("Input blob changed: " + name)
        else:
            if path.exists():
                raise SystemExit("New path already exists: " + name)
            raw = b""
        lines = raw.decode("utf-8").splitlines(keepends=True)
        previous = len(lines)
        for start, end, text in reversed(edits):
            if not 0 <= start <= end <= previous:
                raise SystemExit("Overlapping or invalid edits: " + name)
            previous = start
            lines[start:end] = [text]
        output = "".join(lines).encode("utf-8")
        if blob(output) != after:
            raise SystemExit("Output blob mismatch: " + name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(output)
    elif blob(path.read_bytes()) != after:
        raise SystemExit("Verified output changed: " + name)

bundle = "music_app/static/js/runtime-bundle.js"
expected[bundle] = packet["bundle"]["after"]
if mode == "apply":
    if blob(git("show", "HEAD:" + bundle)) != packet["bundle"]["before"]:
        raise SystemExit("Input bundle changed")
    subprocess.run(["node", "scripts/build-runtime-bundle.cjs"], check=True)
if blob(Path(bundle).read_bytes()) != expected[bundle]:
    raise SystemExit("Rebuilt bundle differs from the reviewed output")
changed = set(git("diff", "--name-only").decode().splitlines())
changed.update(git("ls-files", "--others", "--exclude-standard").decode().splitlines())
if changed != set(expected):
    raise SystemExit("Unexpected changed paths: " + repr(changed.symmetric_difference(expected)))
subprocess.run(["git", "diff", "--check"], check=True)
print("VERIFIED", len(expected), "reviewed output blobs at", head)
