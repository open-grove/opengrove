import type { UserLanguagePreference } from "../core.js";
import { resolveAppManifestPresentation } from "../app-builder/manifest-localization.js";
import type { AppStoreAgentSummary, AppStorePackageRecord } from "./app-store.js";

export function presentAppStoreCatalogPackages(
  packages: AppStorePackageRecord[],
  language: UserLanguagePreference,
  resolveInstalledManifest: (appId: string) => Record<string, unknown> | undefined = () => undefined,
): AppStorePackageRecord[] {
  return packages.map((item) => presentLocalizedPackage(item, language, resolveInstalledManifest(item.appId)));
}

function presentLocalizedPackage(
  item: AppStorePackageRecord,
  language: UserLanguagePreference,
  installedManifest: Record<string, unknown> | undefined,
): AppStorePackageRecord {
  const registryManifest = packagePresentationManifest(item);
  const registryPresentation = registryManifest
    ? resolveAppManifestPresentation(registryManifest, language)
    : undefined;
  const installedPresentation = installedManifest
    ? resolveAppManifestPresentation(installedManifest, language)
    : undefined;
  const localizedPresentation = registryPresentation?.localeMatched
    ? registryPresentation
    : installedPresentation?.localeMatched
      ? installedPresentation
      : undefined;
  const employeePresentation = {
    ...(registryPresentation?.employees ?? {}),
    ...(installedPresentation?.employees ?? {}),
  };
  return {
    ...item,
    ...(localizedPresentation?.title ? { title: localizedPresentation.title } : {}),
    ...(localizedPresentation?.description ? { summary: localizedPresentation.description } : {}),
    ...(localizedPresentation?.title ? { workspaceName: localizedPresentation.title } : {}),
    ...(item.agents
      ? {
          agents: item.agents.map((agent) => presentAgent(agent, employeePresentation[agent.id])),
        }
      : {}),
    ...(item.employee
      ? {
          employee: presentAgent(item.employee, employeePresentation[item.employee.id]),
        }
      : {}),
  };
}

function presentAgent(
  agent: AppStoreAgentSummary,
  localized:
    | {
        name?: string;
        role?: string;
        publicDescription?: string;
        publicSkills?: string[];
        inputSpec?: string;
        outputSpec?: string;
      }
    | undefined,
): AppStoreAgentSummary {
  if (!localized) return agent;
  return {
    ...agent,
    ...(localized.name ? { name: localized.name } : {}),
    ...(localized.role ? { role: localized.role } : {}),
    ...(localized.publicDescription ? { publicDescription: localized.publicDescription } : {}),
    ...(localized.publicSkills?.length ? { publicSkills: localized.publicSkills } : {}),
    ...(localized.inputSpec ? { inputSpec: localized.inputSpec } : {}),
    ...(localized.outputSpec ? { outputSpec: localized.outputSpec } : {}),
  };
}

function packagePresentationManifest(item: AppStorePackageRecord): Record<string, unknown> | undefined {
  if (!item.locales || !Object.keys(item.locales).length) return undefined;
  return {
    id: item.appId,
    title: item.title,
    description: item.summary,
    defaultLocale: item.defaultLocale,
    locales: item.locales,
  };
}
