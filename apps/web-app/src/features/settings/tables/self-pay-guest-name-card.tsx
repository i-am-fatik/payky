import { optionalTextCodec } from "@payky/app-shared/inline-edit-codecs"
import { updateSettings } from "@payky/core/modules/app-settings/app-settings-actions"
import { selfPaySettingsQuery } from "@payky/core/modules/app-settings/app-settings-queries"
import type { NonEmptyString255 } from "@payky/core/modules/shared/schema"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx"
import { InlineEditField } from "@/features/settings/inline-edit-field.tsx"
import { useAppRun } from "@/hooks/use-app-run.ts"
import { useEvoluQuery } from "@/hooks/use-evolu-query.ts"
import { useTranslation } from "@/hooks/use-translation.ts"

export function SelfPayGuestNameCard() {
  const { t } = useTranslation()
  const appRun = useAppRun()
  const {
    data: [settings],
  } = useEvoluQuery(selfPaySettingsQuery)

  const save = async (selfPayGuestName: NonEmptyString255 | null) => {
    await using run = appRun()
    await run.ok(updateSettings({ selfPayGuestName }))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.tables.selfPay.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <InlineEditField
          label={t("settings.tables.selfPayGuestName.label")}
          description={t("settings.tables.selfPayGuestName.description")}
          placeholder={t("settings.tables.selfPayGuestName.placeholder")}
          defaultValue={settings?.selfPayGuestName ?? null}
          codec={optionalTextCodec}
          errorKey="settings.tables.selfPayGuestName.error"
          onSave={save}
        />
      </CardContent>
    </Card>
  )
}
