from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import io
import math
from pathlib import Path
import random
import threading
import time

import pytest

from music_app.services import covers as covers_module

try:
    from PIL import Image as PILImage
except ImportError:  # pragma: no cover - mirrors runtime optional dependency handling
    PILImage = None


pytestmark = pytest.mark.skipif(PILImage is None, reason="Pillow not installed")


def test_production_cover_variant_lane_capacity_matches_gallery_scheduler_policy():
    assert covers_module._COVER_VARIANT_FOREGROUND_WORKERS == 5
    assert covers_module._COVER_VARIANT_INTERACTIVE_WORKERS == 1
    assert covers_module._COVER_VARIANT_BACKGROUND_WORKERS == 2
    assert covers_module._COVER_VARIANT_FOREGROUND_EXECUTOR._max_workers == 5
    assert covers_module._COVER_VARIANT_INTERACTIVE_EXECUTOR._max_workers == 1
    assert covers_module._COVER_VARIANT_PREWARM_EXECUTOR._max_workers == 2
    assert (
        covers_module._COVER_VARIANT_FOREGROUND_WORKERS
        + covers_module._COVER_VARIANT_INTERACTIVE_WORKERS
    ) == 6


def test_cover_variant_priority_normalization_requires_explicit_background():
    assert covers_module.normalize_cover_variant_priority(None) == "foreground"
    assert covers_module.normalize_cover_variant_priority("") == "foreground"
    assert covers_module.normalize_cover_variant_priority("   ") == "foreground"
    assert covers_module.normalize_cover_variant_priority("background") == "background"
    assert covers_module.normalize_cover_variant_priority("foreground") == "foreground"
    assert covers_module.normalize_cover_variant_priority("interactive") == "interactive"
    assert covers_module.normalize_cover_variant_priority("unexpected") == "foreground"


def test_five_blocked_foreground_variants_cannot_starve_reserved_interactive_lane(
    tmp_path,
    monkeypatch,
):
    foreground_executor = ThreadPoolExecutor(
        max_workers=5,
    )
    interactive_executor = ThreadPoolExecutor(
        max_workers=1,
    )
    background_executor = ThreadPoolExecutor(
        max_workers=2,
    )
    release = threading.Event()
    five_foreground_started = threading.Event()
    interactive_started = threading.Event()
    two_background_started = threading.Event()
    count_lock = threading.Lock()
    started = {"foreground": 0, "interactive": 0, "background": 0}
    sources: dict[Path, str] = {}

    for lane, count in (("foreground", 5), ("interactive", 1), ("background", 3)):
        for index in range(count):
            source = tmp_path / f"{lane}-{index}.png"
            source.write_bytes(b"cover-source")
            sources[source] = lane

    def gated_render(source_path, **_kwargs):
        lane = sources[Path(source_path)]
        with count_lock:
            started[lane] += 1
            if started["foreground"] == 5:
                five_foreground_started.set()
            if started["interactive"] == 1:
                interactive_started.set()
            if started["background"] == 2:
                two_background_started.set()
        if lane != "interactive":
            assert release.wait(timeout=5)
        return Path(source_path)

    monkeypatch.setattr(covers_module, "_COVER_VARIANT_FOREGROUND_EXECUTOR", foreground_executor)
    monkeypatch.setattr(
        covers_module,
        "_COVER_VARIANT_INTERACTIVE_EXECUTOR",
        interactive_executor,
        raising=False,
    )
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", background_executor)
    monkeypatch.setattr(covers_module, "_render_cover_variant", gated_render)
    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    futures = []
    try:
        for source, lane in sources.items():
            future = covers_module._queue_cover_variant_generation(
                source,
                variant_base_path=tmp_path / "cache" / source.stem,
                normalized_size=480,
                priority=lane,
            )
            assert future is not None
            futures.append(future)

        assert five_foreground_started.wait(timeout=2)
        assert two_background_started.wait(timeout=2)
        assert interactive_started.wait(timeout=2)
        interactive_future = next(
            future
            for future, source in zip(futures, sources)
            if sources[source] == "interactive"
        )
        assert interactive_future.result(timeout=2) is not None
        with count_lock:
            assert started == {"foreground": 5, "interactive": 1, "background": 2}
    finally:
        release.set()
        for future in futures:
            future.result(timeout=2)
        foreground_executor.shutdown(wait=True)
        interactive_executor.shutdown(wait=True)
        background_executor.shutdown(wait=True)
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_resolve_cover_display_variant_waits_for_cold_variant_then_reuses_it_without_reopening_source(tmp_path, monkeypatch):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="red").save(source_path, format="JPEG")

    cache_root = tmp_path / "cache"

    first_result = covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )

    assert first_result != source_path
    assert first_result.exists()

    first_variant = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )
    resolved_cached_variant = covers_module._find_existing_cover_variant(first_variant)

    assert resolved_cached_variant is not None
    assert resolved_cached_variant.exists()
    assert resolved_cached_variant != source_path

    original_open = covers_module.Image.open

    def fail_if_source_reopened(path, *args, **kwargs):
        if Path(path) == source_path:
            raise AssertionError("source image should not be reopened when the exact variant already exists")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(covers_module.Image, "open", fail_if_source_reopened)

    resolved_variant = covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )

    assert resolved_variant == resolved_cached_variant


