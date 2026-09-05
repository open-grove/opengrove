import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");

export function collectReleaseNotesContext({ from, to = "HEAD" }) {
  const resolvedTo = git(["rev-parse", "--verify", `${to}^{commit}`]);
  const resolvedFrom = from
    ? git(["rev-parse", "--verify", `${from}^{commit}`])
    : gitOptional(["describe", "--tags", "--abbrev=0", resolvedTo]);
  if (!resolvedFrom) {
    throw new Error("no previous release tag was found; pass --from <release-boundary-ref>");
  }
  git(["merge-base", "--is-ancestor", resolvedFrom, resolvedTo]);
  const range = `${resolvedFrom}..${resolvedTo}`;
  const commits = lines(git(["log", "--reverse", "--format=%H%x09%s", range])).map((line) => {
    const [sha, ...subject] = line.split("\t");
    return { sha, subject: subject.join("\t") };
  });
  const firstParent = lines(git(["log", "--first-parent", "--reverse", "--format=%H%x09%s", range])).map((line) => {
    const [sha, ...subject] = line.split("\t");
    return { sha, subject: subject.join("\t") };
  });
  const files = lines(git(["diff", "--name-status", resolvedFrom, resolvedTo]));
  const diffStat = git(["diff", "--stat", resolvedFrom, resolvedTo]);
  return { from: resolvedFrom, to: resolvedTo, range, firstParent, commits, files, diffStat };
}

function main(values) {
  const args = parseArgs(values);
  const context = collectReleaseNotesContext(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    return;
  }
  console.log(`# Release-note review context`);
  console.log(``);
  console.log(`Exact range: ${context.range}`);
  console.log(`First-parent changes: ${context.firstParent.length}`);
  console.log(`All commits: ${context.commits.length}`);
  console.log(`Changed paths: ${context.files.length}`);
  console.log(``);
  console.log(`## First-parent history`);
  for (const commit of context.firstParent) console.log(`- ${commit.sha.slice(0, 12)} ${commit.subject}`);
  console.log(``);
  console.log(`## Complete commit history`);
  for (const commit of context.commits) console.log(`- ${commit.sha.slice(0, 12)} ${commit.subject}`);
  console.log(``);
  console.log(`## Changed paths`);
  for (const file of context.files) console.log(`- ${file}`);
  console.log(``);
  console.log(`## Diff summary`);
  console.log(context.diffStat || "(no changes)");
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") result.json = true;
    else if (value === "--from") result.from = requiredValue(values, ++index, value);
    else if (value.startsWith("--from=")) result.from = value.slice("--from=".length);
    else if (value === "--to") result.to = requiredValue(values, ++index, value);
    else if (value.startsWith("--to=")) result.to = value.slice("--to=".length);
    else throw new Error(`unknown option: ${value}`);
  }
  return result;
}

function requiredValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a git ref`);
  return value;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function gitOptional(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function lines(value) {
  return value ? value.split("\n").filter(Boolean) : [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Release-note context failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
