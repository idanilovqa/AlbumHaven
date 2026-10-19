// Discovery only. The protected server normalizer remains the syntax authority.
// No account lookup, storage, transport or result authority belongs here.
const SearchShorthandModel = (() => {
  const entries = [
    ['loved', 'Your Love', ':loved', ':loved', 'Loved and obsessed tracks', 'love'],
    ['obsessed', 'Your Love', ':obsessed', ':obsessed', 'Obsessed tracks', 'love'],
    ['not-loved', 'Your Love', '-:loved', '-:loved', 'Exclude loved and obsessed tracks', 'love'],
    ['love-alias', 'Your Love', 'love:loved', 'love:loved', 'Alias for :loved', 'love'],
    ['obsessed-alias', 'Your Love', 'love:obsessed', 'love:obsessed', 'Alias for :obsessed', 'love'],
    ['not-love-alias', 'Your Love', '-love:loved', '-love:loved', 'Alias for -:loved', 'love'],
    ['not-obsessed-alias', 'Your Love', '-love:obsessed', '-love:obsessed', 'Alias for -:obsessed', 'love'],
    ['not-obsessed', 'Your Love', '-:obsessed', '-:obsessed', 'Exclude obsessed tracks', 'love'],
    ['love-only', 'Your Love', ':loved -:obsessed', ':loved -:obsessed', 'Loved without obsessed', 'love', false],
    ['listener', 'Listener', '@handle', '@', 'Enter an AlbumHaven username; all-time listening history', 'listener'],
    ['listener-love', 'Listener', '@handle :loved', '@ :loved', 'Enter a username; loved and obsessed listening history', 'listener', false],
    ['tracks', 'Listener', ':tracks', ':tracks', 'Track results; use with a username or popularity', 'tracks'],
    ['history', 'Listener', 'listened:all', 'listened:all', 'All-time history; requires a username', 'listener'],
    ['popular', 'Popularity', ':popular', ':popular', 'Last.fm global scrobbles, highest first', 'popularity'],
    ['sort-popular', 'Popularity', 'sort:popular', 'sort:popular', 'Alias for :popular', 'popularity'],
    ['artist', 'Artist and genre', ':popular artist:"Artist Name"', ':popular artist:""', 'Enter an artist name; popularity searches only', 'popularity'],
    ['not-artist', 'Artist and genre', ':popular -artist:"Artist Name"', ':popular -artist:""', 'Exclude an artist; popularity searches only', 'popularity'],
    ['genre', 'Artist and genre', ':popular genre:"progressive rock"', ':popular genre:"progressive rock"', 'Filter popularity by genre', 'popularity'],
    ['not-genre', 'Artist and genre', ':popular -genre:rock', ':popular -genre:rock', 'Exclude a genre from popularity', 'popularity'],
    ['cap', 'Songs per artist', ':popular per_artist:3', ':popular per_artist:3', 'At most 3 recordings per artist; choose 1–5000', 'popularity'],
  ].map(([id, section, example, insertion, description, dialect, suggest = true]) =>
    Object.freeze({id, section, example, insertion, description, dialect, suggest}));
  const catalog = Object.freeze(entries);
  // Python's query lexer uses str.isspace; do not silently treat a BOM as a separator.
  const whitespace = char => /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(char);
  function tokens(value) {
    const result = []; let index = 0;
    while (index < value.length) {
      if (whitespace(value[index])) {index++; continue;}
      const start = index; let quote = '', quoted = false, malformed = false, decoded = '';
      while (index < value.length && (quote || !whitespace(value[index]))) {
        const char = value[index];
        if (quote) {
          if (char === quote) {quote = ''; index++; continue;}
          if (quote === '"' && char === '\\' && ['"', '\\'].includes(value[index + 1])) {
            decoded += value[index + 1]; index += 2; continue;
          }
          decoded += char; index++; continue;
        }
        if (char === '"' || char === "'") {quote = char; quoted = true; index++; continue;}
        if (char === '\\') {
          if (index + 1 >= value.length) {malformed = true; index++; continue;}
          decoded += value[index + 1]; index += 2; continue;
        }
        decoded += char; index++;
      }
      result.push({start, end: index, raw: value.slice(start, index), decoded, quoted, malformed: malformed || Boolean(quote)});
    }
    return result;
  }
  // Conservative retained-draft validation, not execution or matching. Preserve
  // allowed set-like duplicates, but do not offer additions to malformed clauses.
  function context(parts) {
    const usernames = new Set();
    let love = false, popular = false, filters = false, caps = 0, tracks = 0, history = 0, invalid = false;
    for (const part of parts) {
      const raw = part.raw.toLowerCase();
      if (part.malformed) {invalid = true; continue;}
      if (raw.startsWith('@')) {
        const username = raw.slice(1);
        if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) invalid = true;
        else usernames.add(username);
      } else if (/^-?(?::(?:loved|obsessed)|love:(?:loved|obsessed))$/.test(raw)) love = true;
      else if (/^(?::popular|sort:popular)$/.test(raw)) popular = true;
      else if (/^-?(artist|genre):/.test(raw)) {
        filters = true;
        const prefix = part.raw.slice(0, part.raw.indexOf(':') + 1);
        const value = part.decoded.slice(prefix.length);
        // Server split_search_terms needs at least one Unicode alphanumeric.
        // We do not duplicate its case folding, stemming or matching semantics.
        if (!/[\p{L}\p{N}]/u.test(value)) invalid = true;
      } else if (raw.startsWith('per_artist:')) {
        caps++;
        const value = raw.slice('per_artist:'.length);
        if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 5000) invalid = true;
      } else if (raw === ':tracks') tracks++;
      else if (raw === 'listened:all') history++;
      else invalid = true;
    }
    const listener = usernames.size > 0, popularityFamily = popular || filters || caps > 0;
    if (invalid || usernames.size > 1 || caps > 1
        || popularityFamily && (listener || love || history > 0)
        || !popularityFamily && (listener || history > 0) && (tracks > 1 || history > 1)
        || !listener && love && (tracks > 0 || history > 0)) return {dialect: 'conflict', cap: caps > 0};
    if (listener) return {dialect: 'listener', cap: false};
    if (history > 0) return {dialect: 'incomplete', cap: false};
    if (popularityFamily) return {dialect: popular ? 'popularity' : 'popularity-incomplete', cap: caps > 0};
    if (love) return {dialect: 'love', cap: false};
    if (tracks > 0) return {dialect: 'incomplete', cap: false};
    return {dialect: 'empty', cap: false};
  }
  function range(value, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > value.length) return null;
    const parts = tokens(value), token = parts.find(part => start >= part.start && start <= part.end);
    if (start !== end) {
      // Never destroy clauses spanning several tokens, or slice a quoted value.
      if (!token || start !== token.start || end !== token.end) return null;
      return {start, end, token, parts};
    }
    if (token?.quoted) return null;
    return {start: token?.start ?? start, end: token?.end ?? end, token, parts};
  }
  function plan(value, start, end, id, append = false) {
    const entry = catalog.find(item => item.id === id);
    if (!entry || typeof value !== 'string') return {error: 'Choose a supported shorthand.'};
    const located = append ? {start: value.length, end: value.length, parts: tokens(value)} : range(value, start, end);
    if (!located) return {error: 'Place the caret in a shorthand or select one whole shorthand.'};
    const others = located.parts.filter(part => part !== located.token), current = context(others);
    if (current.dialect === 'conflict' || current.dialect === 'incomplete'
      || current.dialect === 'popularity-incomplete' && entry.dialect !== 'popularity'
      || current.dialect === 'love' && entry.dialect !== 'love'
      || current.dialect === 'listener' && entry.dialect === 'popularity'
      || current.dialect === 'popularity' && !['popularity', 'tracks'].includes(entry.dialect)) {
      return {error: 'This shorthand does not combine with this draft. Edit or clear the conflicting clauses first.'};
    }
    if (entry.id === 'tracks' && !['listener', 'popularity'].includes(current.dialect)) return {error: 'Use :tracks with an AlbumHaven username or :popular.'};
    if (entry.id === 'history' && current.dialect !== 'listener') return {error: 'Enter an AlbumHaven username first, such as @ followed by the username.'};
    if (entry.id.startsWith('listener') && current.dialect === 'listener') return {error: 'This draft already has a listener. Edit that username instead.'};
    if (entry.id === 'cap' && current.cap) return {error: 'This draft already has per_artist. Edit its number instead.'};
    if (current.dialect === 'listener' && ['tracks', 'history'].includes(entry.id) && others.some(part => part.raw.toLowerCase() === entry.insertion)) return {error: 'This draft already has that selector.'};
    let insertion = entry.insertion;
    if (current.dialect === 'popularity') insertion = insertion.replace(/^:popular\s+/, '');
    if (append && value && !/\s$/.test(value)) insertion = ' ' + insertion;
    const next = value.slice(0, located.start) + insertion + value.slice(located.end);
    if (Array.from(next).length > 200 || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(next)) return {error: 'Search must be at most 200 characters and contain valid text.'};
    let caret = located.start + insertion.length, selectionEnd = caret;
    const empty = insertion.indexOf('""');
    if (empty >= 0) caret = selectionEnd = located.start + empty + 1;
    else if (entry.id.startsWith('listener')) caret = selectionEnd = located.start + insertion.indexOf('@') + 1;
    else if (entry.id === 'cap') {caret = located.start + insertion.lastIndexOf('3'); selectionEnd = caret + 1;}
    return {value: next, start: caret, end: selectionEnd};
  }
  function suggestions(value, start, end) {
    const located = range(value, start, end);
    if (!located || !located.token) return [];
    const prefix = value.slice(located.start, start).toLowerCase();
    if (!prefix || !/^[-:@a-z_]/i.test(prefix)) return [];
    return catalog.filter(entry => entry.suggest && [entry.insertion, entry.insertion.replace(/^:popular\s+/, ''), entry.example]
      .some(text => text.toLowerCase().startsWith(prefix)) && !plan(value, start, end, entry.id).error).slice(0, 8);
  }
  // Advanced is an intentionally conservative editable subset of the protected
  // grammar. Discovery context() is never an authority for these drafts.
  const advancedDrafts = new WeakSet();
  const foldKeyword = value => value.replace(/[A-Z\u017f\u212a\u00df\u1e9e\ufb05\ufb06]/g, char =>
    ({'ſ':'s','K':'k','ß':'ss','ẞ':'ss','ﬅ':'st','ﬆ':'st'}[char] || char.toLowerCase()));
  const validRaw = raw => Array.from(raw).length <= 200 && !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(raw);
  const emptyFields = family => ({family, ordinary:'', include:[], exclude:[], username:'', facets:[], cap:{present:false,text:''}});
  const freezeDraft = draft => {
    draft.tokens.forEach(Object.freeze); Object.freeze(draft.tokens);
    draft.fields.facets.forEach(Object.freeze); Object.freeze(draft.fields.facets);
    Object.freeze(draft.fields.include); Object.freeze(draft.fields.exclude); Object.freeze(draft.fields.cap); Object.freeze(draft.fields);
    draft.edits=draft.edits.map(edit=>Object.freeze({...edit,...(edit.patch?{patch:Object.freeze({...edit.patch})}:{}),...(edit.orderedSet?{orderedSet:Object.freeze([...edit.orderedSet])}:{})}));
    draft.diagnostics.forEach(Object.freeze);Object.freeze(draft.edits); Object.freeze(draft.diagnostics); advancedDrafts.add(draft); return Object.freeze(draft);
  };
  function parseAdvanced(raw) {
    raw = String(raw ?? '');
    const fields = emptyFields('ordinary'), diagnostics = [];
    let status = 'editable', family = 'ordinary';
    const issue = (kind, message, token = {start:0,end:raw.length}) => {
      if (status !== 'malformed' || kind === 'malformed') status = kind;
      diagnostics.push({message,start:token.start,end:token.end,codePointStart:Array.from(raw.slice(0,token.start)).length,codePointEnd:Array.from(raw.slice(0,token.end)).length});
    };
    if (!validRaw(raw)) issue('malformed','Use at most 200 characters of valid text.');
    const plain = []; let index = 0;
    while (index < raw.length) {
      if (whitespace(raw[index])) {index++;continue;}
      const start=index;while(index<raw.length&&!whitespace(raw[index]))index++;
      plain.push({start,end:index,raw:raw.slice(start,index),decoded:raw.slice(start,index)});
    }
    const privateLooking = plain.some(t => /^@|^-?:|^-?(?:love:|artist:|genre:)|^(?:per_artist:|listened:|sort:)/.test(foldKeyword(t.raw)));
    const popularity = plain.some(t => /^(?::popular|sort:popular)$|^-?(?:artist|genre):|^per_artist:/.test(foldKeyword(t.raw)));
    let parts = privateLooking ? (popularity ? tokens(raw) : plain) : [];
    if (!privateLooking) fields.ordinary=raw;
    let hasLove=false,hasUser=false,hasPopular=false,tracks=0,history=0,caps=0;
    const handles=new Set();
    parts=parts.map((part,n)=>({...part,id:`t${n}`,codePointStart:Array.from(raw.slice(0,part.start)).length,codePointEnd:Array.from(raw.slice(0,part.end)).length,field:null}));
    for(const part of parts) {
      const folded=foldKeyword(part.raw);
      if(!popularity&&/["'\\]/.test(part.raw)){issue('malformed','Love and listener tokens do not support quotes or escapes.',part);continue;}
      if(part.malformed){issue('malformed','Unclosed quote or trailing escape.',part);continue;}
      const love=folded.match(/^(-)?(?::|love:)(loved|obsessed)$/);
      if(love){hasLove=true;part.field=love[1]?'exclude':'include';if(!fields[part.field].includes(love[2]))fields[part.field].push(love[2]);continue;}
      if(part.raw.startsWith('@')) {
        hasUser=true;part.field='username';
        if(/[^\x00-\x7f]/.test(part.raw)){issue('unsupported','This username needs ordinary Search.',part);continue;}
        const name=part.raw.slice(1).toLowerCase();
        if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(name))issue('malformed','Enter a username of 3–64 permitted characters.',part);
        handles.add(name);fields.username=part.raw.slice(1);continue;
      }
      if(folded===':popular'||folded==='sort:popular'){hasPopular=true;part.field='selector';continue;}
      if(folded===':tracks'){tracks++;part.field='tracks';continue;}
      if(folded==='listened:all'){history++;part.field='history';continue;}
      if(folded.startsWith('per_artist:')) {
        caps++;part.field='cap';const text=part.raw.slice(part.raw.indexOf(':')+1);fields.cap={present:true,text};
        if(!/^[0-9]+$/.test(text)||Number(text)<1||Number(text)>5000)issue('malformed','Songs per artist must be 1–5000.',part);continue;
      }
      const facet=folded.match(/^(-?)(artist|genre):/);
      if(facet) {
        const prefixLength=part.raw.indexOf(':')+1,text=part.decoded.slice(prefixLength);part.field=part.id;
        fields.facets.push({rowId:part.id,kind:facet[2],polarity:facet[1]?'exclude':'include',text});
        if(!/[a-z0-9]/i.test(text))issue(!text||/^[\x00-\x7f]*$/.test(text)?'malformed':'unsupported','Enter a facet containing an ASCII letter or digit; other Unicode-only facets need ordinary Search.',part);
        continue;
      }
      issue(/["'\\]/.test(part.raw)&&/^[-:]|^love:/.test(folded)?'malformed':'unsupported','This query cannot be structurally edited.',part);
    }
    if(privateLooking) {
      family=popularity?'popularity':hasUser||history?'listener':hasLove?'love':'ordinary';
      if((popularity&&(hasLove||hasUser||history))||handles.size>1||caps>1||(!popularity&&(tracks>1||history>1))||(!hasUser&&hasLove&&(tracks||history)))issue('unsupported','Mixed families or duplicate singleton selectors need ordinary Search.');
      if(popularity&&!hasPopular)issue('malformed','Popularity requires :popular.');
      if(!popularity&&!hasUser&&(history||tracks))issue('unsupported','These selectors require a listener.');
    }
    fields.family=family;
    return freezeDraft({status,raw,family,tokens:parts,fields,diagnostics,rawBase:raw,edits:[],nextRowId:0});
  }
  const advancedError = (draft,message) => ({ok:false,draft,diagnostics:[{message}]});
  function editAdvanced(draft, edit) {
    if(!advancedDrafts.has(draft)||draft.status!=='editable')return advancedError(draft,'This draft cannot be edited.');
    if(edit?.type==='reset')return resetAdvanced(draft);
    const fields={...draft.fields,include:[...draft.fields.include],exclude:[...draft.fields.exclude],cap:{...draft.fields.cap},facets:draft.fields.facets.map(row=>({...row}))};
    let key, nextRowId=draft.nextRowId;
    if(edit?.type==='setFamily') {
      if(!['ordinary','love','listener','popularity'].includes(edit.family))return advancedError(draft,'Unknown family.');
      if(edit.family===fields.family)return {ok:true,draft};
      const populated=fields.ordinary!==''||fields.include.length||fields.exclude.length||fields.username||fields.facets.length||fields.cap.present||fields.family==='popularity';
      if(populated)return advancedError(draft,'Reset filters before switching family.');
      const fresh=parseAdvanced('');
      const changed=freezeDraft({...fresh,family:edit.family,fields:emptyFields(edit.family),tokens:[],edits:[{key:'family',type:'setFamily',family:edit.family}],nextRowId});
      return {ok:true,draft:changed};
    } else if(edit?.type==='setLove') {
      if(!['love','listener'].includes(fields.family)||!['include','exclude'].includes(edit.side)||!Array.isArray(edit.orderedSet)||edit.orderedSet.some(v=>!['loved','obsessed'].includes(v)))return advancedError(draft,'Invalid Love field.');
      key=edit.side;fields[key]=['loved','obsessed'].filter(v=>edit.orderedSet.includes(v));
    } else if(edit?.type==='setUsername'&&fields.family==='listener') {key='username';fields.username=String(edit.text);}
    else if(edit?.type==='setCap'&&fields.family==='popularity') {key='cap';fields.cap={present:edit.present===true,text:String(edit.text??'')};}
    else if(['addFacet','updateFacet','removeFacet'].includes(edit?.type)&&fields.family==='popularity') {
      const i=fields.facets.findIndex(row=>row.rowId===edit.rowId);
      if(edit.type==='addFacet') {
        const rowId=`n${nextRowId++}`;
        if(edit.rowId!==undefined&&edit.rowId!==rowId)return advancedError(draft,'Stale facet identity.');
        fields.facets.push({rowId,kind:edit.kind,polarity:edit.polarity,text:String(edit.text??'')});key=rowId;
      } else {
        if(i<0)return advancedError(draft,'Unknown facet row.');key=edit.rowId;
        if(edit.type==='removeFacet')fields.facets.splice(i,1);
        else {if(Object.keys(edit.patch||{}).some(k=>!['kind','polarity','text'].includes(k)))return advancedError(draft,'Unknown facet field.');Object.assign(fields.facets[i],edit.patch);}
      }
      if(fields.facets.some(r=>!['artist','genre'].includes(r.kind)||!['include','exclude'].includes(r.polarity)||typeof r.text!=='string'))return advancedError(draft,'Invalid facet.');
    } else return advancedError(draft,'Unknown field edit.');
    return {ok:true,draft:freezeDraft({...draft,fields,tokens:draft.tokens.slice(),edits:[...draft.edits.filter(e=>e.key!==key),{...edit,key}],nextRowId})};
  }
  function resetAdvanced(draft) {
    if(!advancedDrafts.has(draft)||draft.status!=='editable'||(draft.family==='ordinary'&&draft.fields.ordinary!==''))return advancedError(draft,'Clear this text using ordinary Search.');
    if(draft.family==='ordinary'&&draft.rawBase===''&&!draft.edits.length)return {ok:true,draft};
    return {ok:true,draft:parseAdvanced('')};
  }
  function serializeAdvanced(draft) {
    if(!advancedDrafts.has(draft)||draft.status!=='editable')return {ok:false,value:draft?.raw??'',diagnostics:draft?.diagnostics||[{message:'Invalid draft.'}]};
    const f=draft.fields, failure=message=>({ok:false,value:draft.rawBase,diagnostics:[{message}]});
    if(f.family==='love'&&!f.include.length&&!f.exclude.length)return failure('Choose an Include or Exclude Love filter.');
    if(f.family==='listener'&&!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(f.username))return failure('Enter a valid listener username.');
    if(f.cap.present&&(!/^[0-9]+$/.test(f.cap.text)||Number(f.cap.text)<1||Number(f.cap.text)>5000))return failure('Songs per artist must be 1–5000.');
    if(f.facets.some(r=>!/[a-z0-9]/i.test(r.text)))return failure('Each facet needs an ASCII letter or digit.');
    if(!draft.edits.length)return {ok:true,value:draft.rawBase,diagnostics:[]};
    const quote=text=>'"'+text.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
    const replacement=key=>key==='username'?'@'+f.username:key==='include'||key==='exclude'?f[key].map(v=>(key==='exclude'?'-':'')+':'+v).join(' '):key==='cap'?f.cap.present?'per_artist:'+f.cap.text:'':(()=>{const row=f.facets.find(r=>r.rowId===key);return row?(row.polarity==='exclude'?'-':'')+row.kind+':'+quote(row.text):'';})();
    const changed=new Set(draft.edits.map(e=>e.key)),used=new Set();let result='',cursor=0,remaining=0;
    for(const token of draft.tokens){result+=draft.rawBase.slice(cursor,token.start);let value=token.raw;if(changed.has(token.field)){value=used.has(token.field)?'':replacement(token.field);used.add(token.field);}result+=value;if(value)remaining++;cursor=token.end;}
    result+=draft.rawBase.slice(cursor);
    if(draft.tokens.length&&!remaining)result='';
    const append=value=>{if(!value)return;if(result&&!whitespace(result.at(-1)))result+=' ';result+=value;};
    if(changed.has('family')&&f.family==='popularity')append(':popular');
    for(const key of ['username','include','exclude',...f.facets.filter(r=>r.rowId.startsWith('n')).map(r=>r.rowId),'cap'])if(changed.has(key)&&!used.has(key))append(replacement(key));
    const parsed=parseAdvanced(result);
    if(!validRaw(result)||parsed.status!=='editable'||parsed.family!==f.family)return failure(parsed.diagnostics[0]?.message||'Complete this family before applying.');
    return {ok:true,value:result,diagnostics:[]};
  }
  function advancedSummary(draft) {
    if(!advancedDrafts.has(draft)||draft.status!=='editable'||draft.family==='ordinary')return '';
    return ({love:'Your Love',listener:'Listener',popularity:'Popularity'})[draft.family];
  }
  return Object.freeze({catalog, tokens, context, plan, suggestions, parseAdvanced, editAdvanced, serializeAdvanced, resetAdvanced, advancedSummary});
})();
