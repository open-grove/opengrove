import { useState } from "react";
import type { WorkspaceDirectoryResponse } from "./bridge";
import { postJson } from "./bridge";
import type { AppBuilderRequest } from "./components/apps/app-create-wizard";
import { readDesktopApi } from "./desktop-api";
import { translate } from "./i18n";

export function useAppCreateWorkflow(input: {
  notify: {
    error(message: string): void;
    success(message: string): void;
  };
  askGroveForLocalFolderHelp(): Promise<void>;
  canChooseLocalDirectory: boolean;
  chooseWorkspaceBridgeOutdatedMessage: string;
  folderTitleFromPath(path: string): string;
  onAppCreated?(appId: string): void;
  setConversationSortMenuOpen(open: boolean): void;
  setProjectMenuOpenId(id: string): void;
  setRoomsAppView(view: "messages" | "contacts"): void;
  setRoomsFocusRoomId(roomId: string): void;
  setView(view: string): void;
}) {
  const {
    notify,
    askGroveForLocalFolderHelp,
    canChooseLocalDirectory,
    chooseWorkspaceBridgeOutdatedMessage,
    folderTitleFromPath,
    onAppCreated,
    setConversationSortMenuOpen,
    setProjectMenuOpenId,
  } = input;
  const [appCreateDialogOpen, setAppCreateDialogOpen] = useState(false);
  const [appDraftPath, setAppDraftPath] = useState("");
  const [appDraftTitle, setAppDraftTitle] = useState("");
  const [appDraftDescription, setAppDraftDescription] = useState("");
  const [appFolderPickerPending, setAppFolderPickerPending] = useState(false);
  const [appCreatePending, setAppCreatePending] = useState(false);
  const [appCreateError, setAppCreateError] = useState("");

  function resetAppCreateDraft() {
    setAppDraftPath("");
    setAppDraftTitle("");
    setAppDraftDescription("");
    setAppCreateError("");
  }

  function closeAppCreateDialog() {
    setAppCreateDialogOpen(false);
    resetAppCreateDraft();
  }

  function openAppCreateDialog() {
    setProjectMenuOpenId("");
    setConversationSortMenuOpen(false);
    resetAppCreateDraft();
    setAppCreateDialogOpen(true);
  }

  function setAppCreateDialogState(open: boolean) {
    if (open) {
      openAppCreateDialog();
    } else {
      closeAppCreateDialog();
    }
  }

  async function chooseAppImportFolder() {
    const desktopDirectoryPicker = readDesktopApi()?.chooseDirectory;
    if (!desktopDirectoryPicker && !canChooseLocalDirectory) {
      setAppFolderPickerPending(true);
      try {
        await askGroveForLocalFolderHelp();
      } finally {
        setAppFolderPickerPending(false);
      }
      return;
    }
    setAppFolderPickerPending(true);
    try {
      let path: string;
      if (desktopDirectoryPicker) {
        const result = await desktopDirectoryPicker();
        if (result.status === "cancelled") return;
        path = result.path;
      } else {
        const result = await postJson<WorkspaceDirectoryResponse>("/workspace/choose-directory", {});
        if (result.cancelled) return;
        if (!result.ok || !result.path) {
          throw new Error(result.error || "directory_picker_failed");
        }
        path = result.path;
      }
      setAppDraftPath(path);
      setAppDraftTitle((current) => (current.trim() ? current : folderTitleFromPath(path)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify.error(
        message === "not_found"
          ? chooseWorkspaceBridgeOutdatedMessage
          : translate("createApp.chooseFolderFailed", { message }),
      );
    } finally {
      setAppFolderPickerPending(false);
    }
  }

  async function requestAppBuilder(request: AppBuilderRequest): Promise<boolean> {
    const title = request.title?.trim() ?? "";
    const source = request.source?.trim() ?? "";
    setAppCreatePending(true);
    setAppCreateError("");
    try {
      const result = await postJson<AppCreateResponse>("/apps/create", {
        ...(title ? { title } : {}),
        ...(source ? { source } : {}),
        ...(!source && request.icon ? { icon: request.icon } : {}),
        ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      });
      if (!result.ok || !result.appId) {
        throw new Error(result.error || "app_create_failed");
      }
      const location = result.appRoot ? translate("createApp.appRootLocation", { appRoot: result.appRoot }) : "";
      const mountedTitle = result.title || result.appId;
      notify.success(
        result.mode === "imported"
          ? translate("createApp.importedAndMounted", { title: mountedTitle, location })
          : translate("createApp.createdAndMounted", { title: mountedTitle, location }),
      );
      onAppCreated?.(result.appId);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const formatted = formatAppCreateError(message);
      setAppCreateError(formatted);
      notify.error(translate("createApp.createFailed", { message: formatted }));
      return false;
    } finally {
      setAppCreatePending(false);
    }
  }

  function requestAppBuilderFromDialog(request: AppBuilderRequest) {
    void requestAppBuilder(request).then((ok) => {
      if (ok) closeAppCreateDialog();
    });
  }

  return {
    appCreateDialogOpen,
    appCreateError,
    appCreatePending,
    appDraftDescription,
    appDraftPath,
    appDraftTitle,
    appFolderPickerPending,
    chooseAppImportFolder,
    closeAppCreateDialog,
    openAppCreateDialog,
    requestAppBuilder,
    requestAppBuilderFromDialog,
    setAppCreateDialogState,
    setAppDraftDescription,
    setAppDraftPath,
    setAppDraftTitle,
  };
}

interface AppCreateResponse {
  ok: boolean;
  appId?: string;
  title?: string;
  appRoot?: string;
  mode?: "scaffolded" | "imported";
  error?: string;
  issues?: string[];
}

function formatAppCreateError(message: string): string {
  if (message === "app_directory_already_exists") return translate("createApp.errorDirectoryExists");
  if (message === "app_source_must_be_local_directory") return translate("createApp.errorSourceNotLocalDirectory");
  if (message === "app_title_or_source_required") return translate("createApp.errorTitleOrSourceRequired");
  if (message === "app_create_requires_local_profile") return translate("createApp.errorRequiresLocalProfile");
  if (message === "app_not_valid") return translate("createApp.errorAppNotValid");
  if (message === "app_icon_invalid") return translate("createApp.errorIconInvalid");
  return message;
}
