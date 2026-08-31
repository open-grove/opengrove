import type { CapabilityManifest, PackManifest, PolicyRule, SkillManifest, ToolDefinition, ToolSpec } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.spec.id)) {
      throw new Error(`Tool already registered: ${tool.spec.id}`);
    }
    this.tools.set(tool.spec.id, tool);
    return this;
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  require(id: string): ToolDefinition {
    const tool = this.get(id);
    if (!tool) {
      throw new Error(`Tool not registered: ${id}`);
    }
    return tool;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  specs(): ToolSpec[] {
    return this.list().map((tool) => tool.spec);
  }
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityManifest>();

  register(capability: CapabilityManifest): this {
    if (this.capabilities.has(capability.id)) {
      throw new Error(`Capability already registered: ${capability.id}`);
    }
    this.capabilities.set(capability.id, capability);
    return this;
  }

  get(id: string): CapabilityManifest | undefined {
    return this.capabilities.get(id);
  }

  require(id: string): CapabilityManifest {
    const capability = this.get(id);
    if (!capability) {
      throw new Error(`Capability not registered: ${id}`);
    }
    return capability;
  }

  list(): CapabilityManifest[] {
    return Array.from(this.capabilities.values());
  }

  tools(): ToolSpec[] {
    return this.list().flatMap((capability) => capability.tools);
  }

  skills(): SkillManifest[] {
    return this.list().flatMap((capability) => capability.skills);
  }

  policy(): PolicyRule[] {
    return this.list().flatMap((capability) => capability.policy);
  }
}

export class PackRegistry {
  private readonly packs = new Map<string, PackManifest>();

  register(pack: PackManifest): this {
    if (this.packs.has(pack.id)) {
      throw new Error(`Pack already registered: ${pack.id}`);
    }
    this.packs.set(pack.id, pack);
    return this;
  }

  get(id: string): PackManifest | undefined {
    return this.packs.get(id);
  }

  require(id: string): PackManifest {
    const pack = this.get(id);
    if (!pack) {
      throw new Error(`Pack not registered: ${id}`);
    }
    return pack;
  }

  list(): PackManifest[] {
    return Array.from(this.packs.values());
  }
}
