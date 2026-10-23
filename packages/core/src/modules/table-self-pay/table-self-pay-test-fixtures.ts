import { deriveTableSelfPayRoot, MasterKey } from "../shared/key-derivation.ts"

export const selfPayTestMasterKey = MasterKey(
  "000102030405060708090a0b0c0d0e0f"
)

export const selfPayTestRoot = deriveTableSelfPayRoot(selfPayTestMasterKey)
