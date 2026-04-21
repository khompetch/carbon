import { error } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import { msg } from "@lingui/core/macro";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, redirect } from "react-router";
import {
  getSupplier,
  getSupplierApprovalContext,
  getSupplierContacts,
  getSupplierLocations
} from "~/modules/purchasing";
import SupplierHeader from "~/modules/purchasing/ui/Supplier/SupplierHeader";
import SupplierSidebar from "~/modules/purchasing/ui/Supplier/SupplierSidebar";
import { getTagsList } from "~/modules/shared";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Suppliers`,
  to: path.to.suppliers
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId, userId } = await requirePermissions(request, {
    view: "purchasing"
  });

  const { supplierId } = params;
  if (!supplierId) throw new Error("Could not find supplierId");

  const serviceRole = getCarbonServiceRole();
  // Kick off approval in parallel — it only needs supplier.status, so we chain
  // off the supplier fetch rather than waiting for the whole Promise.all to
  // settle.
  const supplierPromise = getSupplier(client, supplierId);
  const [supplier, contacts, locations, tags, approval] = await Promise.all([
    supplierPromise,
    getSupplierContacts(client, supplierId),
    getSupplierLocations(client, supplierId),
    getTagsList(client, companyId, "supplier"),
    supplierPromise.then((s) =>
      getSupplierApprovalContext(
        serviceRole,
        supplierId,
        s.data?.status ?? null,
        companyId,
        userId
      )
    )
  ]);

  if (supplier.error) {
    throw redirect(
      path.to.suppliers,
      await flash(
        request,
        error(supplier.error, "Failed to load supplier summary")
      )
    );
  }

  return {
    supplier: supplier.data,
    contacts: contacts.data ?? [],
    locations: locations.data ?? [],
    tags: tags.data ?? [],
    ...approval
  };
}

export default function SupplierRoute() {
  return (
    <>
      <SupplierHeader />
      <div className="grid grid-cols-1 md:grid-cols-[1fr_4fr] h-full w-full gap-4">
        <SupplierSidebar />
        <Outlet />
      </div>
    </>
  );
}
