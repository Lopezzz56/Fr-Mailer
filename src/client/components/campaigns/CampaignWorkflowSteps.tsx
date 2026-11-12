import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

const steps = ["Contacts", "Campaign Templates", "Sequence", "Review", "Send"];

export function CampaignWorkflowSteps({
  activeStep,
  onStepChange,
}: {
  activeStep: number;
  onStepChange?: (step: number) => void;
}) {
  return (
    <ol aria-label="Campaign workflow" className="mb-6 flex items-center overflow-x-auto">
      {steps.map((step, index) => {
        const complete = index < activeStep;
        const active = index === activeStep;
        return (
          <li key={step} className="flex min-w-0 flex-1 items-center last:flex-none">
            <button
              type="button"
              onClick={() => onStepChange?.(index)}
              disabled={!onStepChange || index > activeStep}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md text-left",
                onStepChange && index < activeStep && "cursor-pointer hover:text-brand",
                (!onStepChange || index > activeStep) && "cursor-default"
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold",
                  complete && "border-brand bg-brand text-white",
                  active && "border-brand bg-brand-soft text-brand",
                  !complete && !active && "border-line bg-surface text-ink-faint"
                )}
              >
                {complete ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span className={cn("whitespace-nowrap text-xs", active ? "font-semibold text-ink" : "text-ink-subtle")}>
                {step}
              </span>
            </button>
            {index < steps.length - 1 && <span className="mx-3 h-px min-w-4 flex-1 bg-line" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
