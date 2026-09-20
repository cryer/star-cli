import { Box, Static, Text } from "ink";
import { memo } from "react";

export interface DisplayMessage {
  id: number;
  role: "user" | "assistant" | "assistant-cont" | "system" | "tool";
  text: string;
  note?: string;
  // tight = no bottom margin; used for mid-turn continuation chunks so a
  // long streamed answer committed in pieces still reads as one block.
  tight?: boolean;
}

const roleStyles: Record<
  Exclude<DisplayMessage["role"], "assistant-cont">,
  { label: string; color: string }
> = {
  user: { label: "you", color: "cyan" },
  assistant: { label: "star", color: "green" },
  system: { label: "system", color: "yellow" },
  tool: { label: "tool", color: "magenta" },
};

export const MessageList = memo(function MessageList({ messages }: { messages: DisplayMessage[] }) {
  return (
    <Static items={messages}>
      {(message) => {
        const marginBottom = message.tight ? 0 : 1;
        if (message.role === "assistant-cont") {
          return (
            <Box key={message.id} flexDirection="column" marginBottom={marginBottom}>
              <Text color="green">{message.text}</Text>
            </Box>
          );
        }
        const style = roleStyles[message.role];
        return (
          <Box key={message.id} flexDirection="column" marginBottom={marginBottom}>
            <Text bold color={style.color}>
              {style.label}
            </Text>
            <Text color={style.color}>{message.text}</Text>
            {message.note && <Text dimColor>{message.note}</Text>}
          </Box>
        );
      }}
    </Static>
  );
});
