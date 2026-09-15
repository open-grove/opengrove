import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const APP_WEBSITE_CONFIG = "opengrove.web.json";
export const APP_WEBSITE_REVIEW = ".opengrove-web-review.json";
import {
  appWebsiteConfigSchema,
  websiteRelativePathSchema as relativePath,
  appWebsiteReviewInputSchema as reviewInputSchema,
  appWebsiteReviewSchema as reviewSchema,
  type AppWebsiteConfig,
  type AppWebsiteReviewInput,
} from "#protocol";
import { opengroveAppManifestSchema } from "./manifest.js";
export { appWebsiteConfigSchema, WEBSITE_PERMISSIONS } from "#protocol";
export type { AppWebsiteConfig, AppWebsiteReviewInput } from "#protocol";
export interface WebsiteFinding {
  code: string;
  path?: string;
}
export interface AppWebsiteInspection {
  ready: boolean;
  config?: AppWebsiteConfig;
  findings: WebsiteFinding[];
  fileCount: number;
  totalBytes: number;
}
interface WebsiteFile {
  path: string;
  content: string;
}
export interface AppWebsiteArtifact {
  bytes: Buffer;
  sha256: string;
  inspection: AppWebsiteInspection;
}
const TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".webmanifest"]);
const ASSET_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".webm",
  ".ogg",
  ".pdf",
]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const HOST_DEPENDENCY =
  /(?:opengrove\.app\.(?:command|workspace|media|flows)|callServerTool\s*\(|tools\/call|window\.parent\s*===\s*window|host_required)/;
const NODE_DEPENDENCY = /(?:\b(?:from\s*|import\s*\(?|require\s*\()\s*["']node:|\bprocess\.env\b|\bchild_process\b)/;
const LOCAL_DEPENDENCY =
  /(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)|file:\/\/|\/(?:Users|home)\/[^/\s"'<>]+\/)/i;
const SECRET_CONTENT =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:OPENGROVE_WW_ACCESS_TOKEN|WW_ADMIN_TOKEN)\s*[:=]\s*["'][^"']{12,}|\b(?:sk-proj-|AKIA)[A-Za-z0-9_-]{16,})/;

export function prepareAppWebsite(appRoot: string): {
  status: "prepared" | "needs-adaptation";
  inspection: AppWebsiteInspection;
} {
  const root = realpathSync(appRoot);
  const path = join(root, APP_WEBSITE_CONFIG);
  if (!existsSync(path)) {
    const manifest = readManifest(root);
    const entry = manifest.ui?.view?.entry;
    if (typeof entry !== "string" || !relativePath.safeParse(entry).success) {
      return { status: "needs-adaptation", inspection: emptyInspection("website_view_required") };
    }
    const output = dirname(entry).replaceAll(sep, "/");
    if (output === "." || extname(entry) !== ".html") {
      return { status: "needs-adaptation", inspection: emptyInspection("website_index_required") };
    }
    const config = appWebsiteConfigSchema.parse({
      schemaVersion: 1,
      appId: manifest.id,
      title: manifest.title || manifest.id,
      mode: "static",
      output,
      entry: entry.split("/").at(-1),
      audience: { mode: "authenticated" },
      permissions: [],
      includedFeatures: ["Current browser page"],
      desktopOnlyFeatures:
        (manifest.employees?.length ||
          manifest.agents?.length ||
          manifest.capabilities?.employees?.length ||
          manifest.rooms?.employees?.length ||
          0) > 0
          ? ["App Agent workflows"]
          : [],
    });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  }
  const inspection = inspectAppWebsite(root);
  return { status: inspection.ready ? "prepared" : "needs-adaptation", inspection };
}

export function inspectAppWebsite(appRoot: string): AppWebsiteInspection {
  return collectWebsite(appRoot).inspection;
}

export function createAppWebsiteArtifact(appRoot: string): AppWebsiteArtifact {
  const { inspection, files } = collectWebsite(appRoot);
  if (!inspection.ready || !inspection.config) throw new Error("website_checks_failed");
  const { output: _output, ...config } = inspection.config;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, config, files }), "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), inspection };
}

export function recordAppWebsiteReview(appRoot: string, input: AppWebsiteReviewInput) {
  const review = reviewInputSchema.parse(input);
  const artifact = createAppWebsiteArtifact(appRoot);
  if (artifact.sha256 !== review.artifactSha256) throw new Error("website_review_stale");
  const result = { schemaVersion: 1 as const, ...review, reviewedAt: new Date().toISOString() };
  writeWebsiteJson(realpathSync(appRoot), APP_WEBSITE_REVIEW, result);
  return result;
}

export function readReviewedAppWebsiteArtifact(appRoot: string) {
  const artifact = createAppWebsiteArtifact(appRoot);
  let review: z.infer<typeof reviewSchema>;
  try {
    const path = join(realpathSync(appRoot), APP_WEBSITE_REVIEW);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("invalid_review");
    review = reviewSchema.parse(JSON.parse(readWebsiteFile(path, 128 * 1024).toString("utf8")));
  } catch {
    throw new Error("website_review_required");
  }
  if (review.artifactSha256 !== artifact.sha256) throw new Error("website_review_stale");
  return { artifact: artifact.bytes.toString("base64"), artifactSha256: artifact.sha256, review };
}

function collectWebsite(appRoot: string): { inspection: AppWebsiteInspection; files: WebsiteFile[] } {
  const findings: WebsiteFinding[] = [];
  const files: WebsiteFile[] = [];
  const inspection: AppWebsiteInspection = { ready: false, findings, fileCount: 0, totalBytes: 0 };
  try {
    const root = realpathSync(appRoot);
    const configPath = join(root, APP_WEBSITE_CONFIG);
    if (!existsSync(configPath)) return { inspection: emptyInspection("website_config_required"), files };
    if (!lstatSync(configPath).isFile() || lstatSync(configPath).isSymbolicLink())
      throw new Error("website_config_invalid");
    const config = appWebsiteConfigSchema.parse(JSON.parse(readWebsiteFile(configPath, 128 * 1024).toString("utf8")));
    inspection.config = config;
    const manifest = readManifest(root);
    if (manifest.id !== config.appId) throw new Error("website_app_identity_mismatch");
    const workspace = typeof manifest.workspace?.path === "string" ? manifest.workspace.path : "workspace";
    if (overlap(resolve(root, workspace), resolve(root, config.output))) throw new Error("website_workspace_output");
    let cursor = root;
    for (const segment of config.output.split("/")) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory())
        throw new Error("website_output_invalid");
    }
    const output = cursor;
    const seen = new Set<string>();
    function visit(directory: string, depth: number): void {
      if (depth > 16) throw new Error("website_depth_exceeded");
      for (const entry of readdirSync(directory).sort()) {
        const absolute = join(directory, entry);
        const path = relative(output, absolute).split(sep).join("/");
        const stat = lstatSync(absolute);
        if (!relativePath.safeParse(path).success || seen.has(path.toLowerCase())) {
          findings.push({ code: "website_asset_path_invalid", path });
          continue;
        }
        seen.add(path.toLowerCase());
        if (stat.isSymbolicLink()) {
          findings.push({ code: "website_symlink_unsupported", path });
          continue;
        }
        if (stat.isDirectory()) {
          visit(absolute, depth + 1);
          continue;
        }
        if (!stat.isFile() || !ASSET_EXTENSIONS.has(extname(path).toLowerCase())) {
          findings.push({ code: "website_asset_type_unsupported", path });
          continue;
        }
        if (++inspection.fileCount > MAX_FILES || stat.size > MAX_FILE_BYTES) throw new Error("website_asset_limit");
        inspection.totalBytes += stat.size;
        if (inspection.totalBytes > MAX_TOTAL_BYTES) throw new Error("website_asset_limit");
        const bytes = readWebsiteFile(absolute, MAX_FILE_BYTES);
        if (bytes.length !== stat.size) throw new Error("website_output_changed");
        if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) {
          const source = bytes.toString("utf8");
          for (const [pattern, code] of [
            [HOST_DEPENDENCY, "website_host_adapter_required"],
            [NODE_DEPENDENCY, "website_native_dependency_unsupported"],
            [LOCAL_DEPENDENCY, "website_local_dependency_unsupported"],
            [SECRET_CONTENT, "website_credential_detected"],
          ] as const) {
            if (pattern.test(source)) findings.push({ code, path });
          }
        }
        files.push({ path, content: bytes.toString("base64") });
      }
    }
    visit(output, 0);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (!files.some((file) => file.path === config.entry)) findings.push({ code: "website_index_required" });
    inspection.ready = findings.length === 0;
  } catch (error) {
    const code =
      error instanceof Error && /^website_[a-z_]+$/.test(error.message) ? error.message : "website_config_invalid";
    findings.push({ code });
  }
  return { inspection, files };
}

function emptyInspection(code: string): AppWebsiteInspection {
  return { ready: false, findings: [{ code }], fileCount: 0, totalBytes: 0 };
}

function overlap(left: string, right: string): boolean {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}

function readManifest(root: string) {
  return opengroveAppManifestSchema.parse(
    JSON.parse(readWebsiteFile(join(root, "opengrove.app.json"), 1024 * 1024).toString("utf8")),
  );
}

/** Read a regular file without following a final symlink, with a hard byte bound. */
export function readWebsiteFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("website_file_invalid");
    const data = Buffer.allocUnsafe(Math.min(maxBytes, stat.size) + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes || length !== stat.size) throw new Error("website_output_changed");
    return data.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function writeWebsiteJson(root: string, name: string, value: unknown): void {
  if (![APP_WEBSITE_CONFIG, APP_WEBSITE_REVIEW].includes(name)) throw new Error("website_file_invalid");
  const path = join(realpathSync(root), name);
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error("website_file_invalid");
  const temporary = path + "." + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function configureAppWebsiteAudience(appRoot: string, audience: AppWebsiteConfig["audience"]): void {
  const root = realpathSync(appRoot);
  const config = appWebsiteConfigSchema.parse(
    JSON.parse(readWebsiteFile(join(root, APP_WEBSITE_CONFIG), 128 * 1024).toString("utf8")),
  );
  writeWebsiteJson(root, APP_WEBSITE_CONFIG, appWebsiteConfigSchema.parse({ ...config, audience }));
}

export function getLocalAppWebsiteState(appRoot: string) {
  const inspection = inspectAppWebsite(appRoot);
  if (!inspection.ready) return { inspection, reviewStatus: "blocked" as const };
  const artifact = createAppWebsiteArtifact(appRoot);
  try {
    const { review } = readReviewedAppWebsiteArtifact(appRoot);
    return { inspection, artifactSha256: artifact.sha256, review, reviewStatus: "current" as const };
  } catch (error) {
    return {
      inspection,
      artifactSha256: artifact.sha256,
      reviewStatus:
        error instanceof Error && error.message === "website_review_stale" ? ("stale" as const) : ("required" as const),
    };
  }
}
