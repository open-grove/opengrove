import type { AgentEventRecord, RunRecord, SkillRecord, StoredMessage } from "../../bridge";
import { useI18n } from "../../i18n";
import { MessageList } from "./message-list";
import type { ChatImagePayload } from "./message-types";
import "./chat-layout.css";
import styles from "./thread-shell.module.css";

export function ThreadShell(props: {
  messages: StoredMessage[];
  projectTitle: string;
  workspaceRoot?: string;
  skills?: SkillRecord[];
  runtimeEvents?: AgentEventRecord[];
  runs?: RunRecord[];
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject", response?: unknown): void;
  onResolveQuestion(questionId: string, action: "answer" | "decline", response?: unknown): void;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onSaveImageArtifact?(image: ChatImagePayload): void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.shell}>
      {props.messages.length === 0 ? (
        <section className={styles.welcome}>
          <div className={styles.welcomeCopy}>
            <strong>{t("thread.welcome")}</strong>
          </div>
        </section>
      ) : null}
      <MessageList
        messages={props.messages}
        workspaceRoot={props.workspaceRoot}
        skills={props.skills}
        runtimeEvents={props.runtimeEvents}
        runs={props.runs}
        pendingQuestionIds={props.pendingQuestionIds}
        onResolveApproval={props.onResolveApproval}
        onResolveQuestion={props.onResolveQuestion}
        onInsertPrompt={props.onInsertPrompt}
        onSubmitPrompt={props.onSubmitPrompt}
        onTrySkill={(skillName) => props.onInsertPrompt(`/${skillName} `)}
        onEditSkill={(skillName) => props.onInsertPrompt(t("thread.editSkillPrompt", { name: skillName }))}
        onSaveImageArtifact={props.onSaveImageArtifact}
      />
    </div>
  );
}
