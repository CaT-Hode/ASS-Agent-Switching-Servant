const COMPACTION_PERCENT = 90;

function compactTokenLimit(contextWindow) {
  return Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? Math.floor(contextWindow * COMPACTION_PERCENT / 100)
    : undefined;
}

module.exports = { compactTokenLimit };
