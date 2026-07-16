import type { Message } from "@ag-ui/core";
import { ExportedMessageRepository, type ThreadMessage } from "@assistant-ui/react";
import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";

/** 使用 react-ag-ui 官方转换器建立可直接 hydrate 的 assistant-ui 消息。 */
export function convertAgUiMessages(messages: Message[]): ThreadMessage[] {
  const converted = ExportedMessageRepository.fromArray(fromAgUiMessages(messages)).messages.map(
    ({ message }) => message,
  );
  const result: ThreadMessage[] = [];

  for (const message of converted) {
    const previous = result.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      result[result.length - 1] = {
        ...message,
        content: [...previous.content, ...message.content],
      };
      continue;
    }
    result.push(message);
  }
  return result;
}

/** assistant-ui thread.import() 使用的线性权威消息仓库。 */
export function messageRepository(messages: readonly ThreadMessage[]): ExportedMessageRepository {
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((message, index) => ({
      message,
      parentId: messages[index - 1]?.id ?? null,
    })),
  };
}
