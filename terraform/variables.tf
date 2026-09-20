variable "name" {
  description = "Prefix for every named resource: <name>-service, <name>-backup, …"
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
    ADMIN_OPERATOR_ROLES, GOOGLE_CLIENT_ID, LOG_LEVEL and the OAUTH_* limits. The module sets
    NODE_ENV, LOG_PRETTY, AUTH_JWT_ISSUER and GOOGLE_REDIRECT_URI itself (the last two from the
    issuer) and the Web Adapter's own variables; a key here overrides the first two, never the
    adapter's. No default here names anything.
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
    error_message = "secrets must name MONGO_URI: the database is the one dependency both functions have."
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
  description = "ARNs notified when the API returns 5xx, the backup errors or the backup fails to run — the tenant's ops-signals topic, once work-service listens to it."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
