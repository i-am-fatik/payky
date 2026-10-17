import type { ValueOf } from "type-fest"
import { describe, expect, expectTypeOf, test } from "vitest"

import type { MasterKey } from "../modules/shared/key-derivation.ts"

import type { AppBackgroundJobContext } from "./background-job-types.ts"
import {
  cashuBackgroundJobs,
  getBackgroundJobsForRuntime,
  nativeBackgroundJobs,
} from "./background-jobs.ts"
import { startBillClosingJob } from "./jobs/bill-closing-job.ts"
import { startCashuAccountSyncJob } from "./jobs/cashu-account-sync-job.ts"
import { startEetReportingJob } from "./jobs/eet-reporting-job.ts"
import { startFioAccountTransactionSyncJob } from "./jobs/fio-account-transaction-sync-job.ts"
import { startSelfPayPointerJob } from "./jobs/self-pay-pointer-job.ts"
import { startSparkAccountTransactionSyncJob } from "./jobs/spark-account-transaction-sync-job.ts"
import { startTableSelfPayPublishingJob } from "./jobs/table-self-pay-publishing-job.ts"

describe("getBackgroundJobsForRuntime", () => {
  test("does not schedule the Fio job in a regular web runtime", () => {
    expect(getBackgroundJobsForRuntime(false)).toEqual([
      startSparkAccountTransactionSyncJob,
      startEetReportingJob,
      startTableSelfPayPublishingJob,
      startSelfPayPointerJob,
      startBillClosingJob,
    ])
  })

  test("schedules the Fio job in supported native runtimes", () => {
    expect(getBackgroundJobsForRuntime(true)).toEqual([
      startFioAccountTransactionSyncJob,
      startSparkAccountTransactionSyncJob,
      startEetReportingJob,
      startTableSelfPayPublishingJob,
      startSelfPayPointerJob,
      startBillClosingJob,
    ])
  })

  test("keeps the Cashu job out of the CLI, which has no Linky owners", () => {
    expect(nativeBackgroundJobs).not.toContain(startCashuAccountSyncJob)
  })

  test("keeps the Cashu job apart, so a Cashu wallet that fails to start stops no other job", () => {
    expect(getBackgroundJobsForRuntime(false)).not.toContain(
      startCashuAccountSyncJob
    )
    expect(getBackgroundJobsForRuntime(true)).not.toContain(
      startCashuAccountSyncJob
    )
    expect(cashuBackgroundJobs).toEqual([startCashuAccountSyncJob])
  })
})

describe("AppBackgroundJobContext", () => {
  test("hands jobs the self-pay root and never the master key", () => {
    expectTypeOf<AppBackgroundJobContext>().toHaveProperty("tableSelfPayRoot")
    expectTypeOf<
      Extract<ValueOf<AppBackgroundJobContext>, MasterKey>
    >().toBeNever()
  })
})
