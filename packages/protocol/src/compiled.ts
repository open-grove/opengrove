import { compileHostProtocol, type CompiledHostProtocol } from "./compiler.js";
import { hostOperationGroups } from "./registry.js";

export const hostProtocol: CompiledHostProtocol<typeof hostOperationGroups> = compileHostProtocol(hostOperationGroups);
export const hostContracts: (typeof hostProtocol)["operations"] = hostProtocol.operations;
export const hostContractById: (typeof hostProtocol)["operationById"] = hostProtocol.operationById;