def test_find_existing_cover_display_variant_probes_exact_cache_without_queueing_generation(
    tmp_path,
    monkeypatch,
):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 900), color="navy").save(source_path, format="JPEG")
    cache_root = tmp_path / "cache"
    cached_variant = covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )
    assert cached_variant != source_path

    def fail_if_generation_is_queued(*_args, **_kwargs):
        raise AssertionError("an exact display-variant cache probe must not queue generation")

    monkeypatch.setattr(
        covers_module,
        "_queue_cover_variant_generation",
        fail_if_generation_is_queued,
    )

    assert covers_module.find_existing_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=480,
    ) == cached_variant
    assert covers_module.find_existing_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=320,
    ) is None


def test_resolve_cover_display_variant_uses_jpeg_draft_before_load_and_bounds_output(
    tmp_path,
    monkeypatch,
):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (2400, 1600), color="teal").save(source_path, format="JPEG")

    with PILImage.open(source_path) as probe_image:
        jpeg_image_type = type(probe_image)

    decoder_events: list[tuple[str, object]] = []
    original_draft = jpeg_image_type.draft
    original_load = jpeg_image_type.load

    def observed_draft(image, mode, size):
        if Path(image.filename) == source_path:
            decoder_events.append(("draft", (mode, size)))
        return original_draft(image, mode, size)

    def observed_load(image, *args, **kwargs):
        if Path(image.filename) == source_path:
            decoder_events.append(("load", image.size))
        return original_load(image, *args, **kwargs)

    monkeypatch.setattr(jpeg_image_type, "draft", observed_draft)
    monkeypatch.setattr(jpeg_image_type, "load", observed_load)

    resolved_variant = covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=320,
    )

    assert decoder_events[0] == ("draft", ("RGB", (320, 320)))
    assert decoder_events[1][0] == "load"
    assert resolved_variant != source_path
    with PILImage.open(resolved_variant) as rendered:
        assert rendered.width <= 320
        assert rendered.height <= 320


def test_opaque_png_display_variant_uses_high_fidelity_compact_jpeg_and_reuses_cache(
    tmp_path,
    monkeypatch,
):
    source_path = tmp_path / "opaque-cover-source.png"
    rng = random.Random(20260829)
    source = PILImage.frombytes(
        "RGB",
        (240, 240),
        rng.randbytes(240 * 240 * 3),
    ).resize(
        (1200, 1200),
        covers_module._resampling_lanczos(),
    )
    source.save(source_path, format="PNG")

    expected = source.copy()
    expected.thumbnail((480, 480), covers_module._resampling_lanczos())
    variant_base = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    variant_base.parent.mkdir(parents=True)

    rendered_path = covers_module._render_cover_variant(
        source_path,
        variant_base_path=variant_base,
        normalized_size=480,
    )

    assert rendered_path is not None
    assert rendered_path.suffix == ".jpg"
    with PILImage.open(rendered_path) as rendered:
        rendered.load()
        assert rendered.format == "JPEG"
        assert rendered.mode == "RGB"
        assert rendered.size == expected.size
        expected_bytes = expected.tobytes()
        rendered_bytes = rendered.tobytes()

    squared_error = sum(
        (left - right) ** 2
        for left, right in zip(expected_bytes, rendered_bytes)
    ) / len(expected_bytes)
    psnr = 20 * math.log10(255 / math.sqrt(squared_error))
    assert psnr >= 35
    png_buffer = io.BytesIO()
    expected.save(png_buffer, format="PNG")
    assert rendered_path.stat().st_size <= len(png_buffer.getvalue()) * 0.8

    monkeypatch.setattr(
        covers_module.Image,
        "open",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("an exact cached opaque-PNG preview must not reopen the source")
        ),
    )
    assert covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    ) == rendered_path


def test_alpha_png_display_variant_remains_lossless_png_with_exact_alpha(tmp_path):
    source_path = tmp_path / "alpha-cover-source.png"
    source = PILImage.new("RGBA", (960, 720), color=(31, 63, 127, 255))
    alpha = PILImage.linear_gradient("L").resize(source.size)
    source.putalpha(alpha)
    source.save(source_path, format="PNG")
    expected = source.copy()
    expected.thumbnail((480, 480), covers_module._resampling_lanczos())
    variant_base = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    variant_base.parent.mkdir(parents=True)

    rendered_path = covers_module._render_cover_variant(
        source_path,
        variant_base_path=variant_base,
        normalized_size=480,
    )

    assert rendered_path is not None
    assert rendered_path.suffix == ".png"
    with PILImage.open(rendered_path) as rendered:
        rendered.load()
        assert rendered.format == "PNG"
        assert rendered.mode == "RGBA"
        assert rendered.size == expected.size
        assert rendered.tobytes() == expected.tobytes()
        assert rendered.getchannel("A").tobytes() == expected.getchannel("A").tobytes()


def test_fully_opaque_rgba_png_uses_compact_jpeg_preview(tmp_path):
    source_path = tmp_path / "opaque-rgba-cover-source.png"
    PILImage.new("RGBA", (960, 720), color=(31, 63, 127, 255)).save(
        source_path,
        format="PNG",
    )
    variant_base = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    variant_base.parent.mkdir(parents=True)

    rendered_path = covers_module._render_cover_variant(
        source_path,
        variant_base_path=variant_base,
        normalized_size=480,
    )

    assert rendered_path is not None
    assert rendered_path.suffix == ".jpg"
    with PILImage.open(rendered_path) as rendered:
        assert rendered.format == "JPEG"
        assert rendered.mode == "RGB"


