import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The image formats that Netpbm decodes. */
export type ImageFormat = "png" | "jpeg" | "gif" | "ppm";

/** An image that fits: the original bytes when they already did, otherwise a scaled PNG. */
export interface FittedImage {
	readonly bytes: Uint8Array;
	readonly mimeType: "image/png" | "image/jpeg";
}

/** The office formats that ingest lays out as pages, by their file extension. */
export type OfficeFormat = "doc" | "docx" | "pptx";

/**
 * The programs ingestion needs beyond Node: Poppler for page images, LibreOffice for office files laid out as pages and
 * for legacy Word's text, Netpbm for images. Only these lay out pages, so another renderer replaces them here.
 */
export interface Tools {
	/**
	 * A PNG of each of the first `maxPages` pages of a PDF, in page order, scaled so that no side is longer than
	 * `maxSide` pixels.
	 */
	renderPages(pdf: Uint8Array, maxSide: number, maxPages: number): Promise<Uint8Array[]>;
	/** An office file laid out as pages, as a PDF. */
	toPdf(file: Uint8Array, format: OfficeFormat): Promise<Uint8Array>;
	/** The text of a legacy .doc file. */
	docText(doc: Uint8Array): Promise<string>;
	/** The version of each program that lays out or renders pages, for the case's record. */
	versions(): Promise<Record<string, string>>;
	/**
	 * The image with neither side longer than `maxSide` pixels: a PNG or JPEG that fits is kept as it is, anything else
	 * becomes a PNG, scaled down when it is too large.
	 */
	fitImage(image: Uint8Array, format: ImageFormat, maxSide: number): Promise<FittedImage>;
}

const DECODERS: Readonly<Record<ImageFormat, string | null>> = {
	png: "pngtopnm",
	jpeg: "jpegtopnm",
	gif: "giftopnm",
	ppm: null,
};
const BUFFER = { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 } as const;

/** The width and height in a PNM header: a magic number, then the width and height, with `#` comments allowed. */
export function pnmSize(pnm: Uint8Array): { width: number; height: number } {
	const header = new TextDecoder("latin1").decode(pnm.subarray(0, 512)).replace(/#[^\n]*\n/g, " ");
	const match = /^P[1-6]\s+(\d+)\s+(\d+)/.exec(header);
	if (match === null) throw new Error("not a PNM image");
	return { width: Number(match[1]), height: Number(match[2]) };
}

async function inTemporaryFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
	const folder = await mkdtemp(join(tmpdir(), "switch-"));
	try {
		return await work(folder);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

/** The longest that LibreOffice may take to convert one file. */
const OFFICE_TIMEOUT_MS = 180_000;

/**
 * Converts `in.<extension>` in `folder` with LibreOffice to `in.<target extension>`, and returns that file's bytes. The
 * user profile lives in the folder, so that conversions never share one, and a running LibreOffice does not take over.
 * LibreOffice exits without an error when it cannot read a file, so a missing output is the error.
 */
async function office(folder: string, extension: string, target: string): Promise<Buffer> {
	const profile = `-env:UserInstallation=file://${join(folder, "profile")}`;
	const { stderr } = await run(
		"soffice",
		[profile, "--headless", "--convert-to", target, "--outdir", folder, `in.${extension}`],
		{ cwd: folder, timeout: OFFICE_TIMEOUT_MS },
	);
	try {
		return await readFile(join(folder, `in.${target.split(":")[0] ?? target}`));
	} catch {
		throw new Error(`LibreOffice could not convert the file: ${stderr.trim() || "it wrote no output"}`);
	}
}

/** The page number in the name of an image that `pdftoppm` wrote with the prefix `page`, such as `page-07.png`. */
const pageOfName = (name: string): number | null => {
	const match = /^page-(\d+)\.png$/.exec(name);
	return match === null ? null : Number(match[1]);
};

/** The first line of a program's version output; `pdftoppm -v` writes it to stderr. */
async function versionOf(program: string, flag: string): Promise<string> {
	try {
		const { stdout, stderr } = await run(program, [flag]);
		return (`${stdout}\n${stderr}`.split("\n").find((line) => line.trim() !== "") ?? "").trim();
	} catch {
		return "not installed";
	}
}

/** The tools as installed programs: `pdftoppm`, `soffice`, and Netpbm's decoders, `pamscale` and `pnmtopng`. */
export const systemTools: Tools = {
	renderPages: (pdf, maxSide, maxPages) =>
		inTemporaryFolder(async (folder) => {
			await writeFile(join(folder, "in.pdf"), pdf);
			const size = ["-scale-to", String(maxSide), "-l", String(maxPages)];
			await run("pdftoppm", ["-png", ...size, "in.pdf", "page"], { cwd: folder });
			const pages = (await readdir(folder))
				.flatMap((name) => {
					const number = pageOfName(name);
					return number === null ? [] : [{ name, number }];
				})
				.sort((a, b) => a.number - b.number);
			return Promise.all(pages.map(async ({ name }) => new Uint8Array(await readFile(join(folder, name)))));
		}),
	toPdf: (file, format) =>
		inTemporaryFolder(async (folder) => {
			await writeFile(join(folder, `in.${format}`), file);
			return new Uint8Array(await office(folder, format, "pdf"));
		}),
	docText: (doc) =>
		inTemporaryFolder(async (folder) => {
			await writeFile(join(folder, "in.doc"), doc);
			return (await office(folder, "doc", "txt:Text")).toString("utf8");
		}),
	versions: async () => ({
		pdftoppm: await versionOf("pdftoppm", "-v"),
		soffice: await versionOf("soffice", "--version"),
	}),
	fitImage: (image, format, maxSide) =>
		inTemporaryFolder(async (folder) => {
			const input = join(folder, "in");
			await writeFile(input, image);
			const decoder = DECODERS[format];
			const pnm = decoder === null ? image : new Uint8Array((await run(decoder, [input], BUFFER)).stdout);
			const { width, height } = pnmSize(pnm);
			const fits = width <= maxSide && height <= maxSide;
			if (fits && format === "png") return { bytes: image, mimeType: "image/png" };
			if (fits && format === "jpeg") return { bytes: image, mimeType: "image/jpeg" };
			const decoded = join(folder, "in.pnm");
			await writeFile(decoded, pnm);
			const scaled = fits
				? decoded
				: await (async () => {
						const { stdout } = await run(
							"pamscale",
							["-xyfit", String(maxSide), String(maxSide), decoded],
							BUFFER,
						);
						await writeFile(join(folder, "scaled.pnm"), stdout);
						return join(folder, "scaled.pnm");
					})();
			const { stdout } = await run("pnmtopng", [scaled], BUFFER);
			return { bytes: new Uint8Array(stdout), mimeType: "image/png" };
		}),
};
