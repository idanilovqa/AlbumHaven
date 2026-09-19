from pathlib import Path
p=Path('tests/py/test_log_history_route_scope.py');s=p.read_text(encoding='utf-8-sig').replace('import httpx','from tests.py.asgi_testing import run_asgi_request')
s=s.replace('''    async def invoke():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            return await client.request(method,path)
    response=asyncio.run(invoke())
    assert response.status_code==403 and calls==[action]''','''    status, _headers, _body = run_asgi_request(app,method,path)
    assert status==403 and calls==[action]''')
s=s.replace('''    async def invoke():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            return await client.post('/utilities/log-history/export',json={'query':{}})
    response=asyncio.run(invoke())
    assert response.status_code==403 and 'library.logs.read' in requested''','''    status, _headers, _body = run_asgi_request(app,'POST','/utilities/log-history/export',json_body={'query':{}})
    assert status==403 and 'library.logs.read' in requested''')
p.write_text(s)
