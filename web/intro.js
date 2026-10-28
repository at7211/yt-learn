// Pure helper for the 前情提要 card: turns the lesson's optional `intro` into display rows,
// or null when the data is missing or malformed (the player then shows no card).
export function introRows(intro) {
  if (!intro || typeof intro !== 'object' || typeof intro.title !== 'string' || !Array.isArray(intro.lines)) return null;
  const title = intro.title.split('\n').map((r) => r.trim()).filter(Boolean);
  const lines = intro.lines.filter((r) => typeof r === 'string').map((r) => r.trim()).filter(Boolean);
  if (!title.length) return null;
  return { title, lines };
}
