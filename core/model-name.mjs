// Shared by the usage view, request monitor, and desktop request widget. Routing IDs stay raw.
const ASS_AGY_PREFIX = /^ass-[a-f0-9]{14}-/i;
const GEMINI_MODEL = /^gemini(?:[-_.\s]|$)/i;
const PAREN_EFFORT = /\s*\((?:minimal|low|medium|high|xhigh|extra(?:[\s_-]*high)?|max)\)$/i;
const STRICT_EFFORT_SUFFIX = /[-_:](?:minimal|low|medium|high|xhigh|extra[-_]?high)$/i;
const MAX_EFFORT_SUFFIX = /[-_:]max$/i;
const PRESERVED_MAX_MODEL = /(?:^|[-_.])(?:qwen[\d.]*|codex|mini|claude-[\d.]+)-max$/i;
const GEMINI_TIER_SUFFIX = /[-_]tiered$/i;

function stripGeminiVariants(name) {
  let current = name;
  for (let i = 0; i < 4; i++) {
    const next = current
      .replace(PAREN_EFFORT, '')
      .replace(STRICT_EFFORT_SUFFIX, '')
      .replace(MAX_EFFORT_SUFFIX, '')
      .replace(GEMINI_TIER_SUFFIX, '')
      .trim();
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function stripAntigravityEffort(name) {
  let current = name.replace(PAREN_EFFORT, '').trim();
  if (STRICT_EFFORT_SUFFIX.test(current)) {
    const next = current.replace(STRICT_EFFORT_SUFFIX, '').trim();
    if (next) current = next;
  } else if (MAX_EFFORT_SUFFIX.test(current) && !PRESERVED_MAX_MODEL.test(current)) {
    const next = current.replace(MAX_EFFORT_SUFFIX, '').trim();
    if (next) current = next;
  }
  return current;
}

export function usageModelName(model, client) {
  if (typeof model !== 'string' || /[\x00-\x1f\x7f]/.test(model)) return '未标注';
  let name = model.trim().split(/::|\//).at(-1).trim().replace(/\[1m\]$/i, '').trim();
  if (!name) return '未标注';
  const isAssAgy = ASS_AGY_PREFIX.test(name);
  if (isAssAgy) {
    name = name.replace(ASS_AGY_PREFIX, '').trim();
    if (!name) return '未标注';
  }
  if (GEMINI_MODEL.test(name)) {
    name = stripGeminiVariants(name);
  } else if (isAssAgy || client === 'antigravity') {
    name = stripAntigravityEffort(name);
  }
  return name || '未标注';
}
