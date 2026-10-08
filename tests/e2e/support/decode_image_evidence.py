"""Read-only decoded pixel evidence for production-served artwork."""
import hashlib
from io import BytesIO
import json
import sys

from PIL import Image

with Image.open(BytesIO(sys.stdin.buffer.read())) as image:
    rgb = image.convert("RGB")
    print(json.dumps({"width": rgb.width, "height": rgb.height,
                      "sha256": hashlib.sha256(rgb.tobytes()).hexdigest()}))
