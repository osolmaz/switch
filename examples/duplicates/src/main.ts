#!/usr/bin/env -S node --conditions=switch-source
/** The duplicates harness's command line: switch's run and replay with the duplicates domain. */
import { commandLine } from "@osolmaz/switch/cli";
import { duplicatesSetup } from "./setup.ts";

await commandLine({ duplicates: { setup: () => duplicatesSetup() } })
	.name("duplicates")
	.parseAsync();
