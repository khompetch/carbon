import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton
} from "@carbon/react";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { formatPercent, type OeeTotals } from "./types";

function TrendBadge({
  current,
  previous
}: {
  current: number | null;
  previous: number | null | undefined;
}) {
  if (
    current === null ||
    previous === null ||
    previous === undefined ||
    previous === 0
  ) {
    return null;
  }
  const change = ((current - previous) / previous) * 100;
  return change >= 0 ? (
    <Badge variant="green">+{change.toFixed(0)}%</Badge>
  ) : (
    <Badge variant="red">{change.toFixed(0)}%</Badge>
  );
}

function StatCard({
  title,
  value,
  previousValue,
  isLoading
}: {
  title: ReactNode;
  value: number | null;
  previousValue: number | null | undefined;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-muted-foreground text-sm font-medium">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-10 w-[100px]" />
        ) : (
          <div className="flex items-baseline gap-2">
            <h3 className="text-4xl font-medium tracking-tighter">
              {formatPercent(value)}
            </h3>
            <TrendBadge current={value} previous={previousValue} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const OeeStatCards = ({
  totals,
  previousTotals,
  isLoading
}: {
  totals: OeeTotals | null | undefined;
  previousTotals: OeeTotals | null | undefined;
  isLoading: boolean;
}) => {
  return (
    <div className="grid w-full gap-4 grid-cols-2 lg:grid-cols-4">
      <StatCard
        title={<Trans>OEE</Trans>}
        value={totals?.oee ?? null}
        previousValue={previousTotals?.oee}
        isLoading={isLoading}
      />
      <StatCard
        title={<Trans>Availability</Trans>}
        value={totals?.availability ?? null}
        previousValue={previousTotals?.availability}
        isLoading={isLoading}
      />
      <StatCard
        title={<Trans>Performance</Trans>}
        value={totals?.performance ?? null}
        previousValue={previousTotals?.performance}
        isLoading={isLoading}
      />
      <StatCard
        title={<Trans>Quality</Trans>}
        value={totals?.quality ?? null}
        previousValue={previousTotals?.quality}
        isLoading={isLoading}
      />
    </div>
  );
};

export default OeeStatCards;
