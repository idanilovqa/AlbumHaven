"""Authored genuine advance-entry guard, with declared storage admission seams.

No query/runtime pass is claimed. This isolates the default route branch before
any budget/state write, without changing the frozen shared consumer module.
"""
import json
from types import SimpleNamespace
import pytest
from music_app.services import local_album_full_state as full,local_album_listening as local
from music_app.services.playback_capture import CaptureError


def test_default_actual_advance_rejects_unordered_membership_before_budget_or_state_work(monkeypatch):
    calls=[]
    for name in ('_selector','require_position_storage','_require_full_indexes'):
        monkeypatch.setattr(full,name,lambda *args,**kwargs:None)
    for name in ('state_storage_ready','decoder_observation_ready','selection_schema_ready'):
        monkeypatch.setattr(full,name,lambda *args:True)
    monkeypatch.setattr(local,'_require_local_metrics_indexes',lambda *args:None)
    selected=SimpleNamespace(canonical_membership=json.dumps({'order_status':'unsupported','members':[{'track_id':1}]}))
    def edition(*args):calls.append('exact-edition');return selected,[]
    monkeypatch.setattr(local,'_edition',edition)
    def forbidden(*args,**kwargs):raise AssertionError('Unsupported default Full must not inspect versions or allocate budget')
    monkeypatch.setattr(local,'_versions',forbidden);monkeypatch.setattr(full,'_budgets',forbidden)
    with pytest.raises(CaptureError) as raised:
        full.advance_local_album_full_on_connection(object(),object(),object(),'album',0,
            constraints=None,clock=lambda:None,enabled=lambda:True)
    assert raised.value.code=='capture_unavailable'
    assert calls==['exact-edition']
