# The demo tenant's identity-service, as a root would call it: the spine's module at a tag, and this
# one composed with its outputs — the relay carries the registry's events into the spine's archive
# (ADR-0022). Placeholder values only (maestro ADR-0017): nothing here is deployed by the public
# repositories. A real tenant's root lives in fps4/maestro-config-<tenant>, its secrets in Secrets
# Manager under names its secrets.md lists.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "web_adapter_layer_arn" {
  description = "arn:aws:lambda:<region>:<aws-account>:layer:LambdaAdapterLayerArm64:<version> — from the adapter's README; the tenant's tfvars hold it."
  type        = string
}

variable "secrets" {
  description = "Environment variable → Secrets Manager ARN; the tenant's tfvars hold them."
  type        = map(string)
}

# The spine: the archive bucket, the events topic, the sealer. One per tenant; every component's
# relay writes under its own prefix. Its sealer bundle comes from `npm run bundle` in maestro/spine.
module "spine" {
  source = "github.com/fps4/maestro//spine/terraform?ref=spine-v0.2.2"

  name                = "aannemer-x"
  archive_bucket_name = "aannemer-x-maestro-archive"
  archive_prefix      = "identity/"
  digest_contacts     = ["ops@aannemer-x.example"]
  sealer_package      = "${path.module}/sealer.zip"

  tags = { "maestro:tenant" = "aannemer-x" }
}

module "identity" {
  source = "../.."

  name                  = "aannemer-x-identity"
  service_package       = "${path.module}/../../../service/bundle/service.zip"
  backup_package        = "${path.module}/../../../service/bundle/backup.zip"
  relay_package         = "${path.module}/../../../service/bundle/relay.zip"
  web_adapter_layer_arn = var.web_adapter_layer_arn

  # The realm's hostname is the issuer; DNS is an alias to module.identity.domain_target.
  domain          = "id.aannemer-x.example"
  certificate_arn = "arn:aws:acm:eu-west-1::certificate/replace-me"

  environment = {
    AUTH_JWT_AUDIENCE      = "maestro"
    CORS_ORIGINS           = "https://maestro.aannemer-x.example"
    AUTH_REGISTRATION_MODE = "invite"
    AUTH_LOCAL_IDP_ENABLED = "true"
    ADMIN_OPERATOR_ROLES   = "platform_admin"
    LOG_LEVEL              = "info"
    # The record (ADR-0022): this realm's workspace, and the human answerable for what the realm's
    # own automation does — a prn-h-… from the seeded pool; without it a machine actor is refused.
    MAESTRO_WORKSPACE_ID      = "ws-aannemer-x"
    MAESTRO_ACCOUNTABLE       = "prn-h-replaceme0000"
    MAESTRO_CONSEQUENCE_CLASS = "c1"
  }
  secrets = var.secrets # AUTH_JWT_SECRET, OAUTH_KEY_PASSPHRASE, IDENTITY_ADMIN_CLIENT_SECRET — no database credential (ADR-0023)

  # The spine module's outputs, passed through: the relay's names and its policy.
  archive = {
    relay_environment = module.spine.relay_environment
    relay_policy_json = module.spine.relay_policy_json
  }

  backup_bucket_name = "aannemer-x-identity-backups"
  alarm_actions      = []

  tags = { "maestro:tenant" = "aannemer-x" }
}

output "issuer" {
  description = "AUTH_JWT_ISSUER for every consumer's verifier; the JWKS is at <issuer>/.well-known/jwks.json."
  value       = module.identity.issuer
}

output "domain_target" {
  value = module.identity.domain_target
}

output "table_name" {
  description = "The realm's table: what a seed run from an operator's shell names as TABLE_NAME."
  value       = module.identity.table_name
}
