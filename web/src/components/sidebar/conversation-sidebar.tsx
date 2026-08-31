import { useState } from "react";
import clsx from "clsx";
import { Folder, FolderOpen, FolderPlus, ListChecks, Maximize2, Minimize2 } from "lucide-react";
import type { UiThread } from "../../store";
import { useI18n } from "../../i18n";
import { ProductIcon } from "../ui/product-icon";
import { MotionMenu, MotionMenuItem } from "../ui/motion/menu";
import { ThemedPixelIcon } from "./app-navigation";
import {
  ConversationSortMenu,
  formatSidebarThreadMeta,
  type ConversationSortKey,
  type SidebarProject,
} from "./conversation-sidebar-model";
import styles from "./conversation-sidebar.module.css";

export interface ConversationSidebarProps {
  projects: SidebarProject[];
  activeThreadId: string;
  activeView: string;
  runningThreadIds?: string[];
  pendingApprovalCount: number;
  collapsedProjectIds: Set<string>;
  allProjectsCollapsed: boolean;
  projectMenuOpenId: string;
  conversationSortMenuOpen: boolean;
  conversationSortKey: ConversationSortKey;
  onToggleAllProjectsCollapsed(): void;
  onOpenConversationSortMenu(): void;
  onCloseConversationSortMenu(): void;
  onSortKeyChange(key: ConversationSortKey): void;
  onOpenNewProject(): void;
  onOpenFolderProject(): void;
  onOpenNewThread(projectId?: string): void;
  onOpenThread(threadId: string): void;
  onToggleProjectCollapsed(projectId: string): void;
  onToggleProjectMenu(projectId: string): void;
  onCloseProjectMenu(): void;
  onRenameProject(projectId: string, title: string): void;
  onChangeProjectFolder(project: SidebarProject): void;
  onDeleteProject(project: SidebarProject): void;
  onDeleteThread(thread: UiThread): void;
  folderProjectPending?: boolean;
}

