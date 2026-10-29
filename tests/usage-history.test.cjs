const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  parser,
  normalized,
  readJsonl,
  readOpenCode,
  readDsh,
  scan,
  dayKey,
} = require("../core/usage-readers.cjs");
const { Preferences } = require("../core/preferences.cjs");
const { UsageHistory } = require("../core/usage-history.cjs");
const temp = (t) => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "ass-usage-"));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
};
const write = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
};
const when = "2026-09-22T12:00:00.000Z";
test('duplicate message copies always prefer newer usage regardless of file order, including cached rescans',async t=>{
  const home=temp(t),options={home,env:{},dataDir:home,now:Date.parse(when)};
  const files=['a','z'].map(n=>path.join(home,'.claude/projects/project',n+'.jsonl'));
  const row=(time,output)=>({type:'assistant',sessionId:'session',timestamp:time,message:{id:'same',model:'m',usage:{input_tokens:10,output_tokens:output}}});
  for(const sameTimestamp of [false,true])for(const reverse of [false,true]){
    // A newer corrected total can even be lower; copying files in a different
    // directory order must not change which revision is used.
    const output=sameTimestamp?1:30,old=sameTimestamp?30:1;
    write(files[0],JSON.stringify(row(reverse?(sameTimestamp?when:'2026-09-22T11:00:00Z'):when,reverse?old:output))+'\n');write(files[1],JSON.stringify(row(reverse?when:(sameTimestamp?when:'2026-09-22T11:00:00Z'),reverse?output:old))+'\n');
    for(let i=0;i<2;i++){const date=new Date(i===Number(reverse)?'2026-09-22T13:00:00Z':'2026-09-22T11:00:00Z');fs.utimesSync(files[i],date,date);}
    const first=await scan(options);assert.equal(first.snapshot.rows.filter(r=>r.client==='claude').reduce((n,r)=>n+r.output,0),output);
    assert.deepEqual((await scan(options,first.cache)).snapshot,first.snapshot);
  }
});
const total = (i, o, c = 0, r = 0) => ({
  input_tokens: i,
  output_tokens: o,
  cached_input_tokens: c,
  reasoning_output_tokens: r,
});
const token = (time, u, last = u) => ({
  timestamp: time,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: u, last_token_usage: last },
  },
});
test("normalization includes cache once and reasoning stays a subset of output", () => {
  assert.deepEqual(normalized(100, 30, 50, 10, 20), {
    input: 160,
    output: 30,
    cacheRead: 50,
    cacheWrite: 10,
    reasoning: 20,
  });
  assert.equal(normalized(160, 30, 50, 10, 20, true).input, 160);
  assert.deepEqual(normalized(-1, NaN, Infinity, null, 4), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  });
});
test("Codex repeated cumulative reports, seed total, delta and reset are not summed blindly", () => {
  const p = parser("codex", "f");
  p.accept({
    type: "session_meta",
    payload: {
      id: "s",
      timestamp: "2026-09-22T11:00:00Z",
      model_provider: "openai",
    },
  });
  p.accept({ type: "turn_context", payload: { model: "model-a" } });
  p.accept(token(when, total(1000, 100, 400, 20), total(100, 10, 40, 2)));
  p.accept(token(when, total(1000, 100, 400, 20), total(100, 10, 40, 2)));
  p.accept(token("2026-09-22T12:01:00Z", total(1200, 130, 500, 24)));
  p.accept({ type: "turn_context", payload: { model: "model-b" } });
  p.accept(token("2026-09-22T12:02:00Z", total(20, 5, 0, 0)));
  const rows = [...p.rows.values()];
  assert.equal(rows.length, 3);
  assert.equal(
    rows.reduce((a, r) => a + r.input + r.output, 0),
    365,
  );
  assert.equal(rows[2].model, "model-b");
  assert.equal(rows[0].hour, new Date(when).getHours());
  assert.ok(!JSON.stringify(rows).includes("timestamp"));
});
test("Claude streaming revisions replace one message; pi uses non-overlapping cache counters", () => {
  const c = parser("claude", "s");
  const x = {
    type: "assistant",
    timestamp: when,
    sessionId: "s",
    message: {
      id: "m",
      model: "claude",
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 5,
      },
    },
  };
  c.accept(x);
  c.accept({
    ...x,
    message: { ...x.message, usage: { ...x.message.usage, output_tokens: 20 } },
  });
  assert.equal(c.rows.size, 1);
  assert.equal([...c.rows.values()][0].input, 65);
  assert.equal([...c.rows.values()][0].hour, new Date(when).getHours());
  const p = parser("pi", "s");
  p.accept({
    type: "message",
    id: "m",
    timestamp: when,
    message: {
      role: "assistant",
      provider: "p",
      model: "m",
      usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 2 },
    },
  });
  assert.equal([...p.rows.values()][0].input, 17);
  assert.equal([...p.rows.values()][0].hour, new Date(when).getHours());
});
test("partial JSONL append is tolerated; prompts and tool content are not returned", async (t) => {
  const file = path.join(temp(t), "one.jsonl");
  write(
    file,
    JSON.stringify({
      type: "response_item",
      payload: { text: "private prompt" },
    }) +
      "\n" +
      JSON.stringify(token(when, total(12, 3))) +
      '\n{"unfinished":',
  );
  const x = await readJsonl(file, "codex", "f");
  assert.equal(x.rows.length, 1);
  assert.equal(x.malformed, 0);
  assert.ok(!JSON.stringify(x).includes("private"));
});
test("absent numeric usage is not converted to a measured zero", () => {
  const p = parser("codex", "s");
  p.accept(token(when, {}));
  assert.equal(p.rows.size, 0);
  const c = parser("claude", "s");
  c.accept({
    type: "assistant",
    timestamp: when,
    message: { id: "m", usage: { input_tokens: null, output_tokens: null } },
  });
  assert.equal(c.rows.size, 0);
});
test("OpenCode reads only assistant totals, adds separate reasoning and excludes fork seed messages", (t) => {
  const file = path.join(temp(t), "opencode.db"),
    { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE session(id TEXT,time_created INTEGER);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);",
  );
  const time = Date.parse(when);
  db.prepare("INSERT INTO session VALUES (?,?)").run("s", time - 100);
  db.prepare("INSERT INTO session VALUES (?,?)").run("fork", time + 100);
  const data = JSON.stringify({
    role: "assistant",
    time: { created: time },
    modelID: "m",
    providerID: "p",
    tokens: {
      input: 10,
      output: 5,
      reasoning: 20,
      cache: { read: 100, write: 3 },
    },
    text: "must not return",
  });
  for (const id of ["s", "fork"])
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(id, id, time, data);
  db.close();
  const before = fs.readFileSync(file),
    x = readOpenCode(file);
  assert.equal(x.rows.length, 1);
  assert.equal(x.rows[0].input, 113);
  assert.equal(x.rows[0].output, 25);
  assert.equal(x.rows[0].reasoning, 20);
  assert.equal(x.rows[0].hour, new Date(when).getHours());
  assert.deepEqual(before, fs.readFileSync(file));
  assert.ok(!JSON.stringify(x).includes("must not return"));
});
test("DSH ledger uses model buckets, never adds day totals or session totals again", (t) => {
  const file = path.join(temp(t), "ledger.json");
  const u = {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 5,
    reasoning: 10,
    calls: 2,
  };
  write(file, {
    version: 1,
    days: {
      "2026-09-22": {
        ...u,
        byProviderModel: { "provider:model": u },
        sessions: [
          {
            id: "s",
            ...u,
            byProviderModel: { "provider:model": u },
            title: "private title",
          },
        ],
      },
    },
  });
  const x = readDsh(file);
  assert.equal(x.rows.length, 1);
  assert.equal(x.rows[0].input, 45);
  assert.equal(x.rows[0].calls, 2);
  assert.equal(x.rows[0].hour, null);
  assert.ok(!JSON.stringify(x).includes("private title"));
});
test("scan finds native, custom and managed homes, deduplicates copies, caches and never mutates sources", async (t) => {
  const home = temp(t),
    file = path.join(home, ".codex/sessions/a.jsonl");
  const meta = {
    type: "session_meta",
    payload: { id: "s", timestamp: "2026-09-22T10:00:00Z" },
  };
  const bytes =
    JSON.stringify(meta) +
    "\n" +
    JSON.stringify(token(when, total(10, 2))) +
    "\n";
  write(file, bytes);
  write(path.join(home, ".codex/archived_sessions/a.jsonl"), bytes);
  const options = { home, env: {}, dataDir: home, now: Date.parse(when) };
  const a = await scan(options),
    b = await scan(options, a.cache);
  assert.equal(a.snapshot.rows.length, 1);
  assert.equal(a.snapshot.rows[0].input, 10);
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.ok(!JSON.stringify(a.snapshot).includes(home));
  assert.equal(
    a.snapshot.sources.find((s) => s.client === "pi").status,
    "empty",
  );
});
test("date and grouping filters reconcile and distinct sessions are not added across groups", async () => {
  const { summarize } = await import("../src/usage-view.mjs");
  const now = new Date(2026, 8, 22, 12),
    rows = [
      {
        day: "2026-09-22",
        client: "codex",
        model: "a",
        input: 10,
        output: 3,
        calls: 1,
        sessions: ["s"],
      },
      {
        day: "2026-09-22",
        client: "codex",
        model: "b",
        input: 20,
        output: 6,
        calls: 1,
        sessions: ["s"],
      },
      {
        day: "2026-08-22",
        client: "opencode",
        model: "a",
        input: 30,
        output: 9,
        calls: 1,
        sessions: ["t"],
      },
    ];
  const all = summarize(
    rows,
    { range: "year", client: "all", group: "client" },
    now,
  );
  assert.equal(all.total.input + all.total.output, 78);
  assert.equal(all.total.sessions.size, 2);
  assert.equal(
    all.groups.reduce((a, g) => a + g.input + g.output, 0),
    78,
  );
  const month = summarize(
    rows,
    { range: "month", client: "all", group: "model" },
    now,
  );
  assert.equal(month.total.input, 30);
  assert.equal(month.total.sessions.size, 1);
  const empty = summarize(
    rows,
    { range: "week", client: "pi", group: "model" },
    now,
  );
  assert.equal(empty.total.observations, 0);
  assert.equal(empty.timeline.length, 24 + 13);
});
test("scan preserves distinct local hours and invalidates old or other-zone caches", async (t) => {
  const home = temp(t),
    file = path.join(home, ".codex/sessions/hourly.jsonl");
  const a = new Date(2026, 8, 22, 1),
    b = new Date(2026, 8, 22, 2);
  write(
    file,
    [token(a.toISOString(), total(10, 2)), token(b.toISOString(), total(30, 7))]
      .map(JSON.stringify)
      .join("\n"),
  );
  const options = {
    home,
    env: {},
    dataDir: home,
    now: new Date(2026, 8, 22, 12).getTime(),
  };
  const first = await scan(options);
  assert.deepEqual(
    first.snapshot.rows.map((r) => r.hour),
    [1, 2],
  );
  assert.equal(
    first.snapshot.rows.reduce((n, r) => n + r.input + r.output, 0),
    37,
  );
  for (const signature of ["old-daily-cache", "2:Different/Timezone:cache"]) {
    const cache = structuredClone(first.cache);
    for (const entry of Object.values(cache)) {
      entry.signature = signature;
      entry.rows[0].input = 999999;
    }
    assert.deepEqual((await scan(options, cache)).snapshot, first.snapshot);
  }
});
test("weekly hours plus daily-only records reconcile without fabricating midnight activity", async () => {
  const { summarize } = await import("../src/usage-view.mjs");
  const rows = [
    {
      day: "2026-09-21",
      hour: 1,
      client: "codex",
      model: "a",
      input: 100,
      output: 20,
      cacheRead: 40,
      calls: 1,
      sessions: ["s"],
    },
    {
      day: "2026-09-21",
      hour: 2,
      client: "codex",
      model: "a",
      input: 200,
      output: 40,
      calls: 1,
      sessions: ["s"],
    },
    {
      day: "2026-09-21",
      hour: 2,
      client: "pi",
      model: "b",
      input: 10,
      output: 5,
      calls: 1,
      sessions: ["p"],
    },
    {
      day: "2026-09-22",
      hour: null,
      client: "dsh",
      model: "c",
      input: 300,
      output: 60,
      calls: 4,
      sessions: ["d"],
    },
  ];
  for (const group of ["model", "client"]) {
    const s = summarize(
      rows,
      { range: "week", client: "all", group },
      new Date(2026, 8, 22, 12),
    );
    const tokens = (r) => r.input + r.output;
    assert.equal(s.grain, "hour");
    assert.equal(s.timeline.length, 37);
    assert.equal(
      s.timeline.reduce((n, r) => n + tokens(r), 0),
      375,
    );
    assert.equal(tokens(s.unallocated), 360);
    assert.equal(tokens(s.total), 735);
    assert.equal(
      s.groups.reduce((n, r) => n + tokens(r), 0),
      735,
    );
    assert.equal(s.total.sessions.size, 3);
    assert.equal(s.timeline[2].sessions.size, 2);
    assert.equal(s.timeline[24].observations, 0);
    assert.equal(s.dailyOnly[0].day, "2026-09-22");
    assert.equal(s.timeline.at(-1).label, "2026-09-22 12:00–13:00");
    assert.deepEqual(s.timeline.filter(d => d.current).map(d => d.key), ["2026-09-22T12"]);
    assert.ok(!s.timeline.some((d) => d.hour > 12 && d.day === "2026-09-22"));
  }
  const dsh = summarize(
    rows,
    { range: "week", client: "dsh", group: "model" },
    new Date(2026, 8, 22, 12),
  );
  assert.equal(
    dsh.timeline.reduce((n, r) => n + r.calls, 0),
    0,
  );
  assert.equal(dsh.unallocated.calls, 4);
});
test("monthly four-hour buckets and unchanged yearly days retain exact totals, including leap and cross-year dates", async () => {
  const { summarize, dayKey: key } = await import("../src/usage-view.mjs");
  const now = new Date(2028, 1, 29, 23),
    rows = [];
  for (let i = 0; i < 366; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    for (const hour of [0, 12])
      rows.push({
        day: key(date),
        hour,
        client: "pi",
        model: "a",
        input: 10,
        output: 2,
        calls: 1,
        sessions: ["s"],
      });
  }
  const year = summarize(
    rows,
    { range: "year", client: "all", group: "client" },
    now,
  );
  assert.equal(year.grain, "day");
  assert.equal(year.timeline.length, 365);
  assert.equal(year.timeline[0].day, "2027-03-02");
  assert.equal(year.timeline.at(-1).day, "2028-02-29");
  assert.ok(year.timeline.every((d) => d.input === 20 && d.output === 4));
  assert.equal(year.total.input + year.total.output, 365 * 24);
  assert.equal(year.unallocated.observations, 0);
  const month = summarize(
    rows,
    { range: "month", client: "all", group: "model" },
    now,
  );
  assert.equal(month.timeline.length, 29 * 6);
  assert.equal(month.periodHours, 4);
  assert.equal(
    month.timeline.reduce((n, r) => n + r.input + r.output, 0),
    29 * 24,
  );
  assert.equal(month.total.sessions.size, 1);
});
test("four-hour boundaries merge 00-03, 04-07 and so on, with daily-only totals separate", async () => {
  const { summarize } = await import("../src/usage-view.mjs");
  const rows = [0, 3, 4, 7, 8, 23].map((hour) => ({
    day: "2026-09-01",
    hour,
    client: "pi",
    model: "a",
    input: 10,
    output: 2,
    calls: 1,
  }));
  rows.push({
    day: "2026-09-01",
    hour: null,
    client: "dsh",
    model: "b",
    input: 100,
    output: 20,
    calls: 4,
  });
  const s = summarize(
    rows,
    { range: "month", client: "all", group: "model" },
    new Date(2026, 8, 2, 9),
  );
  assert.equal(s.timeline.length, 9);
  assert.deepEqual(
    s.timeline.slice(0, 6).map((r) => r.calls),
    [2, 2, 1, 0, 0, 1],
  );
  assert.equal(s.timeline[0].label, "2026-09-01 00:00–04:00");
  assert.equal(s.timeline[5].label, "2026-09-01 20:00–24:00");
  assert.equal(s.timeline.at(-1).label, "2026-09-02 08:00–12:00");
  assert.equal(s.total.input + s.total.output, 192);
  assert.equal(
    s.timeline.reduce((n, r) => n + r.input + r.output, 0),
    72,
  );
  assert.equal(s.unallocated.input + s.unallocated.output, 120);
  assert.equal(
    s.groups.reduce((n, r) => n + r.input + r.output, 0),
    192,
  );
});
test("week starts Monday across year boundary; current hour is partial and future hours are excluded", async () => {
  const { summarize } = await import("../src/usage-view.mjs");
  const row = (day, hour) => ({
    day,
    hour,
    client: "pi",
    model: "a",
    input: 1,
    output: 1,
    calls: 1,
  });
  const s = summarize(
    [row("2028-12-31", 23), row("2029-01-01", 0), row("2029-01-01", 10)],
    { range: "week", client: "all", group: "client" },
    new Date(2029, 0, 1, 9),
  );
  assert.equal(s.from, "2029-01-01");
  assert.equal(s.timeline.length, 10);
  assert.equal(s.total.calls, 1);
  assert.equal(s.timeline.at(-1).key, "2029-01-01T09");
});
test("date-only records have no fabricated hour", () => {
  const p = parser("codex", "f");
  p.accept(token("2026-09-22", total(10, 2)));
  assert.equal([...p.rows.values()][0].hour, null);
});
test("v1 daily cache rebuilds automatically; v2 preserves hourly metadata across restart", async (t) => {
  const home = temp(t),
    time = new Date(2026, 8, 22, 9).toISOString();
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (bytes) => bytes.toString(),
  };
  const file = path.join(home, "usage-history.enc.json");
  const legacy = {
    version: 1,
    cache: {},
    snapshot: {
      rows: [{ day: "2026-09-22", input: 99999 }],
      updatedAt: new Date().toISOString(),
    },
  };
  write(file, {
    encrypted: crypto.encryptString(JSON.stringify(legacy)).toString("base64"),
  });
  write(
    path.join(home, ".codex/sessions/fixture.jsonl"),
    JSON.stringify(token(time, total(10, 2))),
  );
  const options = {
    dataDir: home,
    crypto,
    getOptions: () => ({ home, env: {}, dataDir: home, now: Date.parse(time) }),
  };
  const history = new UsageHistory(options);
  assert.equal(history.public().rows.length, 0);
  await history.refresh({ automatic: true });
  assert.equal(history.public().rows[0].hour, 9);
  assert.equal(history.public().rows[0].input, 10);
  const saved = JSON.parse(
    crypto.decryptString(
      Buffer.from(
        JSON.parse(fs.readFileSync(file, "utf8")).encrypted,
        "base64",
      ),
    ),
  );
  assert.equal(saved.version, 2);
  assert.deepEqual(new UsageHistory(options).public(), history.public());
});
test("account overview reuses real quotas, does not sum percentages or duplicate bound API balances", async () => {
  const { overviewAccounts } = await import("../src/usage-view.mjs");
  const api = {
    kind: "api",
    id: "api:p",
    providerId: "p",
    ready: true,
    label: "API",
    profile: { fields: [{ id: "remaining", value: 10, unit: "USD" }] },
  };
  const oauth = {
    kind: "native",
    id: "n",
    ready: true,
    label: "OpenAI",
    profile: { fields: [] },
    quota: {
      fields: [{ id: "weekly", kind: "quota", remainingPercent: 42 }],
      updatedAt: when,
    },
  };
  const state = {
    harnesses: {
      clients: [
        { id: "codex", name: "Codex", detected: true, accounts: [oauth, api] },
        { id: "pi", name: "pi", detected: true, accounts: [api] },
        { id: "dsh", name: "DeepSeek Harness", detected: false, accounts: [api] },
      ],
    },
  };
  const rows = overviewAccounts(state, "all");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].clients, ["Codex", "pi"]);
  assert.equal(rows[0].quotas[0].remainingPercent, 42);
  assert.equal(overviewAccounts(state, "pi").length, 1);
  assert.equal(overviewAccounts(state, "dsh").length, 0);
});
test("overview selections persist and invalid view state is ignored", (t) => {
  const d = temp(t),
    p = new Preferences(d);
  p.update({
    usage: { client: "pi", range: "year", tab: "tokens", group: "model" },
  });
  p.update({ usage: { range: "bad", secret: "discard" } });
  assert.deepEqual(new Preferences(d).state.usage, {
    client: "pi",
    range: "year",
    tab: "tokens",
    group: "model",
  });
});
