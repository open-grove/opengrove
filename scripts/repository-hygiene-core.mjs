const ALLOWED_FIXTURE_USERS = new Set(["example", "Shared", "runner", "builder", "upstream"]);
const HOME_PATH_PATTERNS = [
  { platform: "macOS", expression: /\/Users\/([^/\\\s"'`]+)\//gu },
  { platform: "Linux", expression: /\/home\/([^/\\\s"'`]+)\//gu },
  { platform: "Windows", expression: /[A-Za-z]:\\Users\\([^/\\\s"'`]+)\\/gu },
];

export function repositoryHygieneFailures(files) {
  const failures = [];
  for (const { path, contents } of files) {
    if (path.startsWith("web/src/review/") || path.startsWith("web/review/")) {
      failures.push(`${path}: task-specific visual review artifacts belong in ui-review-workbench`);
    }
    if (contents === undefined) continue;
    if (path.startsWith("web/src/") && /\/ui\/review(?:\/|["'`])/u.test(contents)) {
      failures.push(`${path}: product Web entry points must not expose task-specific review routes`);
    }
    collectPersonalHomePaths(path, contents, failures);
  }
  return failures;
}

function collectPersonalHomePaths(path, contents, output) {
  for (const { platform, expression } of HOME_PATH_PATTERNS) {
    for (const match of contents.matchAll(expression)) {
      const user = match[1];
      if (user && !ALLOWED_FIXTURE_USERS.has(user)) {
        output.push(`${path}: ${platform} home path contains personal user name ${JSON.stringify(user)}`);
      }
    }
  }
}
