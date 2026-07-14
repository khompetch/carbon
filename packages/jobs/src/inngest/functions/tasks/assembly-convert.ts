import { getCarbonServiceRole } from "@carbon/auth/client.server";
import type { Json } from "@carbon/database";
import { GEOMETRY_SERVICE_API_KEY, GEOMETRY_SERVICE_URL } from "@carbon/env";
import { inngest } from "../../client";

const SIGNED_URL_EXPIRY = 60 * 60; // seconds

/**
 * Converts an uploaded CAD model (STEP) into web artifacts via the geometry
 * service: a meshopt-compressed GLB and an assembly graph JSON. See
 * docs/specs/animated-work-instructions-contracts.md for the API contract.
 */
export const assemblyConvertFunction = inngest.createFunction(
  {
    id: "assembly-convert",
    retries: 2,
    // The geometry service is CPU-bound and rejects work beyond its slot
    // count with 429s; keep per-company fan-out from starving other tenants.
    concurrency: [{ limit: 4 }, { key: "event.data.companyId", limit: 2 }],
    onFailure: async ({ event }) => {
      const { modelUploadId } = event.data.event.data;
      const client = getCarbonServiceRole();

      await client
        .from("modelUpload")
        .update({
          processingStatus: "Failed",
          processingError: event.data.error.message
        })
        .eq("id", modelUploadId);

      await client
        .from("assemblyPlanJob")
        .update({
          status: "Failed",
          error: event.data.error.message,
          updatedAt: new Date().toISOString()
        })
        .eq("modelUploadId", modelUploadId)
        .eq("kind", "convert")
        .eq("status", "Processing");
    }
  },
  { event: "carbon/assembly-convert" },
  async ({ event, step }) => {
    const { modelUploadId, companyId, userId } = event.data;

    const job = await step.run("queue", async () => {
      const client = getCarbonServiceRole();

      const modelUpload = await client
        .from("modelUpload")
        .select("id, modelPath, companyId")
        .eq("id", modelUploadId)
        .eq("companyId", companyId)
        .single();

      if (modelUpload.error || !modelUpload.data?.modelPath) {
        throw new Error(
          `Model upload ${modelUploadId} not found or has no file`
        );
      }

      const planJob = await client
        .from("assemblyPlanJob")
        .insert({
          modelUploadId,
          kind: "convert",
          status: "Processing",
          companyId,
          createdBy: userId
        })
        .select("id")
        .single();

      if (planJob.error) {
        throw new Error(
          `Failed to create assembly plan job: ${planJob.error.message}`
        );
      }

      await client
        .from("modelUpload")
        .update({ processingStatus: "Processing", processingError: null })
        .eq("id", modelUploadId);

      return { id: planJob.data.id, modelPath: modelUpload.data.modelPath };
    });

    await step.run("convert", async () => {
      const client = getCarbonServiceRole();

      if (!GEOMETRY_SERVICE_URL) {
        throw new Error("GEOMETRY_SERVICE_URL is not configured");
      }

      const glbPath = `${companyId}/models/${modelUploadId}/${job.id}/model.glb`;
      const graphPath = `${companyId}/models/${modelUploadId}/${job.id}/graph.json`;

      const source = await client.storage
        .from("private")
        .createSignedUrl(job.modelPath, SIGNED_URL_EXPIRY);
      if (source.error) {
        throw new Error(`Failed to sign source URL: ${source.error.message}`);
      }

      // upsert: Inngest retries re-upload to the same paths; without it the
      // storage API rejects the second attempt with "resource already exists"
      const [glbUpload, graphUpload] = await Promise.all([
        client.storage
          .from("private")
          .createSignedUploadUrl(glbPath, { upsert: true }),
        client.storage
          .from("private")
          .createSignedUploadUrl(graphPath, { upsert: true })
      ]);
      if (glbUpload.error || graphUpload.error) {
        throw new Error("Failed to sign artifact upload URLs");
      }

      const response = await fetch(`${GEOMETRY_SERVICE_URL}/convert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(GEOMETRY_SERVICE_API_KEY
            ? { Authorization: `Bearer ${GEOMETRY_SERVICE_API_KEY}` }
            : {})
        },
        body: JSON.stringify({
          jobId: job.id,
          source: {
            url: source.data.signedUrl,
            format: "step"
          },
          outputs: {
            glb: { url: glbUpload.data.signedUrl },
            graph: { url: graphUpload.data.signedUrl }
          }
        })
      });

      const result = (await response.json().catch(() => null)) as {
        ok: boolean;
        componentCount?: number;
        stats?: Record<string, unknown>;
        error?: string;
      } | null;

      if (!response.ok || !result?.ok) {
        throw new Error(
          result?.error ?? `Geometry service returned ${response.status}`
        );
      }

      await client
        .from("modelUpload")
        .update({
          processingStatus: "Success",
          processingError: null,
          glbPath,
          graphPath,
          componentCount: result.componentCount ?? null,
          processedAt: new Date().toISOString()
        })
        .eq("id", modelUploadId);

      await client
        .from("assemblyPlanJob")
        .update({
          status: "Success",
          stats: (result.stats ?? null) as Json,
          updatedAt: new Date().toISOString()
        })
        .eq("id", job.id);
    });

    // Planning is NOT chained here — it's expensive (minutes) and the user may
    // author steps manually. It runs lazily on the first "Generate Steps"
    // click (or an explicit re-plan), which then auto-creates the steps.
  }
);
