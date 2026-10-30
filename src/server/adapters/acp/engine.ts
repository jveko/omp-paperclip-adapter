import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { moduleDir, packageRootDir } from "./launch.js";

/**
 * The one place this package loads the acpx engine — and the only deep import
 * of `acpx-engine/execute` outside this directory (`run/execute.ts` does not
 * need it). `acp.ts` is the composition root and stays free of the engine
 * specifier; everything engine-shaped lives behind these names.
 */

export type { AcpxEngineExecutorOptions } from "@paperclipai/adapter-utils/acpx-engine/execute";
export type { AcpxEngineBillingIdentity } from "@paperclipai/adapter-utils/acpx-engine/execute";

/** Starts a run child. The ACP lane supplies the acpx engine. */
export type OmpAcpExecutor = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

/**
 * Load the engine and construct the executor for this package.
 *
 * Loaded on demand by design: the acpx engine (and its transitive CLI deps)
 * must not load until a run actually executes. This is the only dynamic import
 * of the engine in the lane; a static one would pay that cost on every import
 * of the adapter, probes included.
 */
export async function loadAcpxEngineExecutor(
  options: Omit<AcpxEngineExecutorOptions, "adapterType" | "moduleDir" | "packageRootDir">,
): Promise<OmpAcpExecutor> {
  const { createAcpxEngineExecutor } = await import(
    "@paperclipai/adapter-utils/acpx-engine/execute"
  );
  return createAcpxEngineExecutor({
    ...options,
    adapterType: "omp_local",
    moduleDir,
    packageRootDir,
  });
}
