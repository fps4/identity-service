/**
 * A user's entitlement to an application (ADR-0019, application-scoped per ADR-0020). One record per
 * `(userId, applicationId)` pair: it both GATES issuance (a user with no active assignment for an
 * application is denied a token — a hard, global gate) and carries the app-scoped `roles` stamped into
 * that app's token `roles` claim. Roles must be a subset of the application's role catalogue
 * (`application.roles[].key`). A user assigned to an application may log in through ANY of its
 * user-login credentials.
 *
 * `userId` is the user record `_id` (resolved regardless of local vs. federated login), NOT the token
 * `sub` — for a federated login the `sub` is the provider subject, so issuance resolves the user first,
 * then looks the assignment up by `_id`.
 *
 * Assignments do NOT apply to client-credentials (machine) credentials — those have no user.
 *
 * The pair IS the key: `realm#assignment` / `<userId>#<applicationId>` (ADR-0023), which is what made
 * it unique before. There is no separate id.
 */
export interface AssignmentDocument {
  userId: string;        // User._id
  applicationId: string; // Application._id
  roles: string[];       // app-scoped roles (subset of the application's catalogue)
  status: 'active' | 'suspended';
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
