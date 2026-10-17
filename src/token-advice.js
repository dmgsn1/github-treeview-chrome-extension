// What to tell the operator about a token, from what GitHub said it can read.
// A token that works but reaches the wrong owner looks, in the panel, exactly
// like "nothing loads"; this names the likely reason instead.

/** "fine-grained" | "classic" | "other", from the token's prefix. */
export function tokenKind(token) {
  if (/^github_pat_/.test(token)) return "fine-grained";
  if (/^gh[pousr]_/.test(token)) return "classic";
  return "other";
}

/**
 * @param found { login, owners, repoCount, notes } from discoverOwners
 * @returns null when the token reaches beyond its own account, else a sentence
 */
export function tokenAdvice(token, found) {
  const kind = tokenKind(token);
  const others = found.owners.filter((o) => o.toLowerCase() !== found.login.toLowerCase());
  if (found.repoCount === 0) {
    return kind === "fine-grained"
      ? "It cannot read any repository it could find. If its Resource owner is an organisation, type that organisation under Owners to scan and save again; otherwise check its Repository access (All repositories) and that the organisation has approved it."
      : "It cannot read any repository. Check that it has the repo scope.";
  }
  if (others.length) return null;
  return kind === "fine-grained"
    ? `It only reaches ${found.login}'s own repositories. For an organisation's, make a fine-grained token with that organisation as its Resource owner (the organisation may have to approve it), or use a classic token.`
    : `It only reaches ${found.login}'s own repositories. If an organisation's are missing, it may need read:org, or SSO authorisation for that organisation (Configure SSO → Authorize).`;
}
