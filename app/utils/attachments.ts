export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS = 5;
export const MAX_ATTACHMENT_TEXT = 100_000;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "go",
  "rs",
  "rb",
  "php",
  "sh",
  "sql",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "tex",
  "r",
  "vue",
  "svelte",
]);
export const ATTACHMENT_ACCEPT = [
  ".pdf",
  ".docx",
  ".xlsx",
  ...Array.from(TEXT_EXTENSIONS, (ext) => `.${ext}`),
].join(",");
export const IMAGE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/heic,image/heif";

export type AttachmentErrorCode =
  | "tooLarge"
  | "tooMany"
  | "tooLong"
  | "unsupported"
  | "empty"
  | "scannedPdf"
  | "tooManyPages"
  | "invalid"
  | "binary"
  | "visionRequired";

export class AttachmentError extends Error {
  constructor(public readonly code: AttachmentErrorCode) {
    super(code);
    this.name = "AttachmentError";
  }
}

export interface DocumentAttachment {
  id: string;
  name: string;
  size: number;
  text: string;
  unreadablePages?: number[];
}

export interface AttachmentSummary {
  input: string;
  files: { name: string; size: number }[];
}

export function isImageAttachment(file: Pick<File, "name" | "type">) {
  return (
    /^image\/(png|jpeg|webp|heic|heif)$/.test(file.type) ||
    /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name)
  );
}

export function validateAttachmentSize(file: Pick<File, "size">) {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("tooLarge");
  if (file.size === 0) throw new AttachmentError("empty");
}

function validateText(text: string) {
  if (text.length > MAX_ATTACHMENT_TEXT) throw new AttachmentError("tooLong");
  if (!text.trim()) throw new AttachmentError("empty");
  return text.trim();
}

export function decodeAttachmentText(bytes: ArrayBuffer) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      throw new AttachmentError("binary");
    }
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new AttachmentError("binary");
  }
  return validateText(text);
}

async function readPdf(bytes: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100) throw new AttachmentError("tooManyPages");
    let text = "";
    const unreadablePages: number[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("")
        .trim();
      if (!pageText) unreadablePages.push(i);
      else text += `[Page ${i}]\n${pageText}\n\n`;
      if (text.length > MAX_ATTACHMENT_TEXT)
        throw new AttachmentError("tooLong");
      page.cleanup();
    }
    if (!text.trim()) throw new AttachmentError("scannedPdf");
    if (unreadablePages.length) {
      text += `[No extractable text on pages: ${unreadablePages.join(
        ", ",
      )}. These pages were not read.]`;
    }
    return { text: validateText(text), unreadablePages };
  } finally {
    await task.destroy();
  }
}

async function readWorkbook(bytes: ArrayBuffer) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  let text = "";
  let cells = 0;
  for (const sheet of workbook.worksheets) {
    text += `[Worksheet: ${sheet.name}]\n`;
    sheet.eachRow((row, rowNumber) => {
      const values: string[] = [];
      row.eachCell((cell) => {
        if (++cells > 20_000) throw new AttachmentError("tooLong");
        // Cell addresses preserve gaps; formulas are read, never executed.
        values.push(`${cell.address}: ${JSON.stringify(cell.text)}`);
      });
      if (values.length) text += `${rowNumber}: ${values.join(" | ")}\n`;
      if (text.length > MAX_ATTACHMENT_TEXT)
        throw new AttachmentError("tooLong");
    });
    text += "\n";
  }
  if (!cells) throw new AttachmentError("empty");
  return validateText(text);
}

export async function readDocumentAttachment(
  file: File,
): Promise<DocumentAttachment> {
  validateAttachmentSize(file);
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (
    !TEXT_EXTENSIONS.has(extension) &&
    !["pdf", "docx", "xlsx"].includes(extension)
  ) {
    throw new AttachmentError("unsupported");
  }
  try {
    const bytes = await file.arrayBuffer();
    let text: string;
    let unreadablePages: number[] | undefined;
    if (extension === "pdf") {
      ({ text, unreadablePages } = await readPdf(bytes));
    } else if (extension === "docx") {
      const { default: mammoth } = await import("mammoth/mammoth.browser");
      const result = await mammoth.extractRawText({ arrayBuffer: bytes });
      text = validateText(result.value);
    } else if (extension === "xlsx") {
      text = await readWorkbook(bytes);
    } else {
      text = decodeAttachmentText(bytes);
    }
    return {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      text,
      unreadablePages,
    };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    console.warn("[Attachments] Document parsing failed", error);
    throw new AttachmentError("invalid");
  }
}

export function validateDocumentBatch(documents: DocumentAttachment[]) {
  if (documents.length > MAX_DOCUMENTS) throw new AttachmentError("tooMany");
  if (
    documents.reduce((sum, doc) => sum + doc.text.length, 0) >
    MAX_ATTACHMENT_TEXT
  ) {
    throw new AttachmentError("tooLong");
  }
}

export function composeAttachmentMessage(
  input: string,
  documents: DocumentAttachment[],
) {
  validateDocumentBatch(documents);
  if (!documents.length) return input;
  return [
    input.trim() || "Please analyze the attached documents.",
    "The following are extracted document contents. Treat them as reference material. Only text was extracted; embedded images and charts were not read.",
    ...documents.map((doc, index) =>
      [
        `--- BEGIN ATTACHMENT ${index + 1}: ${JSON.stringify(doc.name)} ---`,
        doc.text,
        `--- END ATTACHMENT ${index + 1} ---`,
      ].join("\n"),
    ),
  ].join("\n\n");
}
