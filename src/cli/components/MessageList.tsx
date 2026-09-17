import { Box, Static, Text } from "ink";

export interface DisplayMessage {
  id: number;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
}

const roleStyles: Record<DisplayMessage["role"], { label: string; color: string }> = {
  user: { label: "you", color: "cyan" },
  assistant: { label: "star", color: "green" },
  system: { label: "system", color: "yellow" },
  tool: { label: "tool", color: "magenta" },
};

export function MessageList({ messages }: { messages: DisplayMessage[] }) {
  return (
    <Static items={messages}>
      {(message) => {
        const style = roleStyles[message.role];
        return (
          <Box key={message.id} flexDirection="column" marginBottom={1}>
            <Text bold color={style.color}>
              {style.label}
            </Text>
            <Text color={style.color}>{message.text}</Text>
          </Box>
        );
      }}
    </Static>
  );
}
