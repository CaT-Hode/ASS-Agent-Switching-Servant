const { test } = require('node:test');
const assert = require('node:assert/strict');
const { woyaoGemini, mifyTeamGemini } = require('../core/gemini-compat.cjs');
const { normalizeProvider, codexModelId } = require('../core/models.cjs');
const { Router, routeFor } = require('../core/router.cjs');
const provider = (baseUrl = 'https://api.iiiiitoken.com', model = 'gemini-4-argon') => normalizeProvider({
  id:'woyao-fixture', name:'Custom label', baseUrl, apiKey:'synthetic-provider-key', enabled:true,
  models:[{ model, wireApi:'openai-responses', enabled:true }],
});
test('WOYAO Gemini matching is scoped to the exact service and model family', () => {
  for(const base of ['https://api.iiiiitoken.com','https://api.iiiiitoken.com/v1/'])
    assert.equal(woyaoGemini(provider(base),{model:'google/gemini-3.8-flash-high'}),true);
  for(const base of ['https://api.iiiiitoken.com.evil','https://api.iiiiitoken.com/other','https://api.iiiiitoken.com:444','http://api.iiiiitoken.com'])
    assert.equal(woyaoGemini({baseUrl:base},{model:'gemini-4-argon'}),false);
  assert.equal(woyaoGemini(provider(),{model:'gpt-fixture'}),false);
  assert.equal(mifyTeamGemini(provider('https://api.llm.mioffice.cn/v1'),{model:'vertex_ai/gemini-4-argon'}),true);
  assert.equal(mifyTeamGemini(provider('https://api.llm.mioffice.cn/other'),{model:'vertex_ai/gemini-4-argon'}),false);
  assert.equal(mifyTeamGemini(provider('https://api.llm.mioffice.cn.evil/v1'),{model:'vertex_ai/gemini-4-argon'}),false);
  assert.equal(mifyTeamGemini(provider('https://api.llm.mioffice.cn/v1'),{model:'gpt-fixture'}),false);
});

