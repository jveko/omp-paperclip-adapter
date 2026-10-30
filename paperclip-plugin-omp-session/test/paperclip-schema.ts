/**
 * Column truth for the two Paperclip core tables this plugin reads, derived
 * from paperclip's drizzle schema (paperclip@3edba11,
 * packages/db/src/schema/{heartbeat_runs,cost_events}.ts).
 *
 * The worker runs raw SQL through the plugin host (`ctx.db.query` →
 * `db.execute` on a postgres.js connection, no type parsers), so a wrong column
 * name is an empty result or a query error the worker reports as "no runs", and
 * a `numeric` column arrives as a STRING. This descriptor lets the test drive
 * the handler with rows shaped the way the driver really returns them and fail
 * on any column the query names that the schema does not have.
 */
export type ColumnType =
  | "uuid" | "text" | "timestamp" | "jsonb" | "numeric" | "integer" | "bigint" | "boolean";

/** Bare SQL words that are not column references. */
const SQL_KEYWORDS: Readonly<Record<string, true>> = {
  select: true, from: true, where: true, order: true, by: true, desc: true, asc: true,
  limit: true, offset: true, and: true, or: true, not: true, any: true, all: true,
  as: true, is: true, null: true, true: true, false: true,
};

export const PAPERCLIP_SCHEMA: Readonly<Record<string, Readonly<Record<string, ColumnType>>>> = {
  heartbeat_runs: {
    id: "uuid",
    company_id: "uuid",
    agent_id: "uuid",
    scope_kind: "text",
    issue_id: "uuid",
    invocation_source: "text",
    trigger_detail: "text",
    status: "text",
    responsible_user_id: "text",
    active_identity_context_id: "uuid",
    started_at: "timestamp",
    finished_at: "timestamp",
    execution_control_deadline_at: "timestamp",
    execution_status_delivery_id: "uuid",
    error: "text",
    wakeup_request_id: "uuid",
    exit_code: "integer",
    signal: "text",
    cost_accounting_pending: "boolean",
    cost_accounted_at: "timestamp",
    accounting_projection_version: "text",
    accounting_last_attempt_at: "timestamp",
    accounting_last_error: "text",
    accounting_attempt_count: "integer",
    usage_json: "jsonb",
    result_json: "jsonb",
    runtime_mode: "text",
    runtime_mode_resolver_version: "text",
    runtime_mode_reason: "text",
    runtime_mode_resolved_at: "timestamp",
    runner_profile_json: "jsonb",
    runner_instance_id: "uuid",
    native_session_id: "uuid",
    native_issue_id: "uuid",
    driver_kind: "text",
    driver_version: "text",
    completion_contract_id: "uuid",
    completion_contract_sha256: "text",
    next_event_seq: "bigint",
    native_phase: "text",
    native_phase_updated_at: "timestamp",
    session_id_before: "text",
    session_id_after: "text",
    log_store: "text",
    log_ref: "text",
    log_bytes: "bigint",
    log_sha256: "text",
    log_compressed: "boolean",
    stdout_excerpt: "text",
    stderr_excerpt: "text",
    error_code: "text",
    external_run_id: "text",
    controller_boot_id: "uuid",
    controller_lease_expires_at: "timestamp",
    execution_stage: "text",
    process_pid: "integer",
    process_group_id: "integer",
    process_started_at: "timestamp",
    last_output_at: "timestamp",
    last_output_seq: "integer",
    last_output_stream: "text",
    last_output_bytes: "bigint",
    retry_of_run_id: "uuid",
    process_loss_retry_count: "integer",
    scheduled_retry_at: "timestamp",
    scheduled_retry_attempt: "integer",
    scheduled_retry_reason: "text",
    issue_comment_status: "text",
    issue_comment_satisfied_by_comment_id: "uuid",
    issue_comment_retry_queued_at: "timestamp",
    liveness_state: "text",
    liveness_reason: "text",
    continuation_attempt: "integer",
    last_useful_action_at: "timestamp",
    next_action: "text",
    context_snapshot: "jsonb",
    created_at: "timestamp",
    updated_at: "timestamp",
  },
  cost_events: {
    id: "uuid",
    company_id: "uuid",
    agent_id: "uuid",
    usage_kind: "text",
    responsible_user_id: "text",
    issue_id: "uuid",
    project_id: "uuid",
    goal_id: "uuid",
    heartbeat_run_id: "uuid",
    subscription_id: "uuid",
    billing_code: "text",
    idempotency_key: "text",
    receipt_hash: "text",
    provider_request_id: "text",
    reported_cost_cents: "numeric",
    pricing_provenance: "jsonb",
    provider: "text",
    biller: "text",
    billing_type: "text",
    cost_status: "text",
    model: "text",
    input_tokens: "integer",
    cached_input_tokens: "integer",
    output_tokens: "integer",
    cost_cents: "numeric",
    occurred_at: "timestamp",
    created_at: "timestamp",
  },
};

/** Every identifier the query mentions must be a column of the table it names. */
export function assertQueryColumns(sql: string, table: string): void {
  const columns = PAPERCLIP_SCHEMA[table];
  if (!columns) throw new Error(`unknown table "${table}" in test fixture`);
  if (!sql.includes(table)) {
    throw new Error(`query does not name "${table}": ${sql}`);
  }
  for (const raw of sql.match(/[a-z_][a-z0-9_]*/gi) ?? []) {
    const word = raw.toLowerCase();
    if (word === table || Object.hasOwn(SQL_KEYWORDS, word)) continue;
    if (!Object.hasOwn(columns, word)) {
      throw new Error(`query names unknown column "${word}" on ${table}`);
    }
  }
}

/**
 * Shape fixture rows the way postgres.js hands them to the plugin worker:
 * `numeric` is a string (unparsed), everything else keeps its JS form.
 * Unknown fixture keys fail loudly so a fixture cannot drift from the schema.
 */
export function postgresRows<T>(table: string, rows: ReadonlyArray<Record<string, unknown>>): T[] {
  const columns = PAPERCLIP_SCHEMA[table];
  if (!columns) throw new Error(`unknown table "${table}" in test fixture`);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const type = columns[key];
      if (!type) throw new Error(`fixture row has unknown column "${key}" on ${table}`);
      out[key] = type === "numeric" && typeof value === "number"
        ? value.toFixed(7)
        : value;
    }
    return out as T;
  });
}
