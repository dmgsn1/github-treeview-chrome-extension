// The two comment markers the panel reads (README, "Conventions"): a held PR's
// **Held:** / **Safe to lift:** comment, and a blocked:operator issue's
// **Needs:** comment.

const ordered = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const latestFirst = (comments) => [...(comments || [])].sort((a, b) => ordered(a.createdAt || "", b.createdAt || "")).reverse();

/**
 * The hold comment that counts: the latest comment with a `**Held:**` line,
 * with its `**Safe to lift:**` line and when it was written.
 * @returns { held, safe, at } or null
 */
export function holdComment(comments) {
  for (const c of latestFirst(comments)) {
    const body = String(c.body || "");
    const m = body.match(/\*\*Held:\*\*\s*(.+)/);
    if (m) {
      const safe = body.match(/\*\*Safe to lift:\*\*\s*(.+)/);
      return { held: m[1].trim(), safe: safe ? safe[1].trim() : null, at: c.createdAt || null };
    }
  }
  return null;
}

/**
 * What a blocked:operator issue asks of the operator: the text after the
 * latest comment's `**Needs:**`, or the next non-empty line when the marker
 * stands alone. Null when no comment has one.
 */
export function needsLine(comments) {
  for (const c of latestFirst(comments)) {
    const lines = String(c.body || "").split(/\r?\n/);
    const at = lines.findIndex((l) => /^\s*\*\*Needs:\*\*/.test(l));
    if (at < 0) continue;
    const rest = lines[at].replace(/^\s*\*\*Needs:\*\*\s*/, "").trim();
    return rest || lines.slice(at + 1).find((l) => l.trim())?.trim() || null;
  }
  return null;
}
