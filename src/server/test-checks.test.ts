import { describe, expect, it } from "vitest";
import { evaluateOtlpCheck } from "./test.js";

describe("evaluateOtlpCheck", () => {
  it("off when no endpoint", () => {
    expect(evaluateOtlpCheck({})?.code).toBe("omp_otlp_export_off");
  });
  it("armed when endpoint set with http/protobuf (default protocol)", () => {
    const c = evaluateOtlpCheck({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" });
    expect(c?.code).toBe("omp_otlp_export_armed");
  });
  it("warns on a non-http/protobuf protocol (omp declines that signal)", () => {
    const c = evaluateOtlpCheck({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    expect(c?.level).toBe("warn");
    expect(c?.code).toBe("omp_otlp_protocol_unsupported");
  });
  it("arms when only a signal-specific endpoint is set", () => {
    const c = evaluateOtlpCheck({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" });
    expect(c?.code).toBe("omp_otlp_export_armed");
  });
  it("warns when a signal-specific protocol is non-http/protobuf with a generic endpoint", () => {
    const c = evaluateOtlpCheck({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc" });
    expect(c?.level).toBe("warn");
    expect(c?.code).toBe("omp_otlp_protocol_unsupported");
  });
  it("warns when a signal-specific protocol is non-http/protobuf with that signal's endpoint", () => {
    const c = evaluateOtlpCheck({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://c:4318/v1/metrics", OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc" });
    expect(c?.level).toBe("warn");
    expect(c?.code).toBe("omp_otlp_protocol_unsupported");
  });
});