# Module tests with a mocked provider: no account, no credentials. What they check is the shape the
# design promises — the service behind the Web Adapter on Node 22 / arm64 with the environment the
# service reads, the secrets present by name, the issuer, the backup on its schedule with an alarm that
# treats silence as failure, a backup bucket that expires and never locks — not whether AWS accepts it.
# That is proven by the first real tenant (maestro ADR-0017).

# Terraform >= 1.11 (override_during). ARNs are mocked without an account — the layer's included: the
# public-repository guards forbid one, and the policies only need the shape.
mock_provider "aws" {
  mock_data "aws_secretsmanager_secret_version" {
    defaults = {
      secret_string = "mocked-secret-value"
    }
  }
  mock_resource "aws_s3_bucket" {
    override_during = plan
    defaults = {
      arn = "arn:aws:s3:::example-identity-backups"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    override_during = plan
    defaults = {
      arn = "arn:aws:logs:eu-west-1::log-group:/aws/lambda/example"
    }
  }
  mock_resource "aws_iam_role" {
    override_during = plan
    defaults = {
      arn = "arn:aws:iam:::role/example"
    }
  }
  mock_resource "aws_lambda_function" {
    override_during = plan
    defaults = {
      arn        = "arn:aws:lambda:eu-west-1::function:example"
      invoke_arn = "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1::function:example/invocations"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    override_during = plan
    defaults = {
      id            = "a1b2c3d4e5"
      api_endpoint  = "https://a1b2c3d4e5.execute-api.eu-west-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:eu-west-1::a1b2c3d4e5"
    }
  }
}

variables {
  service_package       = "./tests/fixtures/service.zip"
  backup_package        = "./tests/fixtures/backup.zip"
  web_adapter_layer_arn = "arn:aws:lambda:eu-west-1::layer:LambdaAdapterLayerArm64:25"
  backup_bucket_name    = "example-identity-backups"
  environment = {
    MONGO_DB_NAME          = "identity-service"
    AUTH_JWT_AUDIENCE      = "maestro"
    CORS_ORIGINS           = "https://console.aannemer-x.example"
    AUTH_REGISTRATION_MODE = "invite"
    AUTH_LOCAL_IDP_ENABLED = "true"
    ADMIN_OPERATOR_ROLES   = "platform_admin"
    LOG_LEVEL              = "info"
  }
  secrets = {
    MONGO_URI                    = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/mongo-uri"
    AUTH_JWT_SECRET              = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/jwt-secret"
    OAUTH_KEY_PASSPHRASE         = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/key-passphrase"
    IDENTITY_ADMIN_CLIENT_SECRET = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/admin-client-secret"
  }
}

run "defaults" {
  command = plan

  # --- the service behind the Web Adapter ---
  assert {
    condition     = aws_lambda_function.service.runtime == "nodejs22.x" && aws_lambda_function.service.architectures[0] == "arm64"
    error_message = "the service runs on Node 22, arm64"
  }
  assert {
    condition     = aws_lambda_function.service.handler == "run.sh" && aws_lambda_function.service.layers[0] == var.web_adapter_layer_arn
    error_message = "the service is the bundle run by the Web Adapter layer (zip mode: handler run.sh)"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["AWS_LAMBDA_EXEC_WRAPPER"]) == "/opt/bootstrap"
    error_message = "the adapter's bootstrap wraps the runtime"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["PORT"]) == "7305" && nonsensitive(aws_lambda_function.service.environment[0].variables["AWS_LWA_PORT"]) == "7305"
    error_message = "the adapter forwards to the port the service listens on"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["AWS_LWA_READINESS_CHECK_PATH"]) == "/health"
    error_message = "readiness is the service's own health check"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["NODE_ENV"]) == "production" && nonsensitive(aws_lambda_function.service.environment[0].variables["LOG_PRETTY"]) == "false"
    error_message = "production, JSON logs"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["AUTH_REGISTRATION_MODE"]) == "invite"
    error_message = "the tenant's environment reaches the service"
  }
  assert {
    condition     = alltrue([for k in ["MONGO_URI", "AUTH_JWT_SECRET", "OAUTH_KEY_PASSPHRASE", "IDENTITY_ADMIN_CLIENT_SECRET"] : contains(keys(nonsensitive(aws_lambda_function.service.environment[0].variables)), k)])
    error_message = "every secret appears as the environment variable it is mapped to"
  }
  assert {
    condition     = aws_lambda_function.service.timeout == 29 && aws_lambda_function.service.memory_size == 1024
    error_message = "29 s under the HTTP API's 30 s integration ceiling; 1 GB"
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.service.policy, "s3:") && !strcontains(aws_iam_role_policy.service.policy, "secretsmanager:")
    error_message = "the service's role is logs only: its keys live in the database"
  }

  # --- the issuer without a domain ---
  assert {
    condition     = output.issuer == "https://a1b2c3d4e5.execute-api.eu-west-1.amazonaws.com" && output.issuer == output.api_url
    error_message = "without a domain the API's default endpoint is the issuer"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["AUTH_JWT_ISSUER"]) == output.issuer
    error_message = "AUTH_JWT_ISSUER is the issuer the module outputs"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["GOOGLE_REDIRECT_URI"]) == "${output.issuer}/oauth2/callback"
    error_message = "Google's redirect URI is the issuer's callback"
  }
  assert {
    condition     = length(aws_apigatewayv2_domain_name.this) == 0 && length(aws_apigatewayv2_api_mapping.this) == 0 && output.domain_target == null
    error_message = "no domain, no domain resources"
  }

  # --- the HTTP API ---
  assert {
    condition     = aws_apigatewayv2_api.this.protocol_type == "HTTP" && aws_apigatewayv2_route.default.route_key == "$default"
    error_message = "an HTTP API with one $default route: the service routes"
  }
  assert {
    condition     = aws_apigatewayv2_integration.service.payload_format_version == "2.0" && aws_apigatewayv2_integration.service.integration_type == "AWS_PROXY"
    error_message = "AWS_PROXY, payload 2.0 — what the Web Adapter speaks"
  }
  assert {
    condition     = aws_apigatewayv2_stage.default.name == "$default" && aws_apigatewayv2_stage.default.auto_deploy == true
    error_message = "the $default stage, auto-deployed, so the endpoint has no stage path"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.api_5xx.threshold == 5 && aws_cloudwatch_metric_alarm.api_5xx.period == 300
    error_message = "5xx alarms at five in five minutes"
  }

  # --- the backup ---
  assert {
    condition     = aws_scheduler_schedule.backup.schedule_expression == "cron(30 2 * * ? *)" && aws_scheduler_schedule.backup.schedule_expression_timezone == "UTC"
    error_message = "the backup runs at 02:30 UTC nightly"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.backup_silent.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.backup_silent.period == 86400
    error_message = "a backup that never reports is an alarm, not a quiet day"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.backup_errors.threshold == 1 && aws_cloudwatch_metric_alarm.backup_errors.period == 86400
    error_message = "one backup error in a day alarms"
  }
  assert {
    condition     = aws_lambda_function.backup.runtime == "nodejs22.x" && aws_lambda_function.backup.handler == "index.handler" && aws_lambda_function.backup.layers == null
    error_message = "the backup is a plain handler on Node 22, no adapter"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.backup.environment[0].variables["BACKUP_BUCKET"]) == "example-identity-backups" && nonsensitive(aws_lambda_function.backup.environment[0].variables["BACKUP_PREFIX"]) == "backups"
    error_message = "the backup writes to the bucket under the prefix"
  }
  assert {
    condition     = contains(keys(nonsensitive(aws_lambda_function.backup.environment[0].variables)), "MONGO_URI") && !contains(keys(nonsensitive(aws_lambda_function.backup.environment[0].variables)), "BACKUP_PASSPHRASE")
    error_message = "the backup gets the database secret and, without one configured, no passphrase"
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.backup.policy, "s3:PutObject") && !strcontains(aws_iam_role_policy.backup.policy, "s3:GetObject") && !strcontains(aws_iam_role_policy.backup.policy, "Delete")
    error_message = "the backup writes; it never reads or deletes a backup"
  }

  # --- the backup bucket ---
  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.backup.rule[0].expiration[0].days == 35 && aws_s3_bucket_lifecycle_configuration.backup.rule[0].status == "Enabled"
    error_message = "backups expire after 35 days by default"
  }
  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.backup.rule[0].filter[0].prefix == "backups/"
    error_message = "the lifecycle rule is scoped to the backup prefix"
  }
  assert {
    condition     = aws_s3_bucket.backup.object_lock_enabled == false
    error_message = "a backup bucket has no Object Lock: backups are recovery points, not the record"
  }
  assert {
    condition     = aws_s3_bucket_versioning.backup.versioning_configuration[0].status == "Enabled"
    error_message = "versioned, so an overwritten day is still recoverable"
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.backup.block_public_acls && aws_s3_bucket_public_access_block.backup.restrict_public_buckets
    error_message = "a backup bucket is never public"
  }
  assert {
    condition     = anytrue([for r in aws_s3_bucket_server_side_encryption_configuration.backup.rule : r.apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"])
    error_message = "encrypted at rest"
  }
  assert {
    condition     = strcontains(aws_s3_bucket_policy.backup.policy, "aws:SecureTransport")
    error_message = "TLS only"
  }
}

run "with_a_domain" {
  command = plan

  variables {
    domain                       = "id.aannemer-x.example"
    certificate_arn              = "arn:aws:acm:eu-west-1::certificate/example"
    backup_passphrase_secret_arn = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/backup-passphrase"
    backup_retention_days        = 90
    backup_prefix                = "identity/backups/"
  }

  assert {
    condition     = output.issuer == "https://id.aannemer-x.example"
    error_message = "with a domain the issuer is the domain"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["AUTH_JWT_ISSUER"]) == "https://id.aannemer-x.example"
    error_message = "the service is told the same issuer"
  }
  assert {
    condition     = length(aws_apigatewayv2_domain_name.this) == 1 && length(aws_apigatewayv2_api_mapping.this) == 1
    error_message = "the domain is mapped onto the API"
  }
  assert {
    condition     = aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].security_policy == "TLS_1_2" && aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].endpoint_type == "REGIONAL"
    error_message = "regional endpoint, TLS 1.2"
  }
  assert {
    condition     = output.domain_target != null && output.domain_target.name != "" && output.domain_target.zone_id != ""
    error_message = "the root gets the alias target for its DNS record"
  }
  assert {
    condition     = contains(keys(nonsensitive(aws_lambda_function.backup.environment[0].variables)), "BACKUP_PASSPHRASE")
    error_message = "a configured passphrase reaches the backup"
  }
  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.backup.rule[0].expiration[0].days == 90 && aws_s3_bucket_lifecycle_configuration.backup.rule[0].filter[0].prefix == "identity/backups/"
    error_message = "retention and prefix follow the tenant, the prefix's slash normalised"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.backup.environment[0].variables["BACKUP_PREFIX"]) == "identity/backups" && output.backup_prefix == "identity/backups"
    error_message = "the backup function gets the prefix without its trailing slash"
  }
}

