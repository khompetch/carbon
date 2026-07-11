import { isAuthProviderEnabled } from "@carbon/auth";
import { useLingui } from "@lingui/react/macro";
import { CgProfile } from "react-icons/cg";
import { LuLock } from "react-icons/lu";
import type { Route } from "~/types";
import { path } from "~/utils/path";

export default function useAccountSubmodules() {
  const { t } = useLingui();
  const accountRoutes: Route[] = [
    {
      name: t`Profile`,
      to: path.to.profile,
      icon: <CgProfile />
    }
  ];
  if (isAuthProviderEnabled("password")) {
    accountRoutes.push({
      name: t`Password`,
      to: path.to.accountPassword,
      icon: <LuLock />
    });
  }
  return { links: accountRoutes };
}
