// SPDX-License-Identifier: LicenseRef-Carbon-Commercial
// Carbon Enterprise file, licensed only under the Carbon Commercial License
// (packages/ee/LICENSE). Not AGPL. Running, modifying, or copying it beyond those terms requires a commercial license.

import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPulseProvider } from "../pulse/provider";
import { createSenseProvider } from "../sense/provider";
import {
  DEFAULT_MINIMUM_STATE_SECONDS,
  type OeeProvider,
  type OeeProviderId
} from "./types";

/**
 * What a provider may need besides its settings. A provider that reads
 * Carbon's own tables (Pulse) needs the company and a service-role client; a
 * provider behind an HTTP API (Sense) needs neither.
 */
export type OeeProviderContext = {
  companyId: string;
  serviceClient: SupabaseClient<Database>;
};

type OeeProviderFactory = (
  metadata: Record<string, unknown>,
  context: OeeProviderContext
) => OeeProvider;

/**
 * Integration id → provider factory. The one place an OEE provider is named;
 * everything else finds OEE integrations through `getIntegrationIdsByRole("oee")`.
 */
export const OEE_PROVIDERS: Record<OeeProviderId, OeeProviderFactory> = {
  sense: (metadata) => createSenseProvider(oeeProviderSettings(metadata)),
  pulse: (_metadata, context) => createPulseProvider(context)
};

export function isOeeProviderId(id: string): id is OeeProviderId {
  return Object.hasOwn(OEE_PROVIDERS, id);
}

/**
 * The connection settings of a provider behind an API key, from its metadata
 * (with the vaulted `apiKey` already resolved). Throws when the API key is
 * empty.
 */
export function oeeProviderSettings(metadata: Record<string, unknown>) {
  const apiKey = typeof metadata.apiKey === "string" ? metadata.apiKey : "";
  if (!apiKey) throw new Error("No API key");
  return {
    apiKey,
    environment: String(metadata.environment ?? "production")
  };
}

/**
 * Builds the provider for an integration from its metadata (with the vaulted
 * `apiKey` already resolved). Throws when the id is not an OEE provider, or
 * when the provider's factory refuses the settings (Sense with no API key).
 */
export function createOeeProvider(
  integrationId: string,
  metadata: Record<string, unknown>,
  context: OeeProviderContext
): { provider: OeeProvider; minimumStateSeconds: number } {
  if (!isOeeProviderId(integrationId)) {
    throw new Error(`${integrationId} is not an OEE provider`);
  }
  const provider = OEE_PROVIDERS[integrationId](metadata, context);

  const minimum = Number(metadata.minimumStateSeconds);
  return {
    provider,
    minimumStateSeconds:
      Number.isFinite(minimum) && minimum >= 0
        ? minimum
        : DEFAULT_MINIMUM_STATE_SECONDS
  };
}
