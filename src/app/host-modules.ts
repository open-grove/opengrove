/** Optional product modules. Core task execution, Skills and persistence are always present. */
export interface HostModules {
  rooms: boolean;
  routines: boolean;
  apps: boolean;
}

export const DEFAULT_HOST_MODULES: Readonly<HostModules> = Object.freeze({ rooms: true, routines: true, apps: true });

/** Undefined preserves the desktop composition; an explicit empty list selects core only. */
export function resolveHostModules(names?: readonly string[]): Readonly<HostModules> {
  if (names === undefined) return DEFAULT_HOST_MODULES;
  for (const name of names) {
    if (name !== "rooms" && name !== "routines" && name !== "apps") throw new Error(`unknown_host_module:${name}`);
  }
  const modules = {
    rooms: names.includes("rooms"),
    routines: names.includes("routines"),
    apps: names.includes("apps"),
  };
  if ((modules.routines || modules.apps) && !modules.rooms) throw new Error("host_module_requires_rooms");
  return Object.freeze(modules);
}
