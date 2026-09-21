import pytest
import config


def test_browse_bases_reads_actual_environment(monkeypatch):
    monkeypatch.setenv("ALBUM_HAVEN_LIBRARY_BROWSE_BASES", '["C:/owned/music"]')
    assert config._library_browse_bases() == ["C:/owned/music"]


@pytest.mark.parametrize("raw", ["not-json", '{"root":"private"}', '[1]', '[""]'])
def test_invalid_browse_environment_fails_closed_with_safe_diagnostic(monkeypatch, caplog, raw):
    monkeypatch.setenv("ALBUM_HAVEN_LIBRARY_BROWSE_BASES", raw)
    assert config._library_browse_bases() == []
    assert "ALBUM_HAVEN_LIBRARY_BROWSE_BASES" in caplog.text
    assert "disabled" in caplog.text
    assert raw not in caplog.text
