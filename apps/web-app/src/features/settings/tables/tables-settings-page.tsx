import { tablesExistQuery } from "@payky/core/modules/table/table-queries"
import { selfPayTablesQuery } from "@payky/core/modules/table-self-pay/table-self-pay-queries"
import { type ReactNode, Suspense, useState } from "react"
import { ListSkeleton } from "@/components/list-skeleton.tsx"
import { SearchInput } from "@/components/search-input.tsx"
import { SettingsListPage } from "@/features/settings/settings-list-page.tsx"
import { SelfPayGuestNameCard } from "@/features/settings/tables/self-pay-guest-name-card.tsx"
import { SelfPayOptionsCard } from "@/features/settings/tables/self-pay-options-card.tsx"
import { TableStickerCheck } from "@/features/settings/tables/table-sticker-check.tsx"
import { TablesList } from "@/features/settings/tables/tables-list.tsx"
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts"
import { useEvoluQuery } from "@/hooks/use-evolu-query.ts"
import { useTranslation } from "@/hooks/use-translation.ts"

export function TablesSettingsPage() {
  const { t } = useTranslation()

  return (
    <SettingsListPage
      title={t("settings.tables.title")}
      addAriaLabel={t("settings.tables.add")}
      addTo="/settings/tables/new"
    >
      <TablesSettingsBody />
    </SettingsListPage>
  )
}

function TablesSettingsBody() {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebouncedValue(search, 250)

  const searchInput = (
    <SearchInput
      value={search}
      onChange={setSearch}
      placeholder={t("settings.tables.search")}
      clearAriaLabel={t("settings.tables.search.clear.aria")}
    />
  )

  return (
    <Suspense
      fallback={
        <>
          {searchInput}
          <ListSkeleton />
        </>
      }
    >
      <TablesSettingsContent
        searchInput={searchInput}
        search={debouncedSearch}
      />
    </Suspense>
  )
}

function TablesSettingsContent({
  searchInput,
  search,
}: {
  readonly searchInput: ReactNode
  readonly search: string
}) {
  const { data: existRows } = useEvoluQuery(tablesExistQuery)
  const { data: selfPayTables } = useEvoluQuery(selfPayTablesQuery)
  const hasAny = existRows.length > 0
  const takesSelfPay = selfPayTables.some(
    ({ selfPayEnabled }) => selfPayEnabled === 1
  )

  return (
    <>
      {hasAny && searchInput}
      {hasAny && <TableStickerCheck />}

      <Suspense fallback={<ListSkeleton />}>
        <TablesList search={search} hasAny={hasAny} />
      </Suspense>
      {takesSelfPay && <SelfPayGuestNameCard />}
      {takesSelfPay && <SelfPayOptionsCard />}
    </>
  )
}
