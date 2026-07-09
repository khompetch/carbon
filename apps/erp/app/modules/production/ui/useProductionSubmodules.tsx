import { useLingui } from "@lingui/react/macro";
import {
  LuChartLine,
  LuCirclePlay,
  LuGauge,
  LuListChecks,
  LuSquareChartGantt,
  LuSquareKanban,
  LuTrash
} from "react-icons/lu";
import { usePermissions } from "~/hooks";
import { useSavedViews } from "~/hooks/useSavedViews";
import type { AuthenticatedRouteGroup } from "~/types";
import { path } from "~/utils/path";

export default function useProductionSubmodules() {
  const { t } = useLingui();
  const permissions = usePermissions();

  const productionRoutes: AuthenticatedRouteGroup[] = [
    {
      name: t`Production`,
      routes: [
        {
          name: t`Jobs`,
          to: path.to.jobs,
          icon: <LuCirclePlay />,
          table: "job"
        },
        {
          name: t`OEE`,
          to: path.to.productionOee,
          icon: <LuGauge />,
          role: "employee"
        },
        {
          name: t`Procedures`,
          to: path.to.procedures,
          icon: <LuListChecks />,
          table: "procedure",
          role: "employee"
        }
      ]
    },
    {
      name: t`Plan`,
      routes: [
        {
          name: t`Planning`,
          to: path.to.productionPlanning,
          icon: <LuSquareChartGantt />,
          table: "production-planning"
        },
        {
          name: t`Projections`,
          to: path.to.demandProjections,
          icon: <LuChartLine />,
          table: "demand-projection"
        },
        {
          name: t`Schedule`,
          to: path.to.scheduleDates,
          icon: <LuSquareKanban />
        }
      ]
    },
    {
      name: t`Configure`,
      routes: [
        {
          name: t`Scrap Reasons`,
          to: path.to.scrapReasons,
          role: "employee",
          icon: <LuTrash />
        }
      ]
    }
  ];
  const { addSavedViewsToRoutes } = useSavedViews();

  return {
    groups: productionRoutes
      .filter((group) => {
        const filteredRoutes = group.routes.filter((route) => {
          if (route.role) {
            return permissions.is(route.role);
          } else {
            return true;
          }
        });

        return filteredRoutes.length > 0;
      })
      .map((group) => ({
        ...group,
        routes: group.routes
          .filter((route) => {
            if (route.role) {
              return permissions.is(route.role);
            } else {
              return true;
            }
          })
          .map(addSavedViewsToRoutes)
      }))
  };
}
