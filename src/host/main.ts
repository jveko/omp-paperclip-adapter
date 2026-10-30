import { runCli } from "./cli.js";

/**
 * `dist/omp-host.js` entry point. `serve` is what the adapter spawns; the other
 * commands are the operator surface. Signals close the host through the same
 * drain path as an idle exit, so in-flight runs are journaled, not dropped.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const io = {
    out: (text: string) => process.stdout.write(text),
    err: (text: string) => process.stderr.write(text),
  };
  process.exitCode = await runCli(args, io);
}

main().catch((err: unknown) => {
  process.stderr.write(`omp-host: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
