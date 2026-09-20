variable "name" {
  description = "Prefix for every named resource: <name>-service, <name>-backup, <name>-relay, …"
  type        = string
  default     = "maestro-identity"
}

# --- the code ------------------------------------------------------------------------------------

variable "service_package" {
  description = "Path to the service's zip, produced by `npm run bundle` in service/ (bundle/service.zip): the Express server plus run.sh for the Web Adapter."
  type        = string
}

variable "backup_package" {
  description = "Path to the backup Lambda's zip, produced by `npm run bundle` in service/ (bundle/backup.zip)."
  type        = string
}

variable "relay_package" {
  description = "Path to the relay Lambda's zip, produced by `npm run bundle` in service/ (bundle/relay.zip): the spine's relay handler over this service's outbox (ADR-0022 §5)."
  type        = string
}

variable "web_adapter_layer_arn" {
  description = <<-EOT
    The Lambda Web Adapter layer for arm64, in the deployment's region — `LambdaAdapterLayerArm64`,
    published by AWS. Its ARN carries AWS's account id, which a public repository may not hold, so it
    is an input: find the current version in the adapter's README
    (https://github.com/awslabs/aws-lambda-web-adapter#lambda-functions-packaged-as-zip-package-for-aws-managed-runtimes)
    and put `arn:aws:lambda:<region>:<aws-account>:layer:LambdaAdapterLayerArm64:<version>` in the tenant's tfvars.
  EOT
  type        = string
  validation {
    # The account part is not checked: the module's tests mock an ARN without one, as the
    # public-repository guards require.
    condition     = can(regex("^arn:aws[a-z-]*:lambda:[a-z0-9-]+:[0-9]*:layer:LambdaAdapterLayerArm64:[0-9]+$", var.web_adapter_layer_arn))
    error_message = "web_adapter_layer_arn is the arm64 Web Adapter layer's ARN, with a version."
  }
}

# --- the realm's configuration -------------------------------------------------------------------

variable "environment" {
  description = <<-EOT
    Every non-secret environment variable the service reads (service/.env.example lists them all;
    docs/guides/deployment.md says which a deployment must set). Typically: MONGO_DB_NAME,
    AUTH_JWT_AUDIENCE, CORS_ORIGINS, AUTH_REGISTRATION_MODE, AUTH_LOCAL_IDP_ENABLED,
    ADMIN_OPERATOR_ROLES, GOOGLE_CLIENT_ID, LOG_LEVEL and the OAUTH_* limits — and the record's
    (ADR-0022): MAESTRO_WORKSPACE_ID (this deployment's workspace on maestro's record, `ws-<realm
    slug>`; the service defaults to ws-identity-dev, which no tenant should keep), MAESTRO_ACCOUNTABLE
    (the `prn-h-…` of the human answerable for machine actors' acts; without it an agent or a pipeline
    acting through the management plane is refused) and MAESTRO_CONSEQUENCE_CLASS (`c1` by default).
    The module sets NODE_ENV, LOG_PRETTY, AUTH_JWT_ISSUER and GOOGLE_REDIRECT_URI itself (the last
    two from the issuer), RECORD_SINK=off on the service (the relay function drains the outbox; the
    service relays nothing in-process) and the Web Adapter's own variables; a key here overrides the
    first two, never the rest. The relay function receives the same map. No default here names
    anything.
  EOT
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = <<-EOT
    Environment variable → Secrets Manager secret ARN, read at plan time and set on the function:
    MONGO_URI, AUTH_JWT_SECRET, OAUTH_KEY_PASSPHRASE, IDENTITY_ADMIN_CLIENT_SECRET and, when Google
    federates the login, GOOGLE_CLIENT_SECRET. The value lands in the state and in the function's
    configuration, as a secret in any Lambda environment does — the state bucket is what protects
    it (ADR-0017). Reading at boot through the Parameters and Secrets Lambda extension is the
    follow-up, once the service reads its configuration from there.
  EOT
  type        = map(string)
  validation {
    condition     = contains(keys(var.secrets), "MONGO_URI")
    error_message = "secrets must name MONGO_URI: the database is the one dependency every function has."
  }
}

variable "domain" {
  description = <<-EOT
    The realm's hostname, e.g. id.<tenant-domain> — the issuer every token carries and every consumer
    verifies against, so it must never change. With a domain, `certificate_arn` is required and the
    root points DNS at `domain_target`. Without one the API's default endpoint is the issuer; that
    endpoint is an id AWS assigns, and a redeploy that recreates the API changes it and every
    consumer's verifier with it. Use a domain for anything past a trial.
  EOT
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "ACM certificate for `domain`, in the deployment's region. Required with `domain`."
  type        = string
  default     = null
}

# --- backups -------------------------------------------------------------------------------------

variable "backup_bucket_name" {
  description = "The backup bucket. Globally unique, the tenant's to choose; the tenant's tfvars hold it."
  type        = string
}

variable "backup_prefix" {
  description = "Key prefix inside the backup bucket, under which each day's backup is written."
  type        = string
  default     = "backups"
}

variable "backup_retention_days" {
  description = "Days after which a backup expires from the bucket (a lifecycle rule; the bucket has no Object Lock)."
  type        = number
  default     = 35
  validation {
    condition     = var.backup_retention_days >= 1
    error_message = "Retention is at least one day."
  }
}

variable "backup_schedule" {
  description = "EventBridge Scheduler expression for the backup, evaluated in UTC. 02:30 nightly, as docker/backup.sh's crontab line was."
  type        = string
  default     = "cron(30 2 * * ? *)"
}

variable "backup_passphrase_secret_arn" {
  description = "Optional Secrets Manager secret holding a passphrase; when set, every backup object is also AES-256-GCM encrypted under it (see service/lambda/backup-crypto.ts). Without it the bucket's SSE, public-access block and IAM are the protection, as the plaintext backup.sh path was (ADR-0008)."
  type        = string
  default     = null
}

variable "backup_memory_mb" {
  description = "The backup buffers each collection compressed in memory before it writes it; size for the largest collection (the audit log)."
  type        = number
  default     = 1024
}

variable "backup_timeout_seconds" {
  type    = number
  default = 900
}

# --- the record ----------------------------------------------------------------------------------

variable "archive" {
  description = <<-EOT
    The spine's archive, as the spine's Terraform module outputs it: `relay_environment`
    (ARCHIVE_BUCKET, ARCHIVE_PREFIX, EVENTS_TOPIC_ARN — the names the spine's relay handler reads)
    and `relay_policy_json` (what a relay's role may do: read and write the archive prefix, publish
    to the events topic, never delete). Pass module.spine.relay_environment and
    module.spine.relay_policy_json. Required: the record is not optional in maestro — a deployment
    without an archive would write an outbox nothing ever drains (ADR-0022 §5).
  EOT
  type = object({
    relay_environment = map(string)
    relay_policy_json = string
  })
  validation {
    condition     = alltrue([for k in ["ARCHIVE_BUCKET", "ARCHIVE_PREFIX", "EVENTS_TOPIC_ARN"] : contains(keys(var.archive.relay_environment), k)])
    error_message = "archive.relay_environment carries ARCHIVE_BUCKET, ARCHIVE_PREFIX and EVENTS_TOPIC_ARN — the spine module's relay_environment output."
  }
}

variable "relay_schedule" {
  description = "EventBridge Scheduler expression for the relay, which drains the outbox into the archive. One minute is the latency between an act and its record."
  type        = string
  default     = "rate(1 minute)"
}

variable "relay_memory_mb" {
  type    = number
  default = 512
}

variable "relay_timeout_seconds" {
  description = "One pass drains the outbox in batches until it is empty; a long backlog after an outage is the case that needs the time."
  type        = number
  default     = 300
}

# --- sizing and operations ------------------------------------------------------------------------

variable "memory_mb" {
  type    = number
  default = 1024
}

variable "timeout_seconds" {
  description = "The service function's timeout. An HTTP API integration times out at 30 s, so 29 is the ceiling that still returns the function's own error."
  type        = number
  default     = 29
  validation {
    condition     = var.timeout_seconds >= 1 && var.timeout_seconds <= 30
    error_message = "timeout_seconds is between 1 and 30: the HTTP API integration timeout."
  }
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "alarm_actions" {
  description = "ARNs notified when the API returns 5xx, the backup or the relay errors or fails to run, or the spine refuses an event — the tenant's ops-signals topic, once work-service listens to it."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
