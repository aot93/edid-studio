import { writeFileSync } from "node:fs";
import { rulesMarkdown } from "../packages/edid-core/src/rules-doc.ts";

writeFileSync(new URL("../docs/rules.md", import.meta.url), rulesMarkdown());
console.log("wrote docs/rules.md");