test('MIFYTEAM Gemini preserves array tool contracts and history while adapting search and streaming arguments',async t=>{
  const {toolBridge}=require('../core/tool-bridge.cjs');
  const p=provider('https://api.llm.mioffice.cn/v1','vertex_ai/gemini-4-argon'),calls=[];
  const parameters={type:'object',properties:{commands:{type:'array',items:{type:'string'}}},required:['commands'],additionalProperties:false};
  const fn={type:'function',name:'exec',parameters,strict:false},plain={type:'function',name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}};
  const tools=[{type:'web_search'},{type:'namespace',name:'local',tools:[fn,plain]}];
  const args=JSON.stringify({commands:['echo "hello"','echo 你好']}),wireArgs=JSON.stringify({input:args});
  const history=[{type:'function_call',name:'exec',namespace:'local',call_id:'old',arguments:args},{type:'function_call_output',call_id:'old',output:'unchanged'}];
  const router=new Router({getState:()=>({providers:[p]}),fetchUpstream:async(_url,init)=>{
    const body=JSON.parse(init.body);calls.push(body);const tool=body.tools.find(t=>t.parameters?.properties?.input);
    const item={type:'function_call',id:'fixture-item',call_id:'fixture-call',name:tool.name,arguments:wireArgs};
    const events=[{type:'response.output_item.added',item:{...item,arguments:''}},
      {type:'response.function_call_arguments.delta',item_id:item.id,delta:wireArgs.slice(0,18)},
      {type:'response.function_call_arguments.delta',item_id:item.id,delta:wireArgs.slice(18)},
      {type:'response.function_call_arguments.done',item_id:item.id,arguments:wireArgs},
      {type:'response.output_item.done',item},{type:'response.completed',response:{status:'completed',output:[item]}}];
    return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  }});
  await router.start(0);t.after(()=>router.stop());
  const response=await fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`,{method:'POST',headers:{authorization:'Bearer synthetic-client','content-type':'application/json'},
    body:JSON.stringify({model:codexModelId(p.id,p.models[0].model),stream:true,input:history,tools,tool_choice:{type:'function',namespace:'local',name:'exec'}})});
  const events=(await response.text()).split('\n\n').filter(Boolean).map(f=>JSON.parse(f.split('\n').find(line=>line.startsWith('data:')).slice(5)));
  assert.equal(response.status,200);assert.equal(response.headers.get('x-ass-unavailable-tools'),'web_search');
  assert.match(calls[0].instructions,/Native web search is unavailable/);assert.equal(calls[0].tools.length,2);
  assert.equal(calls[0].tools[0].parameters.properties.input.type,'string');assert.match(calls[0].tools[0].description,/"commands"/);
  assert.deepEqual(calls[0].tools[1].parameters,plain.parameters);
  assert.equal(JSON.parse(calls[0].input[0].arguments).input,args);assert.deepEqual(calls[0].input[1],history[1]);
  assert.equal(events.find(e=>e.type==='response.function_call_arguments.delta').delta,args);
  const restored=events.at(-1).response.output[0];assert.equal(restored.name,'exec');assert.equal(restored.namespace,'local');assert.equal(restored.arguments,args);
  assert.deepEqual(toolBridge({tools:[fn]}).request.tools[0].parameters,parameters,'other providers retain their native array schema');
  const bridge=toolBridge({tools:[fn]},{encodeArrayArguments:true});
  assert.throws(()=>bridge.response({output:[{type:'function_call',name:'exec',arguments:JSON.stringify({input:'[]'})}]}),/JSON 对象/);
  assert.equal(bridge.response({output:[{type:'function_call',name:'exec',arguments:wireArgs}]}).output[0].arguments,args);
});
test('Gemini mixed search/functions are adapted with a notice while forced search and other providers retain their semantics', async t => {
  const p=provider(), calls=[], logs=[];
  const router=new Router({getState:()=>({providers:[p]}),log:r=>logs.push(r),fetchUpstream:async(url,init)=>{
    calls.push({url,body:JSON.parse(init.body),headers:init.headers});
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]}})+'\n\n');
  }});
  t.after(()=>router.stop()); await router.start(0);
  const tools=[{type:'web_search'},{type:'namespace',name:'local',tools:[{type:'function',name:'read',parameters:{type:'object'}}]}];
  const send=body=>fetch(`http://127.0.0.1:${router.port}/clients/ASS/v1/responses`,{
    method:'POST',headers:{authorization:'Bearer synthetic-client','content-type':'application/json'},
    body:JSON.stringify({model:codexModelId(p.id,p.models[0].model),input:'Keep exact user content',stream:true,tools,...body}),
  });
  const result=await send({}); assert.equal(result.status,200); await result.text();
  assert.equal(result.headers.get('x-ass-unavailable-tools'),'web_search');
  assert.deepEqual(calls[0].body.tools,[tools[1]]); assert.match(calls[0].body.instructions,/Native web search is unavailable/);
  assert.equal(calls[0].body.input,'Keep exact user content'); assert.equal(calls[0].body.max_output_tokens,131072);
  assert.equal(calls[0].headers.authorization,'Bearer synthetic-provider-key');
  assert.ok(logs.some(r=>r.ok&&r.omittedTools?.includes('web_search')));
  const forced=await send({tool_choice:{type:'web_search'}}); assert.equal(forced.status,400); await forced.text(); assert.equal(calls.length,1);
  p.baseUrl='https://other.invalid'; const ordinary=await send({}); await ordinary.text();
  assert.deepEqual(calls[1].body.tools,tools); assert.equal(calls[1].body.max_output_tokens,131072);
  p.baseUrl='https://api.iiiiitoken.com';const searchOnly=await send({tools:[tools[0]]});await searchOnly.text();
  assert.deepEqual(calls[2].body.tools,[tools[0]],'no function/tool mixture leaves native search declarations intact');
});
