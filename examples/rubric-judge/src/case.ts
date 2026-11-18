import { z } from "zod";

/** The version of the case folder's `case.json`. A reader refuses any other: ingest the input folder again. */
export const CASE_SCHEMA = 2;

/** One readable part of a file: a PDF page, a group of paragraphs, a sheet's rows, an email. */
export const unitSchema = z.object({
	label: z.string(),
	text: z.string(),
	/** The numbers of the file's pages that hold the unit's text; empty for a file without pages. */
	pages: z.array(z.number().int().positive()),
});

/** An image stored next to the case: an image file, or one page of a file as laid out. */
export const renderSchema = z.object({ label: z.string(), path: z.string(), mimeType: z.string() });

/** One page of a file as laid out, with its image when it could be made. */
export const pageSchema = z.object({
	number: z.number().int().positive(),
	image: renderSchema.nullable(),
	/** Whether the page has a usable text layer; a scan or an image has none. */
	hasText: z.boolean(),
});

export const fileFormats = ["text", "pdf", "docx", "sheet", "email", "slides", "image", "other"] as const;

export const fileSchema = z.object({
	id: z.string(),
	path: z.string(),
	role: z.enum(["answer", "document"]),
	format: z.enum(fileFormats),
	units: z.array(unitSchema),
	words: z.number().int().nonnegative(),
	/** The file's pages; empty for a file that is not laid out in pages, such as a sheet or an email. */
	pages: z.array(pageSchema),
	/** Tracked changes, comments and directly formatted text of a Word file. */
	formatting: z.string().nullable(),
	/** The number of tracked changes and comments in a Word file. */
	marks: z.number().int().nonnegative(),
	/** Why the file could not be read, when it could not. */
	error: z.string().nullable(),
	/** What ingest could not do for a file it read, such as the page images past the page limit. */
	warnings: z.array(z.string()),
});

/** How ingest made the page images: their longest side, and the version of each program it used. */
export const renderingSchema = z.object({
	pageSide: z.number().int().positive(),
	programs: z.record(z.string(), z.string()),
});

export const itemSchema = z.object({ id: z.string(), category: z.string().nullable(), text: z.string() });

/** A rubric-judge case: one answer to one task, with the task's request, rubric and documents. */
export const caseSchema = z.object({
	schema: z.literal(CASE_SCHEMA),
	id: z.string(),
	request: z.string(),
	items: z.array(itemSchema).min(1),
	files: z.array(fileSchema),
	rendering: renderingSchema,
});

export type Unit = z.infer<typeof unitSchema>;
/** A unit as a reader gives it, before ingest finds its pages. */
export type UnitText = Omit<Unit, "pages">;
export type Render = z.infer<typeof renderSchema>;
export type Page = z.infer<typeof pageSchema>;
export type FileFormat = (typeof fileFormats)[number];
export type CaseFile = z.infer<typeof fileSchema>;
export type Item = z.infer<typeof itemSchema>;
export type JudgeCase = z.infer<typeof caseSchema>;
