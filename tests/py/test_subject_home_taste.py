from music_app.services.subject_home_taste import load_subject_album_taste


class Connection:
    def execute(self,sql,params):
        self.sql,self.params=sql,params
        return self
    def fetchall(self):
        return [{'id':23,'rating':8}]


def test_album_taste_requires_explicit_subject_and_library():
    con=Connection()
    assert load_subject_album_taste(con,account_id=17,library_id=29,album_ids=[23])=={
        23:{'rating':8,'favorite':None,'taste_state':'available'}}
    assert con.params==(17,29,[23])
    assert 'account_id=%s' in con.sql and 'bootstrap' not in con.sql