run "the_environment_cannot_override_the_adapter" {
  command = plan

  variables {
    environment = {
      PORT                    = "9999"
      AWS_LAMBDA_EXEC_WRAPPER = "/opt/nothing"
      AUTH_JWT_ISSUER         = "https://somewhere.else.example"
      LOG_PRETTY              = "true"
    }
  }

  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["PORT"]) == "7305" && nonsensitive(aws_lambda_function.service.environment[0].variables["AWS_LAMBDA_EXEC_WRAPPER"]) == "/opt/bootstrap"
    error_message = "the port and the wrapper are the module's"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["AUTH_JWT_ISSUER"]) == output.issuer
    error_message = "the issuer is the module's: it is what the API answers on"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["LOG_PRETTY"]) == "true"
    error_message = "a module default, though, the tenant may override"
  }
}

run "rejects_a_domain_without_a_certificate" {
  command = plan

  variables {
    domain = "id.aannemer-x.example"
  }

  expect_failures = [aws_apigatewayv2_domain_name.this]
}

run "rejects_secrets_without_the_database" {
  command = plan

  variables {
    secrets = {
      AUTH_JWT_SECRET = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/jwt-secret"
    }
  }

  expect_failures = [var.secrets]
}

run "rejects_a_layer_that_is_not_the_adapter" {
  command = plan

  variables {
    web_adapter_layer_arn = "arn:aws:lambda:eu-west-1::layer:SomethingElse:1"
  }

  expect_failures = [var.web_adapter_layer_arn]
}
