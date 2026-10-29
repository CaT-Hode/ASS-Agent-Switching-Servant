const { test } = require('node:test'), assert = require('node:assert/strict');
const { Preferences } = require('../core/preferences.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const start = new Date(2026,9,28,12).getTime();
const row = (id, ms, running = true) => ({ requestId: id, model: 'provider::vendor/model[1m]', source: 'Relay',
  client: 'claude', time: new Date(start+ms).toISOString(), inProgress: running, ms: 1234, tps: 42, tpsEstimated: true,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 10 } });
test('request rows hold their positions for 15 seconds and retire a quiet completed batch once', async () => {
  const { WidgetRequests } = await import('../core/request-widget-view.mjs'), view = new WidgetRequests();
  assert.deepEqual(view.update([row('a',0),row('b',0)],[],start).map(r=>r.id), ['a','b']);
  const a=row('a',1000,false),b=row('b',2000,false);
  view.update([row('b',0)],[a],start+1000);
  assert.deepEqual(view.update([],[a,b],start+2000).map(r=>r.id), ['a','b']);
  assert.deepEqual(view.update([],[a,b],start+16999).map(r=>r.id), ['a','b']);
  assert.deepEqual(view.update([],[a,b],start+17000), []);
  assert.deepEqual(view.update([],[a,b],start+18000), []);
});
test('a new request reuses a completed row without resurrecting it or shifting another live request', async () => {
  const { WidgetRequests } = await import('../core/request-widget-view.mjs'), view = new WidgetRequests();
  view.update([row('a',0),row('b',0)],[],start);
  const a=row('a',1000,false);view.update([row('b',0)],[a],start+1000);
  const result=view.update([row('b',0),row('c',2000)],[a],start+2000);
  assert.deepEqual(result.map(r=>r.id),['c','b']);assert.equal(result[0].model,'model');assert.equal(result[0].cache,80);
  assert.equal(result[0].tps,42);assert.equal(result[0].estimated,true);
  for (let i=3;i<15;i++) assert.deepEqual(view.update([row('c',2000),row('b',0)],[a],start+i*1000).map(r=>r.id),['c','b']);
});
test('today heatmap follows canonical local-hour usage and fills only the interval after the latest scan', async () => {
  const { todayHeatmap }=await import('../core/request-widget-view.mjs');
  const usage={updatedAt:new Date(start).toISOString(),rows:[{day:'2026-10-28',hour:8,input:100,output:10,cacheRead:70},
    {day:'2026-10-28',hour:3,input:20,output:5},{day:'2026-10-28',input:10,output:2},
    {day:'2026-10-27',hour:8,input:999,output:999}]};
  const heat=todayHeatmap(usage,[row('counted',-1000,false),row('new',1000,false)],start+2000);
  assert.equal(heat.cells.length,24);assert.equal(heat.cells[8].tokens,110);assert.equal(heat.cells[12].tokens,120);
  assert.equal(heat.cells[3].tokens,25);assert.equal(heat.total,267);assert.equal(heat.unallocated,12);
  assert.equal(heat.cells[13].future,true);
});
test('widget settings survive reload and leave theme and other preferences intact', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ass-widget-prefs-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const prefs=new Preferences(directory);prefs.update({theme:'light',requestWidget:{enabled:true,width:560,radius:36,rows:3,x:-900,y:50}});
  assert.equal(new Preferences(directory).state.requestWidget.x,-900);
  prefs.update({requestWidget:{enabled:false,width:NaN,radius:200,rows:99}});
  assert.equal(prefs.state.requestWidget.width,560);assert.equal(prefs.state.requestWidget.radius,36);
  assert.equal(prefs.state.requestWidget.enabled,false);assert.equal(prefs.state.theme,'light');
});

test('motion keeps departing rows in their slots, updates live values without replacing IDs, and accepts rapid replacement', async () => {
  const { motionRows, widgetHeight } = await import('../core/request-widget-view.mjs');
  let entries = motionRows([], [{ id:'a', tps:1 }, { id:'b', tps:2 }]);
  entries = motionRows(entries, [{ id:'a', tps:50 }, { id:'b', tps:2 }]);
  assert.deepEqual(entries.map(e=>e.row.id), ['a','b']);assert.equal(entries[0].row.tps,50);
  entries = motionRows(entries, [{ id:'b', tps:3 }, { id:'c', tps:4 }]);
  assert.equal(entries.find(e=>e.row.id==='a').exiting,true);assert.equal(entries.find(e=>e.row.id==='a').index,0);
  assert.equal(entries.find(e=>e.row.id==='b').index,0);assert.equal(entries.find(e=>e.row.id==='c').index,1);
  entries = motionRows(entries, [{ id:'a', tps:5 }]);
  assert.equal(entries.find(e=>e.row.id==='a').exiting,false);assert.equal(entries.length,3);
  assert.equal(widgetHeight(0,5),159);assert.equal(widgetHeight(3,5),217);assert.equal(widgetHeight(100,5),275);
});

test('old default glass radius upgrades once while later explicit radius choices survive restart', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ass-widget-radius-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'preferences.json'),JSON.stringify({theme:'light',requestWidget:{radius:24,width:380,enabled:true}}));
  const prefs=new Preferences(root);assert.equal(prefs.state.requestWidget.radius,36);assert.equal(prefs.state.theme,'light');
  prefs.update({requestWidget:{radius:24}});assert.equal(new Preferences(root).state.requestWidget.radius,24);
});
