import { jest } from "@jest/globals";
import { ChatGPTApi } from "../app/client/platforms/openai";
import { useChatStore } from "../app/store/chat";
import { getMessageImages, getMessageTextContent } from "../app/utils";
import { ServiceProvider } from "../app/constant";
import { TextEncoder } from "node:util";

global.TextEncoder = TextEncoder as typeof global.TextEncoder;

test("raw files survive dispatch, saved history, follow-up and retry with mixed images", async () => {
  const chat = jest
    .spyOn(ChatGPTApi.prototype, "chat")
    .mockResolvedValue(undefined);
  try {
    const store = useChatStore.getState();
    store.newSession();
    store.currentSession().mask.modelConfig.providerName =
      ServiceProvider.OpenAI;
    store.currentSession().mask.modelConfig.model = "gpt-6.1-sol";
    const files = [
      {
        id: "doc",
        name: "scan.pdf",
        size: 8,
        fileData: "data:application/pdf;base64,AAABAgM=",
      },
    ];
    const summary = {
      input: "总结附件",
      native: true,
      files: [{ name: "scan.pdf", size: 8 }],
    };
    const images = ["data:image/png;base64,test"];
    await store.onUserInput("总结附件", images, false, summary, files);
    const outgoing = chat.mock.calls[0][0].messages.at(-1)!;
    expect(outgoing.files).toEqual(files);
    expect(getMessageTextContent(outgoing)).toBe("总结附件");
    expect(getMessageImages(outgoing)).toEqual(images);
    const saved = store
      .currentSession()
      .messages.find((m) => m.role === "user")!;
    expect(JSON.parse(JSON.stringify(saved)).files).toEqual(files);
    await store.onUserInput("继续分析");
    expect(
      chat.mock.calls[1][0].messages.find((m) => m.files?.length)?.files,
    ).toEqual(files);
    await store.onUserInput(
      getMessageTextContent(saved),
      getMessageImages(saved),
      false,
      saved.attachmentSummary,
      saved.files,
    );
    expect(chat.mock.calls[2][0].messages.at(-1)?.files).toEqual(files);
  } finally {
    chat.mockRestore();
  }
});

test("the client sends the original file to Responses and reports unsupported providers without text fallback", async () => {
  const mockFetch = jest.mocked(global.fetch);
  const files = [
    {
      id: "raw",
      name: "scan.pdf",
      size: 3,
      fileData: "data:application/pdf;base64,AAEC",
    },
  ];
  const onFinish = jest.fn();
  const onError = jest.fn();
  mockFetch.mockClear();
  mockFetch.mockResolvedValue({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Native answer" }],
        },
      ],
    }),
  } as Response);
  const options = {
    messages: [{ role: "user" as const, content: "Analyze", files }],
    config: {
      model: "gpt-6.1-sol",
      providerName: ServiceProvider.OpenAI,
      stream: true,
    },
    onFinish,
    onError,
  };
  await new ChatGPTApi().chat(options);
  expect(onError).not.toHaveBeenCalled();
  expect(onFinish.mock.calls[0][0]).toBe("Native answer");
  const call = mockFetch.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/responses"),
  )!;
  expect(call).toBeDefined();
  const body = JSON.parse(call[1]!.body as string);
  expect(body.model).toBe("gpt-6.1-sol");
  expect(body.store).toBe(false);
  expect(body.input[0].content[1]).toEqual({
    type: "input_file",
    filename: "scan.pdf",
    file_data: files[0].fileData,
  });
  mockFetch.mockClear();
  onFinish.mockClear();
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 404,
    json: async () => ({ error: { message: "Responses unsupported" } }),
  } as Response);
  await new ChatGPTApi().chat(options);
  expect(
    mockFetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/v1/responses"),
    ),
  ).toHaveLength(1);
  expect(onFinish).not.toHaveBeenCalled();
  expect(String(onError.mock.calls[0][0])).toContain("Responses unsupported");
});
