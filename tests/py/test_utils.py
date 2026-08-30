from __future__ import annotations

from music_app.services.utils import collect_text_repairs, looks_like_mojibake, repair_display_text


def _byte_swapped_utf16(text: str) -> str:
    return text.encode("utf-16le").decode("utf-16be")


def test_repair_display_text_repairs_utf16_byte_swapped_ascii_text():
    raw_album = _byte_swapped_utf16("Insound Tour Support No. 12")
    raw_artist = _byte_swapped_utf16("Bright Eyes")
    raw_title = _byte_swapped_utf16("The Joy in Discovery")

    assert looks_like_mojibake(raw_album) is True
    assert repair_display_text(raw_album) == "Insound Tour Support No. 12"
    assert repair_display_text(raw_artist) == "Bright Eyes"
    assert repair_display_text(raw_title) == "The Joy in Discovery"
    assert "Insound Tour Support No. 12" in collect_text_repairs(raw_album)


def test_strong_mojibake_ascii_fast_path_preserves_representative_legacy_results(monkeypatch):
    from music_app.services import utils

    def legacy_signal(text: str) -> bool:
        if any(marker in text for marker in utils._QUESTIONABLE_MARKERS):
            return True
        if utils._has_dense_cp1251_as_latin_signal(text):
            return True
        if utils._has_utf16_byte_swap_signal(text):
            return True
        return any(marker in text for marker in utils._SUSPICIOUS_MOJIBAKE_SEQUENCES)

    ascii_samples = [
        "",
        "plain album title",
        "?",
        "? ?",
        "??",
        "prefix??suffix",
        "".join(chr(codepoint) for codepoint in range(128)),
        *(chr(codepoint) for codepoint in range(128)),
    ]
    non_ascii_samples = [
        "正常な日本語タイトル",
        "РђСЂРёСЏ",
        "Björk",
        _byte_swapped_utf16("Bright Eyes"),
        *utils._QUESTIONABLE_MARKERS,
        *utils._SUSPICIOUS_MOJIBAKE_SEQUENCES,
    ]

    for sample in [*ascii_samples, *non_ascii_samples]:
        assert utils._has_strong_mojibake_signal(sample) is legacy_signal(sample)

    def unexpected_expensive_probe(_text):
        raise AssertionError("ASCII fast path must not run non-ASCII mojibake probes")

    monkeypatch.setattr(utils, "_has_dense_cp1251_as_latin_signal", unexpected_expensive_probe)
    monkeypatch.setattr(utils, "_has_utf16_byte_swap_signal", unexpected_expensive_probe)

    for sample in ascii_samples:
        assert utils._has_strong_mojibake_signal(sample) is ("??" in sample)


def test_repeated_mojibake_checks_reuse_the_same_text_analysis(monkeypatch):
    from music_app.services import utils

    raw_text = _byte_swapped_utf16("Problematic Files Cache Probe 91827")
    original_signal = utils._has_strong_mojibake_signal
    signal_calls = 0

    def counted_signal(text: str) -> bool:
        nonlocal signal_calls
        signal_calls += 1
        return original_signal(text)

    monkeypatch.setattr(utils, "_has_strong_mojibake_signal", counted_signal)

    assert utils.looks_like_mojibake(raw_text) is True
    assert utils.looks_like_mojibake(raw_text) is True
    assert signal_calls == 1


def test_repeated_display_repairs_reuse_the_same_candidate_analysis(monkeypatch):
    from music_app.services import utils

    raw_text = _byte_swapped_utf16("Problematic Files Repair Cache Probe 61294")
    original_candidates = utils._repair_text_candidates
    candidate_calls = 0

    def counted_candidates(text: str) -> list[str]:
        nonlocal candidate_calls
        candidate_calls += 1
        return original_candidates(text)

    monkeypatch.setattr(utils, "_repair_text_candidates", counted_candidates)

    assert utils.repair_display_text(raw_text) == "Problematic Files Repair Cache Probe 61294"
    first_call_count = candidate_calls
    assert first_call_count > 0
    assert utils.repair_display_text(raw_text) == "Problematic Files Repair Cache Probe 61294"
    assert candidate_calls == first_call_count
