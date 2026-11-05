/* Run the edge parsers over a fixture and print what they saw, as JSON.
 *
 *     node tests/parsers.mjs listing tests/fixtures/search-single.html
 *     node tests/parsers.mjs report  tests/fixtures/report-clean.html
 *
 * The comparison against crawler/source.py lives in tests/test_parsers.py;
 * this is just the half of it that has to run in a JavaScript engine.
 *
 * The functions under test are Cloudflare Pages Functions -- ES modules named
 * .js, in a tree with no package.json. Node reads that as CommonJS and refuses
 * the `export`, and the fix is not to add a package.json: Pages treats one as
 * "this project has a build", which it does not. So each module is handed to
 * the loader as source instead, and so is anything they import.
 */

import { readFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url);

/** A module as a data: URL, with its own relative imports inlined the same
 *  way -- a data: URL has no directory for "./_found.js" to be relative to. */
function moduleUrl(url) {
  const src = readFileSync(url, "utf8").replace(
    /from\s+"(\.\/[^"]+)"/g, (_, rel) => `from "${moduleUrl(new URL(rel, url))}"`);
  return "data:text/javascript;base64," + Buffer.from(src).toString("base64");
}

async function load(path) {
  return import(moduleUrl(new URL(path, HERE)));
}

const [mode, path] = process.argv.slice(2);
if (!mode || !path) {
  console.error("usage: node tests/parsers.mjs <listing|report> <fixture.html>");
  process.exit(2);
}

const page = readFileSync(path, "utf8");
let out;
if (mode === "listing") {
  const { parseListing, resultCount } = await load("../web/functions/api/place.js");
  out = { rows: resultCount(page), establishments: parseListing(page) };
} else {
  const { parseReport } = await load("../web/functions/api/report.js");
  out = parseReport(page);
}

process.stdout.write(JSON.stringify(out, null, 1));
