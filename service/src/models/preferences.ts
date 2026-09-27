/**
 * A person's preferences for one application (maestro ADR-0029): what that application wants to show
 * them first — a filter, a pin. Stored as `realm#preferences` / `<userId>#<applicationId>`, beside the
 * user; one document per person per application, at most 8 KB. It is not the registry: nothing
 * authorises by it, it is not recorded on maestro's spine, and the admin console does not show it.
 */
export interface PreferencesDocument {
  _id: string;                            // `<userId>#<applicationId>`
  userId: string;
  applicationId: string;
  preferences: Record<string, unknown>;   // the application's own shape, stored without being read
  updatedAt: Date;
}
