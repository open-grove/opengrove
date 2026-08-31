export interface EvalResult {
  id: string;
  ok: boolean;
  checks: Record<string, boolean>;
  answer: string;
  eventTypes: string[];
}

export async function runCapabilityEvals(): Promise<EvalResult[]> {
  return [];
}

if (process.argv[1]?.endsWith("run-evals.js")) {
  const results = await runCapabilityEvals();
  console.log(JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2));
  if (!results.every((result) => result.ok)) {
    process.exitCode = 1;
  }
}
