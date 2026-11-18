import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { CASE_SCHEMA, type CaseFile, caseSchema, type JudgeCase, type Page } from "../case.ts";
import { errorText, type Extracted, type ExtractedPage, extractFile, MAX_IMAGE_SIDE } from "./extract.ts";
import { systemTools, type Tools } from "./tools.ts";
import { countWords } from "./units.ts";

/** The rubric of an input folder: `{"items": [{"id", "category", "text"}]}`. */
export const rubricSchema = z.object({
	items: z.array(z.object({ id: z.string(), category: z.string().nullable().optional(), text: z.string() })).min(1),
});

export interface IngestOptions {
	readonly id: string;
	readonly tools?: Tools;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
};

async function listFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
}

async function safeExtract(
	path: string,
	bytes: Uint8Array,
	tools: Tools,
): Promise<Extracted & { error: string | null }> {
	try {
		return { ...(await extractFile(path, bytes, tools)), error: null };
	} catch (error: unknown) {
		const read = { units: [], pages: [], formatting: null, marks: 0, warnings: [] };
		return { format: "other", ...read, error: errorText(error) };
	}
}

/** Where a file comes from in the input folder and what it becomes in the case. */
interface Source {
	readonly file: string;
	readonly path: string;
	readonly role: CaseFile["role"];
	readonly id: string;
}

const ROLES = [
	{ folder: "answer", prefix: "output", role: "answer", id: "a" },
	{ folder: "documents", prefix: "documents", role: "document", id: "d" },
] as const;

async function sources(input: string): Promise<Source[]> {
	const found: Source[] = [];
	for (const { folder, prefix, role, id } of ROLES) {
		for (const [index, name] of (await listFiles(join(input, folder))).entries()) {
			found.push({
				file: join(input, folder, name),
				path: `${prefix}/${name}`,
				role,
				id: `${id}${String(index + 1)}`,
			});
		}
	}
	return found;
}

/**
 * Stores a page's image next to the case as `images/<file id>-<page>.<extension>`. Its label names the file, and the
 * page unless the file is an image itself, so that the model and the records know what each image shows.
 */
async function storePage(source: Source, isImage: boolean, page: ExtractedPage, output: string): Promise<Page> {
	if (page.image === null) return { number: page.number, image: null, hasText: page.hasText };
	const path = `images/${source.id}-${String(page.number)}.${EXTENSIONS[page.image.mimeType] ?? "png"}`;
	await writeFile(join(output, path), page.image.bytes);
	const label = isImage ? source.path : `${source.path} page ${String(page.number)}`;
	return { number: page.number, image: { label, path, mimeType: page.image.mimeType }, hasText: page.hasText };
}

async function caseFile(source: Source, output: string, tools: Tools): Promise<CaseFile> {
	const bytes = new Uint8Array(await readFile(source.file));
	const extracted = await safeExtract(source.path, bytes, tools);
	const pages: Page[] = [];
	for (const page of extracted.pages) pages.push(await storePage(source, extracted.format === "image", page, output));
	const { format, units, formatting, marks, error, warnings } = extracted;
	return {
		id: source.id,
		path: source.path,
		role: source.role,
		format,
		units,
		words: countWords(units),
		pages,
		formatting,
		marks,
		error,
		warnings,
	};
}

/**
 * Turns an input folder into a case folder. The input holds `request.md`, `rubric.json`, the task's files under
 * `documents/` and the answer's files under `answer/`; the case folder gets `case.json` and the images it refers to.
 */
export async function ingestCase(input: string, output: string, options: IngestOptions): Promise<JudgeCase> {
	const tools = options.tools ?? systemTools;
	const request = await readFile(join(input, "request.md"), "utf8");
	const rubric = rubricSchema.parse(JSON.parse(await readFile(join(input, "rubric.json"), "utf8")));
	await mkdir(join(output, "images"), { recursive: true });
	const files: CaseFile[] = [];
	for (const source of await sources(input)) files.push(await caseFile(source, output, tools));
	const items = rubric.items.map((item) => ({ id: item.id, category: item.category ?? null, text: item.text }));
	const rendering = { pageSide: MAX_IMAGE_SIDE, programs: await tools.versions() };
	const judgeCase = caseSchema.parse({ schema: CASE_SCHEMA, id: options.id, request, items, files, rendering });
	await writeFile(join(output, "case.json"), `${JSON.stringify(judgeCase, null, 1)}\n`);
	return judgeCase;
}
