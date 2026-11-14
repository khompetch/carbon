// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import { ValidatedForm } from "@carbon/form";
import { useAction } from "@carbon/query";
import {
  Button,
  cn,
  DrawerBody,
  HStack,
  IconButton,
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Tr,
  toast,
  VStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useState } from "react";
import { LuPencil, LuPlus, LuTrash, LuTriangleAlert } from "react-icons/lu";
import type { z } from "zod";
import {
  Boolean as BooleanField,
  Hidden,
  Input,
  Location,
  Number as NumberField,
  Submit
} from "~/components/Form";
import { ConfirmDelete } from "~/components/Modals";
import RulesUpgradeOverlay from "~/components/RulesUpgradeOverlay";
import { useDateFormatter, usePermissions } from "~/hooks";
import { usePlanGate } from "~/hooks/usePlanGate";
import { pulseDeviceUpsertValidator } from "~/modules/settings/settings.models";

/**
 * A local mirror of the `pulseDevice` row the loader reads (see
 * `getPulseDevicesTabData`). Not imported from the service, for the same
 * reason `OeeDevices.ee.tsx` mirrors its rows: the route passes real rows, so
 * any drift fails typecheck there.
 */
export type PulseDeviceRow = {
  id: string;
  deviceKey: string;
  name: string;
  locationId: string | null;
  piecesPerPulse: number;
  expectedCycleSeconds: number | null;
  idleAfterSeconds: number | null;
  offlineAfterSeconds: number;
  debounceMs: number;
  bucketSeconds: number;
  active: boolean;
  lastSeenAt: string | null;
  lastPulseAt: string | null;
  lastCounter: number | null;
  rssi: number | null;
  firmwareVersion: string | null;
  queueDepth: number | null;
  currentState: "Running" | "Idle" | "Down" | "Offline" | null;
  currentStateAt: string | null;
  workCenterName: string | null;
  mapped: boolean;
};

type PulseDevicesProps = {
  /** Shared tab bar, rendered at the top of this tab's body card. */
  tabs?: ReactNode;
  devices: PulseDeviceRow[];
  locations: { id: string; name: string }[];
  /** The ingest service's last heartbeat; null when it never reported. */
  ingestHeartbeatAt: string | null;
  error: string | null;
};

/** Same as `INGEST_HEARTBEAT_MAX_AGE_MS` in `@carbon/ee`'s Pulse provider. */
const INGEST_HEARTBEAT_MAX_AGE_MS = 120_000;

type FormValues = z.infer<typeof pulseDeviceUpsertValidator>;

const newDeviceValues: FormValues = {
  intent: "upsert-pulse-device",
  deviceKey: "",
  name: "",
  piecesPerPulse: 1,
  offlineAfterSeconds: 300,
  debounceMs: 20,
  bucketSeconds: 5,
  active: true
};

export function PulseDevices({
  tabs,
  devices,
  locations,
  ingestHeartbeatAt,
  error
}: PulseDevicesProps) {
  const { t } = useLingui();
  const permissions = usePermissions();
  const { isGated } = usePlanGate({ feature: "INTEGRATIONS" });

  return (
    <DrawerBody className="gap-4">
      {tabs}
      {isGated ? (
        <RulesUpgradeOverlay
          preview={
            <PulseDeviceList
              devices={mockDevices}
              locations={[]}
              ingestHeartbeatAt={null}
              canUpdate={false}
            />
          }
          title={t`Machine monitoring`}
          description={t`Register the cycle sensors on your machines, then map each one to a work center.`}
        />
      ) : (
        <>
          {error && (
            <p className="flex w-full items-start gap-2 text-sm text-muted-foreground">
              <LuTriangleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
              <span className="min-w-0">{error}</span>
            </p>
          )}
          <PulseDeviceList
            devices={devices}
            locations={locations}
            ingestHeartbeatAt={ingestHeartbeatAt}
            canUpdate={permissions.can("update", "settings")}
          />
        </>
      )}
    </DrawerBody>
  );
}

const mockDevices: PulseDeviceRow[] = [
  {
    id: "mock-1",
    deviceKey: "press-01",
    name: "Press 1",
    locationId: null,
    piecesPerPulse: 2,
    expectedCycleSeconds: 6,
    idleAfterSeconds: null,
    offlineAfterSeconds: 300,
    debounceMs: 20,
    bucketSeconds: 5,
    active: true,
    lastSeenAt: null,
    lastPulseAt: null,
    lastCounter: 18273,
    rssi: -61,
    firmwareVersion: "1.0.0",
    queueDepth: 0,
    currentState: "Running",
    currentStateAt: null,
    workCenterName: "Press Line",
    mapped: true
  }
];

