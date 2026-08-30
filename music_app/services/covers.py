from __future__ import annotations
from collections import OrderedDict
from concurrent.futures import Future
import hashlib
import io
import os
from pathlib import Path
from threading import Lock, RLock

try:
    from PIL import Image, ImageFilter
except ImportError:
    Image = None
    ImageFilter = None

from music_app.services.runtime_shutdown import create_daemon_executor

_COVER_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
_PREFERRED_COVER_STEMS = ("cover", "folder", "front", "album", "art")
_LOW_QUALITY_COVER_STEMS = ("albumartsmall",)
_IMAGE_DIMENSIONS_CACHE_LOCK = Lock()
_IMAGE_DIMENSIONS_CACHE: dict[str, tuple[tuple[int, int] | None, tuple[int, int]]] = {}
_COVER_VARIANT_PREWARM_LOCK = RLock()
_COVER_VARIANT_PREWARM_INFLIGHT: dict[str, dict[str, object]] = {}
_COVER_VARIANT_ADMISSION_LOCK = Lock()
_COVER_VARIANT_ADMISSION_INFLIGHT: set[tuple[str, str, int]] = set()
_COVER_VARIANT_ADMISSION_WORKERS = 2
_COVER_VARIANT_BACKGROUND_WORKERS = 2
_COVER_VARIANT_BACKGROUND_CAPACITY = (
    _COVER_VARIANT_ADMISSION_WORKERS + _COVER_VARIANT_BACKGROUND_WORKERS
)
_COVER_VARIANT_BACKGROUND_PENDING: OrderedDict[
    tuple[str, str, int], tuple[Path, dict[str, object]]
] = OrderedDict()
_COVER_VARIANT_BACKGROUND_RUNNING: set[tuple[str, str, int]] = set()
_COVER_VARIANT_BACKGROUND_DRAINERS = 0
_COVER_VARIANT_FOREGROUND_WORKERS = 5
_COVER_VARIANT_INTERACTIVE_WORKERS = 1
_COVER_VARIANT_ADMISSION_EXECUTOR = create_daemon_executor(
    max_workers=_COVER_VARIANT_ADMISSION_WORKERS,
    thread_name_prefix="albumhaven-cover-variant-admission",
)
_COVER_VARIANT_PREWARM_EXECUTOR = create_daemon_executor(
    max_workers=_COVER_VARIANT_BACKGROUND_WORKERS,
    thread_name_prefix="albumhaven-cover-variant",
)
_COVER_VARIANT_FOREGROUND_EXECUTOR = create_daemon_executor(
    max_workers=_COVER_VARIANT_FOREGROUND_WORKERS,
    thread_name_prefix="albumhaven-cover-variant-demand",
)
_COVER_VARIANT_INTERACTIVE_EXECUTOR = create_daemon_executor(
    max_workers=_COVER_VARIANT_INTERACTIVE_WORKERS,
    thread_name_prefix="albumhaven-cover-variant-interactive",
)
_COVER_VARIANT_PRIORITY_BACKGROUND = "background"
_COVER_VARIANT_PRIORITY_FOREGROUND = "foreground"
_COVER_VARIANT_PRIORITY_INTERACTIVE = "interactive"
_COVER_VARIANT_PRIORITY_RANK = {
    _COVER_VARIANT_PRIORITY_BACKGROUND: 0,
    _COVER_VARIANT_PRIORITY_FOREGROUND: 1,
    _COVER_VARIANT_PRIORITY_INTERACTIVE: 2,
}
_COVER_VARIANT_CACHE_POLICY_VERSION = "opaque-png-jpeg-q95-444-v1"


def _resampling_bilinear():
    if Image is None:
        return None
    resampling = getattr(Image, "Resampling", Image)
    return getattr(resampling, "BILINEAR", getattr(Image, "BILINEAR", 2))


def _resampling_lanczos():
    if Image is None:
        return None
    resampling = getattr(Image, "Resampling", Image)
    return getattr(resampling, "LANCZOS", getattr(Image, "LANCZOS", _resampling_bilinear()))


