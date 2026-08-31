import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

export function tailwindStylesPlugin(stylesPath) {
  const absoluteStylesPath = resolve(stylesPath);

  return {
    name: "opengrove-tailwind-styles",
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.css$/ }, async (args) => {
        if (resolve(args.path) !== absoluteStylesPath) return undefined;

        const source = await readFile(absoluteStylesPath, "utf8");
        const result = await postcss([tailwindcss()]).process(source, {
          from: absoluteStylesPath,
        });

        return {
          contents: result.css,
          loader: "css",
          resolveDir: dirname(absoluteStylesPath),
        };
      });
    },
  };
}
