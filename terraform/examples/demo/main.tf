# The demo tenant's identity-service, as a root would call it. Placeholder values only (maestro
# ADR-0017): nothing here is deployed by the public repositories. A real tenant's root lives in
# fps4/maestro-config-<tenant>, its secrets in Secrets Manager under names its secrets.md lists.

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

module "identity" {
  source = "../.."

  name                  = "aannemer-x-identity"
  service_package       = "${path.module}/../../../service/bundle/service.zip"
  backup_package        = "${path.module}/../../../service/bundle/backup.zip"
  web_adapter_layer_arn = var.web_adapter_layer_arn

  # The realm's hostname is the issuer; DNS is an alias to module.identity.domain_target.
  domain          = "id.aannemer-x.example"
  certificate_arn = "arn:aws:acm:eu-west-1::certificate/replace-me"

  environment = {
    MONGO_DB_NAME          = "identity-service"
    AUTH_JWT_AUDIENCE      = "maestro"
    CORS_ORIGINS           = "https://maestro.aannemer-x.example"
    AUTH_REGISTRATION_MODE = "invite"
    AUTH_LOCAL_IDP_ENABLED = "true"
    ADMIN_OPERATOR_ROLES   = "platform_admin"
    LOG_LEVEL              = "info"
  }
  secrets = var.secrets # MONGO_URI, AUTH_JWT_SECRET, OAUTH_KEY_PASSPHRASE, IDENTITY_ADMIN_CLIENT_SECRET

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
