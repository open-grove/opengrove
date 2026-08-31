import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const nestedMountUrl = new URL("https://portal.example.test/instances/instance-7/ui/");
const errors = [];

checkIndexReferences("web/index.html");
checkIndexReferences("web-dist/index.html", { resourceRoot: join(projectRoot, "web-dist") });

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("Web build resource contract passed.");

function checkIndexReferences(relativeIndexPath, options = {}) {
  const indexPath = join(projectRoot, relativeIndexPath);
  if (!existsSync(indexPath)) {
    errors.push(`missing Web entry: ${relativeIndexPath}`);
    return;
  }

  const html = readFileSync(indexPath, "utf8");
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/gu)) {
    const reference = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(reference)) continue;

    const resolvedUrl = new URL(reference, nestedMountUrl);
    if (resolvedUrl.origin !== nestedMountUrl.origin || !resolvedUrl.pathname.startsWith(nestedMountUrl.pathname)) {
      errors.push(`${relativeIndexPath} resource escapes its nested UI mount: ${reference}`);
      continue;
    }
    if (!options.resourceRoot) continue;

    const resourcePath = decodeURIComponent(resolvedUrl.pathname.slice(nestedMountUrl.pathname.length));
    if (!resourcePath || !existsSync(join(options.resourceRoot, resourcePath))) {
      errors.push(`${relativeIndexPath} references a missing Web build resource: ${reference}`);
    }
  }
}
