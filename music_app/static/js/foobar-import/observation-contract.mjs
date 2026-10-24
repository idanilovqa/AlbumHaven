// Presentation of actual verified source evidence, never native authority.
export const OBSERVATION_RESPONSE_BYTES=131072;
export const OBSERVATION_FIELDS=Object.freeze(['play_count','play_count_enhanced','first_played','last_played','first_played_enhanced','last_played_enhanced']);
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v,max,min=0)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const hex=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const count=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
const fail=()=>{throw new Error('The observation review could not be verified. Run a fresh review.');};
const characters=v=>{if(typeof v!=='string')fail();let n=0;for(const c of v){const p=c.codePointAt(0);if(p>=0xd800&&p<=0xdfff)fail();n++;}return n;};
const label=(v,max)=>typeof v==='string'&&!/[\p{C}\u2028\u2029]/u.test(v)&&new TextEncoder().encode(v).length<=max;
function field(value,name,command,row,side){
  if(!exact(value,['field','state','count','code','origin','raw_prefix','raw_characters'])||value.field!==name
      ||!['absent','empty','unavailable','valid','invalid'].includes(value.state)
      ||!integer(value.raw_characters,65536))fail();
  const isCount=name==='play_count'||name==='play_count_enhanced';
  if(!isCount&&value.state==='invalid'||value.code!==(value.state==='invalid'?'invalid_count':null))fail();
  if(isCount&&value.state==='valid'?!count(value.count):value.count!==null)fail();
  let origin=null;
  if(value.state==='absent'){
    if(value.origin!==null||value.raw_prefix!==null||value.raw_characters!==0)fail();
  }else{
    if(!Array.isArray(value.origin)||value.origin.length!==3||!hex(value.origin[0])
        ||!integer(value.origin[1],100000,1)||!integer(value.origin[2],255)
        ||characters(value.raw_prefix)!==Math.min(8,value.raw_characters)
        ||side==='incoming'&&(value.origin[0]!==command.upload_sha256||value.origin[1]!==row))fail();
    origin=Object.freeze([...value.origin]);
  }
  return Object.freeze({...value,origin});
}
export function validateObservationPage(value,command,startOffset){
  if(!exact(value,['items','after','next','remaining','raw_chunk','date_state_is_raw_parser_evidence','families_are_not_added'])
      ||!Array.isArray(value.items)||value.items.length>20||!integer(value.after,command.total_rows,startOffset)
      ||!integer(value.remaining,command.total_rows-value.after)
      ||value.items.length+value.remaining!==command.total_rows-value.after
      ||value.date_state_is_raw_parser_evidence!==true||value.families_are_not_added!==true)fail();
  let previous=value.after;
  const items=value.items.map(item=>{
    if(!exact(item,['row','source_artist','source_title','source_album','incoming','effective'])
        ||item.row!==previous+1||!label(item.source_artist,48)||!label(item.source_title,96)||!label(item.source_album,48))fail();
    previous=item.row;
    const sides={};
    for(const side of ['incoming','effective']){
      if(!Array.isArray(item[side])||item[side].length!==OBSERVATION_FIELDS.length)fail();
      sides[side]=Object.freeze(item[side].map((v,i)=>field(v,OBSERVATION_FIELDS[i],command,item.row,side)));
    }
    return Object.freeze({...item,...sides});
  });
  if(value.next!==(value.remaining?previous:null)||value.remaining&&items.length!==20)fail();
  let raw=null;
  if(value.raw_chunk!==null){
    const c=value.raw_chunk;
    if(!exact(c,['ordinal','side','field','offset','total_characters','text','next_offset'])
        ||!['incoming','effective'].includes(c.side)||!OBSERVATION_FIELDS.includes(c.field)
        ||!integer(c.offset,65536)||c.offset%512||!integer(c.total_characters,65536,c.offset)
        ||characters(c.text)!==Math.min(512,c.total_characters-c.offset)
        ||c.offset>0&&c.offset===c.total_characters
        ||c.next_offset!==(c.offset+characters(c.text)<c.total_characters?c.offset+characters(c.text):null))fail();
    const row=items.find(i=>i.row===c.ordinal),f=row?.[c.side].find(f=>f.field===c.field);
    if(!f||f.raw_characters!==c.total_characters||c.offset===0&&f.raw_prefix!==null&&!c.text.startsWith(f.raw_prefix))fail();
    raw=Object.freeze({...c});
  }
  return Object.freeze({...value,items:Object.freeze(items),raw_chunk:raw});
}
export function validateRawFieldRequest(raw,page){
  if(raw===null)return null;
  if(!exact(raw,['ordinal','side','field','offset'])||!['incoming','effective'].includes(raw.side)
      ||!OBSERVATION_FIELDS.includes(raw.field)||!integer(raw.offset,65536)||raw.offset%512
      ||!page?.items.some(r=>r.row===raw.ordinal))fail();
  if(raw.offset!==0){const c=page.raw_chunk;if(!c||raw.ordinal!==c.ordinal||raw.side!==c.side||raw.field!==c.field||raw.offset!==c.next_offset)fail();}
  return Object.freeze({...raw});
}
export function displayRawEvidence(value){
  if(value===null)return 'No supplied field';
  // Keep raw controls/bidi readable without letting them affect visual order.
  return Array.from(value,c=>/[\p{C}\u2028\u2029]/u.test(c)?`\\u{${c.codePointAt(0).toString(16)}}`:c).join('');
}
