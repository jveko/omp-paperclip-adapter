import { describe, expect, it } from "vitest";
import { ompEnv } from "./omp-env.js";

describe("ompEnv", () => {
  it("returns {} for an empty config", () => {
    expect(ompEnv({ config: {} })).toEqual({});
  });
  it("includes broker vars only in broker mode (resolved strings)", () => {
    expect(ompEnv({
      config: { credentialMode: "broker", env: { OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" } },
    })).toEqual({ OMP_AUTH_BROKER_URL: "http://b:8765", OMP_AUTH_BROKER_TOKEN: "tok" });
    expect(ompEnv({ config: { credentialMode: "local", env: { OMP_AUTH_BROKER_URL: "http://b:8765" } } })).toEqual({});
  });
  it("passes through OTEL_EXPORTER_OTLP_* only", () => {
    expect(ompEnv({
      config: { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf", OTEL_SERVICE_NAME: "omp", OTHER: "x" } },
    })).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" });
  });
  it("sets PI_CONFIG_FILES when an overlay path is given", () => {
    expect(ompEnv({ config: {}, overlayPath: "/x/omp-failover-config.yml" }))
      .toEqual({ PI_CONFIG_FILES: "/x/omp-failover-config.yml" });
  });
  it("forwards the operator's PI_CONFIG_FILES when no overlay is given", () => {
    expect(ompEnv({ config: { env: { PI_CONFIG_FILES: "/op/x.yml" } } }))
      .toEqual({ PI_CONFIG_FILES: "/op/x.yml" });
  });
  it("appends the overlay to the operator's existing PI_CONFIG_FILES list", () => {
    expect(ompEnv({ config: { env: { PI_CONFIG_FILES: "/op/x.yml" } }, overlayPath: "/ov/y.yml" }))
      .toEqual({ PI_CONFIG_FILES: "/op/x.yml:/ov/y.yml" });
  });
});
