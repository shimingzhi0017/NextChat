/** @jest-environment node */
import { readFile } from "node:fs/promises";
import {
  AttachmentError,
  composeAttachmentMessage,
  decodeAttachmentText,
  DocumentAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TEXT,
  readDocumentAttachment,
  validateDocumentBatch,
} from "../app/utils/attachments";

function makeFile(name: string, bytes: Uint8Array | string, size?: number) {
  const data =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return {
    name,
    size: size ?? data.byteLength,
    type: "",
    arrayBuffer: async () =>
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  } as File;
}

test("text and code contents are sent with filenames, including attachment-only messages", async () => {
  const doc = await readDocumentAttachment(
    makeFile("题目.txt", "题目：计算 2 + 3。"),
  );
  const code = await readDocumentAttachment(
    makeFile("answer.py", "print(2 + 3)"),
  );
  const payload = composeAttachmentMessage("请核对答案", [doc, code]);
  expect(payload).toContain("请核对答案");
  expect(payload).toContain("题目.txt");
  expect(payload).toContain("题目：计算 2 + 3。");
  expect(payload).toContain("print(2 + 3)");
  expect(composeAttachmentMessage("", [doc])).toContain(doc.text);
  expect(composeAttachmentMessage("普通聊天", [])).toBe("普通聊天");
});

test("reads actual PDF, Word and Excel fixtures", async () => {
  for (const name of ["sample.pdf", "sample.docx", "sample.xlsx"]) {
    const bytes = await readFile(`test/fixtures/attachments/${name}`);
    const doc = await readDocumentAttachment(makeFile(name, bytes));
    expect(doc.text).toContain("Attachment test 42");
    if (name.endsWith("xlsx")) {
      expect(doc.text).toContain("Second sheet");
      expect(doc.text).toContain("C3");
    }
  }
}, 30_000);

test("rejects unreadable, oversized and unsupported attachments without silently truncating", async () => {
  await expect(
    readDocumentAttachment(makeFile("a.txt", "x", MAX_ATTACHMENT_BYTES + 1)),
  ).rejects.toMatchObject({ code: "tooLarge" });
  await expect(
    readDocumentAttachment(makeFile("a.txt", "")),
  ).rejects.toMatchObject({ code: "empty" });
  await expect(
    readDocumentAttachment(makeFile("a.exe", "binary")),
  ).rejects.toMatchObject({ code: "unsupported" });
  await expect(
    readDocumentAttachment(makeFile("a.docx", "broken archive")),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    readDocumentAttachment(
      makeFile("a.txt", "x".repeat(MAX_ATTACHMENT_TEXT + 1)),
    ),
  ).rejects.toMatchObject({ code: "tooLong" });
  expect(() => decodeAttachmentText(new Uint8Array([0, 1, 2]).buffer)).toThrow(
    AttachmentError,
  );
});

test("rejects scan-only PDFs and reports unextractable pages in mixed PDFs", async () => {
  const scan = await readFile("test/fixtures/attachments/scan.pdf");
  await expect(
    readDocumentAttachment(makeFile("scan.pdf", scan)),
  ).rejects.toMatchObject({ code: "scannedPdf" });
  const mixed = await readFile("test/fixtures/attachments/mixed.pdf");
  const result = await readDocumentAttachment(makeFile("mixed.pdf", mixed));
  expect(result.text).toContain("Attachment test 42");
  expect(result.unreadablePages).toEqual([2]);
  expect(result.text).toContain("These pages were not read");
});

test("enforces document count and combined content length", () => {
  const doc: DocumentAttachment = {
    id: "1",
    name: "a.txt",
    size: 1,
    text: "x",
  };
  expect(() => validateDocumentBatch(Array(6).fill(doc))).toThrow("tooMany");
  expect(() =>
    validateDocumentBatch([
      { ...doc, text: "x".repeat(60_000) },
      { ...doc, text: "y".repeat(60_000) },
    ]),
  ).toThrow("tooLong");
});
