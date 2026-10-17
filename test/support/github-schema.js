// GitHub's public GraphQL schema (@octokit/graphql-schema), for checking that
// every query the extension sends is one GitHub would accept. A fake GitHub
// answers anything; this is what keeps the fakes honest about the real one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchema, parse, validate } from "graphql";

// The package exports no path to its .graphql file, so read it from node_modules.
const file = fileURLToPath(new URL("../../node_modules/@octokit/graphql-schema/schema.graphql", import.meta.url));
// assumeValidSDL: the published SDL repeats two Enterprise fields, which is not ours to fix.
const schema = buildSchema(readFileSync(file, "utf8"), { assumeValidSDL: true });

/** Throws with GitHub-style messages when `query` is not valid against the schema. */
export function assertValidQuery(query) {
  const errors = validate(schema, parse(query));
  if (errors.length) throw new Error(`invalid GraphQL for GitHub's schema:\n  ${errors.map((e) => e.message).join("\n  ")}\n in: ${query.replace(/\s+/g, " ").slice(0, 300)}`);
}
