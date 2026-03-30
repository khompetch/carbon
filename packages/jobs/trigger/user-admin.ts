import { task } from "@trigger.dev/sdk";
import { z } from "zod";

import type { Result } from "@carbon/auth";
import { getAppUrl, RESEND_DOMAIN } from "@carbon/auth";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { deactivateUser } from "@carbon/auth/users.server";
import { InviteEmail } from "@carbon/documents/email";
import { sendEmail } from "@carbon/lib/resend.server";
import { render } from "@react-email/components";
import { nanoid } from "nanoid";

const serviceRole = getCarbonServiceRole();
export const userAdminSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("deactivate"),
    companyId: z.string(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("resend"),
    location: z.string(),
    ip: z.string(),
    companyId: z.string(),
  }),
]);

export const userAdminTask = task({
  id: "user-admin",
  run: async (payload: z.infer<typeof userAdminSchema>) => {
    console.log(`🔰 User admin update ${payload.type} for ${payload.id}`);

    let result: Result;

    switch (payload.type) {
      case "deactivate":
        console.log(`🚭 Deactivating ${payload.id}`);
        // deactivateUser() handles Stripe subscription quantity update internally
        result = await deactivateUser(
          serviceRole,
          payload.id,
          payload.companyId
        );
        break;
      case "resend":
        const { id: userId, companyId, location, ip } = payload;
        console.log(`🔄 Resending invite for ${payload.id}`);
        const [company, user] = await Promise.all([
          serviceRole
            .from("company")
            .select("name")
            .eq("id", companyId)
            .single(),
          serviceRole
            .from("user")
            .select("email, fullName")
            .eq("id", userId)
            .single(),
        ]);

        if (!company.data || !user.data) {
          throw new Error("Failed to load company or user");
        }

        const invite = await serviceRole
          .from("invite")
          .select("code, createdBy")
          .eq("email", user.data.email)
          .eq("companyId", companyId)
          .is("acceptedAt", null)
          .single();

        if (invite.error || !invite.data) {
          return {
            success: false,
            message: "Failed to load existing invite",
          };
        }

        const inviter = await serviceRole
          .from("user")
          .select("email, fullName")
          .eq("id", invite.data.createdBy)
          .single();

        await sendEmail({
          from: `Carbon <no-reply@${RESEND_DOMAIN}>`,
          to: user.data.email,
          subject: `You have been invited to join ${company.data?.name} on Carbon`,
          headers: {
            "X-Entity-Ref-ID": nanoid(),
          },
          html: await render(
            InviteEmail({
              invitedByEmail: inviter.data?.email ?? user.data.email,
              invitedByName: inviter.data?.fullName ?? "",
              email: user.data.email,
              name: user.data.fullName ?? "",
              companyName: company.data.name,
              inviteLink: `${getAppUrl()}/invite/${invite.data.code}`,
              ip,
              location,
            })
          ),
        });

        result = {
          success: true,
          message: `Successfully resent invite for ${payload.id}`,
        };
        break;
    }

    if (result.success) {
      console.log(`✅ Success ${payload.id}`);
    } else {
      console.error(
        `❌ Admin action ${payload.type} failed for ${payload.id}: ${result.message}`
      );
    }

    return result;
  },
});
