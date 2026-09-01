import { compileHostProtocol } from "./compiler.js";
import { hostOperationGroups } from "./registry.js";

export const hostProtocol = compileHostProtocol(hostOperationGroups);
export const hostContracts = hostProtocol.operations;
export const hostContractById = hostProtocol.operationById;
