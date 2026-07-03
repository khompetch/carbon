import { PlanView } from "@carbon/onboarding/ui";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { path } from "~/utils/path";

// Scroll to (and briefly highlight) the step card linked from the hub's
// "View in project plan" deep link. State + mutations come from
// <HubProvider> in the layout.
export default function GetStartedPlanRoute() {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-2", "ring-primary");
    const t = setTimeout(
      () => el.classList.remove("ring-2", "ring-primary"),
      1600
    );
    return () => clearTimeout(t);
  }, [hash]);

  return (
    <PlanView
      onOpenSetupMap={() =>
        window.open(
          path.to.getStartedPage("setup"),
          "_blank",
          "noopener,noreferrer"
        )
      }
    />
  );
}
