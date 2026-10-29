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
  assert.deepEqual(heat.cells.filter(cell=>cell.current).map(cell=>cell.hour),[12]);
  assert.deepEqual(todayHeatmap(usage,[],start+3600000).cells.filter(cell=>cell.current).map(cell=>cell.hour),[13]);
});
test('widget settings survive reload and leave theme and other preferences intact', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ass-widget-prefs-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const prefs=new Preferences(directory);prefs.update({theme:'light',requestWidget:{enabled:true,width:560,radius:36,rows:3,x:-900,y:50,bottom:247}});
  assert.equal(new Preferences(directory).state.requestWidget.x,-900);
  assert.equal(new Preferences(directory).state.requestWidget.bottom,247);
  prefs.update({requestWidget:{enabled:false,width:NaN,radius:200,rows:99}});
  assert.equal(prefs.state.requestWidget.width,560);assert.equal(prefs.state.requestWidget.radius,36);
  assert.equal(prefs.state.requestWidget.enabled,false);assert.equal(prefs.state.theme,'light');
});

test('widget elapsed time is independent integer seconds without switching to minutes', async () => {
  const { widgetDuration }=await import('../core/request-widget-view.mjs');
  assert.deepEqual([0,999,1000,1999,61000,3600123,null,NaN,-1].map(widgetDuration),
    ['0s','0s','1s','1s','61s','3600s','—','—','—']);
});

test('motion keeps departing rows in their slots, updates live values without replacing IDs, and accepts rapid replacement', async () => {
  const { motionRows, widgetHeight, widgetWidth } = await import('../core/request-widget-view.mjs');
  let entries = motionRows([], [{ id:'a', tps:1 }, { id:'b', tps:2 }]);
  entries = motionRows(entries, [{ id:'a', tps:50 }, { id:'b', tps:2 }]);
  assert.deepEqual(entries.map(e=>e.row.id), ['a','b']);assert.equal(entries[0].row.tps,50);
  entries = motionRows(entries, [{ id:'b', tps:3 }, { id:'c', tps:4 }]);
  assert.equal(entries.find(e=>e.row.id==='a').exiting,true);assert.equal(entries.find(e=>e.row.id==='a').index,0);
  assert.equal(entries.find(e=>e.row.id==='b').index,0);assert.equal(entries.find(e=>e.row.id==='c').index,1);
  entries = motionRows(entries, [{ id:'a', tps:5 }]);
  assert.equal(entries.find(e=>e.row.id==='a').exiting,false);assert.equal(entries.length,3);
  // Compact margins remove 16px horizontally and 20px vertically; rows stay 29px.
  assert.equal(widgetWidth(380),364);
  assert.equal(widgetHeight(0,5),139);assert.equal(widgetHeight(3,5),197);assert.equal(widgetHeight(100,5),255);
});

test('old default glass radius upgrades once while later explicit radius choices survive restart', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ass-widget-radius-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'preferences.json'),JSON.stringify({theme:'light',requestWidget:{radius:24,width:380,enabled:true}}));
  const prefs=new Preferences(root);assert.equal(prefs.state.requestWidget.radius,36);assert.equal(prefs.state.theme,'light');
  prefs.update({requestWidget:{radius:24}});assert.equal(new Preferences(root).state.requestWidget.radius,24);
});

test('quiet widget frames stop IPC and native layout work while active metrics and retirement stay live', async t => {
  const { EventEmitter } = require('node:events'), { RequestWidget } = require('../core/request-widget.cjs');
  const model = await import('../core/request-widget-view.mjs');
  let now = start, scans = 0, layouts = 0, presented = 0;
  t.mock.method(Date, 'now', () => now);
  const history = { rows: [], revision: 0 }, usage = { rows: [], updatedAt: new Date(start).toISOString() };
  let active = [];
  const sent = [], widget = new RequestWidget({
    electron: { ipcMain: { handle() {}, on() {} }, powerMonitor: new EventEmitter(), nativeTheme: { shouldUseDarkColors: true } },
    preferences: { state: { requestWidget: { radius: 36, rows: 5 } } }, model,
    read: () => ({ active, history, usage }), refreshUsage: () => { scans++; },
  });
  widget.window = { webContents: { isLoading: () => false, send: (name, frame) => sent.push(frame) } };
  widget.glass = { options: () => { layouts++; }, stats: () => ({ presented: ++presented, gpuMs: presented / 10, error: 0, readbackBytes: 64, luminance: .2 }) };
  for (let i = 0; i < 100; i++) { now = start + i * 100;history.revision++;widget.tick(); }
  assert.equal(sent.length, 1, 'unchanged visible data does not repaint for changing native stats');
  assert.equal(scans, 1, 'frequent request revisions do not rescan native usage files');
  assert.equal(layouts, 0, 'metric ticks do not resend native size targets');
  for (let i = 0; i < 10; i++) {
    now += 100;active = [{ ...row('live', 0), ms: i * 100, tps: i + 1 }];widget.tick();
  }
  assert.equal(sent.length, 11);assert.equal(sent.at(-1).rows[0].tps, 10);
  active = [];history.rows = [{ ...row('live', 0, false), time: new Date(now).toISOString() }];history.revision++;
  widget.tick();assert.equal(sent.at(-1).rows[0].inProgress, false);
  now += 15000;widget.tick();assert.equal(sent.at(-1).rows.length, 0);
  now = start + 60000;widget.tick();assert.equal(scans, 2);
  assert.equal(sent.at(-1).glass, true);
});

