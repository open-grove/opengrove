import type { JsonObject, JsonValue, ToolCallContext, ToolDefinition, ToolResult } from "../core.js";

export interface ToolMiddlewareContext {
  tool: ToolDefinition;
  input: JsonValue;
  callContext: ToolCallContext;
}

export interface ToolMiddleware {
  beforeToolCall?(context: ToolMiddlewareContext): Promise<void> | void;
  afterToolCall?(
    context: ToolMiddlewareContext & { result: ToolResult },
  ): Promise<ToolResult | void> | ToolResult | void;
  onToolError?(context: ToolMiddlewareContext & { error: unknown }): Promise<ToolResult | void> | ToolResult | void;
}

export class ToolMiddlewareRunner {
  private readonly middleware: ToolMiddleware[] = [];

  register(middleware: ToolMiddleware): this {
    this.middleware.push(middleware);
    return this;
  }

  list(): ToolMiddleware[] {
    return [...this.middleware];
  }

  async execute(tool: ToolDefinition, input: JsonObject, callContext: ToolCallContext): Promise<ToolResult> {
    const context: ToolMiddlewareContext = { tool, input, callContext };
    for (const middleware of this.middleware) {
      await middleware.beforeToolCall?.(context);
    }

    try {
      let result = await tool.execute(input, callContext);
      for (const middleware of this.middleware) {
        const next = await middleware.afterToolCall?.({ ...context, result });
        if (next) {
          result = next;
        }
      }
      return result;
    } catch (error) {
      for (const middleware of this.middleware) {
        const handled = await middleware.onToolError?.({ ...context, error });
        if (handled) {
          return handled;
        }
      }
      throw error;
    }
  }
}

export function createToolMiddlewareRunner(): ToolMiddlewareRunner {
  return new ToolMiddlewareRunner();
}