def test_palette_transparency_png_display_variant_preserves_transparency(tmp_path):
    source_path = tmp_path / "palette-alpha-cover-source.png"
    source = PILImage.new("P", (960, 720), color=1)
    source.putpalette([0, 0, 0, 31, 127, 223] + ([0, 0, 0] * 254))
    source.info["transparency"] = 0
    source.paste(0, (0, 0, 480, 720))
    source.save(source_path, format="PNG", transparency=0)
    expected = source.copy()
    expected.thumbnail((480, 480), covers_module._resampling_lanczos())
    variant_base = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    variant_base.parent.mkdir(parents=True)

    rendered_path = covers_module._render_cover_variant(
        source_path,
        variant_base_path=variant_base,
        normalized_size=480,
    )

    assert rendered_path is not None
    assert rendered_path.suffix == ".png"
    with PILImage.open(rendered_path) as rendered:
        rendered.load()
        assert rendered.format == "PNG"
        assert rendered.convert("RGBA").tobytes() == expected.convert("RGBA").tobytes()


def test_variant_cache_policy_does_not_reuse_legacy_opaque_png_variant(tmp_path):
    source_path = tmp_path / "opaque-source.png"
    PILImage.new("RGB", (960, 960), color=(24, 72, 144)).save(source_path, format="PNG")
    cache_root = tmp_path / "cache"
    signature = covers_module._image_dimensions_signature(source_path)
    assert signature is not None
    legacy_key = hashlib.sha1(
        f"{source_path.resolve()}|{signature[0]}|{signature[1]}|480".encode(
            "utf-8",
            "ignore",
        )
    ).hexdigest()
    legacy_base = cache_root / "cover_variants" / legacy_key[:2] / legacy_key
    legacy_base.parent.mkdir(parents=True)
    legacy_variant = legacy_base.with_suffix(".png")
    PILImage.new("RGB", (480, 480), color="red").save(legacy_variant, format="PNG")

    rendered_path = covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )

    assert covers_module._COVER_VARIANT_CACHE_POLICY_VERSION == "opaque-png-jpeg-q95-444-v1"
    assert rendered_path != legacy_variant
    assert rendered_path.suffix == ".jpg"
    assert rendered_path.exists()


def test_png_variant_policy_version_does_not_invalidate_existing_jpeg_cache_keys(tmp_path):
    source_path = tmp_path / "jpeg-source.jpg"
    PILImage.new("RGB", (960, 960), color=(48, 96, 144)).save(source_path, format="JPEG")
    signature = covers_module._image_dimensions_signature(source_path)
    assert signature is not None
    legacy_key = hashlib.sha1(
        f"{source_path.resolve()}|{signature[0]}|{signature[1]}|480".encode(
            "utf-8",
            "ignore",
        )
    ).hexdigest()

    variant_base = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    )

    assert variant_base.name == legacy_key


def test_five_concurrent_cold_opaque_png_variants_use_jpeg_preview_contract(
    tmp_path,
    monkeypatch,
):
    source_paths = []
    for index in range(5):
        source_path = tmp_path / f"cold-{index}.png"
        PILImage.new("RGB", (960, 960), color=(index * 17, 80, 160)).save(
            source_path,
            format="PNG",
        )
        source_paths.append(source_path)

    original_save = PILImage.Image.save
    observed_jpeg_saves = []
    observed_lock = threading.Lock()

    def observed_save(image, fp, format=None, **params):
        if format == "JPEG" and str(fp).endswith(".jpg.tmp"):
            with observed_lock:
                observed_jpeg_saves.append(dict(params))
        return original_save(image, fp, format=format, **params)

    monkeypatch.setattr(PILImage.Image, "save", observed_save)

    def render(source_path):
        variant_base = tmp_path / "cache" / source_path.stem
        variant_base.parent.mkdir(parents=True, exist_ok=True)
        return covers_module._render_cover_variant(
            source_path,
            variant_base_path=variant_base,
            normalized_size=480,
        )

    with ThreadPoolExecutor(max_workers=5) as workers:
        rendered_paths = list(workers.map(render, source_paths))

    assert observed_jpeg_saves == [{"quality": 95, "subsampling": 0}] * 5
    assert all(
        path is not None and path.exists() and path.suffix == ".jpg"
        for path in rendered_paths
    )


def test_resolve_cover_display_variant_concurrent_callers_render_same_variant_once(tmp_path, monkeypatch):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="purple").save(source_path, format="JPEG")

    cache_root = tmp_path / "cache"
    render_count = 0
    render_lock = threading.Lock()
    original_render = covers_module._render_cover_variant

    def counted_render(*args, **kwargs):
        nonlocal render_count
        with render_lock:
            render_count += 1
        time.sleep(0.05)
        return original_render(*args, **kwargs)

    monkeypatch.setattr(covers_module, "_render_cover_variant", counted_render)

    with ThreadPoolExecutor(max_workers=8) as callers:
        results = list(callers.map(
            lambda _index: covers_module.resolve_cover_display_variant(
                source_path,
                cache_root=cache_root,
                max_size=480,
            ),
            range(8),
        ))

    assert render_count == 1
    assert len(set(results)) == 1
    assert results[0] != source_path
    assert results[0].exists()


