import { z } from "zod";

export type BridgeJsonContract = Readonly<{
  id: string;
  request?: z.ZodType;
  response: z.ZodType;
}>;

export type BridgeContractRequest<TContract extends BridgeJsonContract> = TContract["request"] extends z.ZodType
  ? z.input<TContract["request"]>
  : never;

export type BridgeContractResponse<TContract extends BridgeJsonContract> = z.output<TContract["response"]>;

export type BridgeContractIssue = {
  path: string;
  code: string;
};

export function defineBridgeJsonContract<const TContract extends BridgeJsonContract>(contract: TContract): TContract {
  return contract;
}

export function bridgeContractIssues(error: z.ZodError): BridgeContractIssue[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join(".") || "$",
    code: issue.code,
  }));
}
