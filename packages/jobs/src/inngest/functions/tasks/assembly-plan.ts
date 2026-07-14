import { getCarbonServiceRole } from "@carbon/auth/client.server";
import type { Json } from "@carbon/database";
import { GEOMETRY_SERVICE_API_KEY, GEOMETRY_SERVICE_URL } from "@carbon/env";
import type { AssemblyPlan } from "@carbon/viewer/steps";
import { inngest } from "../../client";
import { loadPlanUnits } from "./plan-units";
import { updateAssemblyStepMotionsFromPlan } from "./update-step-motions";

const SIGNED_URL_EXPIRY = 60 * 60; // seconds
// Every geometry HTTP call is now short (submit or a status poll), so a tight
// per-request timeout is safe and catches a genuinely unreachable service.
const REQUEST_TIMEOUT_MS = 60 * 1000;
// Large assemblies can plan for 10+ minutes. Poll the async job on this cadence
// up to this many times; exceeding it fails the job (→ onFailure → Failed → the
// UI offers a retry) rather than waiting forever.
const PLAN_POLL_INTERVAL = "15s";
const PLAN_MAX_POLLS = 120; // 15s × 120 = 30 min budget
// The geometry job registry is in-process; a restart drops running jobs. Re-submit
// the plan on a lost job up to this many times before giving up.
const PLAN_MAX_RESUBMITS = 3;

const authHeaders: Record<string, string> = GEOMETRY_SERVICE_API_KEY
  ? { Authorization: `Bearer ${GEOMETRY_SERVICE_API_KEY}` }
  : {};

/**
 * Runs the geometry service motion planner over a converted model: computes a
 * collision-free insertion motion per part plus an assembly sequence, stored
 * as plan.json next to the model artifacts. See
 * docs/specs/animated-work-instructions-contracts.md (POST /plan).
 */
