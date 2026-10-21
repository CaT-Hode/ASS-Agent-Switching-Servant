const { test } = require('node:test');
const assert = require('node:assert/strict');
const { woyaoGemini } = require('../core/woyao-compat.cjs');
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
