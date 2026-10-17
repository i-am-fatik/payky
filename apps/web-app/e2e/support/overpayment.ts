import type { Language } from "@payky/app-shared/i18n/resources"
import type { Locator, Page } from "@playwright/test"
import { simulateBillModifiedDuringPayment } from "./collisions.ts"
import { translate } from "./i18n.ts"
import {
  markCashPaidAndSettle,
  startBillAndBeginCashPayment,
} from "./payment.ts"

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

const startingWith = (text: string) => new RegExp(`^${escapeRegExp(text)}`, "u")

export const overpaymentCard = (page: Page): Locator =>
  page.getByTestId("overpayment-card")

export const overpaidByPattern = (language: Language): RegExp => {
  const [prefix = ""] = translate(language, "overpayment.title").split(
    "{amount}"
  )
  return startingWith(prefix)
}

export async function openOverpaymentResolution(
  page: Page,
  language: Language,
  kind: "tip" | "kept"
): Promise<Locator> {
  await overpaymentCard(page)
    .getByRole("button", {
      name: translate(
        language,
        kind === "tip" ? "overpayment.action.tip" : "overpayment.action.keep"
      ),
    })
    .click()
  return page.getByRole("dialog")
}

export async function submitOverpaymentResolution(
  page: Page,
  language: Language,
  { kind, amount }: { readonly kind: "tip" | "kept"; readonly amount: string }
): Promise<Locator> {
  const dialog = await openOverpaymentResolution(page, language, kind)
  await dialog
    .getByLabel(translate(language, "overpayment.dialog.amount"))
    .fill(amount)
  if (kind === "tip") {
    await dialog
      .getByRole("checkbox", {
        name: translate(language, "overpayment.dialog.tipConfirm"),
      })
      .check()
  }
  const [confirmPrefix = ""] = translate(
    language,
    kind === "tip"
      ? "overpayment.dialog.confirm.tip"
      : "overpayment.dialog.confirm.keep"
  ).split("{amount}")
  await dialog
    .getByRole("button", { name: startingWith(confirmPrefix) })
    .click()
  return dialog
}

export async function resolveOverpayment(
  page: Page,
  language: Language,
  resolution: { readonly kind: "tip" | "kept"; readonly amount: string }
): Promise<void> {
  const dialog = await submitOverpaymentResolution(page, language, resolution)
  await dialog.waitFor({ state: "hidden" })
}

export async function withdrawOverpaymentAnswer(
  page: Page,
  language: Language,
  labelKey: "overpayment.breakdown.tip" | "overpayment.breakdown.kept"
): Promise<void> {
  await overpaymentCard(page)
    .getByTestId("overpayment-answer")
    .filter({ hasText: translate(language, labelKey) })
    .getByRole("button", { name: translate(language, "overpayment.withdraw") })
    .click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: translate(language, "overpayment.withdraw") })
    .click()
}

export async function openOverpaymentReturn(
  page: Page,
  language: Language
): Promise<Locator> {
  await overpaymentCard(page)
    .getByRole("button", {
      name: translate(language, "overpayment.action.return"),
    })
    .click()
  return page.getByRole("dialog")
}

export async function confirmRefund(
  dialog: Locator,
  language: Language
): Promise<void> {
  const [confirmPrefix = ""] = translate(
    language,
    "refund.dialog.confirm"
  ).split("{amount}")
  await dialog
    .getByRole("button", {
      name: new RegExp(`^${escapeRegExp(confirmPrefix)}.+`, "u"),
    })
    .click()
  await dialog.waitFor({ state: "hidden" })
}

export async function startPartlyPaidBill(
  page: Page,
  language: Language
): Promise<string> {
  const billId = await startBillAndBeginCashPayment(page, language)
  await simulateBillModifiedDuringPayment(page, billId, "add")
  await markCashPaidAndSettle(page, language)
  await page.goto(`/bill?billId=${billId}`, { waitUntil: "domcontentloaded" })
  await page
    .getByRole("heading", { name: translate(language, "bill.title") })
    .waitFor()
  return billId
}
