"""Display scope is deliberately outside the immutable acquisition command."""
from tests.py.test_album_top_acquired_artist_preview_postgres import preview_case,preparations,db,urls,setup,acquire,expected,OTHER,descriptor


def test_same_key_family_artist_family_reprojects_without_new_acquisition(preview_case):
    case=preview_case;command,family=setup(case,(OTHER,),'family')
    first=acquire(case,command,family);before=case.state()
    assert first['artist_scope_preview']==expected(family,first,False)
    middle=acquire(case,command,descriptor(case.db,'artist'))
    assert middle['artist_scope_preview'] is None and middle['state']=='pending'
    final=acquire(case,command,family)
    assert final==first and len(case.calls)==1 and case.state()==before
    assert {key:value for key,value in middle.items() if key!='artist_scope_preview'}=={key:value for key,value in first.items() if key!='artist_scope_preview'}
