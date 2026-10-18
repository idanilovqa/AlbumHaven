"""Bounded metadata only. Never grants runtime trust or executes native tests."""
# This covers Python code after startup, including imports, setup and output.
# Interpreter startup/parse failures and uncatchable termination remain outside it.
try:
    import sys

    # Check isolation before importing any other Python module. -S excludes .pth/site.
    if not (len(sys.argv) == 1 and sys.flags.isolated and sys.flags.no_site
            and sys.flags.dont_write_bytecode and sys.implementation.name == "cpython"
            and sys.platform == "linux" and sys.version_info[:2] == (3, 11)):
        raise ValueError("isolation")

    import os
    import hashlib
    import json
    import stat

    SOURCE_NAMES = (
        "asyncio/base_events.py", "asyncio/base_subprocess.py", "asyncio/events.py",
        "asyncio/selector_events.py", "asyncio/subprocess.py", "asyncio/unix_events.py",
        "selectors.py", "subprocess.py", "threading.py",
    )
    MAX_FILE_BYTES = 1048576
    CHUNK_BYTES = 65536
    MAX_JSON_BYTES = 8192
    DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


    def directory_at(parent, component):
        """Open a single directory component without symlink traversal."""
        if not component or component in (".", "..") or "/" in component:
            raise ValueError("directory")
        return os.open(component, DIR_FLAGS, dir_fd=parent)


    def absolute_directory(path):
        # Strictly reject noncanonical paths; do not resolve/follow arbitrary links.
        if not isinstance(path, str) or len(path) > 4096 or not path.startswith("/"):
            raise ValueError("path")
        parts = path.split("/")[1:]
        if not parts or len(parts) > 32:
            raise ValueError("path")
        fd = os.open("/", DIR_FLAGS)
        try:
            for part in parts:
                child = directory_at(fd, part)
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise


    def fingerprint(st):
        return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_size,
                st.st_mtime_ns, st.st_ctime_ns)


    def capture():
        # CPython supplies these; no environment, sysconfig, configuration or cwd read.
        base = sys.base_prefix
        stdlib = sys._stdlib_dir
        expected = base + "/lib/python3.11"
        if stdlib != expected or sys.prefix != base or sys.exec_prefix != base:
            raise ValueError("layout")
        base_fd = absolute_directory(base)
        lib_fd = stdlib_fd = asyncio_fd = None
        records = []
        try:
            lib_fd = directory_at(base_fd, "lib")
            stdlib_fd = directory_at(lib_fd, "python3.11")
            asyncio_fd = directory_at(stdlib_fd, "asyncio")
            for name in SOURCE_NAMES:
                parent = asyncio_fd if name.startswith("asyncio/") else stdlib_fd
                leaf = name.rsplit("/", 1)[-1]
                fd = os.open(leaf, FILE_FLAGS, dir_fd=parent)
                try:
                    before = os.fstat(fd)
                    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                            or not 0 < before.st_size <= MAX_FILE_BYTES):
                        raise ValueError("file")
                    digest = hashlib.sha256()
                    remaining = before.st_size
                    while remaining:
                        chunk = os.read(fd, min(remaining, CHUNK_BYTES))
                        if not chunk:
                            raise ValueError("short_read")
                        digest.update(chunk)
                        remaining -= len(chunk)
                    if os.read(fd, 1) or fingerprint(before) != fingerprint(os.fstat(fd)):
                        raise ValueError("changed")
                    records.append({"name": name, "size_bytes": before.st_size,
                                    "sha256": digest.hexdigest()})
                finally:
                    os.close(fd)
        finally:
            for fd in (asyncio_fd, stdlib_fd, lib_fd, base_fd):
                if fd is not None:
                    os.close(fd)
        report = {"schema": "albumhaven-rooted-stdlib-metadata-v1",
                  "purpose": "unreviewed_metadata_only", "runtime_approved": False,
                  "native_tests_executed": False,
                  "implementation": sys.implementation.name, "platform": sys.platform,
                  "version": list(sys.version_info), "source_files": records,
                  "layout": "verified_base_prefix/lib/python3.11",
                  "max_file_bytes": MAX_FILE_BYTES}
        encoded = json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n"
        if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
            raise ValueError("report")
        return encoded


    if __name__ == "__main__":
        result = capture()
        sys.stdout.write(result)
        sys.stdout.flush()
        # Explicit successful flush is complete; avoid later shutdown flush/finalizers.
        os._exit(0)
except BaseException:
    # Fixed diagnostic only; an unavailable stderr may prevent any diagnostic.
    try:
        sys.stderr.write("rooted_metadata_capture_failed\n")
        sys.stderr.flush()
    except BaseException:
        pass
    try:
        # os is imported before other stdlib dependencies, after isolation checks.
        # Immediate exit avoids retrying failed stdout/stderr buffers at shutdown.
        os._exit(1)
    except BaseException:
        # Isolation rejection or an os import failure may leave no _exit helper.
        # Disable Python's shutdown stream flushing before the fallback exit.
        try:
            sys.stdout = None
            sys.stderr = None
        except BaseException:
            pass
        raise SystemExit(1) from None
