"""Bounded first-sample timestamp observation for the existing FLAC producer.

This observes the unchanged decoder before encoding. It never seeks, transforms
samples, waits for proof, or turns the requested seek position into evidence.
"""
import re


class EncodedSeekOrigin:
    def __init__(self, *, source_rate, coordinate_rate, start_frame):
        numerator = start_frame * source_rate
        self.expected, remainder = divmod(numerator, coordinate_rate)
        self.available = remainder == 0
        self.confirmed = False
        self._line = bytearray()
        self._pattern = re.compile(
            rb'^\[Parsed_ashowinfo_[0-9]+ @ [^\]\r\n]{1,64}\] '
            rb'n:0 pts:([0-9]{1,16}) pts_time:\S+ (?:pos:\S+ )?'
            rb'fmt:\S+ channels:[0-9]+ chlayout:\S+ rate:'
            + str(source_rate).encode()
            + rb' nb_samples:([0-9]{1,8}) checksum:[0-9A-Fa-f]+ '
            rb'plane_checksums: \[[^\r\n]*\]$')

    def feed(self, chunk):
        if not self.available or self.confirmed:
            return
        for value in chunk:
            if value != 10:
                if len(self._line) >= 2048:
                    self.available = False
                    self._line.clear()
                    return
                self._line.append(value)
                continue
            line = bytes(self._line).rstrip(b'\r')
            self._line.clear()
            if b'ashowinfo' not in line or b' n:' not in line:
                continue
            match = self._pattern.fullmatch(line)
            if match is None or int(match[1]) != self.expected or int(match[2]) <= 0:
                self.available = False
                return
            self.confirmed = True

