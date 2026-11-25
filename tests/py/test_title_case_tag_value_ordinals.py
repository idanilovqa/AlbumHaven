from music_app.services.utils import title_case_tag_value


def test_title_case_keeps_ordinals_lower_case_after_digits():
    assert title_case_tag_value("20th anniversary edition remix") == "20th Anniversary Edition Remix"
    assert title_case_tag_value("1st press, 2nd edition, 3rd mix") == "1st Press, 2nd Edition, 3rd Mix"
    assert title_case_tag_value("2005 remaster") == "2005 Remaster"
    assert title_case_tag_value("deluxe edition of the MTV iTunes cd") == "Deluxe Edition Of The MTV iTunes Cd"