def _decode_image_bytes(raw_bytes: bytes):
    if Image is None:
        return None
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img.load()
        return img
    except Exception:
        return None


def _image_visual_fingerprint(img) -> bytes | None:
    try:
        reduced = img.convert("RGB").resize((64, 64), _resampling_lanczos())
        if ImageFilter is not None:
            reduced = reduced.filter(ImageFilter.GaussianBlur(radius=1.0))
        return reduced.tobytes()
    except Exception:
        return None


def _maximum_visual_block_delta(
    existing_fingerprint: bytes,
    incoming_fingerprint: bytes,
) -> float:
    block_totals = [0] * 64
    for pixel_index in range(64 * 64):
        byte_index = pixel_index * 3
        block_index = ((pixel_index // 64) // 8) * 8 + ((pixel_index % 64) // 8)
        for channel_offset in range(3):
            block_totals[block_index] += abs(
                existing_fingerprint[byte_index + channel_offset]
                - incoming_fingerprint[byte_index + channel_offset]
            )
    return max(block_totals, default=0) / (8 * 8 * 3)


def _image_difference_hash(img) -> int | None:
    try:
        reduced = img.convert("L").resize((9, 8), _resampling_bilinear())
        get_flattened_data = getattr(reduced, "get_flattened_data", None)
        pixels = list(
            get_flattened_data()
            if callable(get_flattened_data)
            else reduced.getdata()
        )
        fingerprint = 0
        for y in range(8):
            row_offset = y * 9
            for x in range(8):
                fingerprint <<= 1
                if pixels[row_offset + x] > pixels[row_offset + x + 1]:
                    fingerprint |= 1
        return fingerprint
    except Exception:
        return None


def cover_stem(path: Path | None) -> str:
    if path is None:
        return ""
    return str(path.stem or "").strip().casefold()


def is_low_quality_cover_name(path: Path | None) -> bool:
    stem = cover_stem(path)
    return any(stem.startswith(prefix) for prefix in _LOW_QUALITY_COVER_STEMS)


def is_authoritative_cover_name(path: Path | None) -> bool:
    return cover_stem(path) == "cover"


def needs_remote_cover_refresh(path: Path | None) -> bool:
    if path is None:
        return True
    if is_low_quality_cover_name(path):
        return True
    return not is_authoritative_cover_name(path)


def measure_image_sharpness(image) -> float:
    if Image is None or image is None:
        return 0.0
    try:
        sample = image.convert("L")
        sample.thumbnail((256, 256), _resampling_bilinear())
        width, height = sample.size
        if width < 2 or height < 2:
            return 0.0
        pixels = list(sample.getdata())
        total_delta = 0.0
        comparisons = 0
        for y in range(height):
            row_offset = y * width
            for x in range(width - 1):
                total_delta += abs(pixels[row_offset + x] - pixels[row_offset + x + 1])
                comparisons += 1
        for y in range(height - 1):
            row_offset = y * width
            next_row_offset = (y + 1) * width
            for x in range(width):
                total_delta += abs(pixels[row_offset + x] - pixels[next_row_offset + x])
                comparisons += 1
        return float(total_delta / comparisons) if comparisons else 0.0
    except Exception:
        return 0.0


def images_are_visually_similar(existing_path: Path, raw_bytes: bytes) -> bool:
    if not existing_path.is_file():
        return False
    try:
        existing_bytes = existing_path.read_bytes()
    except Exception:
        return False
    existing_img = _decode_image_bytes(existing_bytes)
    incoming_img = _decode_image_bytes(raw_bytes)
    if existing_img is None or incoming_img is None:
        return False
    try:
        existing_fingerprint = _image_visual_fingerprint(existing_img)
        incoming_fingerprint = _image_visual_fingerprint(incoming_img)
        if not existing_fingerprint or not incoming_fingerprint:
            return False
        if existing_fingerprint == incoming_fingerprint:
            return True
        total_delta = 0
        for left, right in zip(existing_fingerprint, incoming_fingerprint):
            total_delta += abs(int(left) - int(right))
        average_delta = total_delta / max(1, len(existing_fingerprint))
        maximum_block_delta = _maximum_visual_block_delta(
            existing_fingerprint,
            incoming_fingerprint,
        )
        existing_hash = _image_difference_hash(existing_img)
        incoming_hash = _image_difference_hash(incoming_img)
        if existing_hash is None or incoming_hash is None:
            return False
        structural_delta = (existing_hash ^ incoming_hash).bit_count()
        return (
            average_delta <= 5.0
            and maximum_block_delta <= 6.0
            and structural_delta <= 4
        )
    finally:
        try:
            existing_img.close()
        except Exception:
            pass
        try:
            incoming_img.close()
        except Exception:
            pass


def reserve_existing_cover_variant(folder: Path, raw_bytes: bytes) -> Path | None:
    current_cover = folder / "cover.jpg"
    if not current_cover.is_file():
        return None
    if images_are_visually_similar(current_cover, raw_bytes):
        return None
    current_bytes = current_cover.read_bytes()
    index = 1
    while True:
        candidate = folder / f"cover-existing-{index}.jpg"
        try:
            with candidate.open("xb") as reserve_file:
                reserve_file.write(current_bytes)
                reserve_file.flush()
                os.fsync(reserve_file.fileno())
        except FileExistsError:
            index += 1
            continue
        except Exception:
            candidate.unlink(missing_ok=True)
            raise
        return candidate


def _image_dimensions_signature(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return (int(stat.st_mtime_ns), int(stat.st_size))


def normalize_cover_variant_size(value: object, *, maximum: int = 2048) -> int:
    try:
        normalized = int(str(value or "").strip())
    except (TypeError, ValueError):
        return 0
    if normalized <= 0:
        return 0
    return min(normalized, maximum)


def normalize_cover_variant_priority(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    if normalized == _COVER_VARIANT_PRIORITY_BACKGROUND:
        return _COVER_VARIANT_PRIORITY_BACKGROUND
    if normalized == _COVER_VARIANT_PRIORITY_INTERACTIVE:
        return _COVER_VARIANT_PRIORITY_INTERACTIVE
    return _COVER_VARIANT_PRIORITY_FOREGROUND


def _image_has_visible_transparency(image) -> bool:
    image_mode = str(getattr(image, "mode", "") or "")
    image_info = getattr(image, "info", {}) or {}
    try:
        if "A" in image_mode:
            alpha_extrema = image.getchannel("A").getextrema()
            return bool(alpha_extrema and alpha_extrema[0] < 255)
        if "transparency" in image_info:
            alpha_extrema = image.convert("RGBA").getchannel("A").getextrema()
            return bool(alpha_extrema and alpha_extrema[0] < 255)
    except Exception:
        # If Pillow exposes transparency metadata but cannot measure it, retain
        # PNG rather than risk flattening visible transparency into JPEG.
        return "A" in image_mode or "transparency" in image_info
    return False


def _cover_variant_format(path: Path, image) -> tuple[str, str]:
    suffix = str(path.suffix or "").strip().casefold()
    if _image_has_visible_transparency(image):
        return (".png", "PNG")
    if suffix == ".webp":
        return (".webp", "WEBP")
    if suffix == ".png":
        return (".jpg", "JPEG")
    return (".jpg", "JPEG")


def build_cover_variant_path(source_path: Path, *, cache_root: Path, max_size: int, extension: str) -> Path:
    return build_cover_variant_base_path(
        source_path,
        cache_root=cache_root,
        max_size=max_size,
    ).with_suffix(extension)


def build_cover_variant_base_path(source_path: Path, *, cache_root: Path, max_size: int) -> Path:
    signature = _image_dimensions_signature(source_path) or (0, 0)
    cache_key_material = f"{source_path.resolve()}|{signature[0]}|{signature[1]}|{max_size}"
    if source_path.suffix.casefold() == ".png":
        cache_key_material = f"{cache_key_material}|{_COVER_VARIANT_CACHE_POLICY_VERSION}"
    cache_key = hashlib.sha1(
        cache_key_material.encode("utf-8", "ignore")
    ).hexdigest()
    return cache_root / "cover_variants" / cache_key[:2] / cache_key


def _find_existing_cover_variant(variant_base_path: Path) -> Path | None:
    for extension in (".png", ".webp", ".jpg"):
        candidate = variant_base_path.with_suffix(extension)
        if candidate.exists():
            return candidate
    return None


def _render_cover_variant(
    source_path: Path,
    *,
    variant_base_path: Path,
    normalized_size: int,
) -> Path | None:
    with Image.open(source_path) as source_image:
        width, height = source_image.size
        if width <= 0 or height <= 0 or max(width, height) <= normalized_size:
            return None
        extension, save_format = _cover_variant_format(source_path, source_image)
        variant_path = variant_base_path.with_suffix(extension)
        existing_variant = _find_existing_cover_variant(variant_base_path)
        if existing_variant is not None:
            return existing_variant
        if str(source_path.suffix or "").strip().casefold() in {".jpg", ".jpeg"}:
            source_image.draft("RGB", (normalized_size, normalized_size))
        source_image.load()
        rendered = source_image.copy()
        rendered.thumbnail((normalized_size, normalized_size), _resampling_lanczos())
        save_kwargs: dict[str, object] = {}
        if save_format == "JPEG":
            rendered = rendered.convert("RGB")
            save_kwargs = {
                "quality": 85,
            }
            if source_path.suffix.casefold() == ".png":
                save_kwargs = {
                    "quality": 95,
                    "subsampling": 0,
                }
        elif save_format == "WEBP":
            rendered = rendered.convert("RGB")
            save_kwargs = {
                "quality": 85,
                "method": 4,
            }
        temp_path = variant_path.with_suffix(f"{variant_path.suffix}.tmp")
        rendered.save(temp_path, save_format, **save_kwargs)
        temp_path.replace(variant_path)
    return variant_path


def _queue_cover_variant_generation(
    source_path: Path,
    *,
    variant_base_path: Path,
    normalized_size: int,
    priority: str = _COVER_VARIANT_PRIORITY_BACKGROUND,
) -> Future[Path | None] | None:
    normalized_priority = normalize_cover_variant_priority(priority)
    inflight_key = str(variant_base_path)

    def _build() -> Path | None:
        try:
            existing_variant = _find_existing_cover_variant(variant_base_path)
            if existing_variant is not None:
                return existing_variant
            if not source_path.exists() or not source_path.is_file():
                return None
            variant_base_path.parent.mkdir(parents=True, exist_ok=True)
            existing_variant = _find_existing_cover_variant(variant_base_path)
            if existing_variant is not None:
                return existing_variant
            return _render_cover_variant(
                source_path,
                variant_base_path=variant_base_path,
                normalized_size=normalized_size,
            )
        except Exception:
            return None

    def _run_work(work: dict[str, object]) -> Path | None:
        result = work["result"]
        if not isinstance(result, Future):
            return None
        with _COVER_VARIANT_PREWARM_LOCK:
            if result.done():
                return result.result()
            work["started"] = True
        generated = _build()
        if not result.done():
            result.set_result(generated)
        return generated

    def _submit(work: dict[str, object], work_priority: str) -> bool:
        if work_priority == _COVER_VARIANT_PRIORITY_BACKGROUND:
            executor = _COVER_VARIANT_PREWARM_EXECUTOR
        elif work_priority == _COVER_VARIANT_PRIORITY_INTERACTIVE:
            executor = _COVER_VARIANT_INTERACTIVE_EXECUTOR
        else:
            executor = _COVER_VARIANT_FOREGROUND_EXECUTOR
        try:
            runner = executor.submit(_run_work, work)
            work["runner"] = runner
        except Exception:
            result = work["result"]
            if isinstance(result, Future) and not result.done():
                result.set_result(None)
            return False

        def _settle_abandoned_runner(completed: Future[Path | None]) -> None:
            with _COVER_VARIANT_PREWARM_LOCK:
                if work.get("runner") is not completed:
                    return
                shared_result = work.get("result")
                if not isinstance(shared_result, Future) or shared_result.done():
                    return
                if completed.cancelled() or completed.exception() is not None:
                    shared_result.set_result(None)

        runner.add_done_callback(_settle_abandoned_runner)
        return True

    with _COVER_VARIANT_PREWARM_LOCK:
        work = _COVER_VARIANT_PREWARM_INFLIGHT.get(inflight_key)
        if work is not None:
            result = work.get("result")
            if not isinstance(result, Future):
                return None
            current_priority = normalize_cover_variant_priority(work.get("priority"))
            if (
                _COVER_VARIANT_PRIORITY_RANK[normalized_priority]
                > _COVER_VARIANT_PRIORITY_RANK[current_priority]
                and not bool(work.get("started"))
            ):
                runner = work.get("runner")
                if isinstance(runner, Future):
                    work["runner"] = None
                    if runner.cancel():
                        work["priority"] = normalized_priority
                        _submit(work, normalized_priority)
                    else:
                        work["runner"] = runner
                        if runner.done() and not result.done():
                            try:
                                runner_failed = runner.cancelled() or runner.exception() is not None
                            except Exception:
                                runner_failed = True
                            if runner_failed:
                                result.set_result(None)
                else:
                    work["priority"] = normalized_priority
            return result

        result: Future[Path | None] = Future()
        work = {
            "priority": normalized_priority,
            "result": result,
            "runner": None,
            "started": False,
        }
        _COVER_VARIANT_PREWARM_INFLIGHT[inflight_key] = work

    def _clear_inflight(completed: Future[Path | None]) -> None:
        with _COVER_VARIANT_PREWARM_LOCK:
            current = _COVER_VARIANT_PREWARM_INFLIGHT.get(inflight_key)
            if current is work and current.get("result") is completed:
                _COVER_VARIANT_PREWARM_INFLIGHT.pop(inflight_key, None)

    result.add_done_callback(_clear_inflight)
    with _COVER_VARIANT_PREWARM_LOCK:
        _submit(work, normalize_cover_variant_priority(work.get("priority")))
    return result


def find_existing_cover_display_variant(
    source_path: Path,
    *,
    cache_root: Path,
    max_size: int,
) -> Path | None:
    normalized_size = normalize_cover_variant_size(max_size)
    if (
        Image is None
        or normalized_size <= 0
        or not source_path.exists()
        or not source_path.is_file()
    ):
        return None
    variant_base_path = build_cover_variant_base_path(
        source_path,
        cache_root=cache_root,
        max_size=normalized_size,
    )
    return _find_existing_cover_variant(variant_base_path)


def resolve_cover_display_variant(
    source_path: Path,
    *,
    cache_root: Path,
    max_size: int,
    priority: str = _COVER_VARIANT_PRIORITY_FOREGROUND,
) -> Path:
    normalized_size = normalize_cover_variant_size(max_size)
    if (
        Image is None
        or normalized_size <= 0
        or not source_path.exists()
        or not source_path.is_file()
    ):
        return source_path

    existing_variant = find_existing_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=normalized_size,
    )
    if existing_variant is not None:
        return existing_variant

    variant_base_path = build_cover_variant_base_path(
        source_path,
        cache_root=cache_root,
        max_size=normalized_size,
    )

    inflight = _queue_cover_variant_generation(
        source_path,
        variant_base_path=variant_base_path,
        normalized_size=normalized_size,
        priority=priority,
    )
    if inflight is not None:
        try:
            generated_variant = inflight.result()
        except Exception:
            generated_variant = None
        if generated_variant is not None and generated_variant.exists():
            return generated_variant
    return source_path


def _admit_cover_display_variant_generation(
    source_path: Path,
    *,
    cache_root: Path,
    normalized_size: int,
    normalized_priority: str,
) -> Future[Path | None] | None:
    variant_base_path = build_cover_variant_base_path(
        source_path,
        cache_root=cache_root,
        max_size=normalized_size,
    )
    if _find_existing_cover_variant(variant_base_path) is not None:
        return

    return _queue_cover_variant_generation(
        source_path,
        variant_base_path=variant_base_path,
        normalized_size=normalized_size,
        priority=normalized_priority,
    )


def _settle_background_admission_drainer_locked(token: dict[str, bool]) -> None:
    global _COVER_VARIANT_BACKGROUND_DRAINERS
    if token.get("settled"):
        return
    token["settled"] = True
    _COVER_VARIANT_BACKGROUND_DRAINERS = max(
        0,
        _COVER_VARIANT_BACKGROUND_DRAINERS - 1,
    )


def _settle_background_admission_drainer(token: dict[str, bool]) -> None:
    with _COVER_VARIANT_ADMISSION_LOCK:
        _settle_background_admission_drainer_locked(token)


def _drain_background_cover_admissions(token: dict[str, bool]) -> None:
    try:
        while True:
            with _COVER_VARIANT_ADMISSION_LOCK:
                if not _COVER_VARIANT_BACKGROUND_PENDING:
                    _settle_background_admission_drainer_locked(token)
                    return
                admission_key, admission = (
                    _COVER_VARIANT_BACKGROUND_PENDING.popitem(last=False)
                )
                _COVER_VARIANT_BACKGROUND_RUNNING.add(admission_key)

            source_path, admission_kwargs = admission
            try:
                render_future = _admit_cover_display_variant_generation(
                    source_path,
                    **admission_kwargs,
                )
                if isinstance(render_future, Future):
                    render_future.result()
            except Exception:
                pass
            finally:
                with _COVER_VARIANT_ADMISSION_LOCK:
                    _COVER_VARIANT_BACKGROUND_RUNNING.discard(admission_key)
                    _COVER_VARIANT_ADMISSION_INFLIGHT.discard(admission_key)
    finally:
        _settle_background_admission_drainer(token)


def _reserve_background_admission_drainers_locked() -> list[dict[str, bool]]:
    global _COVER_VARIANT_BACKGROUND_DRAINERS
    tokens: list[dict[str, bool]] = []
    target_drainers = min(
        _COVER_VARIANT_ADMISSION_WORKERS,
        len(_COVER_VARIANT_BACKGROUND_RUNNING)
        + len(_COVER_VARIANT_BACKGROUND_PENDING),
    )
    while (
        _COVER_VARIANT_BACKGROUND_DRAINERS < target_drainers
    ):
        token = {"settled": False}
        _COVER_VARIANT_BACKGROUND_DRAINERS += 1
        tokens.append(token)
    return tokens


def _submit_background_admission_drainers(tokens: list[dict[str, bool]]) -> None:
    for token in tokens:
        try:
            runner = _COVER_VARIANT_ADMISSION_EXECUTOR.submit(
                _drain_background_cover_admissions,
                token,
            )
        except Exception:
            _settle_background_admission_drainer(token)
            continue

        def _settle_abandoned_drainer(
            completed: Future[object],
            *,
            drainer_token: dict[str, bool] = token,
        ) -> None:
            if completed.cancelled():
                _settle_background_admission_drainer(drainer_token)
                return
            try:
                failed = completed.exception() is not None
            except Exception:
                failed = True
            if failed:
                _settle_background_admission_drainer(drainer_token)

        runner.add_done_callback(_settle_abandoned_drainer)


def queue_cover_display_variant_generation(
    source_path: Path,
    *,
    cache_root: Path,
    max_size: int,
    priority: str = _COVER_VARIANT_PRIORITY_BACKGROUND,
) -> None:
    normalized_size = normalize_cover_variant_size(max_size)
    normalized_priority = normalize_cover_variant_priority(priority)
    if (
        Image is None
        or normalized_size <= 0
    ):
        return

    admission_kwargs = {
        "cache_root": cache_root,
        "normalized_size": normalized_size,
        "normalized_priority": normalized_priority,
    }
    if normalized_priority == _COVER_VARIANT_PRIORITY_BACKGROUND:
        admission_key = (
            os.path.normcase(os.path.abspath(os.fspath(source_path))),
            os.path.normcase(os.path.abspath(os.fspath(cache_root))),
            normalized_size,
        )
        with _COVER_VARIANT_ADMISSION_LOCK:
            if admission_key not in _COVER_VARIANT_ADMISSION_INFLIGHT:
                if (
                    len(_COVER_VARIANT_ADMISSION_INFLIGHT)
                    >= _COVER_VARIANT_BACKGROUND_CAPACITY
                    and _COVER_VARIANT_BACKGROUND_PENDING
                ):
                    evicted_key, _evicted = (
                        _COVER_VARIANT_BACKGROUND_PENDING.popitem(last=False)
                    )
                    _COVER_VARIANT_ADMISSION_INFLIGHT.discard(evicted_key)
                if (
                    len(_COVER_VARIANT_ADMISSION_INFLIGHT)
                    < _COVER_VARIANT_BACKGROUND_CAPACITY
                ):
                    _COVER_VARIANT_ADMISSION_INFLIGHT.add(admission_key)
                    _COVER_VARIANT_BACKGROUND_PENDING[admission_key] = (
                        source_path,
                        admission_kwargs,
                    )
            drainer_tokens = _reserve_background_admission_drainers_locked()

        _submit_background_admission_drainers(drainer_tokens)
        return

    _admit_cover_display_variant_generation(
        source_path,
        **admission_kwargs,
    )


def image_dimensions(path: Path, *, raise_errors: bool = False) -> tuple[int, int]:
    if Image is None:
        return (0, 0)
    normalized_path = str(path)
    signature = _image_dimensions_signature(path)
    with _IMAGE_DIMENSIONS_CACHE_LOCK:
        cached = _IMAGE_DIMENSIONS_CACHE.get(normalized_path)
        if cached and cached[0] == signature and (not raise_errors or cached[1] != (0, 0)):
            return cached[1]
    try:
        with Image.open(path) as img:
            width, height = img.size
            dimensions = (int(width or 0), int(height or 0))
    except Exception:
        if raise_errors:
            raise
        dimensions = (0, 0)
    with _IMAGE_DIMENSIONS_CACHE_LOCK:
        _IMAGE_DIMENSIONS_CACHE[normalized_path] = (signature, dimensions)
    return dimensions

def image_area(path: Path) -> int:
    width, height = image_dimensions(path)
    if width <= 0 or height <= 0:
        return 0
    return width * height


def image_sharpness(path: Path | None) -> float:
    if Image is None or path is None:
        return 0.0
    try:
        with Image.open(path) as img:
            return measure_image_sharpness(img)
    except Exception:
        return 0.0

def score_image(path: Path) -> tuple[float, int, int]:
    width, height = image_dimensions(path)
    if width <= 0 or height <= 0:
        return (9999.0, 0, 0)
    ratio_delta = abs((width / height) - 1.0)
    area = width * height
    return (ratio_delta, -area, len(path.name))

def find_cover_image(folder: Path, image_extensions: set[str]) -> Path | None:
    if folder is None or not folder.exists() or not folder.is_dir():
        return None
    for stem in _PREFERRED_COVER_STEMS:
        for ext in _COVER_IMAGE_EXTENSIONS:
            candidate = folder / f"{stem}{ext}"
            if candidate.exists():
                return candidate
    try:
        candidates = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in image_extensions]
    except FileNotFoundError:
        return None
    if not candidates:
        return None
    return min(candidates, key=score_image)
