/** @jest-environment node */
import { readFile } from "node:fs/promises";
import {
  readNativeAttachment,
  validateNativeBatch,
  MAX_NATIVE_ATTACHMENT_BYTES,
} from "../app/utils/attachments";
import {
  buildNativeInput,
  getNativeOutput,
  readNativeStream,
} from "../app/utils/native-files";

test("sends real document bytes unchanged, including scanned PDFs and binary Office files", async () => {
  for (const name of ["sample.pdf", "scan.pdf", "sample.docx", "sample.xlsx"]) {
    const bytes = await readFile(`test/fixtures/attachments/${name}`);
    const file = await readNativeAttachment({
      name,
      size: bytes.length,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    } as File);
    expect(Buffer.from(file.fileData.split(",")[1], "base64")).toEqual(bytes);
    const input = buildNativeInput([
      { role: "system", content: "Personal instructions" },
      { role: "user", content: "Analyze", files: [file] },
      { role: "assistant", content: "Earlier answer" },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
        ],
      },
    ]);
    expect(input[1].content).toEqual([
      { type: "input_text", text: "Analyze" },
      { type: "input_file", filename: name, file_data: file.fileData },
    ]);
    expect(input[0].content).toEqual([
      { type: "input_text", text: "Personal instructions" },
    ]);
    expect(input[2].content).toBe("Earlier answer");
    expect(input[3].content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,abc" },
    ]);
    expect(JSON.stringify(input)).not.toContain("extracted document contents");
  }
});

test("enforces native file byte limits rather than text extraction limits", async () => {
  const file = {
    name: "scan.pdf",
    size: MAX_NATIVE_ATTACHMENT_BYTES + 1,
  } as File;
  await expect(readNativeAttachment(file)).rejects.toMatchObject({
    code: "nativeTooLarge",
  });
  expect(() =>
    validateNativeBatch([
      { size: MAX_NATIVE_ATTACHMENT_BYTES } as any,
      { size: 1 } as any,
    ]),
  ).toThrow("nativeTooLarge");
  await expect(
    readNativeAttachment({ name: "empty.pdf", size: 0 } as File),
  ).rejects.toMatchObject({ code: "empty" });
});

const output = {
  status: "completed",
  output: [
    { type: "message", content: [{ type: "output_text", text: "原文件回答" }] },
  ],
};
function responseFromChunks(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3)
          controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("streams UTF-8 across arbitrary chunk boundaries and requires completed output", async () => {
  const updates: string[] = [];
  const sse = `data: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: "原文件",
  })}\r\n\r\ndata: ${JSON.stringify({
    type: "response.completed",
    response: output,
  })}\r\n\r\n`;
  expect(
    await readNativeStream(responseFromChunks(sse), (text) =>
      updates.push(text),
    ),
  ).toBe("原文件回答");
  expect(updates).toEqual(["原文件"]);
  await expect(
    readNativeStream(
      responseFromChunks(
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      ),
      () => {},
    ),
  ).rejects.toThrow("interrupted");
  await expect(
    readNativeStream(
      responseFromChunks(
        'data: {"type":"response.failed","response":{"error":{"message":"unsupported file"}}}\n\n',
      ),
      () => {},
    ),
  ).rejects.toThrow("unsupported file");
  expect(getNativeOutput(output)).toBe("原文件回答");
  expect(() =>
    getNativeOutput({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }),
  ).toThrow("max_output_tokens");
});
