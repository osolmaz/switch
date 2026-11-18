import type { FileFormat, Unit, UnitText } from "../case.ts";
import { readDocx } from "./docx.ts";
import { readEmail } from "./email.ts";
import { unitPages } from "./pages.ts";
import { hasTextLayer, readPdf } from "./pdf.ts";
import { readPptx } from "./pptx.ts";
import type { FittedImage, ImageFormat, OfficeFormat, Tools } from "./tools.ts";
import { htmlText, textUnits } from "./units.ts";
import { readXlsx } from "./xlsx.ts";

/** One page of a file as laid out, with its image when it could be made. */
export interface ExtractedPage {
	readonly number: number;
	readonly image: FittedImage | null;
	readonly hasText: boolean;
}

export interface Extracted {
	readonly format: FileFormat;
	readonly units: Unit[];
	readonly pages: ExtractedPage[];
	readonly formatting: string | null;
	readonly marks: number;
	readonly warnings: string[];
}

/** At most this many pages of one file get an image; the case notes the rest in the file's warnings. */
export const MAX_PAGES = 300;
/** The longest image side that TypeSafe's Jev accepts: it refuses an image with a side of 1,569 pixels or more. */
export const MAX_IMAGE_SIDE = 1568;
/** The longest error or warning text that a case keeps. */
const MESSAGE_CHARACTERS = 300;
const IMAGES: Readonly<Record<string, ImageFormat | null>> = {
	png: "png",
	jpg: "jpeg",
	jpeg: "jpeg",
	gif: "gif",
	ppm: "ppm",
	webp: null,
};
const TEXT = new Set(["", "md", "txt", "csv", "json", "xml", "rels", "html", "htm"]);

const extensionOf = (path: string): string => {
	const name = path.split("/").at(-1) ?? path;
	return name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
};

/** An error as the text a case keeps. */
export const errorText = (error: unknown): string =>
	(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, MESSAGE_CHARACTERS);

const withoutPages = (units: readonly UnitText[]): Unit[] => units.map((unit) => ({ ...unit, pages: [] }));

const plain = (format: FileFormat, units: readonly UnitText[]): Extracted => ({
	format,
	units: withoutPages(units),
	pages: [],
	formatting: null,
	marks: 0,
	warnings: [],
});

/** What rendering the pages left out: pages past the limit, and pages it could not render. */
function renderWarnings(pageCount: number, images: number): string[] {
	const rendered = Math.min(pageCount, MAX_PAGES);
	return [
		...(pageCount > MAX_PAGES
			? [`only the first ${String(MAX_PAGES)} of ${String(pageCount)} pages have images`]
			: []),
		...(images < rendered ? [`${String(rendered - images)} of ${String(rendered)} pages could not be rendered`] : []),
	];
}

/** A PDF's pages, given each page's text: the image of each, up to the page limit, and whether it has a text layer. */
async function laidOut(
	pdf: Uint8Array,
	pageTexts: readonly string[],
	tools: Tools,
): Promise<{ pages: ExtractedPage[]; warnings: string[] }> {
	let images: Uint8Array[] = [];
	let failure: string | null = null;
	try {
		images = await tools.renderPages(pdf, MAX_IMAGE_SIDE, MAX_PAGES);
	} catch (error: unknown) {
		failure = `the pages could not be rendered: ${errorText(error)}`;
	}
	const pages = pageTexts.map((text, index): ExtractedPage => {
		const png = images[index];
		return {
			number: index + 1,
			image: png === undefined ? null : { bytes: png, mimeType: "image/png" },
			hasText: hasTextLayer(text),
		};
	});
	const warnings = failure === null ? renderWarnings(pageTexts.length, images.length) : [failure];
	return { pages, warnings };
}

async function pdf(bytes: Uint8Array, tools: Tools): Promise<Extracted> {
	const texts = await readPdf(bytes);
	const { pages, warnings } = await laidOut(
		bytes,
		texts.map((unit) => unit.text),
		tools,
	);
	const units = texts.map((unit, index) => ({ ...unit, pages: [index + 1] }));
	return { format: "pdf", units, pages, formatting: null, marks: 0, warnings };
}

/** What a reader gives for an office file before it is laid out as pages. */
type OfficeText = Pick<Extracted, "format" | "formatting" | "marks"> & { readonly units: UnitText[] };

/**
 * An office file: the text that its own reader gives, which keeps what a layout loses, such as a Word file's styles and
 * tracked changes, and the file's pages as LibreOffice lays them out, with each unit's pages. A file that cannot be laid
 * out keeps its text, with a warning.
 */
async function officeFile(read: OfficeText, bytes: Uint8Array, format: OfficeFormat, tools: Tools): Promise<Extracted> {
	let laidOutPdf: Uint8Array;
	try {
		laidOutPdf = await tools.toPdf(bytes, format);
	} catch (error: unknown) {
		const warning = `the file could not be laid out as pages: ${errorText(error)}`;
		return { ...read, units: withoutPages(read.units), pages: [], warnings: [warning] };
	}
	const texts = (await readPdf(laidOutPdf, " ")).map((unit) => unit.text);
	const { pages, warnings } = await laidOut(laidOutPdf, texts, tools);
	const found = unitPages(read.units, texts);
	const units = read.units.map((unit, index) => ({ ...unit, pages: found[index] ?? [] }));
	return { ...read, units, pages, warnings };
}

function text(extension: string, bytes: Uint8Array): Extracted {
	const decoded = new TextDecoder().decode(bytes);
	return plain("text", textUnits(extension === "html" || extension === "htm" ? htmlText(decoded) : decoded));
}

async function image(extension: string, bytes: Uint8Array, tools: Tools): Promise<Extracted> {
	const format = IMAGES[extension];
	if (format === undefined || format === null) throw new Error(`${extension} images are not supported`);
	const fitted = await tools.fitImage(bytes, format, MAX_IMAGE_SIDE);
	return { ...plain("image", []), pages: [{ number: 1, image: fitted, hasText: false }] };
}

function docx(bytes: Uint8Array, tools: Tools): Promise<Extracted> {
	const word = readDocx(bytes);
	const read = { format: "docx", units: word.units, formatting: word.formatting, marks: word.marks } as const;
	return officeFile(read, bytes, "docx", tools);
}

const READERS: Readonly<Record<string, (bytes: Uint8Array, tools: Tools) => Promise<Extracted>>> = {
	pdf,
	docx,
	xlsx: (bytes) => Promise.resolve(plain("sheet", readXlsx(bytes))),
	pptx: (bytes, tools) =>
		officeFile({ format: "slides", units: readPptx(bytes), formatting: null, marks: 0 }, bytes, "pptx", tools),
	eml: async (bytes) => plain("email", await readEmail(bytes)),
	doc: async (bytes, tools) =>
		officeFile(
			{ format: "text", units: textUnits(await tools.docText(bytes)), formatting: null, marks: 0 },
			bytes,
			"doc",
			tools,
		),
};

/** A file's text, parts and pages, by its extension. A format switch does not read gives a file with no parts. */
export async function extractFile(path: string, bytes: Uint8Array, tools: Tools): Promise<Extracted> {
	const extension = extensionOf(path);
	if (extension in IMAGES) return image(extension, bytes, tools);
	const reader = READERS[extension];
	if (reader !== undefined) return reader(bytes, tools);
	return TEXT.has(extension) ? text(extension, bytes) : plain("other", []);
}
