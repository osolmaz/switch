import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** One item of a list, such as a criterion of a rubric: its id and its text. */
export const itemSchema = z.object({ id: z.string().min(1), text: z.string().min(1) }).strict();

/** A list of items to search for duplicates: its id and its items, whose ids differ. */
export const caseSchema = z
	.object({ id: z.string().min(1), items: z.array(itemSchema).min(2) })
	.strict()
	.refine((list) => new Set(list.items.map((item) => item.id)).size === list.items.length, {
		message: "two items share an id",
	});
export type List = z.infer<typeof caseSchema>;
export type Item = z.infer<typeof itemSchema>;

/** Reads and checks a case folder's `case.json`. */
export async function loadList(folder: string): Promise<List> {
	return caseSchema.parse(JSON.parse(await readFile(join(folder, "case.json"), "utf8")));
}
