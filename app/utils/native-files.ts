import type { RequestMessage } from "../client/api";

export function buildNativeInput(messages: RequestMessage[]) {
  return messages.map((message) => {
    if (message.role === "assistant")
      return {
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text ?? "").join("\n"),
      };
    return {
      role: message.role,
      content: [
        ...(typeof message.content === "string"
          ? [{ type: "input_text", text: message.content }]
          : message.content.map((part) =>
              part.type === "image_url"
                ? { type: "input_image", image_url: part.image_url!.url }
                : { type: "input_text", text: part.text ?? "" },
            )),
        ...(message.files ?? []).map((file) => ({
          type: "input_file",
          filename: file.name,
          file_data: file.fileData,
        })),
      ],
    };
  });
}

export function getNativeOutput(response: any): string {
  if (
    response.error ||
    response.status === "failed" ||
    response.status === "incomplete"
  )
    throw new Error(
      response.error?.message ??
        response.incomplete_details?.reason ??
        "Incomplete file response",
    );
  const text = (response.output ?? [])
    .flatMap((item: any) =>
      item.type === "message"
        ? (item.content ?? []).map((part: any) =>
            part.type === "output_text"
              ? part.text
              : part.type === "refusal"
              ? part.refusal
              : "",
          )
        : [],
    )
    .join("");
  if (!text) throw new Error("The file response contained no text");
  return text;
}

// Parse complete SSE events, including events split across network/UTF-8 chunks.
export async function readNativeStream(
  response: Response,
  onUpdate: (text: string, delta: string) => void,
) {
  if (!response.body) throw new Error("Empty file response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    text = "",
    complete = false;
  function dispatch() {
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    if (payload === "[DONE]") return;
    const event = JSON.parse(payload);
    if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    )
      throw new Error(
        event.message ??
          event.error?.message ??
          event.response?.error?.message ??
          event.response?.incomplete_details?.reason ??
          "File response failed",
      );
    if (
      event.type === "response.output_text.delta" ||
      event.type === "response.refusal.delta"
    ) {
      text += event.delta ?? "";
      onUpdate(text, event.delta ?? "");
    } else if (event.type === "response.completed") {
      text = getNativeOutput(event.response);
      complete = true;
    }
  }
  function consumeLines(final = false) {
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) dispatch();
      else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
    if (final) {
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).trim());
      dispatch();
    }
  }
  try {
    while (!complete) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      consumeLines(chunk.done);
      if (chunk.done) break;
    }
    if (!complete)
      throw new Error("File response interrupted before completion");
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
