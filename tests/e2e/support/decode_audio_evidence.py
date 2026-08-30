import json
import math
import struct
import subprocess
import sys

import imageio_ffmpeg


def main() -> None:
    media = sys.stdin.buffer.read()
    if not media:
        raise ValueError("audio evidence input is empty")
    completed = subprocess.run(
        [
            imageio_ffmpeg.get_ffmpeg_exe(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-t",
            "1",
            "-f",
            "f32le",
            "-ac",
            "2",
            "-ar",
            "48000",
            "pipe:1",
        ],
        check=True,
        input=media,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    sample_count = len(completed.stdout) // 4
    if sample_count == 0 or len(completed.stdout) % 8:
        raise ValueError("decoded audio did not contain complete stereo f32le frames")
    finite_samples = 0
    nonzero_samples = 0
    peak_sample = 0.0
    for (sample,) in struct.iter_unpack("<f", completed.stdout):
        if math.isfinite(sample):
            finite_samples += 1
        if sample != 0:
            nonzero_samples += 1
        peak_sample = max(peak_sample, abs(sample))
    print(json.dumps({
        "frameCount": sample_count // 2,
        "finiteSamples": finite_samples,
        "nonZeroSamples": nonzero_samples,
        "peakSample": peak_sample,
        "sampleRate": 48000,
    }))


if __name__ == "__main__":
    main()
