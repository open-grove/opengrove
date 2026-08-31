import assert from "node:assert/strict";
import { repositoryHygieneFailures } from "./repository-hygiene-core.mjs";

const failures = repositoryHygieneFailures([
  { path: "web/src/review/rooms.tsx", contents: "export const review = true;" },
  { path: "web/review/rooms.css", contents: ".review {}" },
  { path: "web/src/main.tsx", contents: 'const path = "/ui/review/rooms";' },
  { path: "web/src/fixture.tsx", contents: ["", "Users", "alice", "Projects", "OpenGrove"].join("/") },
  { path: "docs/example.md", contents: ["C:", "Users", "alice", "Projects", "OpenGrove"].join("\\") },
]);

assert.equal(failures.length, 5, "every task-review and personal-path fixture must be rejected");
assert.ok(failures.some((failure) => failure.includes("web/src/review/rooms.tsx")));
assert.ok(failures.some((failure) => failure.includes("web/review/rooms.css")));
assert.ok(failures.some((failure) => failure.includes("review routes")));
assert.ok(failures.some((failure) => failure.includes('macOS home path contains personal user name "alice"')));
assert.ok(failures.some((failure) => failure.includes('Windows home path contains personal user name "alice"')));

assert.deepEqual(
  repositoryHygieneFailures([
    { path: "web/src/main.tsx", contents: "export const product = true;" },
    { path: "docs/example.md", contents: "/Users/example/Projects/OpenGrove" },
    { path: "src/tests/example.ts", contents: String.raw`C:\Users\builder\src` },
  ]),
  [],
  "anonymous documentation and test fixture paths must remain allowed",
);

console.log("repository hygiene contract harness ok");
