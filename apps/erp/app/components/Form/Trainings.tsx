import type { MultiSelectProps } from "@carbon/form";
import { MultiSelect } from "@carbon/form";
import { useMount } from "@carbon/react";
import { useMemo } from "react";
import { useFetcher } from "react-router";
import type { getTrainingsList } from "~/modules/resources";
import { path } from "~/utils/path";

type TrainingsSelectProps = Omit<MultiSelectProps, "options">;

const Trainings = (props: TrainingsSelectProps) => {
  const options = useTrainings();

  return (
    <MultiSelect
      options={options}
      {...props}
      label={props?.label ?? "Trainings"}
    />
  );
};

Trainings.displayName = "Trainings";

export default Trainings;

export const useTrainings = () => {
  const fetcher = useFetcher<Awaited<ReturnType<typeof getTrainingsList>>>();

  useMount(() => {
    fetcher.load(path.to.api.trainingsList);
  });

  const options = useMemo(
    () =>
      fetcher.data?.data
        ? fetcher.data?.data.map((c) => ({
            value: c.id,
            label: c.name
          }))
        : [],
    [fetcher.data]
  );

  return options;
};
