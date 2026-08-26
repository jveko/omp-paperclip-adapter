import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";

const executor = createOmpAcpExecutor();

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return executor(ctx);
}
