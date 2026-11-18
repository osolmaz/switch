import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CASE_SCHEMA, caseSchema } from "./case.ts";
import type { CaseFolder } from "./state.ts";

const versioned = z.object({ schema: z.unknown() });

/**
 * Reads and checks a case folder's `case.json`; images are read from the folder when a view shows them. A case of
 * another schema version is refused with a hint to ingest it again.
 */
export async function loadCase(folder: string): Promise<CaseFolder> {
	const json: unknown = JSON.parse(await readFile(join(folder, "case.json"), "utf8"));
	const { schema } = versioned.parse(json);
	if (schema !== CASE_SCHEMA)
		throw new Error(
			`${folder}: case.json has schema ${String(schema)}, and this code reads schema ${String(CASE_SCHEMA)}; ingest the input folder again`,
		);
	const judgeCase = caseSchema.parse(json);
	return {
		case: judgeCase,
		image: async (render) => ({
			type: "image",
			label: render.label,
			mimeType: render.mimeType,
			data: (await readFile(join(folder, render.path))).toString("base64"),
		}),
	};
}