export const assemblyPlanFunction = inngest.createFunction(
  {
    id: "assembly-plan",
    retries: 2,
    concurrency: [{ limit: 4 }, { key: "event.data.companyId", limit: 1 }],
    onFailure: async ({ event }) => {
      const { modelUploadId } = event.data.event.data;
      const client = getCarbonServiceRole();

      // Queued included: a pre-created row (planJobId) stays Queued when the
      // function fails before its "queue" step promotes it to Processing.
      await client
        .from("assemblyPlanJob")
        .update({
          status: "Failed",
          error: event.data.error.message,
          updatedAt: new Date().toISOString()
        })
        .eq("modelUploadId", modelUploadId)
        .eq("kind", "plan")
        .in("status", ["Queued", "Processing"]);
    }
  },
  { event: "carbon/assembly-plan" },
  async ({ event, step }) => {
    const { modelUploadId, companyId, userId, reMotionFor, planJobId } =
      event.data;

    const job = await step.run("queue", async () => {
      const client = getCarbonServiceRole();

      const modelUpload = await client
        .from("modelUpload")
        .select("id, modelPath, graphPath, processingStatus")
        .eq("id", modelUploadId)
        .eq("companyId", companyId)
        .single();

      if (modelUpload.error || !modelUpload.data?.modelPath) {
        throw new Error(
          `Model upload ${modelUploadId} not found or has no file`
        );
      }

      // Adopt the trigger's pre-created row when given (created Queued so the
      // UI shows "planning" from the moment of the click); fall back to
      // inserting a row when adoption fails.
      if (planJobId) {
        const adopted = await client
          .from("assemblyPlanJob")
          .update({ status: "Processing", updatedAt: new Date().toISOString() })
          .eq("id", planJobId)
          .eq("companyId", companyId)
          .select("id")
          .maybeSingle();

        if (adopted.data?.id) {
          return {
            id: adopted.data.id,
            modelPath: modelUpload.data.modelPath,
            graphPath: modelUpload.data.graphPath
          };
        }
      }

      const planJob = await client
        .from("assemblyPlanJob")
        .insert({
          modelUploadId,
          kind: "plan",
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

      return {
        id: planJob.data.id,
        modelPath: modelUpload.data.modelPath,
        graphPath: modelUpload.data.graphPath
      };
    });

    if (!GEOMETRY_SERVICE_URL) {
      throw new Error("GEOMETRY_SERVICE_URL is not configured");
    }
    const geometryUrl = GEOMETRY_SERVICE_URL;

    // Re-motion mode (order-preserving): take the existing step order as the
    // fixed assembly sequence and let the planner only recompute each step's
    // motion (forward-collision against earlier steps). Otherwise plan fresh:
    // collapse the model's leaf soup into rigid-body units so a 400-part model
    // plans as its ~7 assembled units. Best-effort: no units → every leaf.
    const sequence = reMotionFor
      ? await step.run("derive-sequence", async () => {
          const client = getCarbonServiceRole();
          const steps = await client
            .from("assemblyInstructionStep")
            .select("componentNodeIds")
            .eq("assemblyInstructionId", reMotionFor)
            .eq("companyId", companyId)
            .order("sortOrder", { ascending: true });
          // Every step's parts (Done included — they're obstacles) in order.
          return (steps.data ?? [])
            .map((row) => row.componentNodeIds ?? [])
            .filter((group) => group.length > 0);
        })
      : null;
    const units =
      sequence != null
        ? []
        : await step.run("derive-units", () =>
            loadPlanUnits({
              modelUploadId,
              companyId,
              graphPath: job.graphPath
            })
          );

    // Kick off the planner. The service starts it in the background and returns
    // immediately, so the request is short — no connection is held open across
    // the multi-minute run (which no HTTP hop survives). A fresh signed source
    // URL is minted per submit so re-submits (below) don't reuse an expired one.
    const submitPlan = async () => {
      const client = getCarbonServiceRole();

      const source = await client.storage
        .from("private")
        .createSignedUrl(job.modelPath, SIGNED_URL_EXPIRY);
      if (source.error) {
        throw new Error(`Failed to sign source URL: ${source.error.message}`);
      }

      const response = await fetch(`${geometryUrl}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          jobId: job.id,
          source: { url: source.data.signedUrl, format: "step" },
          ...(sequence != null
            ? { options: { sequence } }
            : units.length > 0
              ? { options: { units } }
              : {})
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!response.ok || !result?.ok) {
        throw new Error(
          result?.error ?? `Geometry service returned ${response.status}`
        );
      }
      return { ok: true };
    };

    await step.run("start-plan", submitPlan);

    // Poll the async job until it finishes. Each poll is its own short step, so
    // Inngest sleeps between them rather than holding a request open. The
    // geometry service keeps its job registry in-process, so a restart (or its
    // dev `uvicorn --reload`) drops the running job and the poll 404s — recover
    // by re-submitting rather than failing the whole plan.
    let plan: Json | null = null;
    let stats: Json = null;
    let resubmits = 0;
    for (let attempt = 0; attempt < PLAN_MAX_POLLS; attempt++) {
      await step.sleep(`plan-wait-${attempt}`, PLAN_POLL_INTERVAL);

      const status = await step.run(`plan-poll-${attempt}`, async () => {
        const response = await fetch(`${geometryUrl}/plan/${job.id}`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        // 404 = the service no longer knows this job (it restarted).
        if (response.status === 404) return { status: "missing" as const };
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          status?: string;
          plan?: Json;
          stats?: Record<string, unknown>;
          error?: string;
        } | null;
        if (!response.ok || !body?.ok) {
          throw new Error(
            body?.error ?? `Geometry status check returned ${response.status}`
          );
        }
        return body;
      });

      if (status.status === "missing") {
        if (resubmits >= PLAN_MAX_RESUBMITS) {
          throw new Error(
            "The geometry service repeatedly lost the plan job (restarting?)"
          );
        }
        resubmits++;
        await step.run(`plan-resubmit-${attempt}`, submitPlan);
        continue;
      }
      if (status.status === "done") {
        if (status.plan == null) {
          throw new Error("Planner reported done but returned no plan");
        }
        plan = status.plan;
        stats = (status.stats ?? null) as Json;
        break;
      }
      if (status.status === "error") {
        throw new Error(status.error ?? "Motion planning failed");
      }
    }

    if (plan == null) {
      throw new Error("Motion planning did not finish in time");
    }
    const planData = plan;

    await step.run("persist-plan", async () => {
      const client = getCarbonServiceRole();
      const planPath = `${companyId}/models/${modelUploadId}/${job.id}/plan.json`;

      const upload = await client.storage
        .from("private")
        .upload(planPath, JSON.stringify(planData), {
          contentType: "application/json",
          upsert: true
        });
      if (upload.error) {
        throw new Error(`Failed to upload plan: ${upload.error.message}`);
      }

      await client
        .from("assemblyPlanJob")
        .update({
          status: "Success",
          planPath,
          stats,
          updatedAt: new Date().toISOString()
        })
        .eq("id", job.id);
    });

    // Re-motion: the plan preserved the step order — update each step's motion
    // in place (Done steps kept, order/titles/typed fields untouched).
    if (reMotionFor) {
      await step.run("update-step-motions", async () => {
        const client = getCarbonServiceRole();
        await updateAssemblyStepMotionsFromPlan(client, {
          assemblyInstructionId: reMotionFor,
          plan: planData as unknown as AssemblyPlan,
          graphPath: job.graphPath,
          companyId,
          userId
        });
      });
    }
  }
);
