import { useCarbon } from "@carbon/auth";
import { ValidatedForm } from "@carbon/form";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  HStack,
  toast,
  VStack
} from "@carbon/react";
import { useEffect, useState } from "react";
import { useFetcher, useParams } from "react-router";
import type { z } from "zod";
import {
  ConversionFactor,
  CustomFormFields,
  Hidden,
  Input,
  // biome-ignore lint/suspicious/noShadowRestrictedNames: suppressed due to migration
  Number,
  Submit,
  Supplier,
  UnitOfMeasure
} from "~/components/Form";
import { useCurrencyFormatter, usePermissions, useUser } from "~/hooks";
import { path } from "~/utils/path";
import { supplierPartValidator } from "../../items.models";

type SupplierPartFormProps = {
  initialValues: z.infer<typeof supplierPartValidator>;
  type: "Part" | "Service" | "Tool" | "Consumable" | "Material";
  unitOfMeasureCode: string;
  onClose: () => void;
};

const SupplierPartForm = ({
  initialValues,
  type,
  unitOfMeasureCode,
  onClose
}: SupplierPartFormProps) => {
  const { carbon } = useCarbon();
  const permissions = usePermissions();
  const formatter = useCurrencyFormatter();

  const { company } = useUser();
  const baseCurrency = company?.baseCurrencyCode ?? "USD";

  let { itemId } = useParams();

  if (!itemId) {
    itemId = initialValues.itemId;
  }

  const [purchaseUnitOfMeasure, setPurchaseUnitOfMeasure] = useState<
    string | undefined
  >(initialValues.supplierUnitOfMeasureCode);

  const isEditing = initialValues.id !== undefined;
  const isDisabled = isEditing
    ? !permissions.can("update", "parts")
    : !permissions.can("create", "parts");

  const action = getAction(isEditing, type, itemId, initialValues.id);
  const fetcher = useFetcher<{ success: boolean; message: string }>();

  // Fetch price breaks for existing supplier parts
  const [priceBreaks, setPriceBreaks] = useState<
    {
      quantity: number;
      unitPrice: number;
      leadTime: number | null;
      sourceType: string;
    }[]
  >([]);

  useEffect(() => {
    if (!carbon || !isEditing || !initialValues.id) return;

    carbon
      .from("supplierPartPrice")
      .select("quantity, unitPrice, leadTime, sourceType")
      .eq("supplierPartId", initialValues.id)
      .order("quantity", { ascending: true })
      .then(({ data }) => {
        if (data?.length) setPriceBreaks(data);
      });
  }, [carbon, isEditing, initialValues.id]);

  useEffect(() => {
    if (fetcher.data?.success) {
      onClose();
    } else if (fetcher.data?.message) {
      toast.error(fetcher.data.message);
    }
  }, [fetcher.data?.success, fetcher.data?.message, onClose]);

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent size="lg">
        <ValidatedForm
          defaultValues={initialValues}
          validator={supplierPartValidator}
          method="post"
          action={action}
          className="flex flex-col h-full"
          fetcher={fetcher}
        >
          <DrawerHeader>
            <DrawerTitle>
              {isEditing ? "Edit" : "New"} Supplier Part
            </DrawerTitle>
          </DrawerHeader>
          <DrawerBody>
            <Hidden name="id" />
            <Hidden name="itemId" />

            <VStack spacing={4}>
              <Supplier name="supplierId" label="Supplier" />
              <Input name="supplierPartId" label="Supplier Part ID" />
              <Number
                name="unitPrice"
                label="Unit Price"
                minValue={0}
                formatOptions={{
                  style: "currency",
                  currency: baseCurrency
                }}
              />
              {/* last purchase info (read-only) */}
              {initialValues.lastPurchaseDate && (
                <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3 space-y-1">
                  <div className="font-medium text-foreground">
                    Last Purchase Info
                  </div>
                  <div>
                    Date:{" "}
                    {new Date(
                      initialValues.lastPurchaseDate
                    ).toLocaleDateString()}
                  </div>
                  {initialValues.lastPOQuantity != null && (
                    <div>
                      Quantity: {initialValues.lastPOQuantity.toLocaleString()}
                    </div>
                  )}
                </div>
              )}
              {/* Show quantity price breaks if available */}
              {priceBreaks.length > 0 && (
                <div className="text-sm bg-muted/50 rounded-md p-3 space-y-2 w-full">
                  <div className="font-medium text-foreground">
                    Price Breaks
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-muted-foreground border-b">
                        <th className="text-left py-1">Qty</th>
                        <th className="text-right py-1">Unit Price</th>
                        <th className="text-right py-1">Lead Time</th>
                        <th className="text-right py-1">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceBreaks.map((pb) => (
                        <tr
                          key={pb.quantity}
                          className="border-b last:border-0"
                        >
                          <td className="py-1">
                            {pb.quantity.toLocaleString()}
                          </td>
                          <td className="text-right py-1">
                            {formatter.format(pb.unitPrice)}
                          </td>
                          <td className="text-right py-1">
                            {pb.leadTime != null ? `${pb.leadTime}d` : "—"}
                          </td>
                          <td className="text-right py-1 text-muted-foreground">
                            {pb.sourceType}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <UnitOfMeasure
                name="supplierUnitOfMeasureCode"
                label="Unit of Measure"
                onChange={(value) => {
                  if (value) setPurchaseUnitOfMeasure(value.value);
                }}
              />
              <ConversionFactor
                name="conversionFactor"
                label="Conversion Factor"
                inventoryCode={unitOfMeasureCode ?? undefined}
                purchasingCode={purchaseUnitOfMeasure}
              />
              <Number
                name="minimumOrderQuantity"
                label="Minimum Order Quantity"
                minValue={0}
              />
              <CustomFormFields table="partSupplier" />
            </VStack>
          </DrawerBody>
          <DrawerFooter>
            <HStack>
              <Submit
                isDisabled={isDisabled || fetcher.state !== "idle"}
                isLoading={fetcher.state !== "idle"}
                withBlocker={false}
              >
                Save
              </Submit>
              <Button size="md" variant="solid" onClick={onClose}>
                Cancel
              </Button>
            </HStack>
          </DrawerFooter>
        </ValidatedForm>
      </DrawerContent>
    </Drawer>
  );
};

export default SupplierPartForm;

function getAction(
  isEditing: boolean,
  type: "Part" | "Service" | "Tool" | "Consumable" | "Material",
  itemId: string,
  id?: string
) {
  if (type === "Part") {
    if (isEditing) {
      return path.to.partSupplier(itemId, id!);
    } else {
      return path.to.newPartSupplier(itemId);
    }
  }
  if (type === "Service") {
    if (isEditing) {
      return path.to.serviceSupplier(itemId, id!);
    } else {
      return path.to.newServiceSupplier(itemId);
    }
  }

  if (type === "Tool") {
    if (isEditing) {
      return path.to.toolSupplier(itemId, id!);
    } else {
      return path.to.newToolSupplier(itemId);
    }
  }

  if (type === "Consumable") {
    if (isEditing) {
      return path.to.consumableSupplier(itemId, id!);
    } else {
      return path.to.newConsumableSupplier(itemId);
    }
  }

  if (type === "Material") {
    if (isEditing) {
      return path.to.materialSupplier(itemId, id!);
    } else {
      return path.to.newMaterialSupplier(itemId);
    }
  }

  throw new Error("Invalid type");
}
