import type { ViewId } from "../bridge";

export type RailSectionId = "chat" | "rooms" | "network" | "ops" | "extensions" | "apps" | "settings";

export type AppIconName =
  | "chat"
  | "rooms"
  | "messages"
  | "contacts"
  | "library"
  | "folder"
  | "document"
  | "seed"
  | "search"
  | "plus"
  | "settings"
  | "user"
  | "ops"
  | "store"
  | "extensions";

export type AppLayer = "foundation" | "workspace" | "user";

export interface OpenGroveAppDefinition {
  id: string;
  view: ViewId;
  section: RailSectionId;
  layer: AppLayer;
  title: string;
  navLabel: string;
  icon: AppIconName;
  rail: boolean;
  mobile: boolean;
}

export const REGISTERED_APPS: OpenGroveAppDefinition[] = [
  {
    id: "agent-console",
    view: "chat",
    section: "chat",
    layer: "foundation",
    title: "Agent Console",
    navLabel: "Agent",
    icon: "chat",
    rail: true,
    mobile: true,
  },
  {
    id: "rooms",
    view: "rooms",
    section: "rooms",
    layer: "workspace",
    title: "Rooms",
    navLabel: "Rooms",
    icon: "rooms",
    rail: true,
    mobile: false,
  },
  {
    id: "ops-center",
    view: "ops",
    section: "settings",
    layer: "foundation",
    title: "Ops Center",
    navLabel: "Ops",
    icon: "ops",
    rail: false,
    mobile: false,
  },
  {
    id: "extension-manager",
    view: "extensions",
    section: "extensions",
    layer: "foundation",
    title: "Extensions",
    navLabel: "Extensions",
    icon: "extensions",
    rail: true,
    mobile: true,
  },
  {
    id: "app-store",
    view: "app-store",
    section: "network",
    layer: "foundation",
    title: "App Store",
    navLabel: "App Store",
    icon: "store",
    rail: true,
    mobile: false,
  },
  {
    id: "mounted-app",
    view: "app",
    section: "apps",
    layer: "user",
    title: "Mounted App",
    navLabel: "App",
    icon: "document",
    rail: false,
    mobile: false,
  },
  {
    id: "capability-settings",
    view: "settings",
    section: "settings",
    layer: "foundation",
    title: "Capability Settings",
    navLabel: "Settings",
    icon: "settings",
    rail: false,
    mobile: false,
  },
];

export const RAIL_APPS = REGISTERED_APPS.filter((app) => app.rail);
export const MOBILE_APPS = REGISTERED_APPS.filter((app) => app.mobile);

export function appForView(view: ViewId): OpenGroveAppDefinition {
  return (
    REGISTERED_APPS.find((app) => app.view === view) ||
    (view === "contacts" ? REGISTERED_APPS.find((app) => app.view === "rooms") : undefined) ||
    REGISTERED_APPS[0]!
  );
}

export function railSectionForView(view: ViewId): RailSectionId {
  return appForView(view).section;
}
