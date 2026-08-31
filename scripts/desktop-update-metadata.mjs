import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { desktopReleaseTargets } from "./desktop-release-targets.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");

export async function verifyDesktopUpdateMetadata({ releaseDir, updaterDir, version, releasedAt, requireAll = false }) {
  const candidates = desktopReleaseTargets(version);
  const targets = candidates.filter((target) => existsSync(join(updaterDir, target.id)));
  if (requireAll && targets.length !== candidates.length) {
    const missing = candidates.filter((target) => !targets.includes(target)).map((target) => target.id);
    throw new Error(`updater metadata is missing target directories: ${missing.join(", ")}`);
  }
  if (targets.length === 0) throw new Error("updater metadata does not contain any target directories");

  const evidence = [];
  for (const target of targets) {
    const targetDir = join(updaterDir, target.id);
    const payloadPath = join(releaseDir, target.updaterFile);
    const feedPath = join(targetDir, target.updaterFeed);
    if (!existsSync(payloadPath) || !existsSync(feedPath)) {
      throw new Error(`${target.id} updater metadata is missing ${target.updaterFile} or ${target.updaterFeed}`);
    }
    const payloadSize = statSync(payloadPath).size;
    const payloadSha512 = await hashFile(payloadPath, "sha512", "base64");
    const feed = load(readFileSync(feedPath, "utf8"));
    const files = Array.isArray(feed?.files) ? feed.files : [];
    if (
      feed?.version !== version ||
      feed?.path !== target.updaterFile ||
      feed?.sha512 !== payloadSha512 ||
      files.length !== 1 ||
      files[0]?.url !== target.updaterFile ||
      files[0]?.sha512 !== payloadSha512 ||
      files[0]?.size !== payloadSize ||
      !Number.isFinite(Date.parse(feed?.releaseDate ?? "")) ||
      (releasedAt && feed?.releaseDate !== releasedAt)
    ) {
      throw new Error(
        `${target.id} updater feed SHA512, size, version, or release date does not match the final payload`,
      );
    }
    evidence.push({
      target: target.id,
      feed: target.updaterFeed,
      payload: target.updaterFile,
      size: payloadSize,
      sha512: payloadSha512,
    });
  }
  return { schemaVersion: 1, gate: "updater_metadata", passed: true, version, releasedAt, targets: evidence };
}

function hashFile(path, algorithm, encoding) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest(encoding)));
  });
}
