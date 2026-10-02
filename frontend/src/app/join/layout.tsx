import "./service.css";
import { ServiceIntakeRouter } from "@/components/customer-intake/service-intake-router";
import {
  intakeEnabled,
  intakePreview,
  SHEET_SHARE_EMAIL,
  INTAKE_RECIPIENT,
} from "@/lib/customer-intake/config";
export const dynamic = "force-dynamic";
export default function JoinLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ServiceIntakeRouter
        enabled={intakeEnabled()}
        preview={intakePreview()}
        shareEmail={SHEET_SHARE_EMAIL}
        contactEmail={INTAKE_RECIPIENT}
      />
      {children}
    </>
  );
}
