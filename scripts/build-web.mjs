// Bundle the browser app with esbuild.
import esbuild from "esbuild";

const production = process.env.NODE_ENV === "production";
const ctx = await esbuild.context({
  entryPoints: ["public/app.ts"],
  bundle: true,
  outfile: "public/app.js",
  format: "iife",
  target: ["es2020"],
  sourcemap: production ? false : true,
  minify: production,
  logLevel: "info",
});
if (process.argv.includes("--watch")) {
  await ctx.watch();
  console.log("watching public/app.ts …");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("bundled -> public/app.js");
}
