// Shared by the usage view and the desktop request widget. Routing IDs stay raw.
export function usageModelName(model) {
  if (typeof model !== 'string' || /[\x00-\x1f\x7f]/.test(model)) return '未标注';
  return model.trim().split(/::|\//).at(-1).trim().replace(/\[1m\]$/i, '').trim() || '未标注';
}
