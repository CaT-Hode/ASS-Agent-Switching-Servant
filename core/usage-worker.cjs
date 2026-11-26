const { parentPort, workerData } = require("node:worker_threads");
const { isDeepStrictEqual: equal } = require("node:util");
const { scan } = require("./usage-readers.cjs");
const { selectUsage } = require("./usage-drilldown.cjs");

const content = snapshot => {
  if (!snapshot) return null;
  const { updatedAt, ...usage } = snapshot;
  return usage;
};
let previous = workerData || {};
let records;
parentPort.on("message", async ({ options, saveFailed, selection, port }) => {
  if (port) {
    try {
      if (!records) throw Error("用量明细尚未读取，请刷新本地用量");
      port.postMessage({ result: await selectUsage(records, selection) });
    } catch (error) {
      port.postMessage({ error: error.message });
    } finally {
      port.close();
    }
    return;
  }
  try {
    const result = await scan(options, previous.cache, previous.locations, (value) => { records = value; });
    const changed = saveFailed || !equal(result.cache, previous.cache) ||
      !equal(result.locations, previous.locations) || !equal(content(result.snapshot), content(previous.snapshot));
    const payload = changed ? JSON.stringify({ version: 2, ...result }) : undefined;
    previous = result;
    parentPort.postMessage({ snapshot: result.snapshot, payload });
  } catch {
    parentPort.postMessage(null);
  }
});
