/**
 * The event types this service emits (ADR-0022), each with the schema that narrows its body below the
 * spine's floor: tokens only — kinds, statuses, role keys, application ids, oversight levels. Never a
 * name, an email, a subject, a sentence. The spine's relay checks the floor again; these are what make
 * "identity-service's events" a declared set rather than whatever the code happened to write.
 *
 *   PrincipalRegistered@1    a principal now exists: which kind, from which source, in which realm
 *   PrincipalSuspended@1     it can no longer act, and why (disabled by an operator, deleted)
 *   PrincipalReinstated@1    it can act again (enabled, unlocked)
 *   SeatOccupancyChanged@1   a seat was granted to or revoked from a principal on an application
 *
 * `SeatOccupancyChanged` is where identity-service's own model meets maestro's vocabulary: an
 * application's ROLE (its catalogue key, stamped into the token's `roles` claim) is the SEAT, and a user's
 * ASSIGNMENT to that application is the OCCUPANCY. One event per role that changed hands, so a reader
 * replaying a principal sees each seat come and go rather than diffing arrays.
 */
import { z } from 'zod';
import { typeKey, type TypeSchemas } from '@fps4/maestro-spine';

/** A body leaf that reads as an identifier, never as prose — the spine's own floor, restated per field. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=#-]{0,255}$/;
const token = z.string().regex(TOKEN, 'must be a token — an id, a key, an enum value; never free text');

export const PRINCIPAL_KINDS = ['human', 'agent', 'workload'] as const;
export const REGISTRATION_SOURCES = ['local', 'google', 'client_credentials', 'seed'] as const;
export const SUSPENSION_REASONS = ['disabled', 'locked', 'deleted'] as const;
export const REINSTATEMENT_REASONS = ['enabled', 'unlocked'] as const;
export const SEAT_CHANGES = ['granted', 'revoked'] as const;
export const OVERSIGHT_LEVELS = ['O0', 'O1', 'O2', 'O3', 'O4'] as const;

export type RegistrationSource = (typeof REGISTRATION_SOURCES)[number];
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];
export type ReinstatementReason = (typeof REINSTATEMENT_REASONS)[number];
export type SeatChange = (typeof SEAT_CHANGES)[number];

const bodies = {
  PrincipalRegistered: z.object({
    kind: z.enum(PRINCIPAL_KINDS),
    source: z.enum(REGISTRATION_SOURCES),
    realm: token
  }).strict(),
  PrincipalSuspended: z.object({
    reason: z.enum(SUSPENSION_REASONS)
  }).strict(),
  PrincipalReinstated: z.object({
    reason: z.enum(REINSTATEMENT_REASONS)
  }).strict(),
  SeatOccupancyChanged: z.object({
    seat: token,             // the application's role key
    application: token,      // the application id
    change: z.enum(SEAT_CHANGES),
    oversight_level: z.enum(OVERSIGHT_LEVELS)
  }).strict()
} as const;

export type RecordType = keyof typeof bodies;

export const RECORD_TYPES: TypeSchemas = new Map(
  Object.entries(bodies).map(([type, schema]) => [typeKey(type, 1), schema])
);

export const RECORD_TYPE_NAMES = Object.keys(bodies) as RecordType[];

/** True if a value can be a body token — what `seat` and `application` must be for an act to be recordable. */
export const isBodyToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);
