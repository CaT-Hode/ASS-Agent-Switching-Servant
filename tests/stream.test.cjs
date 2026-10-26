const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SseMonitor } = require("../core/sse-monitor.cjs");
const { Router } = require("../core/router.cjs");
const { Readable, Writable } = require('node:stream');
const { normalizeProvider, codexModelId } = require('../core/models.cjs');
const settle = async () => { for(let i=0;i<3;i++) await new Promise(setImmediate); };
async function pendingStream(t, { protocol = 'openai-responses', headersPending = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const chunks = [], logs = [];
  const provider=normalizeProvider({id:'fixture',baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',models:[{model:'slow',wireApi:protocol}]});
  let source, signal, cancelled=false;
  const router=new Router({getState:()=>({providers:[provider]}),log:r=>logs.push(r),fetchUpstream:async(_url,init)=>{
    signal=init.signal;
    if(headersPending) return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return new Response(new ReadableStream({start(c){source=c;},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream','x-request-id':'fixture-upstream'}});
  }});
  const req=Readable.from([Buffer.from(JSON.stringify({model:protocol==='openai-responses'?'gpt-fixture':codexModelId(provider.id,'slow'),stream:true,input:[]}))]);
  Object.assign(req,{url:'/clients/ASS/v1/responses',method:'POST',headers:{host:'127.0.0.1:25819',authorization:'Bearer synthetic-oauth'}});
  const res=new Writable({write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback();}});
  res.headersSent=false;res.setHeader=()=>{};res.flushHeaders=()=>{};
  res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers;res.headersSent=true;};
  const done=router.handle(req,res);t.after(async()=>{res.destroy();await done;});await settle();
  return {router,res,logs,done,signal,text:()=>Buffer.concat(chunks).toString('utf8'),cancelled:()=>cancelled,
    send:async text=>{source.enqueue(Buffer.from(text));await settle();},tick:async ms=>{t.mock.timers.tick(ms);await settle();}};
}

test('official stream heartbeats survive more than five minutes and preserve complete raw frames',async t=>{
  const f=await pendingStream(t),heart=': keepalive\r\n\r\n';
  await f.tick(240000);await f.send(heart);await f.tick(240000);await f.send('event: response.com');
  assert.equal(f.signal.aborted,false);
  const end='pleted\r\ndata: {"type":"response.completed"}\r\n\r\n';await f.send(end);await f.done;
  assert.equal(f.text(),heart+'event: response.com'+end);
  assert.equal(f.res.headers['x-request-id'],'fixture-upstream');
  assert.equal(f.logs[0].taskOk,true);assert.equal(f.logs[0].ms,480000);
  await f.tick(300000);assert.equal(f.logs.length,1);
});

test('converted streams count raw heartbeats and report an idle timeout only after a full silent interval',async t=>{
  const f=await pendingStream(t,{protocol:'openai-chat'});
  await f.tick(240000);await f.send(': keepalive\n\n');await f.tick(240000);
  await f.send('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n');
  assert.equal(f.signal.aborted,false);assert.match(f.text(),/hello/);
  await f.tick(299999);assert.equal(f.signal.aborted,false);await f.tick(1);await f.done;
  assert.equal(f.signal.reason.code,'upstream_idle_timeout');assert.equal(f.cancelled(),true);
  assert.match(f.text(),/upstream_idle_timeout/);assert.doesNotMatch(f.text(),/response.completed/);
  assert.equal(f.logs[0].status,504);assert.equal(f.logs[0].taskOk,false);assert.match(f.logs[0].error,/连续 5 分钟未返回数据/);
});

test('missing upstream headers time out with a distinct gateway timeout',async t=>{
  const f=await pendingStream(t,{headersPending:true});await f.tick(300000);await f.done;
  assert.equal(f.res.statusCode,504);assert.equal(JSON.parse(f.text()).error.code,'upstream_idle_timeout');
  assert.equal(f.router.active,0);assert.equal(f.router.clientActive(),0);
});

test('client cancellation stops a pending response body without labelling it a timeout',async t=>{
  const f=await pendingStream(t);f.res.destroy();await settle();await f.done;
  assert.equal(f.cancelled(),true);assert.equal(f.logs[0].error,'请求已取消');assert.equal(f.router.active,0);
});
test("SSE monitor handles split UTF8/CRLF and rejects truncated or failed streams", () => {
  const monitor = new SseMonitor(),
    bytes = Buffer.from(
      'data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n',
    );
  for (const byte of bytes) monitor.feed(Uint8Array.of(byte));
  monitor.feed(null, true);
  assert.equal(monitor.ended, true);
  assert.throws(() => new SseMonitor().feed(null, true));
  assert.throws(() =>
    new SseMonitor().feed(Buffer.from('data: {"type":"response.failed"}\n\n')),
  );
});
test("official Responses missing Content-Type is sniffed safely, HTML is rejected", async (t) => {
  let html = false;
  const router = new Router({
    getState: () => ({ providers: [] }),
    fetchUpstream: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              Buffer.from(
                html
                  ? "<html>blocked</html>"
                  : 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
              ),
            );
            c.close();
          },
        }),
      ),
  });
  router.port = 0;
  await router.start();
  router.port = router.server.address().port;
  t.after(() => router.stop());
  const request = () =>
    fetch("http://127.0.0.1:" + router.port + "/clients/ASS/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-test", stream: true, input: "hi" }),
    });
  const success = await request();
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("content-type"), "text/event-stream");
  assert.match(await success.text(), /response.completed/);
  html = true;
  const error = await request();
  assert.equal(error.status, 502);
  assert.match(await error.text(), /SSE/);
});
