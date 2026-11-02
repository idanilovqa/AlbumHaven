"""Conservative optional same-descriptor WAV source qualification.

Default: canonical stereo48 RIFF signed PCM16/24/32 through seekable fd:.
The explicit native profile qualifies stereo44100 signed PCM16 only.
Unsupported files/platforms fall back to ordinary
playback. No file-wide read, subprocess, metadata inference or path-only proof.
"""
import os
import stat
import struct


def open_qualified_wave(path):
    """Legacy qualification stays stereo48 signed PCM16/24/32."""
    return _open_qualified_wave(path, 48000, (16, 24, 32))


def open_qualified_native_wave(path):
    """First native-rate evidence profile: canonical stereo44100 signed PCM16."""
    return _open_qualified_wave(path, 44100, (16,))


def _open_qualified_wave(path, sample_rate, widths):
    if any(ord(char) < 32 or ord(char) == 127 for char in str(path)):
        return None
    source = None
    try:
        source = open(path, 'rb', buffering=0)
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or not 44 <= before.st_size <= 2**32 + 7:
            return None
        header = source.read(44)
        if len(header) != 44:
            return None
        (riff, size, wave, fmt, fmt_size, encoding, channels, rate, byte_rate,
            align, bits, data, data_size) = struct.unpack('<4sI4s4sIHHIIHH4sI', header)
        if (riff, wave, fmt, fmt_size, encoding, channels, rate, data) != (
                b'RIFF', b'WAVE', b'fmt ', 16, 1, 2, sample_rate, b'data'):
            return None
        if bits not in widths or align != 2 * (bits // 8) or byte_rate != rate * align:
            return None
        if sample_rate == 44100 and data_size == 0:
            return None
        if size + 8 != before.st_size or data_size + 44 != before.st_size or data_size % align:
            return None
        after = os.fstat(source.fileno())
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            return None
        source.seek(0)
        source.qualification_stamp = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        # Server-only facts from this exact retained descriptor. Width changes
        # amplitude representation, not the retained native sample-frame grid.
        source.qualification_rate = rate
        source.qualification_bits = bits
        source.qualification_frames = data_size // align
        accepted = source
        source = None
        return accepted
    except (OSError, ValueError, struct.error):
        return None
    finally:
        if source is not None:
            source.close()


def qualified_wave_unchanged(source):
    try:
        value = os.fstat(source.fileno())
        return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns) == source.qualification_stamp
    except (OSError, ValueError, AttributeError):
        return False
