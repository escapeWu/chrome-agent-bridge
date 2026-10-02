import { readFileSync } from "node:fs";

/** The project version, read once from package.json so a release changes one place. */
export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
