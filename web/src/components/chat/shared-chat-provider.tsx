import { ChatProvider } from "@olorinm/agent-ui";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
export function SharedChatProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <ChatProvider translate={t} Button={Button}>
      {children}
    </ChatProvider>
  );
}
