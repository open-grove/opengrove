import { fileURLToPath } from "node:url";

export function checkCiResults(needs, expectations) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("CI job results must be an object");
  }

  const entries = Object.entries(needs);
  if (entries.length === 0) throw new Error("CI job results must contain at least one dependency");

  const expectedResults = expectations ?? Object.fromEntries(entries.map(([job]) => [job, "success"]));
  validateExpectations(needs, expectedResults);

  return entries.flatMap(([job, value]) => {
    const result = value && typeof value === "object" && typeof value.result === "string" ? value.result : "missing";
    const expected = expectedResults[job];
    return result === expected ? [] : [{ job, result, expected }];
  });
}

export function parseCiJobExpectations(raw) {
  if (!raw) return undefined;

  const expectations = {};
  for (const [index, sourceLine] of raw.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || separator === line.length - 1) {
      throw new Error(`Invalid CI job expectation on line ${index + 1}: ${sourceLine}`);
    }
    const job = line.slice(0, separator).trim();
    const result = line.slice(separator + 1).trim();
    if (Object.hasOwn(expectations, job)) throw new Error(`Duplicate CI job expectation: ${job}`);
    expectations[job] = result;
  }
  if (Object.keys(expectations).length === 0) throw new Error("CI_JOB_EXPECTATIONS must contain at least one job");
  return expectations;
}

function validateExpectations(needs, expectations) {
  if (!expectations || typeof expectations !== "object" || Array.isArray(expectations)) {
    throw new Error("CI job expectations must be an object");
  }

  for (const job of Object.keys(needs)) {
    if (!Object.hasOwn(expectations, job)) throw new Error(`CI job expectations are missing dependency: ${job}`);
  }
  for (const [job, expected] of Object.entries(expectations)) {
    if (!Object.hasOwn(needs, job)) throw new Error(`CI job expectations contain unknown dependency: ${job}`);
    if (expected !== "success" && expected !== "skipped") {
      throw new Error(`CI job expectation for ${job} must be success or skipped`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rawResults = process.env.CI_JOB_RESULTS;
  if (!rawResults) throw new Error("CI_JOB_RESULTS is required");

  let results;
  try {
    results = JSON.parse(rawResults);
  } catch (error) {
    throw new Error(`CI_JOB_RESULTS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const expectations = parseCiJobExpectations(process.env.CI_JOB_EXPECTATIONS);
  const failures = checkCiResults(results, expectations);
  if (failures.length > 0) {
    console.error("CI dependency results did not match the scope decision:");
    for (const failure of failures) {
      console.error(`- ${failure.job}: expected ${failure.expected}, received ${failure.result}`);
    }
    process.exitCode = 1;
  } else {
    console.log("All CI dependencies matched the scope decision.");
  }
}
