#!/usr/bin/env node
// edidtool entry point. Commands arrive in milestone M3 (SPEC.md, section 12).
import { argv, exit, stderr, stdout } from "node:process";

const USAGE = `edidtool: build, edit, validate and explain EDIDs

Commands (not yet implemented):
  decode, validate, timing, budget, build, recipe run, diff, convert

See SPEC.md, section 12.
`;

const args = argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  stdout.write(USAGE);
  exit(0);
}
stderr.write(`edidtool: unknown command "${args[0]}"\n`);
exit(3);
