/**
 * The engine's stdout-event parser, re-exported here so the UI bundle's entry
 * point (src/ui-parser.ts) depends on this package's adapter directory rather
 * than on an engine deep import. The bundle stays self-contained: esbuild
 * inlines the engine module either way.
 */
export { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";
