const fs=require('node:fs'),path=require('node:path');
function nativeDelivery(root, html, entryNames) {
  const realRoot=fs.realpathSync(root), bodies=new Map();
  const nativeRoot=path.join(realRoot,'music_app/static/js');
  const confined=file=>{
    const resolved=fs.realpathSync(file);
    if(!resolved.startsWith(realRoot+path.sep))throw new Error('Native fixture path escaped repository: '+file);
    return resolved;
  };
  function collect(relative) {
    const url='/'+relative;
    if(bodies.has(url))return;
    if(!relative.startsWith('music_app/static/js/')||!relative.endsWith('.mjs'))throw new Error('Non-native module: '+relative);
    const file=confined(path.resolve(realRoot,relative));
    if(!file.startsWith(nativeRoot+path.sep)||!file.endsWith('.mjs'))throw new Error('Non-native module path: '+relative);
    const body=fs.readFileSync(file,'utf8');
    // Deliberately bounded static syntax, not a JavaScript parser or bundler.
    // Current owners use static imports. Dynamic imports fail closed.
    if(/\bimport\s*\(/.test(body))throw new Error('Dynamic module imports are not supported: '+relative);
    const imports=[];
    const declarations=/\bimport\s+(?:[^;'"`]*?\s+from\s*)?(['"])([^'"\r\n]+)\1\s*;|\bexport\s+(?:\*\s*(?:as\s+\w+\s*)?|\{[^}]*\}\s*)from\s*(['"])([^'"\r\n]+)\3\s*;/g;
    const remaining=body.replace(declarations,(_match,_q,spec,_eq,exportSpec)=>{imports.push(spec||exportSpec);return '';});
    if(/^\s*import\b/m.test(remaining)||/^\s*export\s+(?:\*|\{)[^;]*\bfrom\b/m.test(remaining))throw new Error('Unsupported module declaration: '+relative);
    bodies.set(url,body);
    for(const spec of imports) {
      if(!/^\.{1,2}\/[a-zA-Z0-9_./-]+\.mjs$/.test(spec))throw new Error('Only relative native .mjs dependencies are allowed: '+spec);
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(relative),spec));
      collect(dependency);
    }
  }
  const entries = new Map();
  const allowed = new Set(['mobileTrackColumnsNativeEntry.mjs']);
  for (const name of entryNames) {
    if (!allowed.has(name)) throw new Error('Unknown fixture entry: '+name);
    const file = confined(path.join(__dirname, name));
    if (path.dirname(file)!==fs.realpathSync(__dirname)||path.basename(file)!==name) throw new Error('Fixture entry escaped its fixed directory');
    const entry = fs.readFileSync(file, 'utf8');
    const imports = [...entry.matchAll(/import\s+[^;]*?from\s*['"](\/music_app\/static\/js\/[a-zA-Z0-9_./-]+\.mjs)['"]\s*;/g)];
    const remaining = entry.replace(/import\s+[^;]*?from\s*['"]\/music_app\/static\/js\/[a-zA-Z0-9_./-]+\.mjs['"]\s*;/g, '');
    if (/\bimport\s*\(/.test(entry)||/^\s*import\b/m.test(remaining)||/^\s*export\b/m.test(remaining)) throw new Error('Unsupported fixture import: '+name);
    for (const match of imports) collect(match[1].slice(1));
    entries.set('/__mobile_columns_fixture__/'+name.replace(/\.jsx$/, '.mjs'), entry);
  }
  return route=>{
    const request=route.request(),raw=request.url();
    const reject=()=>route.fulfill({status:404,contentType:'text/plain',body:'Unknown fixture resource'});
    let url;try{url=new URL(raw);}catch{return reject();}
    const pathname=url.pathname;
    // Never reinterpret encoded/malformed paths as the document fallback.
    if(request.method()!=='GET'||pathname.includes('%')||raw.includes('\\'))return reject();
    if(!url.search&&entries.has(pathname))return route.fulfill({contentType:'text/javascript; charset=utf-8',body:entries.get(pathname)});
    if(!url.search&&bodies.has(pathname))return route.fulfill({contentType:'text/javascript; charset=utf-8',body:bodies.get(pathname)});
    if(request.resourceType()==='document'&&!/\.(?:m?js|jsx|cjs)(?:\/|$)/i.test(pathname)&&!pathname.startsWith('/music_app/')&&!pathname.startsWith('/__mobile_columns_fixture__/'))return route.fulfill({contentType:'text/html',body:html});
    return reject();
  };
}
module.exports={nativeDelivery};
