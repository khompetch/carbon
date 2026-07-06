import { assertIsPost, error, RATE_LIMIT, success } from "@carbon/auth";
import {
  getUserHasSetPassword,
  requirePermissions,
  setUserPassword,
  signInWithEmail
} from "@carbon/auth/auth.server";
import { flash, requireAuthSession } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import { Ratelimit, redis } from "@carbon/kv";
import { VStack } from "@carbon/react";
import { msg } from "@lingui/core/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData } from "react-router";
import { accountPasswordValidator } from "~/modules/account";
import { PasswordForm } from "~/modules/account/ui/Password";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Password`,
  to: path.to.accountPassword
};

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermissions(request, {});
  // Credential operations act on the real session user, never the effective
  // (console-mode) user that requirePermissions may substitute.
  const authSession = await requireAuthSession(request);
  const hasSetPassword = await getUserHasSetPassword(authSession.userId);
  return { hasSetPassword };
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  await requirePermissions(request, {});
  // Credential operations act on the real session user, never the effective
  // (console-mode) user that requirePermissions may substitute — verify,
  // gate, and write must all target the same identity.
  const authSession = await requireAuthSession(request);
  const userId = authSession.userId;

  // Verifying currentPassword is a credential check — rate limit it like login.
  const ip = request.headers.get("x-forwarded-for") ?? "127.0.0.1";
  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(RATE_LIMIT, "1 h"),
    analytics: true
  });
  const { success: withinLimit } = await ratelimit.limit(ip);
  if (!withinLimit) {
    return data({}, await flash(request, error(null, "Rate limit exceeded")));
  }

  const validation = await validator(accountPasswordValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { currentPassword, password } = validation.data;

  const hasSetPassword = await getUserHasSetPassword(userId);
  if (hasSetPassword) {
    const verified = currentPassword
      ? await signInWithEmail(authSession.email, currentPassword)
      : null;
    if (!verified) {
      return data(
        {},
        await flash(request, error(null, "Current password is incorrect"))
      );
    }
  }

  const updated = await setUserPassword(userId, password);
  if (!updated) {
    return data(
      {},
      await flash(request, error(null, "Failed to update password"))
    );
  }

  return data({}, await flash(request, success("Updated password")));
}

export default function AccountPassword() {
  const { hasSetPassword } = useLoaderData<typeof loader>();

  return (
    <VStack spacing={4} className="pb-6">
      <PasswordForm hasSetPassword={hasSetPassword} />
    </VStack>
  );
}
