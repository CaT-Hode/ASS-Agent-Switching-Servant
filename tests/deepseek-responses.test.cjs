const test=require('node:test'),assert=require('node:assert/strict');
const {Router}=require('../core/router.cjs');
const {makeCatalog,codexModelId}=require('../core/models.cjs');
const provider={id:'deepseek-fixture',name:'DeepSeek fixture',enabled:true,apiKey:'synthetic-only',baseUrl:'https://api.deepseek.com',
  models:[{model:'deepseek-flash',displayName:'DeepSeek Flash',enabled:true,wireApi:'openai-responses',contextWindow:900000,efforts:['low','high','max'],defaultEffort:'max'}]};
const tools=[{type:'namespace',name:'functions',tools:[
  {type:'custom',name:'exec',description:'Synthetic raw input tool',format:{type:'text'}},
  {type:'function',name:'read',parameters:{type:'object',properties:{name:{type:'string'}}}},
]}];
const raw='ASS_TOOL_CHECK\n\"中文\"';
const request=stream=>({model:codexModelId(provider.id,'deepseek-flash'),stream,instructions:'Synthetic tool dispatch only',tools,
  input:[{type:'custom_tool_call',namespace:'functions',name:'exec',call_id:'previous',input:'previous input'},
    {type:'custom_tool_call_output',call_id:'previous',output:'previous result'},
    {type:'reasoning',id:'native-reasoning',content:[{type:'reasoning_text',text:'synthetic private state'}]},
    {role:'user',content:'Use the synthetic tool'}],tool_choice:{type:'custom',namespace:'functions',name:'exec'}});
const output=name=>({id:'call_item',type:'function_call',call_id:'call_fixture',name,arguments:JSON.stringify({input:raw}),status:'completed'});
function upstream(body,stream,{badArgs=false,failed=false,truncated=false}={}) {
  assert.equal(body.tools[0].type,'function','DeepSeek must receive a flat JSON function, not a namespace');
  assert.equal(body.tools.some(t=>t.type==='namespace'||t.type==='custom'),false);
  assert.equal(body.tools[0].parameters.properties.input.type,'string');
  assert.equal(body.input[0].type,'function_call');
  assert.equal(body.input[0].namespace,undefined);
  assert.equal(body.input[0].name,body.tools[0].name);
  assert.equal(body.input[1].type,'function_call_output');
  assert.equal(body.input[2].content[0].text,'synthetic private state','native Responses reasoning must remain replayable');
  assert.deepEqual(body.tool_choice,{type:'function',name:body.tools[0].name});
  const item=output(body.tools[0].name);if(badArgs)item.arguments='{"wrong":"input"}';
  const response={id:'resp_fixture',status:failed?'failed':'completed',output:[item],usage:{input_tokens:8,output_tokens:3,total_tokens:11}};
  if(!stream)return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
  const args=item.arguments,events=[
    {type:'response.created',sequence_number:0,response:{id:response.id,status:'in_progress',output:[]}},
    {type:'response.output_item.added',sequence_number:1,output_index:0,item:{...item,status:'in_progress',arguments:''}},
    {type:'response.function_call_arguments.delta',sequence_number:2,item_id:item.id,output_index:0,delta:args.slice(0,7)},
    {type:'response.function_call_arguments.delta',sequence_number:3,item_id:item.id,output_index:0,delta:args.slice(7)},
    {type:'response.function_call_arguments.done',sequence_number:4,item_id:item.id,output_index:0,arguments:args},
    {type:'response.output_item.done',sequence_number:5,output_index:0,item},
    {type:failed?'response.failed':'response.completed',sequence_number:6,response},
  ];
  if(truncated)events.pop();
  return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}
async function fixture(t,fetcher,p=provider) {
  const logs=[],calls=[];
  const router=new Router({getState:()=>({providers:[p]}),log:row=>logs.push(row),fetchUpstream:async(url,init)=>{
    assert.equal(url,p.baseUrl+'/v1/responses');
    const body=JSON.parse(init.body);calls.push(body);return fetcher(body);
  }});
  await router.start(0);t.after(()=>router.stop());
  return {calls,logs,send:body=>fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+router.clientToken,'content-type':'application/json'},body:JSON.stringify(body)})};
}
for(const stream of [false,true])test(`DeepSeek native Responses restores namespace custom tools, history and repeated requests (${stream?'SSE':'JSON'})`,async t=>{
  const f=await fixture(t,b=>upstream(b,stream));
  for(let i=0;i<2;i++) {
    const r=await f.send(request(stream));assert.equal(r.status,200);
    const text=await r.text(),events=stream?text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))):[];
    const response=stream?events.at(-1).response:JSON.parse(text),item=response.output[0];
    assert.equal(item.type,'custom_tool_call');assert.equal(item.name,'exec');assert.equal(item.namespace,'functions');assert.equal(item.input,raw);assert.equal(item.call_id,'call_fixture');
    assert.equal(response.status,'completed');assert.equal(response.usage.total_tokens,11);
    if(stream){assert.equal(events.filter(e=>e.type==='response.custom_tool_call_input.done').length,1);assert.equal(events.some(e=>e.type==='response.function_call_arguments.delta'),false);assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i));}
  }
  assert.equal(f.calls.length,2);assert.equal(f.logs.filter(l=>l.taskOk).length,2);
});
for(const stream of [false,true])test(`DeepSeek native Responses rejects malformed raw input and failed tasks (${stream?'SSE':'JSON'})`,async t=>{
  let options={badArgs:true};const f=await fixture(t,b=>upstream(b,stream,options));
  for(options of [{badArgs:true},{failed:true},...(stream?[{truncated:true}]:[])]) {
    const r=await f.send(request(stream)),text=await r.text();
    if(stream){assert.doesNotMatch(text,/event: response.completed/);assert.match(text,/event: error/);}
    else assert.equal(r.status,502);
    assert.equal(f.logs.at(-1).taskOk,false);
  }
});
test('DeepSeek Codex metadata follows the official tool protocol and preserves native subscription models',()=>{
  const native={slug:'gpt-fixture',context_window:500000,use_responses_lite:true,tool_mode:'direct',supports_parallel_tool_calls:false,input_modalities:['text'],unrelated:'native',base_instructions:'Native instructions'};
  const original=structuredClone(native),catalog=makeCatalog([native],[provider]);
  assert.deepEqual(catalog.models[0],original);
  const entry=catalog.models.find(x=>x.slug.includes('::'));
  assert.equal(entry.use_responses_lite,false);assert.equal(entry.tool_mode,null);assert.equal(entry.apply_patch_tool_type,'freeform');assert.equal(entry.prefer_websockets,false);assert.equal(entry.supports_parallel_tool_calls,true);
  assert.equal(entry.context_window,900000);assert.equal(entry.default_reasoning_level,'max');
});

