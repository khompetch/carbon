// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import type { Database } from "@carbon/database";

/** The unit of an operation's machine time (`jobOperation.machineUnit`). */
export type MachineUnit = Database["public"]["Enums"]["factor"];

/**
 * The ideal seconds per piece of an operation's machine time standard, for
 * OEE Performance. Null when the standard is not per piece (`Total Hours`,
 * `Total Minutes`) or is not set (0 or less).
 */
export function idealSecondsPerPiece(
  machineTime: number,
  machineUnit: MachineUnit
): number | null {
  if (!Number.isFinite(machineTime) || machineTime <= 0) return null;
  switch (machineUnit) {
    case "Seconds/Piece":
      return machineTime;
    case "Minutes/Piece":
      return machineTime * 60;
    case "Hours/Piece":
      return machineTime * 3600;
    case "Minutes/100 Pieces":
      return (machineTime * 60) / 100;
    case "Minutes/1000 Pieces":
      return (machineTime * 60) / 1000;
    case "Hours/100 Pieces":
      return (machineTime * 3600) / 100;
    case "Hours/1000 Pieces":
      return (machineTime * 3600) / 1000;
    case "Pieces/Minute":
      return 60 / machineTime;
    case "Pieces/Hour":
      return 3600 / machineTime;
    default:
      return null;
  }
}

/**
 * The ideal seconds per piece of a Pulse device: its expected cycle divided
 * by the pieces one pulse makes. Null when either value is missing.
 */
export function deviceIdealSecondsPerPiece(
  expectedCycleSeconds: number | null,
  piecesPerPulse: number
): number | null {
  if (expectedCycleSeconds === null || expectedCycleSeconds <= 0) return null;
  if (!Number.isFinite(piecesPerPulse) || piecesPerPulse <= 0) return null;
  return expectedCycleSeconds / piecesPerPulse;
}