function IngestStatus({ heartbeatAt }: { heartbeatAt: string | null }) {
  const { formatTimeAgo } = useDateFormatter();
  // Two instants compared, never a calendar date: `Date.parse` is fine here.
  const stale =
    heartbeatAt === null ||
    Date.now() - Date.parse(heartbeatAt) > INGEST_HEARTBEAT_MAX_AGE_MS;

  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          stale ? "bg-red-500" : "bg-emerald-500"
        )}
      />
      {heartbeatAt === null ? (
        <Trans>The Pulse ingest service has never reported</Trans>
      ) : stale ? (
        <Trans>
          The Pulse ingest service last reported {formatTimeAgo(heartbeatAt)}
        </Trans>
      ) : (
        <Trans>The Pulse ingest service is running</Trans>
      )}
    </p>
  );
}

function PulseDeviceList({
  devices,
  locations,
  ingestHeartbeatAt,
  canUpdate
}: {
  devices: PulseDeviceRow[];
  locations: { id: string; name: string }[];
  ingestHeartbeatAt: string | null;
  canUpdate: boolean;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<FormValues | null>(null);
  const [deleting, setDeleting] = useState<PulseDeviceRow | null>(null);
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex w-full items-center justify-between gap-3">
        <IngestStatus heartbeatAt={ingestHeartbeatAt} />
        {canUpdate && (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<LuPlus />}
            onClick={() => setEditing(newDeviceValues)}
          >
            <Trans>New device</Trans>
          </Button>
        )}
      </div>

      {devices.length === 0 ? (
        <p className="w-full py-8 text-center text-sm text-muted-foreground">
          <Trans>No devices registered</Trans>
        </p>
      ) : (
        <Table full>
          <Thead>
            <Tr>
              <Th className="px-0">
                <Trans>Device</Trans>
              </Th>
              <Th>
                <Trans>Work Center</Trans>
              </Th>
              <Th>
                <Trans>Health</Trans>
              </Th>
              <Th className="w-[72px] px-0">
                <span className="sr-only">
                  <Trans>Actions</Trans>
                </span>
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {devices.map((device) => (
              <Tr
                key={device.id}
                className="border-b border-border last:border-b-0"
              >
                <Td className="px-0 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <PulseStateDot device={device} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">
                        {device.name}
                        {!device.active && (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            · <Trans>Inactive</Trans>
                          </span>
                        )}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {device.deviceKey}
                        {device.locationId &&
                          locationName.get(device.locationId) &&
                          ` · ${locationName.get(device.locationId)}`}
                      </span>
                    </div>
                  </div>
                </Td>
                <Td className="py-2.5 text-sm">
                  {device.workCenterName ?? (
                    <span className="text-muted-foreground">
                      <Trans>Not mapped</Trans>
                    </span>
                  )}
                </Td>
                <Td className="py-2.5">
                  <DeviceHealth device={device} />
                </Td>
                <Td className="px-0 py-2.5">
                  {canUpdate && (
                    <HStack spacing={1} className="justify-end">
                      <IconButton
                        size="sm"
                        variant="ghost"
                        icon={<LuPencil />}
                        aria-label={t`Edit ${device.name}`}
                        onClick={() => setEditing(toFormValues(device))}
                      />
                      <IconButton
                        size="sm"
                        variant="ghost"
                        icon={<LuTrash />}
                        aria-label={t`Delete ${device.name}`}
                        onClick={() => setDeleting(device)}
                      />
                    </HStack>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}

      <PulseDeviceForm
        open={editing !== null}
        initialValues={editing ?? newDeviceValues}
        onClose={() => setEditing(null)}
      />
      <ConfirmDelete
        isOpen={deleting !== null}
        name={deleting?.name ?? ""}
        fields={{ intent: "delete-pulse-device", id: deleting?.id ?? "" }}
        isDisabled={deleting?.mapped ?? false}
        text={
          deleting?.mapped
            ? t`This device is mapped to ${deleting.workCenterName ?? ""}. Unmap it on the Devices tab first.`
            : t`The device's counts and state changes are deleted too. The sensor stops reporting to Carbon.`
        }
        onCancel={() => setDeleting(null)}
        onSubmit={() => setDeleting(null)}
      />
    </div>
  );
}

function toFormValues(device: PulseDeviceRow): FormValues {
  return {
    intent: "upsert-pulse-device",
    id: device.id,
    deviceKey: device.deviceKey,
    name: device.name,
    locationId: device.locationId ?? undefined,
    piecesPerPulse: device.piecesPerPulse,
    expectedCycleSeconds: device.expectedCycleSeconds ?? undefined,
    idleAfterSeconds: device.idleAfterSeconds ?? undefined,
    offlineAfterSeconds: device.offlineAfterSeconds,
    debounceMs: device.debounceMs,
    bucketSeconds: device.bucketSeconds,
    active: device.active
  };
}

/** Last message, signal and the device's own queue, in one line. */
function DeviceHealth({ device }: { device: PulseDeviceRow }) {
  const { formatTimeAgo } = useDateFormatter();
  if (!device.lastSeenAt) {
    return (
      <span className="text-xs text-muted-foreground">
        <Trans>Never reported</Trans>
      </span>
    );
  }
  const lastSeen = formatTimeAgo(device.lastSeenAt);
  const parts: string[] = [];
  if (device.rssi !== null) parts.push(`${device.rssi} dBm`);
  if (device.firmwareVersion) parts.push(`v${device.firmwareVersion}`);
  return (
    <div className="flex flex-col text-xs">
      <span>
        <Trans>Seen {lastSeen}</Trans>
      </span>
      <span className="text-muted-foreground">
        {parts.join(" · ")}
        {device.queueDepth !== null && device.queueDepth > 0 && (
          <span className="text-amber-600">
            {parts.length > 0 && " · "}
            <Trans>{device.queueDepth} queued</Trans>
          </span>
        )}
      </span>
    </div>
  );
}

/** The state the ingest service inferred, with its time on hover. */
function PulseStateDot({ device }: { device: PulseDeviceRow }) {
  const { t } = useLingui();
  const { formatTimeAgo } = useDateFormatter();

  const stateLabels = {
    Running: t`Running`,
    Idle: t`Idle`,
    Down: t`Down`,
    Offline: t`Offline`
  } as const;
  const stateDots = {
    Running: "bg-emerald-500",
    Idle: "bg-amber-400",
    Down: "bg-red-500",
    Offline: "bg-muted-foreground/40"
  } as const;

  let dotClassName = "border border-muted-foreground/40";
  let labelText = t`No state yet`;
  if (device.currentState) {
    const state = stateLabels[device.currentState];
    dotClassName = stateDots[device.currentState];
    const since = device.currentStateAt
      ? formatTimeAgo(device.currentStateAt)
      : null;
    labelText = since ? t`${state} since ${since}` : state;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // focusable: the tooltip is the only place the state is named
          tabIndex={0}
          role="img"
          aria-label={labelText}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={cn("size-2 rounded-full", dotClassName)} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{labelText}</TooltipContent>
    </Tooltip>
  );
}

function PulseDeviceForm({
  open,
  initialValues,
  onClose
}: {
  open: boolean;
  initialValues: FormValues;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ModalContent>
        {/* Keyed so each open starts from the row it edits. */}
        <PulseDeviceFormBody
          key={initialValues.id ?? "new"}
          initialValues={initialValues}
          onClose={onClose}
        />
      </ModalContent>
    </Modal>
  );
}

function PulseDeviceFormBody({
  initialValues,
  onClose
}: {
  initialValues: FormValues;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const isEditing = initialValues.id !== undefined;
  const fetcher = useAction({
    onSuccess: () => {
      toast.success(t`Saved device`);
      onClose();
    }
  });

  return (
    <ValidatedForm
      validator={pulseDeviceUpsertValidator}
      method="post"
      defaultValues={initialValues}
      fetcher={fetcher}
      className="flex h-full flex-col"
    >
      <ModalHeader>
        <ModalTitle>
          {isEditing ? (
            <Trans>Edit Pulse device</Trans>
          ) : (
            <Trans>New Pulse device</Trans>
          )}
        </ModalTitle>
        <ModalDescription>
          <Trans>
            The device key is the device's MQTT username. It cannot change after
            the device is registered.
          </Trans>
        </ModalDescription>
      </ModalHeader>
      <ModalBody>
        <Hidden name="intent" />
        <Hidden name="id" />
        <VStack spacing={4}>
          {isEditing ? (
            <Hidden name="deviceKey" />
          ) : (
            <Input
              name="deviceKey"
              label={t`Device key`}
              helperText={t`For example press-01`}
            />
          )}
          <Input name="name" label={t`Name`} />
          <Location name="locationId" label={t`Location`} isOptional />
          <div className="grid w-full grid-cols-2 gap-4">
            <NumberField
              name="piecesPerPulse"
              label={t`Pieces per pulse`}
              minValue={0}
            />
            <NumberField
              name="expectedCycleSeconds"
              label={t`Standard cycle (seconds)`}
              minValue={0}
            />
            <NumberField
              name="idleAfterSeconds"
              label={t`Idle after (seconds)`}
              helperText={t`Empty: 3 standard cycles, at least 30`}
              minValue={1}
            />
            <NumberField
              name="offlineAfterSeconds"
              label={t`Offline after (seconds)`}
              minValue={1}
            />
            <NumberField
              name="debounceMs"
              label={t`Debounce (ms)`}
              minValue={0}
            />
            <NumberField
              name="bucketSeconds"
              label={t`Send every (seconds)`}
              minValue={1}
            />
          </div>
          <BooleanField
            name="active"
            label={t`Active`}
            description={t`An inactive device is ignored by the ingest service.`}
          />
        </VStack>
      </ModalBody>
      <ModalFooter>
        <HStack>
          <Button variant="secondary" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Submit>
            <Trans>Save</Trans>
          </Submit>
        </HStack>
      </ModalFooter>
    </ValidatedForm>
  );
}
