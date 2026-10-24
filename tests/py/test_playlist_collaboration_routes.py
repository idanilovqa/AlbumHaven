"""Focused transport tests; service authorization is covered independently."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from tests.py.test_playlist_collaboration import ACCESS, MANAGE, P, K, G, context
from music_app.routes import owned_playlists_asgi as routes
from music_app.services.private_route_boundary import _PRIVATE_ROUTE_ACTIONS


class Service:
    def __init__(self):
        self.commands=[]
    def execute(self,ctx,command,*,constraints):
        self.commands.append(command)
        return {"ok":True,"action":command.action,"playlist_id":command.playlist_ref,"revision":"5","request_key":K}


def request(payload,service,*,fresh=True):
    body=json.dumps(payload).encode()
    async def receive():
        return {"type":"http.request","body":body,"more_body":False}
    return Request({"type":"http","method":"POST","path":"/playlists","query_string":b"",
        "headers":[(b"content-type",b"application/json"),(b"x-albumhaven-context",(b"a" if fresh else b"b")*64)],
        "app":SimpleNamespace(state=SimpleNamespace(owned_playlists_service=service))},receive)


@pytest.mark.parametrize("action,data,coarse", [
    ("visibility",{"visibility":"server_shared"},ACCESS),
    ("grant_editor",{"account_id":44,"role":"editor"},ACCESS),
    ("revoke_editor",{},ACCESS),
    ("delete",{},MANAGE),
])
def test_transport_retains_freshness_bounded_body_and_command_identity(monkeypatch,action,data,coarse):
    service=Service()
    seen=[]
    def ctx(req,policy):
        seen.append(policy)
        return context(),None
    monkeypatch.setattr(routes,"_context",ctx)
    monkeypatch.setattr(routes,"_context_ref",lambda request:"a"*64)
    response=asyncio.run(routes._write(request({"revision":"4","request_key":K,**data},service),action,P,
        grant_ref=G if action=="revoke_editor" else None))
    assert response.status_code==200
    assert seen==[coarse]
    assert response.headers["cache-control"]=="private, no-store"
    assert json.loads(response.body)["context_ref"]=="a"*64
    assert len(service.commands)==1 and service.commands[0].request_key==K
    if action=="revoke_editor":
        assert service.commands[0].data["grant_ref"]==G


def test_stale_context_and_spoofed_revoke_target_never_reach_service(monkeypatch):
    monkeypatch.setattr(routes,"_context",lambda request,action:(context(),None))
    monkeypatch.setattr(routes,"_context_ref",lambda request:"a"*64)
    for body,fresh,error in (({"revision":"4","request_key":K},False,"stale_context"),
            ({"revision":"4","request_key":K,"grant_ref":P},True,"invalid_command")):
        service=Service()
        response=asyncio.run(routes._write(request(body,service,fresh=fresh),"revoke_editor",P,grant_ref=G))
        assert json.loads(response.body)["error"]==error
        assert service.commands==[]


def test_implemented_routes_have_exact_policy_and_no_reserved_duplicates():
    import ast
    expected={
        ("GET","/playlists/{playlist_ref}/access-grants"):ACCESS,
        ("POST","/playlists/{playlist_ref}/access-grants"):ACCESS,
        ("DELETE","/playlists/{playlist_ref}/access-grants/{grant_ref}"):ACCESS,
        ("PATCH","/playlists/{playlist_ref}/visibility"):ACCESS,
        ("DELETE","/playlists/{playlist_ref}"):MANAGE,
    }
    assert {route:_PRIVATE_ROUTE_ACTIONS[route] for route in expected}==expected
    registered=[]
    for filename in ("owned_playlists_asgi.py","api_wave_b_asgi_routes.py"):
        tree=ast.parse(Path(routes.__file__).with_name(filename).read_text())
        for node in ast.walk(tree):
            if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)):
                for decorator in node.decorator_list:
                    if isinstance(decorator,ast.Call) and isinstance(decorator.func,ast.Attribute) and decorator.args and isinstance(decorator.args[0],ast.Constant):
                        registered.append((decorator.func.attr.upper(),decorator.args[0].value))
    assert all(registered.count(route)==1 for route in expected)
