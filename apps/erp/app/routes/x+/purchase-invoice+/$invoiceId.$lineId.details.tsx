import { assertIsPost, error, notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { JSONContent } from "@carbon/react";
import { Spinner } from "@carbon/react";
import { getItemReadableId } from "@carbon/utils";
import { useLingui } from "@lingui/react/macro";
import { Suspense } from "react";
import { Fragment } from "react/jsx-runtime";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Await,
  Outlet,
  redirect,
  useLoaderData,
  useParams
} from "react-router";
import { useRouteData } from "~/hooks";
import {
  getPurchaseInvoice,
  getPurchaseInvoiceLine,
  isPurchaseInvoiceLocked,
  PurchaseInvoiceLineForm,
  purchaseInvoiceLineValidator,
  upsertPurchaseInvoiceLine
} from "~/modules/invoicing";
import { getSupplierInteractionLineDocuments } from "~/modules/purchasing";
import {
  SupplierInteractionLineDocuments,
  SupplierInteractionLineNotes
} from "~/modules/purchasing/ui/SupplierInteraction";
import { useItems } from "~/stores";
import { getCustomFields, setCustomFields } from "~/utils/form";
import { requireUnlocked } from "~/utils/lockedGuard.server";
import { path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "invoicing",
    role: "employee"
  });

  const { lineId } = params;
  if (!lineId) throw notFound("lineId not found");

  const [purchaseInvoiceLine, files] = await Promise.all([
    getPurchaseInvoiceLine(client, lineId),
    getSupplierInteractionLineDocuments(client, companyId, lineId)
  ]);

  return {
    purchaseInvoiceLine: purchaseInvoiceLine?.data ?? null,
    files
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);

  const { invoiceId, lineId } = params;
  if (!invoiceId) throw new Error("Could not find invoiceId");
  if (!lineId) throw new Error("Could not find lineId");

  // Check if PI is locked
  const { client: viewClient } = await requirePermissions(request, {
    view: "invoicing"
  });

  const purchaseInvoice = await getPurchaseInvoice(viewClient, invoiceId);
  if (purchaseInvoice.error) {
    throw redirect(
      path.to.purchaseInvoiceLine(invoiceId, lineId),
      await flash(
        request,
        error(purchaseInvoice.error, "Failed to load purchase invoice")
      )
    );
  }

  await requireUnlocked({
    request,
    isLocked: isPurchaseInvoiceLocked(purchaseInvoice.data?.status),
    redirectTo: path.to.purchaseInvoiceLine(invoiceId, lineId),
    message: "Cannot modify a confirmed purchase invoice."
  });

  const { client, userId } = await requirePermissions(request, {
    create: "invoicing"
  });

  const formData = await request.formData();
  const validation = await validator(purchaseInvoiceLineValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  // biome-ignore lint/correctness/noUnusedVariables: suppressed due to migration
  const { id, ...d } = validation.data;

  // if (d.invoiceLineType === "G/L Account") {
  //   d.assetId = undefined;
  //   d.itemId = undefined;
  // } else if (d.invoiceLineType === "Fixed Asset") {
  //   d.accountNumber = undefined;
  //   d.itemId = undefined;
  // } else
  // if (d.invoiceLineType === "Comment") {
  //   d.accountNumber = undefined;
  //   d.assetId = undefined;
  //   d.itemId = undefined;
  // } else {
  //   d.accountNumber = undefined;
  //   d.assetId = undefined;
  // }

  const updatePurchaseInvoiceLine = await upsertPurchaseInvoiceLine(client, {
    id: lineId,
    ...d,
    updatedBy: userId,
    customFields: setCustomFields(formData)
  });

  if (updatePurchaseInvoiceLine.error) {
    throw redirect(
      path.to.purchaseInvoiceLine(invoiceId, lineId),
      await flash(
        request,
        error(
          updatePurchaseInvoiceLine.error,
          "Failed to update purchase invoice line"
        )
      )
    );
  }

  throw redirect(path.to.purchaseInvoiceLine(invoiceId, lineId));
}

export default function EditPurchaseInvoiceLineRoute() {
  const { t } = useLingui();
  const { invoiceId, lineId } = useParams();
  if (!invoiceId) throw notFound("invoiceId not found");
  if (!lineId) throw notFound("lineId not found");

  const routeData = useRouteData<{
    purchaseInvoice: { status: string };
  }>(path.to.purchaseInvoice(invoiceId));
  const isReadOnly = isPurchaseInvoiceLocked(
    routeData?.purchaseInvoice?.status
  );

  const [items] = useItems();
  const { purchaseInvoiceLine, files } = useLoaderData<typeof loader>();

  const initialValues = {
    id: purchaseInvoiceLine?.id ?? undefined,
    invoiceId: purchaseInvoiceLine?.invoiceId ?? "",
    invoiceLineType: (purchaseInvoiceLine?.invoiceLineType ?? "Part") as "Part",
    itemId: purchaseInvoiceLine?.itemId ?? "",

    accountNumber: purchaseInvoiceLine?.accountNumber ?? "",
    assetId: purchaseInvoiceLine?.assetId ?? "",
    description: purchaseInvoiceLine?.description ?? "",
    quantity: purchaseInvoiceLine?.quantity ?? 1,
    supplierUnitPrice: purchaseInvoiceLine?.supplierUnitPrice ?? 0,
    supplierShippingCost: purchaseInvoiceLine?.supplierShippingCost ?? 0,
    supplierTaxAmount: purchaseInvoiceLine?.supplierTaxAmount ?? 0,
    exchangeRate: purchaseInvoiceLine?.exchangeRate ?? 1,
    purchaseUnitOfMeasureCode:
      purchaseInvoiceLine?.purchaseUnitOfMeasureCode ?? "",
    inventoryUnitOfMeasureCode:
      purchaseInvoiceLine?.inventoryUnitOfMeasureCode ?? "",
    conversionFactor: purchaseInvoiceLine?.conversionFactor ?? 1,
    shelfId: purchaseInvoiceLine?.shelfId ?? "",
    taxPercent: purchaseInvoiceLine?.taxPercent ?? 0,
    ...getCustomFields(purchaseInvoiceLine?.customFields)
  };

  return (
    <Fragment key={purchaseInvoiceLine?.id}>
      <PurchaseInvoiceLineForm
        key={initialValues.id}
        initialValues={initialValues}
      />
      <SupplierInteractionLineNotes
        id={purchaseInvoiceLine?.id ?? ""}
        table="purchaseInvoiceLine"
        title={t`Notes`}
        subTitle={getItemReadableId(items, purchaseInvoiceLine?.itemId) ?? ""}
        internalNotes={purchaseInvoiceLine?.internalNotes as JSONContent}
      />

      <Suspense
        fallback={
          <div className="flex w-full h-full rounded bg-gradient-to-tr from-background to-card items-center justify-center">
            <Spinner className="h-10 w-10" />
          </div>
        }
      >
        <Await resolve={files}>
          {(resolvedFiles) => (
            <SupplierInteractionLineDocuments
              files={resolvedFiles ?? []}
              id={invoiceId}
              lineId={lineId}
              type="Purchase Invoice"
              isReadOnly={isReadOnly}
            />
          )}
        </Await>
      </Suspense>

      <Outlet />
    </Fragment>
  );
}
