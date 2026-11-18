"""English country names for split same-name labels (owner 2026-11-17, display only)."""
import json

from music_app.services.country_names import COUNTRY_NAMES, country_name, country_names_sql_literal


def test_iso_codes_become_english_names_and_musicbrainz_regions_are_named():
    assert [country_name(code) for code in ("ES", "PL", "us", "GB", "XE", "XW")] == [
        "Spain", "Poland", "United States", "United Kingdom", "Europe", "Worldwide"]


def test_a_code_with_no_name_stays_the_code():
    assert country_name("QZ") == "QZ"
    assert country_name("") == ""


def test_the_sql_literal_is_the_whole_map_with_quotes_escaped():
    literal = country_names_sql_literal()
    assert literal.startswith("'") and literal.endswith("'::jsonb")
    body = literal[1:-len("'::jsonb")].replace("''", "'")
    assert json.loads(body) == COUNTRY_NAMES
    assert "d''Ivoire" in literal, "an apostrophe is doubled inside the SQL string"
    assert literal.isascii(), "escaped, so the SQL text never carries literal accents"
    assert all(len(code) == 2 and code.isupper() for code in COUNTRY_NAMES)
