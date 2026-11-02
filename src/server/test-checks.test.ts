import { describe, expect, it } from "vitest";
import { evaluateOtlpCheck, evaluateSessionScopeCheck } from "./test.js";
import { validateSessionScope } from "./session-directives.js";

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
describe("evaluateSessionScopeCheck", () => {
  it("warns that the default scope shares sessions host-wide", () => {
    const check = evaluateSessionScopeCheck({});
    expect(check.level).toBe("warn");
    expect(check.code).toBe("omp_sessions_shared");
    expect(check.message).toContain("host-wide");
  });
  it("takes the isolated scope by default under broker credentials", () => {
    const check = evaluateSessionScopeCheck({ credentialMode: "broker" });
    expect(check.level).toBe("info");
    expect(check.code).toBe("omp_sessions_isolated");
  });
  it("warns only for an explicit shared scope under broker credentials", () => {
    const check = evaluateSessionScopeCheck({ sessionScope: "shared", credentialMode: "broker" });
    expect(check.level).toBe("warn");
    expect(check.code).toBe("omp_sessions_shared_cross_tenant");
    expect(check.message).toContain("cross-tenant");
    // The non-broker default keeps its existing warning, not the cross-tenant one.
    expect(evaluateSessionScopeCheck({ sessionScope: "shared" }).code).toBe("omp_sessions_shared");
    expect(evaluateSessionScopeCheck({ credentialMode: "local" }).code).toBe("omp_sessions_shared");
  });
  it("fails isolated without broker credentials, same message as the run path", () => {
    const check = evaluateSessionScopeCheck({ sessionScope: "isolated" });
    expect(check.level).toBe("error");
    expect(check.code).toBe("omp_config_error");
    expect(check.message).toBe(validateSessionScope({ sessionScope: "isolated" }));
  });
  it("fails an unknown scope rather than silently running shared", () => {
    const check = evaluateSessionScopeCheck({ sessionScope: "Isolated" });
    expect(check.level).toBe("error");
    expect(check.code).toBe("omp_config_error");
  });
  it("reports an isolated, broker-backed scope as clean", () => {
    const check = evaluateSessionScopeCheck({ sessionScope: "isolated", credentialMode: "broker" });
    expect(check.level).toBe("info");
    expect(check.code).toBe("omp_sessions_isolated");
    expect(check.message).toContain("omp-agent");
  });
});
