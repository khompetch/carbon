import { error, safeRedirect, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { deactivateUser } from "@carbon/auth/users.server";
import { validationError, validator } from "@carbon/form";
import type { userAdminTask } from "@carbon/jobs/trigger/user-admin";
import { tasks } from "@trigger.dev/sdk";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { deactivateUsersValidator } from "~/modules/users";

export async function action({ request }: ActionFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    delete: "users"
  });

  const validation = await validator(deactivateUsersValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { users, redirectTo } = validation.data;

  if (users.length === 1) {
    const [userId] = users;
    // deactivateUser() handles Stripe subscription quantity update internally
    const result = await deactivateUser(client, userId, companyId);

    throw redirect(safeRedirect(redirectTo), await flash(request, result));
  } else {
    const batchPayload = users.map((id) => ({
      payload: {
        id,
        type: "deactivate" as const,
        companyId
      }
    }));

    try {
      await tasks.batchTrigger<typeof userAdminTask>(
        "user-admin",
        batchPayload
      );
      throw redirect(
        safeRedirect(redirectTo),
        await flash(
          request,
          success("Success. Please check back in a few moments.")
        )
      );
    } catch (e) {
      throw redirect(
        safeRedirect(redirectTo),
        await flash(request, error(e, "Failed to deactivate users"))
      );
    }
  }
}
