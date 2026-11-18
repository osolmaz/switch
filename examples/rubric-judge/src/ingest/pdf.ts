import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { UnitText } from "../case.ts";

/** A page with fewer characters than this has no usable text layer, such as a scan. */
export const SCAN_TEXT_LIMIT = 40;

/**
 * Each page's text, one unit per page. pdf.js splits a line into text items, often within a word for kerning, so the
 * items are joined with `between`: nothing for the text a model reads, a space where only the words count.
 */
export async function readPdf(bytes: Uint8Array, between = ""): Promise<UnitText[]> {
	const task = getDocument({ data: bytes.slice(), verbosity: 0 });
	const document = await task.promise;
	try {
		const units: UnitText[] = [];
		for (let number = 1; number <= document.numPages; number += 1) {
			const page = await document.getPage(number);
			const content = await page.getTextContent();
			const text = content.items
				.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
				.join(between);
			units.push({ label: `page ${String(number)}`, text: text.trim() });
		}
		return units;
	} finally {
		await task.destroy();
	}
}

/** Whether a page's text is a usable text layer. */
export const hasTextLayer = (text: string): boolean => text.length >= SCAN_TEXT_LIMIT;
