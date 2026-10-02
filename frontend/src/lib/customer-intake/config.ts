// The fixed recipient is an operator decision; never read it from a public request.
export const INTAKE_RECIPIENT = "nccu95208069@gmail.com";
export const SHEET_SHARE_EMAIL = "nccu95208069@gmail.com";
export function intakeEnabled() {
  return process.env.CUSTOMER_INTAKE_ENABLED === "true";
}

export function intakePreview() {
  return process.env.CUSTOMER_INTAKE_PREVIEW === "true";
}