export function ConversationSidebar(props: ConversationSidebarProps) {
  const { t } = useI18n();
  const [renamingProjectId, setRenamingProjectId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const runningThreadSet = new Set(props.runningThreadIds ?? []);

  function startProjectRename(project: SidebarProject) {
    setRenamingProjectId(project.id);
    setRenameDraft(project.title);
    props.onCloseProjectMenu();
  }

  function commitProjectRename(project: SidebarProject) {
    const nextTitle = renameDraft.trim();
    setRenamingProjectId("");
    if (!nextTitle || nextTitle === project.title) return;
    props.onRenameProject(project.id, nextTitle);
  }

  return (
    <div className={clsx("project-section", styles.section)} aria-label={t("app.chat")}>
      <div className={clsx("thread-heading-row", styles.headingRow)}>
        <span>{t("app.chat")}</span>
        <span
          className={clsx(
            "thread-heading-actions",
            styles.headingActions,
            props.conversationSortMenuOpen && "active",
            props.conversationSortMenuOpen && styles.headingActionsActive,
          )}
        >
          <button
            className={clsx("sidebar-mini-action", styles.miniAction)}
            type="button"
            onClick={props.onOpenFolderProject}
            disabled={props.folderProjectPending}
            aria-label={t("conversation.newFolderProject")}
            title={t("conversation.newFolderProject")}
          >
            <ThemedPixelIcon pixelIcon="folder" professionalIcon={FolderOpen} professionalSize={13} pixelSize={15} />
          </button>
          <button
            className={clsx("sidebar-mini-action", styles.miniAction)}
            type="button"
            onClick={props.onToggleAllProjectsCollapsed}
            aria-label={props.allProjectsCollapsed ? t("conversation.expandAll") : t("conversation.collapseAll")}
            title={props.allProjectsCollapsed ? t("conversation.expandAll") : t("conversation.collapseAll")}
          >
            {props.allProjectsCollapsed ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
          </button>
          <MotionMenu
            open={props.conversationSortMenuOpen}
            onOpenChange={(open) => {
              if (open && !props.conversationSortMenuOpen) props.onOpenConversationSortMenu();
              if (!open && props.conversationSortMenuOpen) props.onCloseConversationSortMenu();
            }}
            side="bottom"
            align="end"
            className="conversation-sort-menu"
            ariaLabel={t("conversation.sortProjects")}
            trigger={
              <button
                className={clsx(
                  "sidebar-mini-action",
                  styles.miniAction,
                  props.conversationSortMenuOpen && "active",
                  props.conversationSortMenuOpen && styles.miniActionActive,
                )}
                type="button"
                aria-label={t("conversation.sortProjects")}
                title={t("conversation.sort")}
              >
                <ListChecks size={13} />
              </button>
            }
          >
            <ConversationSortMenu sortKey={props.conversationSortKey} onSortKeyChange={props.onSortKeyChange} />
          </MotionMenu>
          <button
            className={clsx("sidebar-mini-action", styles.miniAction)}
            type="button"
            onClick={props.onOpenNewProject}
            aria-label={t("conversation.newProject")}
            title={t("conversation.newProject")}
          >
            <ThemedPixelIcon pixelIcon="folder" professionalIcon={FolderPlus} professionalSize={13} pixelSize={15} />
          </button>
        </span>
      </div>
      <div className={clsx("project-tree", styles.projectTree)}>
        {props.projects.map((project) => (
          <div
            className={clsx("project-group", styles.projectGroup)}
            data-active={project.active ? "true" : "false"}
            key={project.id}
          >
            <div
              className={clsx("project-row", styles.projectRow)}
              data-menu-open={props.projectMenuOpenId === project.id ? "true" : "false"}
            >
              {renamingProjectId === project.id ? (
                <div className={clsx("project-item", styles.projectItem)}>
                  <span className={clsx("project-item-main", styles.projectItemMain)}>
                    {props.collapsedProjectIds.has(project.id) ? (
                      <ThemedPixelIcon
                        pixelIcon="folder"
                        professionalIcon={Folder}
                        professionalSize={17}
                        pixelSize={20}
                      />
                    ) : (
                      <ThemedPixelIcon
                        pixelIcon="folder"
                        professionalIcon={FolderOpen}
                        professionalSize={17}
                        pixelSize={20}
                      />
                    )}
                    <span className={clsx("project-item-copy", styles.projectItemCopy)}>
                      <input
                        className={clsx("project-rename-input", styles.projectRenameInput)}
                        value={renameDraft}
                        autoFocus
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() => commitProjectRename(project)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setRenamingProjectId("");
                        }}
                        aria-label={t("conversation.renameProject")}
                      />
                    </span>
                  </span>
                </div>
              ) : (
                <>
                  <button
                    className={clsx("project-item", styles.projectItem)}
                    type="button"
                    onClick={() => props.onToggleProjectCollapsed(project.id)}
                  >
                    <span className={clsx("project-item-main", styles.projectItemMain)}>
                      {props.collapsedProjectIds.has(project.id) ? (
                        <ThemedPixelIcon
                          pixelIcon="folder"
                          professionalIcon={Folder}
                          professionalSize={17}
                          pixelSize={20}
                        />
                      ) : (
                        <ThemedPixelIcon
                          pixelIcon="folder"
                          professionalIcon={FolderOpen}
                          professionalSize={17}
                          pixelSize={20}
                        />
                      )}
                      <span className={clsx("project-item-copy", styles.projectItemCopy)}>
                        <span className={clsx("project-item-title", styles.projectItemTitle)}>{project.title}</span>
                        {project.workspaceRoot ? (
                          <span
                            className={clsx("project-item-context", styles.projectItemContext)}
                            title={t("conversation.projectFolder", { path: project.workspaceRoot })}
                          >
                            {folderNameFromPath(project.workspaceRoot)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className={clsx("project-item-count", styles.projectItemCount)}>
                      {project.threads.filter((thread) => !thread.id.startsWith("empty:")).length}
                    </span>
                  </button>
                  <span className={clsx("project-row-actions", styles.projectRowActions)}>
                    <button
                      className={clsx("project-row-action", styles.projectRowAction)}
                      type="button"
                      onClick={() => props.onOpenNewThread(project.id)}
                      aria-label={`${project.title} · ${t("conversation.newThread")}`}
                      title={t("conversation.newThread")}
                    >
                      <ProductIcon name="edit" size={14} />
                    </button>
                    <MotionMenu
                      open={props.projectMenuOpenId === project.id}
                      onOpenChange={(open) => {
                        const isOpen = props.projectMenuOpenId === project.id;
                        if (open !== isOpen) props.onToggleProjectMenu(project.id);
                      }}
                      side="right"
                      align="start"
                      className="project-row-menu"
                      ariaLabel={`${project.title} · ${t("conversation.more")}`}
                      trigger={
                        <button
                          className={clsx("project-row-action", styles.projectRowAction)}
                          type="button"
                          aria-label={`${project.title} · ${t("conversation.more")}`}
                          title={t("conversation.more")}
                        >
                          <ProductIcon name="more" size={14} />
                        </button>
                      }
                    >
                      <MotionMenuItem onClick={() => startProjectRename(project)}>
                        <ProductIcon name="edit" size={14} />
                        <span>{t("conversation.renameProject")}</span>
                      </MotionMenuItem>
                      <MotionMenuItem onClick={() => props.onChangeProjectFolder(project)}>
                        <ThemedPixelIcon
                          pixelIcon="folder"
                          professionalIcon={FolderOpen}
                          professionalSize={14}
                          pixelSize={15}
                        />
                        <span>{t("conversation.changeProjectFolder")}</span>
                      </MotionMenuItem>
                      <MotionMenuItem
                        danger
                        onClick={() => props.onDeleteProject(project)}
                        disabled={project.threads.some((thread) => runningThreadSet.has(thread.id))}
                      >
                        <ProductIcon name="delete" size={13} />
                        <span>{t("common.remove")}</span>
                      </MotionMenuItem>
                    </MotionMenu>
                  </span>
                </>
              )}
            </div>
            {!props.collapsedProjectIds.has(project.id) ? (
              <div className={clsx("project-thread-list", styles.threadList)}>
                {project.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === props.activeThreadId && props.activeView === "chat"}
                    running={runningThreadSet.has(thread.id)}
                    pendingApprovalCount={props.pendingApprovalCount}
                    onOpenThread={props.onOpenThread}
                    onOpenNewThread={props.onOpenNewThread}
                    onDeleteThread={props.onDeleteThread}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function folderNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function ThreadRow(props: {
  thread: UiThread;
  active: boolean;
  running: boolean;
  pendingApprovalCount: number;
  onOpenThread(threadId: string): void;
  onOpenNewThread(projectId?: string): void;
  onDeleteThread(thread: UiThread): void;
}) {
  const empty = props.thread.id.startsWith("empty:");
  const { t } = useI18n();
  const title = props.thread.title || t("conversation.newThreadFallback");
  return (
    <div className={clsx("thread-row", styles.threadRow)}>
      <button
        className={clsx(
          "thread-item",
          styles.threadItem,
          props.active && "active",
          props.active && styles.threadItemActive,
          props.running && "running",
          props.running && styles.threadItemRunning,
        )}
        type="button"
        onClick={() => (empty ? props.onOpenNewThread(props.thread.projectId) : props.onOpenThread(props.thread.id))}
      >
        <span className={styles.threadTitle}>{title}</span>
        <span className={clsx("thread-item-meta", styles.threadMeta)}>
          {props.running ? (
            <span
              className={clsx("thread-running-indicator", styles.runningIndicator)}
              aria-label={t("settings.running")}
            />
          ) : props.active && props.pendingApprovalCount ? (
            `${props.pendingApprovalCount} ${t("conversation.pendingApproval")}`
          ) : (
            formatSidebarThreadMeta(props.thread, t)
          )}
        </span>
      </button>
      {!empty ? (
        <button
          className={clsx("sidebar-delete-action", styles.deleteAction)}
          type="button"
          onClick={() => props.onDeleteThread(props.thread)}
          disabled={props.running}
          aria-label={`${t("conversation.deleteThread")} ${title}`}
        >
          <ProductIcon name="delete" size={13} />
        </button>
      ) : null}
    </div>
  );
}