def test_resolve_cover_display_variant_renders_distinct_cold_variants_concurrently_while_deduplicating_each(
    tmp_path,
    monkeypatch,
):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="navy").save(source_path, format="JPEG")

    cache_root = tmp_path / "cache"
    render_counts = {320: 0, 480: 0}
    active_renders = 0
    maximum_active_renders = 0
    render_lock = threading.Lock()
    both_variants_started = threading.Event()
    original_render = covers_module._render_cover_variant

    def counted_render(*args, **kwargs):
        nonlocal active_renders, maximum_active_renders
        normalized_size = kwargs["normalized_size"]
        with render_lock:
            render_counts[normalized_size] += 1
            active_renders += 1
            maximum_active_renders = max(maximum_active_renders, active_renders)
            if all(render_counts.values()):
                both_variants_started.set()
        try:
            assert both_variants_started.wait(timeout=2)
            return original_render(*args, **kwargs)
        finally:
            with render_lock:
                active_renders -= 1

    monkeypatch.setattr(covers_module, "_render_cover_variant", counted_render)

    requested_sizes = [320, 480] * 4
    with ThreadPoolExecutor(max_workers=len(requested_sizes)) as callers:
        results = list(callers.map(
            lambda max_size: (
                max_size,
                covers_module.resolve_cover_display_variant(
                    source_path,
                    cache_root=cache_root,
                    max_size=max_size,
                ),
            ),
            requested_sizes,
        ))

    results_by_size = {
        max_size: {result for result_size, result in results if result_size == max_size}
        for max_size in render_counts
    }
    assert render_counts == {320: 1, 480: 1}
    assert maximum_active_renders == 2
    assert all(len(group_results) == 1 for group_results in results_by_size.values())
    assert results_by_size[320] != results_by_size[480]
    assert all(
        result != source_path and result.exists()
        for group_results in results_by_size.values()
        for result in group_results
    )


def test_resolve_cover_display_variant_returns_source_when_generation_fails(tmp_path, monkeypatch):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="yellow").save(source_path, format="JPEG")

    monkeypatch.setattr(
        covers_module,
        "_render_cover_variant",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("render failed")),
    )

    assert covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    ) == source_path


def test_resolve_cover_display_variant_returns_small_source(tmp_path):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (320, 240), color="green").save(source_path, format="JPEG")

    assert covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    ) == source_path


def test_queue_cover_display_variant_generation_defers_rendering_to_background_queue(tmp_path, monkeypatch):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="blue").save(source_path, format="JPEG")

    cache_root = tmp_path / "cache"
    queued_calls: list[dict[str, object]] = []
    queued = threading.Event()

    def fake_queue(source_path_arg, *, variant_base_path, normalized_size, priority="background"):
        queued_calls.append({
            "source_path": Path(source_path_arg),
            "variant_base_path": Path(variant_base_path),
            "normalized_size": normalized_size,
            "priority": priority,
        })
        queued.set()

    monkeypatch.setattr(covers_module, "_queue_cover_variant_generation", fake_queue)

    covers_module.queue_cover_display_variant_generation(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )

    assert queued.wait(timeout=2)
    expected_variant_base = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )

    assert queued_calls == [{
        "source_path": source_path,
        "variant_base_path": expected_variant_base,
        "normalized_size": 480,
        "priority": "background",
    }]
    assert covers_module._find_existing_cover_variant(expected_variant_base) is None


def test_queue_cover_display_variant_generation_can_submit_to_foreground_queue(tmp_path, monkeypatch):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="indigo").save(source_path, format="JPEG")

    queued_priorities: list[str] = []
    monkeypatch.setattr(
        covers_module,
        "_queue_cover_variant_generation",
        lambda _source_path, **kwargs: queued_priorities.append(str(kwargs.get("priority") or "")),
    )

    covers_module.queue_cover_display_variant_generation(
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
        priority="foreground",
    )

    assert queued_priorities == ["foreground"]


def test_queue_cover_display_variant_generation_does_not_probe_dimensions_before_queue(tmp_path, monkeypatch):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="orange").save(source_path, format="JPEG")

    cache_root = tmp_path / "cache"
    queued_calls: list[Path] = []
    queued = threading.Event()
    monkeypatch.setattr(
        covers_module,
        "image_dimensions",
        lambda _source_path: (_ for _ in ()).throw(
            AssertionError("dimension probe should run in the background worker")
        ),
    )
    def fake_queue(source_path_arg, **_kwargs):
        queued_calls.append(Path(source_path_arg))
        queued.set()

    monkeypatch.setattr(covers_module, "_queue_cover_variant_generation", fake_queue)

    covers_module.queue_cover_display_variant_generation(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )

    assert queued.wait(timeout=2)
    assert queued_calls == [source_path]


