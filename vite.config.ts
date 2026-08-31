import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => {
  const development = command === "serve";
  const developmentBackendUrl = process.env.OPENGROVE_WEB_DEV_BACKEND_URL?.trim();
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const packageVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  const buildId = development ? "dev" : process.env.OPENGROVE_WEB_BUILD_ID?.trim() || Date.now().toString(36);
  const apiBase = process.env.OPENGROVE_WEB_API_BASE?.trim() || "../api/";
  if (!packageVersion)
    throw new Error("package.json must contain a non-empty version before starting the Web frontend.");
  return {
    root: resolve(import.meta.dirname, "web"),
    base: "./",
    plugins: [
      tailwindcss(),
      react(),
      {
        name: "opengrove-web-build-contract",
        transformIndexHtml: {
          order: "pre" as const,
          handler(html: string) {
            return html
              .replace(
                /<meta name="opengrove-api-base" content="[^"]*" \/>/u,
                `<meta name="opengrove-api-base" content="${escapeHtmlAttribute(apiBase)}" />`,
              )
              .replace(
                /<meta name="opengrove-build-id" content="[^"]*" \/>/u,
                `<meta name="opengrove-build-id" content="${escapeHtmlAttribute(buildId)}" />`,
              )
              .replace(
                /<meta name="opengrove-package-version" content="[^"]*" \/>/u,
                `<meta name="opengrove-package-version" content="${escapeHtmlAttribute(packageVersion)}" />`,
              );
          },
        },
        generateBundle() {
          if (development) return;
          this.emitFile({
            type: "asset",
            fileName: "version.json",
            source: `${JSON.stringify({ buildId, packageVersion }, null, 2)}\n`,
          });
        },
      },
    ],
    build: {
      outDir: resolve(import.meta.dirname, "web-dist"),
      emptyOutDir: true,
      sourcemap: process.env.OPENGROVE_WEB_SOURCEMAP === "1",
    },
    resolve: {
      alias: {
        "@opengrove/agent-protocol/locale-registry": resolve(
          import.meta.dirname,
          "packages/agent-protocol/src/locale-registry.ts",
        ),
        "@opengrove/agent-protocol": resolve(import.meta.dirname, "packages/agent-protocol/src/index.ts"),
      },
    },
    define: {
      __OPENGROVE_BUILD_ID__: JSON.stringify(buildId),
      __OPENGROVE_PACKAGE_VERSION__: JSON.stringify(packageVersion),
    },
    server: {
      ...(developmentBackendUrl
        ? {
            proxy: Object.fromEntries(
              ["/api", "/generated", "/vault-file", "/apps", "/mcp-app-sandbox", "/mcp-app-media"].map((path) => [
                path,
                {
                  target: developmentBackendUrl,
                  changeOrigin: false,
                },
              ]),
            ),
          }
        : {}),
      fs: {
        allow: [resolve(import.meta.dirname)],
      },
    },
  };
});

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
