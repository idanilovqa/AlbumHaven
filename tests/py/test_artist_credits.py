from __future__ import annotations

import pytest

from music_app.services.artist_credits import track_artist_credit_members


@pytest.mark.parametrize(
    ("credit", "owner", "expected"),
    [
        ("Maroon 5; Megan Thee Stallion", "Maroon 5", ["Maroon 5", "Megan Thee Stallion"]),
        ("Maroon 5; Nipsey Hussle; YG", "Maroon 5", ["Maroon 5", "Nipsey Hussle", "YG"]),
        ("Jason Derulo; Adam Levine", "Maroon 5", ["Jason Derulo", "Adam Levine"]),
        ("Ногу Свело! feat 25 / 17", "Ногу Свело!", ["Ногу Свело!", "25/17"]),
        ("Owner feat Guest / Partner", "Owner", ["Owner", "Guest / Partner"]),
        ("Owner feat. Fire & Ash", "Owner", ["Owner", "Fire & Ash"]),
        ("Owner feat. To/Die/For", "Owner", ["Owner", "To/Die/For"]),
        ("Owner feat. Чиж & Co", "Owner", ["Owner", "Чиж & Co"]),
        ("Fire & Ash", "Fire", ["Fire & Ash"]),
        ("To/Die/For", "To", ["To/Die/For"]),
        ("Чиж & Co", "Чиж", ["Чиж & Co"]),
        ("Earth, Wind & Fire", "Earth", ["Earth, Wind & Fire"]),
        ("Me and That Man", "Me", ["Me and That Man"]),
        ("Guest; Owner; Guest", "Owner", ["Owner", "Guest"]),
        ("", "Owner", []),
        (None, "Owner", []),
    ],
)
def test_track_artist_credit_members_are_explicit_and_stable(credit, owner, expected):
    assert track_artist_credit_members(credit, owner) == expected