def test_queue_cover_display_variant_generation_returns_before_background_source_stat_completes(
    tmp_path,
    monkeypatch,
):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="gold").save(source_path, format="JPEG")

    background_executor = ThreadPoolExecutor(max_workers=1)
    admission_executor = ThreadPoolExecutor(max_workers=2)
    caller_executor = ThreadPoolExecutor(max_workers=1)
    stat_entered = threading.Event()
    release_stat = threading.Event()
    original_stat = Path.stat

    def blocking_source_stat(path, *args, **kwargs):
        if path == source_path:
            stat_entered.set()
            assert release_stat.wait(timeout=5)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", background_executor)
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_ADMISSION_EXECUTOR", admission_executor)
    monkeypatch.setattr(Path, "stat", blocking_source_stat)
    caller_future = caller_executor.submit(
        covers_module.queue_cover_display_variant_generation,
        source_path,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    try:
        assert stat_entered.wait(timeout=2)
        caller_future.result(timeout=1)
    finally:
        release_stat.set()
        caller_future.result(timeout=5)
        caller_executor.shutdown(wait=True)
        admission_executor.shutdown(wait=True)
        background_executor.shutdown(wait=True)
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_background_cover_admission_backlog_is_bounded_and_retains_latest_request(
    tmp_path,
    monkeypatch,
):
    class RecordingExecutor:
        def __init__(self):
            self.executor = ThreadPoolExecutor(max_workers=2)
            self.submissions = 0
            self.lock = threading.Lock()

        def submit(self, fn, *args, **kwargs):
            with self.lock:
                self.submissions += 1
            return self.executor.submit(fn, *args, **kwargs)

        def shutdown(self):
            self.executor.shutdown(wait=True)

    admission_executor = RecordingExecutor()
    sources = [tmp_path / f"cover-source-{index}.jpg" for index in range(8)]
    background_admissions: list[Path] = []
    bypass_admissions: list[tuple[Path, str]] = []
    render_futures: list[Future] = []
    two_background_started = threading.Event()
    admission_lock = threading.Lock()

    def admit_with_blocked_render(source_path, **kwargs):
        source = Path(source_path)
        priority = kwargs["normalized_priority"]
        render_future = Future()
        with admission_lock:
            render_futures.append(render_future)
            if priority == "background":
                background_admissions.append(source)
                if len(background_admissions) == 2:
                    two_background_started.set()
                elif len(background_admissions) > 2:
                    render_future.set_result(None)
            else:
                bypass_admissions.append((source, priority))
                render_future.set_result(None)
        return render_future

    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    pending_admissions = getattr(
        covers_module,
        "_COVER_VARIANT_ADMISSION_INFLIGHT",
        None,
    )
    if pending_admissions is not None:
        pending_admissions.clear()
    monkeypatch.setattr(
        covers_module,
        "_COVER_VARIANT_ADMISSION_EXECUTOR",
        admission_executor,
    )
    monkeypatch.setattr(
        covers_module,
        "_admit_cover_display_variant_generation",
        admit_with_blocked_render,
    )

    try:
        for source in sources[:2]:
            covers_module.queue_cover_display_variant_generation(
                source,
                cache_root=tmp_path / "cache",
                max_size=480,
            )
        assert two_background_started.wait(timeout=2)

        for source in sources[2:4]:
            covers_module.queue_cover_display_variant_generation(
                source,
                cache_root=tmp_path / "cache",
                max_size=480,
            )
        with covers_module._COVER_VARIANT_ADMISSION_LOCK:
            state_size_before_duplicate = len(
                covers_module._COVER_VARIANT_ADMISSION_INFLIGHT
            )
        for _ in range(10):
            covers_module.queue_cover_display_variant_generation(
                sources[3],
                cache_root=tmp_path / "cache",
                max_size=480,
            )
        with covers_module._COVER_VARIANT_ADMISSION_LOCK:
            state_size_after_duplicate = len(
                covers_module._COVER_VARIANT_ADMISSION_INFLIGHT
            )

        for source in sources[4:6]:
            covers_module.queue_cover_display_variant_generation(
                source,
                cache_root=tmp_path / "cache",
                max_size=480,
            )

        covers_module.queue_cover_display_variant_generation(
            sources[6],
            cache_root=tmp_path / "cache",
            max_size=480,
            priority="foreground",
        )
        covers_module.queue_cover_display_variant_generation(
            sources[7],
            cache_root=tmp_path / "cache",
            max_size=480,
            priority="interactive",
        )

        with covers_module._COVER_VARIANT_ADMISSION_LOCK:
            saturated_state_size = len(
                covers_module._COVER_VARIANT_ADMISSION_INFLIGHT
            )
        with admission_executor.lock:
            drainer_submissions = admission_executor.submissions
        with admission_lock:
            admissions_while_render_blocked = list(background_admissions)
    finally:
        with admission_lock:
            futures_to_release = list(render_futures)
        for render_future in futures_to_release:
            if not render_future.done():
                render_future.set_result(None)
        admission_executor.shutdown()
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
        if pending_admissions is not None:
            pending_admissions.clear()
        for state_name in (
            "_COVER_VARIANT_BACKGROUND_PENDING",
            "_COVER_VARIANT_BACKGROUND_RUNNING",
        ):
            scheduler_state = getattr(covers_module, state_name, None)
            clear_state = getattr(scheduler_state, "clear", None)
            if callable(clear_state):
                clear_state()

    total_capacity = (
        covers_module._COVER_VARIANT_ADMISSION_WORKERS
        + covers_module._COVER_VARIANT_BACKGROUND_WORKERS
    )
    assert drainer_submissions <= covers_module._COVER_VARIANT_ADMISSION_WORKERS
    assert saturated_state_size <= total_capacity
    assert state_size_after_duplicate == state_size_before_duplicate
    assert admissions_while_render_blocked == sources[:2]
    assert len(background_admissions) == total_capacity
    assert set(background_admissions) == {sources[0], sources[1], sources[4], sources[5]}
    assert bypass_admissions == [
        (sources[6], "foreground"),
        (sources[7], "interactive"),
    ]
    assert covers_module._COVER_VARIANT_BACKGROUND_CAPACITY == total_capacity == 4


def test_background_cover_admission_retries_after_drainer_submit_rejection(
    tmp_path,
    monkeypatch,
):
    class RejectOnceExecutor:
        def __init__(self):
            self.submissions = 0

        def submit(self, fn, *args, **kwargs):
            self.submissions += 1
            if self.submissions == 1:
                raise RuntimeError("executor temporarily unavailable")
            future = Future()
            try:
                future.set_result(fn(*args, **kwargs))
            except Exception as exc:
                future.set_exception(exc)
            return future

    executor = RejectOnceExecutor()
    source = tmp_path / "retry-cover-source.jpg"
    admitted: list[Path] = []

    def admit(source_path, **_kwargs):
        admitted.append(Path(source_path))
        completed = Future()
        completed.set_result(None)
        return completed

    covers_module._COVER_VARIANT_ADMISSION_INFLIGHT.clear()
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_ADMISSION_EXECUTOR", executor)
    monkeypatch.setattr(covers_module, "_admit_cover_display_variant_generation", admit)
    try:
        covers_module.queue_cover_display_variant_generation(
            source,
            cache_root=tmp_path / "cache",
            max_size=480,
        )
        covers_module.queue_cover_display_variant_generation(
            source,
            cache_root=tmp_path / "cache",
            max_size=480,
        )
    finally:
        covers_module._COVER_VARIANT_ADMISSION_INFLIGHT.clear()
        for state_name in (
            "_COVER_VARIANT_BACKGROUND_PENDING",
            "_COVER_VARIANT_BACKGROUND_RUNNING",
        ):
            scheduler_state = getattr(covers_module, state_name, None)
            clear_state = getattr(scheduler_state, "clear", None)
            if callable(clear_state):
                clear_state()

    assert executor.submissions == 2
    assert admitted == [source]


def test_background_cover_admission_does_not_block_an_already_admitted_render(
    tmp_path,
    monkeypatch,
):
    source_one = tmp_path / "cover-source-one.jpg"
    source_two = tmp_path / "cover-source-two.jpg"
    source_one.write_bytes(b"cover-source-one")
    source_two.write_bytes(b"cover-source-two")

    prewarm_executor = ThreadPoolExecutor(max_workers=1)
    admission_executor = ThreadPoolExecutor(max_workers=2)
    source_one_admission_started = threading.Event()
    release_source_one_admission = threading.Event()
    source_one_admission_completed = threading.Event()
    allow_source_two_admission = threading.Event()
    source_two_admission_started = threading.Event()
    release_source_two_admission = threading.Event()
    source_one_render_started = threading.Event()
    original_admit = covers_module._admit_cover_display_variant_generation

    def blocking_admit(source_path, **kwargs):
        if source_path == source_one:
            source_one_admission_started.set()
            assert release_source_one_admission.wait(timeout=5)
            try:
                return original_admit(source_path, **kwargs)
            finally:
                source_one_admission_completed.set()
        if source_path == source_two:
            assert allow_source_two_admission.wait(timeout=5)
            source_two_admission_started.set()
            assert release_source_two_admission.wait(timeout=5)
        return original_admit(source_path, **kwargs)

    def record_render_start(source_path, **_kwargs):
        if source_path == source_one:
            source_one_render_started.set()
        return source_path

    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", prewarm_executor)
    monkeypatch.setattr(
        covers_module,
        "_COVER_VARIANT_ADMISSION_EXECUTOR",
        admission_executor,
        raising=False,
    )
    monkeypatch.setattr(covers_module, "_admit_cover_display_variant_generation", blocking_admit)
    monkeypatch.setattr(covers_module, "_render_cover_variant", record_render_start)
    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    try:
        covers_module.queue_cover_display_variant_generation(
            source_one,
            cache_root=tmp_path / "cache",
            max_size=480,
        )
        assert source_one_admission_started.wait(timeout=2)

        covers_module.queue_cover_display_variant_generation(
            source_two,
            cache_root=tmp_path / "cache",
            max_size=480,
        )
        release_source_one_admission.set()
        assert source_one_admission_completed.wait(timeout=2)
        allow_source_two_admission.set()
        assert source_two_admission_started.wait(timeout=2)

        assert source_one_render_started.wait(timeout=2)
        assert not release_source_two_admission.is_set()
    finally:
        release_source_one_admission.set()
        allow_source_two_admission.set()
        release_source_two_admission.set()
        admission_executor.shutdown(wait=True)
        prewarm_executor.shutdown(wait=True)
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_queue_cover_display_variant_generation_skips_when_variant_already_exists(tmp_path, monkeypatch):
    source_path = tmp_path / "cover-source.jpg"
    PILImage.new("RGB", (1200, 1200), color="green").save(source_path, format="JPEG")

    cache_root = tmp_path / "cache"

    class ImmediateExecutor:
        def submit(self, fn, *args, **kwargs):
            future = Future()
            try:
                future.set_result(fn(*args, **kwargs))
            except Exception as exc:
                future.set_exception(exc)
            return future

    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", ImmediateExecutor())

    covers_module.resolve_cover_display_variant(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )
    variant_base = covers_module.build_cover_variant_base_path(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )
    existing_variant = covers_module._find_existing_cover_variant(variant_base)

    queued_calls: list[bool] = []
    monkeypatch.setattr(
        covers_module,
        "_queue_cover_variant_generation",
        lambda *args, **kwargs: queued_calls.append(True),
    )

    covers_module.queue_cover_display_variant_generation(
        source_path,
        cache_root=cache_root,
        max_size=480,
    )

    assert existing_variant is not None
    assert existing_variant.exists()
    assert queued_calls == []


def test_foreground_variant_generation_is_not_starved_by_background_family_work(tmp_path, monkeypatch):
    background_executor = ThreadPoolExecutor(max_workers=2)
    foreground_executor = ThreadPoolExecutor(max_workers=1)
    background_gate = threading.Event()
    both_background_started = threading.Event()
    render_lock = threading.Lock()
    started_background = 0
    original_render = covers_module._render_cover_variant
    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()

    sources = []
    for name, color in (("background-one", "navy"), ("background-two", "teal"), ("visible", "orange")):
        source = tmp_path / f"{name}.png"
        PILImage.new("RGB", (960, 960), color=color).save(source, format="PNG")
        sources.append(source)

    def gated_render(source_path, **kwargs):
        nonlocal started_background
        if Path(source_path).stem.startswith("background"):
            with render_lock:
                started_background += 1
                if started_background == 2:
                    both_background_started.set()
            assert background_gate.wait(timeout=5)
        return original_render(source_path, **kwargs)

    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", background_executor)
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_FOREGROUND_EXECUTOR", foreground_executor)
    monkeypatch.setattr(covers_module, "_render_cover_variant", gated_render)

    background_futures = []
    try:
        for source in sources[:2]:
            variant_base = covers_module.build_cover_variant_base_path(
                source,
                cache_root=tmp_path / "cache",
                max_size=480,
            )
            background_futures.append(covers_module._queue_cover_variant_generation(
                source,
                variant_base_path=variant_base,
                normalized_size=480,
                priority="background",
            ))
        assert both_background_started.wait(timeout=2)

        with ThreadPoolExecutor(max_workers=1) as demand_caller:
            demand = demand_caller.submit(
                covers_module.resolve_cover_display_variant,
                sources[2],
                cache_root=tmp_path / "cache",
                max_size=480,
                priority="foreground",
            )
            try:
                visible_variant = demand.result(timeout=2)
            finally:
                background_gate.set()

        assert visible_variant != sources[2]
        assert visible_variant.exists()
        with PILImage.open(visible_variant) as rendered:
            assert rendered.size == (480, 480)

        background_variants = [future.result(timeout=2) for future in background_futures]
        assert all(variant is not None and variant.exists() for variant in background_variants)
    finally:
        background_gate.set()
        background_executor.shutdown(wait=True)
        foreground_executor.shutdown(wait=True)
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_queued_same_key_background_variant_promotes_to_foreground_lane(tmp_path, monkeypatch):
    class QueuedExecutor:
        def __init__(self):
            self.calls = []

        def submit(self, fn, *args, **kwargs):
            runner = Future()
            self.calls.append((runner, fn, args, kwargs))
            return runner

        def run_next(self):
            while self.calls:
                runner, fn, args, kwargs = self.calls.pop(0)
                if runner.cancelled():
                    continue
                try:
                    runner.set_result(fn(*args, **kwargs))
                except Exception as exc:
                    runner.set_exception(exc)
                return runner
            raise AssertionError("no queued cover variant work")

    source = tmp_path / "same-key.png"
    PILImage.new("RGB", (960, 960), color="purple").save(source, format="PNG")
    cache_root = tmp_path / "cache"
    variant_base = covers_module.build_cover_variant_base_path(
        source,
        cache_root=cache_root,
        max_size=480,
    )
    background_executor = QueuedExecutor()
    foreground_executor = QueuedExecutor()
    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", background_executor)
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_FOREGROUND_EXECUTOR", foreground_executor)

    background_result = covers_module._queue_cover_variant_generation(
        source,
        variant_base_path=variant_base,
        normalized_size=480,
        priority="background",
    )
    assert background_result is not None
    assert len(background_executor.calls) == 1

    try:
        with ThreadPoolExecutor(max_workers=1) as demand_caller:
            demand = demand_caller.submit(
                covers_module.resolve_cover_display_variant,
                source,
                cache_root=cache_root,
                max_size=480,
                priority="foreground",
            )
            deadline = time.monotonic() + 2
            while not foreground_executor.calls and time.monotonic() < deadline:
                time.sleep(0.01)
            assert len(foreground_executor.calls) == 1
            assert background_executor.calls[0][0].cancelled()
            assert not background_result.done(), (
                "the cancelled old runner callback must not settle the promoted shared result"
            )
            foreground_executor.run_next()
            visible_variant = demand.result(timeout=2)

        assert background_result.result(timeout=2) == visible_variant
        assert visible_variant != source
        assert visible_variant.exists()
    finally:
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_higher_priority_request_promotes_work_published_before_initial_submission(
    tmp_path,
    monkeypatch,
):
    published_before_submission = threading.Event()
    allow_initial_submission = threading.Event()

    class GatedFuture(Future):
        def add_done_callback(self, fn):
            if getattr(fn, "__name__", "") == "_clear_inflight":
                published_before_submission.set()
                assert allow_initial_submission.wait(timeout=5)
            return super().add_done_callback(fn)

    class QueuedExecutor:
        def __init__(self):
            self.calls = []

        def submit(self, fn, *args, **kwargs):
            runner = GatedFuture()
            self.calls.append((runner, fn, args, kwargs))
            return runner

        def run_next(self):
            while self.calls:
                runner, fn, args, kwargs = self.calls.pop(0)
                if runner.cancelled():
                    continue
                try:
                    runner.set_result(fn(*args, **kwargs))
                except Exception as exc:
                    runner.set_exception(exc)
                return runner
            raise AssertionError("no queued cover variant work")

    source = tmp_path / "published-before-submit.png"
    PILImage.new("RGB", (960, 960), color="indigo").save(source, format="PNG")
    variant_base = covers_module.build_cover_variant_base_path(
        source,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    background_executor = QueuedExecutor()
    interactive_executor = QueuedExecutor()
    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    monkeypatch.setattr(covers_module, "Future", GatedFuture)
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", background_executor)
    monkeypatch.setattr(
        covers_module,
        "_COVER_VARIANT_INTERACTIVE_EXECUTOR",
        interactive_executor,
    )

    with ThreadPoolExecutor(max_workers=1) as initial_caller:
        initial_call = initial_caller.submit(
            covers_module._queue_cover_variant_generation,
            source,
            variant_base_path=variant_base,
            normalized_size=480,
            priority="background",
        )
        try:
            assert published_before_submission.wait(timeout=2)

            interactive_result = covers_module._queue_cover_variant_generation(
                source,
                variant_base_path=variant_base,
                normalized_size=480,
                priority="interactive",
            )
            allow_initial_submission.set()
            background_result = initial_call.result(timeout=2)

            assert interactive_result is background_result
            assert len(background_executor.calls) == 0
            assert len(interactive_executor.calls) == 1

            interactive_executor.run_next()
            generated = interactive_result.result(timeout=2)
            assert generated is not None
            assert generated.exists()
        finally:
            allow_initial_submission.set()
            covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_queued_same_key_foreground_variant_promotes_to_interactive_without_demotion_or_duplicate(
    tmp_path,
    monkeypatch,
):
    class QueuedExecutor:
        def __init__(self):
            self.calls = []

        def submit(self, fn, *args, **kwargs):
            runner = Future()
            self.calls.append((runner, fn, args, kwargs))
            return runner

        def run_next(self):
            while self.calls:
                runner, fn, args, kwargs = self.calls.pop(0)
                if runner.cancelled():
                    continue
                try:
                    runner.set_result(fn(*args, **kwargs))
                except Exception as exc:
                    runner.set_exception(exc)
                return runner
            raise AssertionError("no queued cover variant work")

    source = tmp_path / "interactive-same-key.png"
    PILImage.new("RGB", (960, 960), color="violet").save(source, format="PNG")
    variant_base = covers_module.build_cover_variant_base_path(
        source,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    foreground_executor = QueuedExecutor()
    interactive_executor = QueuedExecutor()
    rendered_sources: list[Path] = []
    original_render = covers_module._render_cover_variant

    def record_render(source_path, **kwargs):
        rendered_sources.append(Path(source_path))
        return original_render(source_path, **kwargs)

    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_FOREGROUND_EXECUTOR", foreground_executor)
    monkeypatch.setattr(
        covers_module,
        "_COVER_VARIANT_INTERACTIVE_EXECUTOR",
        interactive_executor,
        raising=False,
    )
    monkeypatch.setattr(covers_module, "_render_cover_variant", record_render)

    foreground_result = covers_module._queue_cover_variant_generation(
        source,
        variant_base_path=variant_base,
        normalized_size=480,
        priority="foreground",
    )
    assert foreground_result is not None

    try:
        interactive_result = covers_module._queue_cover_variant_generation(
            source,
            variant_base_path=variant_base,
            normalized_size=480,
            priority="interactive",
        )
        later_foreground_result = covers_module._queue_cover_variant_generation(
            source,
            variant_base_path=variant_base,
            normalized_size=480,
            priority="foreground",
        )

        assert interactive_result is foreground_result
        assert later_foreground_result is foreground_result
        assert foreground_executor.calls[0][0].cancelled()
        assert len(foreground_executor.calls) == 1
        assert len(interactive_executor.calls) == 1
        assert not foreground_result.done()

        interactive_executor.run_next()
        generated = foreground_result.result(timeout=2)
        assert generated is not None
        assert generated.exists()
        assert rendered_sources == [source]
        assert len(interactive_executor.calls) == 0
    finally:
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_executor_shutdown_cancellation_settles_and_clears_current_cover_work(tmp_path, monkeypatch):
    worker_gate = threading.Event()
    worker_started = threading.Event()
    executor = ThreadPoolExecutor(max_workers=1)

    def occupy_worker():
        worker_started.set()
        assert worker_gate.wait(timeout=5)

    blocker = executor.submit(occupy_worker)
    assert worker_started.wait(timeout=2)
    source = tmp_path / "shutdown-cancel.png"
    PILImage.new("RGB", (960, 960), color="red").save(source, format="PNG")
    variant_base = covers_module.build_cover_variant_base_path(
        source,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", executor)

    try:
        shared_result = covers_module._queue_cover_variant_generation(
            source,
            variant_base_path=variant_base,
            normalized_size=480,
            priority="background",
        )
        assert shared_result is not None
        assert not shared_result.done()

        executor.shutdown(wait=False, cancel_futures=True)

        assert shared_result.result(timeout=2) is None
        assert str(variant_base) not in covers_module._COVER_VARIANT_PREWARM_INFLIGHT
    finally:
        worker_gate.set()
        blocker.result(timeout=2)
        executor.shutdown(wait=True)
        covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()


def test_executor_rejection_settles_and_clears_current_cover_work(tmp_path, monkeypatch):
    class RejectingExecutor:
        def submit(self, _fn, *_args, **_kwargs):
            runner = Future()
            runner.set_exception(RuntimeError("executor rejected queued cover work"))
            return runner

    source = tmp_path / "runner-rejected.png"
    PILImage.new("RGB", (960, 960), color="blue").save(source, format="PNG")
    variant_base = covers_module.build_cover_variant_base_path(
        source,
        cache_root=tmp_path / "cache",
        max_size=480,
    )
    covers_module._COVER_VARIANT_PREWARM_INFLIGHT.clear()
    monkeypatch.setattr(covers_module, "_COVER_VARIANT_PREWARM_EXECUTOR", RejectingExecutor())

    shared_result = covers_module._queue_cover_variant_generation(
        source,
        variant_base_path=variant_base,
        normalized_size=480,
        priority="background",
    )

    assert shared_result is not None
    assert shared_result.result(timeout=2) is None
    assert str(variant_base) not in covers_module._COVER_VARIANT_PREWARM_INFLIGHT
