import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createOmpAcpExecutor } from "./acp.js";

const executor = createOmpAcpExecutor();

/**
 * The package's run entry. The supervisor owns the per-session lease (it is the
 * one process that stays alive across runs and the only reaper), so the adapter
 * holds none: it composes the plan and hands the run to the instance's omp-host.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return executor(ctx);
}
