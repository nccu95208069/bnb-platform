"use client";

import { useWizardStore } from "@/stores/wizardStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import { WizardProgress } from "./WizardProgress";
import { StepRecipient } from "./StepRecipient";
import { StepContent } from "./StepContent";
import { StepMedia } from "./StepMedia";
import { StepPreview } from "./StepPreview";
import { StepConfirm } from "./StepConfirm";

const stepComponents = {
  1: StepRecipient,
  2: StepContent,
  3: StepMedia,
  4: StepPreview,
  5: StepConfirm,
} as const;

export function MessageWizard() {
  useAutoSave();
  const currentStep = useWizardStore((s) => s.currentStep);
  const lastSavedAt = useWizardStore((s) => s.lastSavedAt);

  const StepComponent = stepComponents[currentStep];

  return (
    <div className="space-y-6">
      <WizardProgress />
      <StepComponent />
      {lastSavedAt && (
        <p className="text-center text-xs text-muted-foreground">
          上次自動儲存：{new Date(lastSavedAt).toLocaleTimeString("zh-TW")}
        </p>
      )}
    </div>
  );
}
