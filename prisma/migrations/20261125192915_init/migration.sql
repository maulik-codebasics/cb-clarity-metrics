-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('CRON_CLI', 'CRON_HTTP', 'MANUAL', 'REPROCESS');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'SKIPPED_LOCKED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED_BUDGET');

-- CreateEnum
CREATE TYPE "ErrorCode" AS ENUM ('AUTH_ERROR', 'RATE_LIMITED', 'BAD_REQUEST', 'SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'PARSE_ERROR', 'DB_ERROR', 'BUDGET_EXHAUSTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "KpiUnit" AS ENUM ('percent', 'count', 'seconds', 'minutes', 'ratio');

-- CreateEnum
CREATE TYPE "KpiAggregation" AS ENUM ('weighted_avg', 'avg', 'sum', 'last');

-- CreateTable
CREATE TABLE "pipeline_runs" (
    "id" UUID NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "num_of_days" INTEGER NOT NULL DEFAULT 1,
    "window_start" TIMESTAMPTZ(3),
    "window_end" TIMESTAMPTZ(3),
    "reprocess_of_run_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "pulls_total" INTEGER NOT NULL DEFAULT 0,
    "pulls_succeeded" INTEGER NOT NULL DEFAULT 0,
    "pulls_failed" INTEGER NOT NULL DEFAULT 0,
    "pulls_skipped" INTEGER NOT NULL DEFAULT 0,
    "api_calls_used" INTEGER NOT NULL DEFAULT 0,
    "rows_fetched" INTEGER NOT NULL DEFAULT 0,
    "metrics_written" INTEGER NOT NULL DEFAULT 0,
    "error_code" "ErrorCode",
    "error_message" TEXT,
    "error_details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_run_steps" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "pull_key" TEXT NOT NULL,
    "dimensions" TEXT[],
    "attempt" INTEGER NOT NULL,
    "http_status" INTEGER,
    "status" "StepStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "rows_fetched" INTEGER NOT NULL DEFAULT 0,
    "metrics_written" INTEGER NOT NULL DEFAULT 0,
    "error_code" "ErrorCode",
    "error_message" TEXT,
    "error_details" JSONB,

    CONSTRAINT "pipeline_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_responses" (
    "id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "pull_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_values" (
    "id" BIGSERIAL NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "pull_key" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "dim1_name" TEXT NOT NULL DEFAULT '',
    "dim1_value" TEXT NOT NULL DEFAULT '',
    "dim2_name" TEXT NOT NULL DEFAULT '',
    "dim2_value" TEXT NOT NULL DEFAULT '',
    "dim3_name" TEXT NOT NULL DEFAULT '',
    "dim3_value" TEXT NOT NULL DEFAULT '',
    "value" DECIMAL(20,6) NOT NULL,
    "run_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_call_log" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID,
    "step_id" UUID,
    "called_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "http_status" INTEGER,
    "budget_date" DATE NOT NULL,

    CONSTRAINT "api_call_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_configs" (
    "key" TEXT NOT NULL,
    "dimensions" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "pull_configs_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "kpi_definitions" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "unit" "KpiUnit" NOT NULL,
    "aggregation" "KpiAggregation" NOT NULL,
    "higher_is_better" BOOLEAN NOT NULL,
    "display_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "kpi_definitions_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "pipeline_runs_started_at_idx" ON "pipeline_runs"("started_at" DESC);

-- CreateIndex
CREATE INDEX "pipeline_runs_status_started_at_idx" ON "pipeline_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "pipeline_runs_snapshot_date_idx" ON "pipeline_runs"("snapshot_date");

-- CreateIndex
CREATE INDEX "pipeline_run_steps_run_id_idx" ON "pipeline_run_steps"("run_id");

-- CreateIndex
CREATE INDEX "raw_responses_fetched_at_idx" ON "raw_responses"("fetched_at");

-- CreateIndex
CREATE INDEX "raw_responses_snapshot_date_pull_key_idx" ON "raw_responses"("snapshot_date", "pull_key");

-- CreateIndex
CREATE INDEX "metric_values_snapshot_date_idx" ON "metric_values"("snapshot_date");

-- CreateIndex
CREATE INDEX "metric_values_metric_name_field_snapshot_date_idx" ON "metric_values"("metric_name", "field", "snapshot_date");

-- CreateIndex
CREATE INDEX "metric_values_pull_key_snapshot_date_idx" ON "metric_values"("pull_key", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "metric_values_natural_key" ON "metric_values"("snapshot_date", "pull_key", "metric_name", "field", "dim1_value", "dim2_value", "dim3_value");

-- CreateIndex
CREATE INDEX "api_call_log_budget_date_idx" ON "api_call_log"("budget_date");

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_reprocess_of_run_id_fkey" FOREIGN KEY ("reprocess_of_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_run_steps" ADD CONSTRAINT "pipeline_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_responses" ADD CONSTRAINT "raw_responses_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "pipeline_run_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pipeline_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_call_log" ADD CONSTRAINT "api_call_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_call_log" ADD CONSTRAINT "api_call_log_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "pipeline_run_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
