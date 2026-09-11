import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const entrypoint = join(packageRoot, "src", "index.ts");
const defaultOutputDirectory = join(packageRoot, "dist");
const nativeSpecifier = "../native.cjs";

export async function buildNativeFacade({
  outputDirectory = defaultOutputDirectory,
  metafile = false,
} = {}) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const javascriptBuilds = [];
  for (const [format, filename] of [
    ["esm", "index.mjs"],
    ["cjs", "index.cjs"],
  ]) {
    const result = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [entrypoint],
      outfile: join(outputDirectory, filename),
      bundle: true,
      packages: "bundle",
      platform: "node",
      format,
      target: "node22",
      external: [nativeSpecifier],
      legalComments: "none",
      logLevel: "silent",
      metafile,
      sourcemap: false,
    });
    javascriptBuilds.push({ filename, format, metafile: result.metafile });
  }

  const declarationBundle = await rollup({
    input: entrypoint,
    external: (id) => id === nativeSpecifier,
    plugins: [dts({ respectExternal: false })],
    onwarn(warning) {
      throw new Error(`Rollup warning: ${warning.message}`);
    },
  });

  let declaration;
  try {
    const generated = await declarationBundle.generate({ format: "es" });
    const chunk = generated.output.find((output) => output.type === "chunk");
    if (!chunk) {
      throw new Error("Declaration bundling produced no output");
    }
    declaration = chunk.code;
  } finally {
    await declarationBundle.close();
  }

  await Promise.all([
    writeFile(join(outputDirectory, "index.d.mts"), declaration),
    writeFile(join(outputDirectory, "index.d.cts"), declaration),
    writeFile(join(outputDirectory, "index.d.ts"), declaration),
  ]);

  for (const filename of [
    "index.mjs",
    "index.cjs",
    "index.d.mts",
    "index.d.cts",
    "index.d.ts",
  ]) {
    const contents = await readFile(join(outputDirectory, filename), "utf8");
    if (contents.includes("@okf-internal/prepare") || contents.includes("workspace:")) {
      throw new Error(`${filename} contains a private workspace reference`);
    }
  }

  return { javascriptBuilds };
}


if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await buildNativeFacade();
}
