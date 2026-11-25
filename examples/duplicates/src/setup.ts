import { type Runner, runnerOf } from "@osolmaz/switch";
import { loadList } from "./case.ts";
import { DUPLICATES, outcomeOf, searchMachine } from "./duplicates.ts";

/** The duplicates domain. It has no flags of its own, and its definition is its texts, thresholds and limits. */
export function duplicatesSetup(): Promise<Runner> {
	return Promise.resolve(
		runnerOf({
			...DUPLICATES,
			caseId: async (folder) => (await loadList(folder)).id,
			load: async (folder) => searchMachine(await loadList(folder)),
			outcome: outcomeOf,
		}),
	);
}
