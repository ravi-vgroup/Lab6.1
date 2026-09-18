export function requireApproval({ role, confirmed }) {
  const allowedRoles = ["admin", "staff"];

  if (!allowedRoles.includes(role)) {
    throw new Error(
      "Approval denied: caller must be admin or staff."
    );
  }

  if (confirmed !== true) {
    throw new Error(
      "Approval denied: explicit confirmation is required."
    );
  }

  return true;
}