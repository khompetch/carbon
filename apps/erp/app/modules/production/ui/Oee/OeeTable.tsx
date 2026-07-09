import { Table, Tbody, Td, Th, Thead, Tr } from "@carbon/react";
import { formatDurationMilliseconds } from "@carbon/utils";
import { Trans } from "@lingui/react/macro";
import { formatPercent, type OeeGroup } from "./types";

const OeeTable = ({ groups }: { groups: OeeGroup[] }) => {
  return (
    <div className="w-full overflow-x-auto">
      <Table>
        <Thead>
          <Tr>
            <Th>
              <Trans>Name</Trans>
            </Th>
            <Th className="text-right">
              <Trans>OEE</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Availability</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Performance</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Quality</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Runtime</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Planned</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Downtime</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Good</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Scrap</Trans>
            </Th>
            <Th className="text-right">
              <Trans>Rework</Trans>
            </Th>
          </Tr>
        </Thead>
        <Tbody>
          {groups.map((group) => (
            <Tr key={group.id}>
              <Td className="font-medium">{group.name}</Td>
              <Td className="text-right font-mono font-semibold">
                {formatPercent(group.oee)}
              </Td>
              <Td className="text-right font-mono">
                {formatPercent(group.availability)}
              </Td>
              <Td className="text-right font-mono">
                {formatPercent(group.performance)}
              </Td>
              <Td className="text-right font-mono">
                {formatPercent(group.quality)}
              </Td>
              <Td className="text-right font-mono">
                {formatDurationMilliseconds(group.runtimeMs)}
              </Td>
              <Td className="text-right font-mono">
                {group.plannedMs > 0
                  ? formatDurationMilliseconds(group.plannedMs)
                  : "–"}
              </Td>
              <Td className="text-right font-mono">
                {group.downtimeMs > 0
                  ? formatDurationMilliseconds(group.downtimeMs)
                  : "–"}
              </Td>
              <Td className="text-right font-mono">{group.good}</Td>
              <Td className="text-right font-mono">{group.scrap}</Td>
              <Td className="text-right font-mono">{group.rework}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </div>
  );
};

export default OeeTable;