test('other Responses providers keep native namespace/custom payloads unchanged',async t=>{
  for(const baseUrl of ['https://relay.test/v1','https://api.deepseek.com.evil.test','https://api.deepseek.com:8443']) {
    const p={...provider,baseUrl};let sent;
    const router=new Router({getState:()=>({providers:[p]}),fetchUpstream:async(url,init)=>{
      sent=JSON.parse(init.body);
      return new Response(JSON.stringify({id:'native',status:'completed',output:[{type:'custom_tool_call',namespace:'functions',name:'exec',call_id:'native_call',input:raw}]}),{headers:{'content-type':'application/json'}});
    }});
    await router.start(0);t.after(()=>router.stop());
    const r=await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+router.clientToken,'content-type':'application/json'},body:JSON.stringify(request(false))});
    assert.equal(r.status,200);assert.deepEqual(sent.tools,tools);assert.deepEqual(sent.input,request(false).input);
    assert.equal((await r.json()).output[0].input,raw);
  }
});

test('DSML-looking prose is kept as text and is never promoted to a runnable tool',async t=>{
  const prose='Example: <｜｜DSML｜｜ calls>synthetic text</｜｜DSML｜｜ calls>';
  const f=await fixture(t,b=>{
    assert.equal(b.tools[0].type,'function');
    return new Response(JSON.stringify({id:'text',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:prose}]}]}),{headers:{'content-type':'application/json'}});
  });
  const r=await f.send(request(false));assert.equal(r.status,200);
  const value=await r.json();assert.equal(value.output.length,1);assert.equal(value.output[0].type,'message');assert.equal(value.output[0].content[0].text,prose);
});

for(const stream of [false,true])test(`explicit compatible/native selection controls Responses tools for any supplier (${stream?'SSE':'JSON'})`,async t=>{
  for(const mode of ['compatible','native']) {
    // Force compatibility on an unrelated relay, and opt out on DeepSeek.
    const p={...provider,baseUrl:mode==='compatible'?'https://relay.test':provider.baseUrl,
      models:provider.models.map(m=>({...m,codexToolMode:mode}))};
    const f=await fixture(t,b=>{
      if(mode==='compatible')return upstream(b,stream);
      assert.deepEqual(b.tools,tools);assert.deepEqual(b.input,request(stream).input);
      const response={id:'native',status:'completed',output:[{type:'custom_tool_call',namespace:'functions',name:'exec',call_id:'native_call',input:raw}]};
      return new Response(stream?'event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response})+'\n\n':JSON.stringify(response),
        {headers:{'content-type':stream?'text/event-stream':'application/json'}});
    },p);
    for(let i=0;i<2;i++) {
      const r=await f.send(request(stream));assert.equal(r.status,200);
      const text=await r.text(),value=stream?JSON.parse(text.split('\n').filter(l=>l.startsWith('data: ')).at(-1).slice(6)).response:JSON.parse(text);
      assert.equal(value.output[0].type,'custom_tool_call');assert.equal(value.output[0].namespace,'functions');assert.equal(value.output[0].input,raw);
      assert.equal(f.logs.at(-1).taskOk,true);
    }
  }
});

for(const stream of [false,true])test(`existing Codex history without namespaces reaches DeepSeek and restores the current tool (${stream?'SSE':'JSON'})`,async t=>{
  const body=request(stream);delete body.input[0].namespace;
  const f=await fixture(t,b=>upstream(b,stream));
  for(let i=0;i<2;i++){
    const r=await f.send(body);assert.equal(r.status,200);const text=await r.text();
    const response=stream?JSON.parse(text.split('\n').filter(l=>l.startsWith('data: ')).at(-1).slice(6)).response:JSON.parse(text);
    assert.equal(response.output[0].type,'custom_tool_call');assert.equal(response.output[0].namespace,'functions');
    assert.equal(response.output[0].name,'exec');assert.equal(response.output[0].input,raw);assert.equal(f.logs.at(-1).taskOk,true);
  }
});
