from pathlib import Path
p=Path('tests/py/test_api_read_asgi_routes.py')
s=p.read_text(encoding='utf-8')
old='''    assert _decode_json(log_body) == {
        "ok": True,
        "items": [{"id": "entry-1", "message": "Refresh started"}],
        "revision": "test-process:4",
    }'''
new='''    assert _decode_json(log_body) == {
        "ok": True,
        "items": [{"id": "entry-1", "message": "Refresh started"}],
        "revision": "test-process:4",
        "allowed_actions": {"library.logs.read": True, "library.logs.export": True},
    }'''
if s.count(old)!=2: raise RuntimeError(f'expected two history payload anchors, got {s.count(old)}')
s=s.replace(old,new)
old='''    assert _decode_json(body) == {"ok": True, "items": [], "revision": "test-process:0"}'''
new='''    assert _decode_json(body) == {
        "ok": True,
        "items": [],
        "revision": "test-process:0",
        "allowed_actions": {"library.logs.read": True, "library.logs.export": True},
    }'''
if old not in s: raise RuntimeError('empty history payload anchor missing')
p.write_text(s.replace(old,new),encoding='utf-8',newline='\n')
