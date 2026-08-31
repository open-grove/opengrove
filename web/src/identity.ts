export const APP_PRODUCT_NAME = "OpenGrove";
export const APP_PROTOCOL_ID = "opengrove";
export const APP_BRIDGE_TOKEN_HEADER = "x-opengrove-token";
export const APP_VAULT_DIR = "opengrove-vault";
export const APP_DEFAULT_PROJECT_ID = `project:${APP_PROTOCOL_ID}`;
export const APP_DEFAULT_PROJECT_TITLE = APP_PRODUCT_NAME;

export const APP_STORAGE_KEYS = {
  uiModel: `${APP_PROTOCOL_ID}UiModel`,
  uiModelByBinding: `${APP_PROTOCOL_ID}UiModelByBinding`,
  uiView: `${APP_PROTOCOL_ID}UiView`,
  uiThreadId: `${APP_PROTOCOL_ID}UiThreadId`,
  directKernelChatRuntime: `${APP_PROTOCOL_ID}DirectKernelChatRuntime`,
  uiState: `${APP_PROTOCOL_ID}-react-ui`,
  bridgeToken: `${APP_PROTOCOL_ID}BridgeToken`,
  reasoningEffort: `${APP_PROTOCOL_ID}ReasoningEffort`,
  responseSpeed: `${APP_PROTOCOL_ID}ResponseSpeed`,
  budgetLimitUsd: `${APP_PROTOCOL_ID}BudgetLimitUsd`,
  accessMode: `${APP_PROTOCOL_ID}AccessMode`,
  language: `${APP_PROTOCOL_ID}Language`,
  theme: `${APP_PROTOCOL_ID}Theme`,
  iconStyle: `${APP_PROTOCOL_ID}IconStyle`,
  railExpanded: `${APP_PROTOCOL_ID}RailExpanded`,
  sidebarWidth: `${APP_PROTOCOL_ID}SidebarWidth`,
  sidebarCollapsed: `${APP_PROTOCOL_ID}SidebarCollapsed`,
  roomsOnboardingGuide: `${APP_PROTOCOL_ID}RoomsOnboardingGuideV2`,
  accountProfiles: `${APP_PROTOCOL_ID}AccountProfiles`,
  activeMountedAppId: `${APP_PROTOCOL_ID}ActiveMountedAppId`,
  roomsLastView: `${APP_PROTOCOL_ID}RoomsLastView`,
  roomsLastRoomId: `${APP_PROTOCOL_ID}RoomsLastRoomId`,
  vaultOpenPaths: `${APP_PROTOCOL_ID}VaultOpenPaths`,
  vaultTreeOrder: `${APP_PROTOCOL_ID}VaultTreeOrder`,
  libraryLastKnowledgeId: `${APP_PROTOCOL_ID}LibraryLastKnowledgeId`,
  clientActivityLastAttempt: `${APP_PROTOCOL_ID}ClientActivityLastAttempt`,
  accountOnboarding: `${APP_PROTOCOL_ID}AccountOnboardingV1`,
} as const;