test('widget data uses a one-second clock independent of native rendering', async t => {
  const { EventEmitter }=require('node:events'),{ RequestWidget }=require('../core/request-widget.cjs');
  const model=await import('../core/request-widget-view.mjs');let reads=0;
  t.mock.timers.enable({apis:['setInterval']});
  class Window extends EventEmitter {
    constructor(){super();this.webContents={setWindowOpenHandler(){},on(){},isLoading:()=>false,send(){}};}
    setAlwaysOnTop(){}setVisibleOnAllWorkspaces(){}loadFile(){}
    destroy(){this.emit('closed');}
  }
  const area={x:0,y:0,width:1920,height:1080};
  const widget=new RequestWidget({electron:{BrowserWindow:Window,ipcMain:{handle(){},on(){}},powerMonitor:new EventEmitter(),
    nativeTheme:{shouldUseDarkColors:true},screen:{getPrimaryDisplay:()=>({workArea:area}),getDisplayNearestPoint:()=>({workArea:area})}},
    preferences:{state:{requestWidget:{width:380,rows:5,radius:36}}},model,refreshUsage(){},
    read:()=>{reads++;return{active:[],history:{rows:[],revision:0},usage:{rows:[],updatedAt:null}};}});
  widget.open();const initial=reads;
  t.mock.timers.tick(999);assert.equal(reads,initial);
  t.mock.timers.tick(1);assert.equal(reads,initial+1);
  t.mock.timers.tick(1000);assert.equal(reads,initial+2);
  widget.close();t.mock.timers.tick(1000);assert.equal(reads,initial+2);
});

test('drag defers content and position writes, then release sends the latest frame once', async t => {
  const { EventEmitter }=require('node:events'),{ RequestWidget }=require('../core/request-widget.cjs');
  const model=await import('../core/request-widget-view.mjs'),handlers=new Map(),sent=[],saved=[];
  let dragging=false,reads=0,now=start;t.mock.method(Date,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});
  const settings={width:380,rows:5,radius:36};
  const widget=new RequestWidget({electron:{ipcMain:{handle(){},on:(name,fn)=>handlers.set(name,fn)},
    powerMonitor:new EventEmitter(),nativeTheme:{shouldUseDarkColors:true}},
    preferences:{state:{requestWidget:settings},update:value=>saved.push(value)},model,refreshUsage(){},
    read:()=>{reads++;return{active:[{...row('live',0),ms:now-start}],history:{rows:[],revision:0},usage:{rows:[],updatedAt:null}};}});
  const webContents={isLoading:()=>false,send:(_name,value)=>sent.push(value)};
  widget.window={webContents,isDestroyed:()=>false,getPosition:()=>[10,20],getContentSize:()=>[364,255]};
  widget.glass={stats:()=>({presented:1,dragging:dragging?1:0}),endDrag:()=>{dragging=false}};
  widget.tick();assert.equal(sent.length,1);
  dragging=true;widget.positionDirty=true;
  for(let i=0;i<100;i++){now+=100;widget.tick();widget.savePosition();}
  assert.equal(reads,1);assert.equal(sent.length,1);assert.equal(saved.length,0);
  handlers.get('ass-widget:drag-end')({sender:webContents});
  assert.equal(reads,2);assert.equal(sent.length,2);assert.equal(sent[1].rows[0].ms,10000);
  assert.equal(saved.length,0,'the release frame is sent before the deferred preference write');
  t.mock.timers.tick(200);assert.deepEqual(saved,[{requestWidget:{x:10,y:20,bottom:275}}]);
  widget.tick();assert.equal(saved.length,1);assert.equal(sent.length,2);
});
