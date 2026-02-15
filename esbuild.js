const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : "inline",
  logLevel: "info"
};

async function buildExtension() {
  const options = {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"]
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return ctx;
  }

  await esbuild.build(options);
  return null;
}

async function buildWebview() {
  const options = {
    ...shared,
    entryPoints: ["src/webview/main.tsx"],
    outdir: "dist/webview",
    platform: "browser",
    format: "iife",
    target: "es2022"
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return ctx;
  }

  await esbuild.build(options);
  return null;
}

async function run() {
  try {
    const contexts = await Promise.all([buildExtension(), buildWebview()]);

    if (watch) {
      console.log("watching extension and webview bundles...");
      process.on("SIGINT", async () => {
        await Promise.all(contexts.filter(Boolean).map((ctx) => ctx.dispose()));
        process.exit(0);
      });
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

run();
