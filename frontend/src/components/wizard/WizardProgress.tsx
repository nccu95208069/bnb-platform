"use client";

import { cn } from "@/lib/utils";
import { useWizardStore, type WizardStep } from "@/stores/wizardStore";
import { Check, User, FileText, Image, Eye, Send } from "lucide-react";

const steps: { step: WizardStep; label: string; icon: React.ElementType }[] = [
  { step: 1, label: "收件人", icon: User },
  { step: 2, label: "內容", icon: FileText },
  { step: 3, label: "媒體", icon: Image },
  { step: 4, label: "預覽", icon: Eye },
  { step: 5, label: "確認", icon: Send },
];

export function WizardProgress() {
  const currentStep = useWizardStore((s) => s.currentStep);
  const setStep = useWizardStore((s) => s.setStep);

  return (
    <nav aria-label="訊息建立進度" className="mb-8">
      <ol className="flex items-center justify-between">
        {steps.map(({ step, label, icon: Icon }, index) => {
          const isCompleted = currentStep > step;
          const isCurrent = currentStep === step;
          const isClickable = step < currentStep;

          return (
            <li key={step} className="flex flex-1 items-center">
              <button
                type="button"
                onClick={() => isClickable && setStep(step)}
                disabled={!isClickable}
                className={cn(
                  "flex flex-col items-center gap-2 transition-colors",
                  isClickable && "cursor-pointer",
                  !isClickable && !isCurrent && "cursor-default"
                )}
                aria-current={isCurrent ? "step" : undefined}
              >
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all",
                    isCompleted &&
                      "border-primary bg-primary text-primary-foreground",
                    isCurrent &&
                      "border-primary bg-background text-primary ring-4 ring-primary/20",
                    !isCompleted &&
                      !isCurrent &&
                      "border-muted-foreground/30 text-muted-foreground"
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-5 w-5" />
                  ) : (
                    <Icon className="h-5 w-5" />
                  )}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium",
                    isCurrent && "text-primary",
                    isCompleted && "text-primary",
                    !isCompleted && !isCurrent && "text-muted-foreground"
                  )}
                >
                  {label}
                </span>
              </button>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    "mx-2 h-0.5 flex-1",
                    currentStep > step + 1
                      ? "bg-primary"
                      : currentStep > step
                        ? "bg-primary/50"
                        : "bg-muted-foreground/20"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
