import type {
  AppBackgroundJob,
  CashuBackgroundJob,
} from "./background-job-types.ts"
import { startCashuAccountSyncJob } from "./jobs/cashu-account-sync-job.ts"
import { startEetReportingJob } from "./jobs/eet-reporting-job.ts"
import { startFioAccountTransactionSyncJob } from "./jobs/fio-account-transaction-sync-job.ts"
import { startSelfPayPointerJob } from "./jobs/self-pay-pointer-job.ts"
import { startSparkAccountTransactionSyncJob } from "./jobs/spark-account-transaction-sync-job.ts"
import { startTableSelfPayPublishingJob } from "./jobs/table-self-pay-publishing-job.ts"

export const nativeBackgroundJobs = [
  startFioAccountTransactionSyncJob,
  startSparkAccountTransactionSyncJob,
  startEetReportingJob,
  startTableSelfPayPublishingJob,
  startSelfPayPointerJob,
] satisfies ReadonlyArray<AppBackgroundJob>

/**
 * A browser or PWA can't reach the FIO API directly, so its sync job is left
 * out there — the same limitation the Fio settings screen warns about in
 * `settings.fioPlugin.nativeRuntimeWarning`.
 */
const browserBackgroundJobs = [
  startSparkAccountTransactionSyncJob,
  startEetReportingJob,
  startTableSelfPayPublishingJob,
  startSelfPayPointerJob,
] satisfies ReadonlyArray<AppBackgroundJob>

export function getBackgroundJobsForRuntime(
  isNativePlatform: boolean
): ReadonlyArray<AppBackgroundJob> {
  return isNativePlatform ? nativeBackgroundJobs : browserBackgroundJobs
}

/**
 * The shared Cashu wallet's job, on native and browser alike. It runs apart
 * from the others (`CashuBackgroundJobs`), so a Cashu wallet that fails to
 * start, or never does, holds up none of them.
 */
export const cashuBackgroundJobs = [
  startCashuAccountSyncJob,
] satisfies ReadonlyArray<CashuBackgroundJob>
