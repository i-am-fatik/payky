import { optionalTextCodec } from "@payky/app-shared/inline-edit-codecs"
import { updateSettings } from "@payky/core/modules/app-settings/app-settings-actions"
import { selfPaySettingsQuery } from "@payky/core/modules/app-settings/app-settings-queries"
import { InlineEditField } from "../../../components/inline-edit-field.tsx"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.tsx"
import { useEvoluQuery } from "../../../hooks/use-evolu-query.ts"
import { useRunToast } from "../../../hooks/use-run-toast.ts"
import { useTranslation } from "../../../hooks/use-translation.ts"

/** The name the guest page shows, as web's `SelfPayGuestNameCard`. */
export function SelfPayGuestNameCard() {
  const { t } = useTranslation()
  const runToast = useRunToast()
  const {
    data: [settings],
  } = useEvoluQuery(selfPaySettingsQuery)

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
          onSave={(selfPayGuestName) =>
            runToast(async (run) => {
              await run.ok(updateSettings({ selfPayGuestName }))
            })
          }
        />
      </CardContent>
    </Card>
  )
}
