# Module tests with a mocked provider: no account, no credentials. What they check is the shape the
# design promises — the table keyed pk/sk with its indexes, TTL and point-in-time recovery, granted to
# each function and named on it; the service behind the Web Adapter on Node 22 / arm64 with the
# environment the service reads and RECORD_SINK=off, the secrets present by name and no database
# credential among them, the issuer, the backup on its schedule with an alarm that treats silence as
# failure, a backup bucket that expires and never locks, the relay carrying the spine's names under the
# spine's policy on its schedule, one at a time — not whether AWS accepts it. That is proven by the
# first real tenant (maestro ADR-0017).

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
  mock_resource "aws_dynamodb_table" {
    override_during = plan
    defaults = {
      arn = "arn:aws:dynamodb:eu-west-1::table/maestro-identity"
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
  relay_package         = "./tests/fixtures/relay.zip"
  web_adapter_layer_arn = "arn:aws:lambda:eu-west-1::layer:LambdaAdapterLayerArm64:25"
  backup_bucket_name    = "example-identity-backups"
  environment = {
    AUTH_JWT_AUDIENCE         = "maestro"
    CORS_ORIGINS              = "https://console.aannemer-x.example"
    AUTH_REGISTRATION_MODE    = "invite"
    AUTH_LOCAL_IDP_ENABLED    = "true"
    ADMIN_OPERATOR_ROLES      = "platform_admin"
    LOG_LEVEL                 = "info"
    MAESTRO_WORKSPACE_ID      = "ws-aannemer-x"
    MAESTRO_ACCOUNTABLE       = "prn-h-0000000000ex"
    MAESTRO_CONSEQUENCE_CLASS = "c1"
  }
  secrets = {
    AUTH_JWT_SECRET              = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/jwt-secret"
    OAUTH_KEY_PASSPHRASE         = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/key-passphrase"
    IDENTITY_ADMIN_CLIENT_SECRET = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/admin-client-secret"
  }
  # The spine module's outputs, as a root passes them.
  archive = {
    relay_environment = {
      ARCHIVE_BUCKET   = "aannemer-x-maestro-archive"
      ARCHIVE_PREFIX   = "identity/"
      EVENTS_TOPIC_ARN = "arn:aws:sns:eu-west-1::aannemer-x-spine-events.fifo"
    }
    relay_policy_json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\"],\"Resource\":\"arn:aws:s3:::aannemer-x-maestro-archive\"}]}"
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
    condition     = alltrue([for k in ["AUTH_JWT_SECRET", "OAUTH_KEY_PASSPHRASE", "IDENTITY_ADMIN_CLIENT_SECRET"] : contains(keys(nonsensitive(aws_lambda_function.service.environment[0].variables)), k)])
    error_message = "every secret appears as the environment variable it is mapped to"
  }
  assert {
    condition     = !contains(keys(nonsensitive(aws_lambda_function.service.environment[0].variables)), "MONGO_URI") && nonsensitive(aws_lambda_function.service.environment[0].variables["TABLE_NAME"]) == "maestro-identity"
    error_message = "no database credential: the service is told its table's name, and reaches it by its role"
  }
  assert {
    condition     = aws_lambda_function.service.timeout == 29 && aws_lambda_function.service.memory_size == 1024
    error_message = "29 s under the HTTP API's 30 s integration ceiling; 1 GB"
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.service.policy, "s3:") && !strcontains(aws_iam_role_policy.service.policy, "secretsmanager:") && !strcontains(aws_iam_role_policy.service.policy, "sns:")
    error_message = "the service's role is its table and its logs: its keys live in the table, the archive is the relay's"
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.service.policy, "dynamodb:TransactWriteItems") && strcontains(aws_iam_role_policy.service.policy, "dynamodb:Query") && strcontains(aws_iam_role_policy.service.policy, "/index/*") && !strcontains(aws_iam_role_policy.service.policy, "dynamodb:Scan")
    error_message = "the service transacts and queries its table and its indexes; it never scans"
  }

  # --- the table ---
  assert {
    condition     = aws_dynamodb_table.records.name == "maestro-identity" && aws_dynamodb_table.records.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.records.hash_key == "pk" && aws_dynamodb_table.records.range_key == "sk"
    error_message = "one on-demand table per deployment, named after the module, keyed pk/sk (maestro ADR-0018)"
  }
  assert {
    condition     = toset([for i in aws_dynamodb_table.records.global_secondary_index : i.name]) == toset(["gsi1", "gsi2", "pending"]) && alltrue([for i in aws_dynamodb_table.records.global_secondary_index : i.projection_type == "ALL"])
    error_message = "gsi1, gsi2 and the sparse pending index, projecting everything — the shape service/src/db/table.ts declares"
  }
  assert {
    condition     = alltrue([for i in aws_dynamodb_table.records.global_secondary_index : i.hash_key == "${i.name == "pending" ? "pending_pk" : "${i.name}pk"}" && i.range_key == "${i.name == "pending" ? "pending_sk" : "${i.name}sk"}"])
    error_message = "each index is keyed <name>pk/<name>sk (pending_pk/pending_sk for the relay's)"
  }
  assert {
    condition     = aws_dynamodb_table.records.ttl[0].attribute_name == "expires_at" && aws_dynamodb_table.records.ttl[0].enabled == true
    error_message = "expiry is the table's TTL on expires_at"
  }
  assert {
    condition     = aws_dynamodb_table.records.point_in_time_recovery[0].enabled == true && aws_dynamodb_table.records.server_side_encryption[0].enabled == true
    error_message = "point-in-time recovery on, encrypted"
  }
  assert {
    condition     = output.table_name == aws_dynamodb_table.records.name
    error_message = "the module outputs its table's name for the tenant's seed run"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["RECORD_SINK"]) == "off"
    error_message = "the service writes the outbox and relays nothing; the relay function is the one relay"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["MAESTRO_WORKSPACE_ID"]) == "ws-aannemer-x" && nonsensitive(aws_lambda_function.service.environment[0].variables["MAESTRO_ACCOUNTABLE"]) == "prn-h-0000000000ex" && nonsensitive(aws_lambda_function.service.environment[0].variables["MAESTRO_CONSEQUENCE_CLASS"]) == "c1"
    error_message = "the record's names come through the tenant's environment"
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
    condition     = nonsensitive(aws_lambda_function.backup.environment[0].variables["TABLE_NAME"]) == "maestro-identity" && !contains(keys(nonsensitive(aws_lambda_function.backup.environment[0].variables)), "MONGO_URI") && !contains(keys(nonsensitive(aws_lambda_function.backup.environment[0].variables)), "BACKUP_PASSPHRASE")
    error_message = "the backup is told the table and holds no database secret; without one configured, no passphrase either"
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.backup.policy, "s3:PutObject") && !strcontains(aws_iam_role_policy.backup.policy, "s3:GetObject") && !strcontains(aws_iam_role_policy.backup.policy, "Delete")
    error_message = "the backup writes; it never reads or deletes a backup"
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.backup.policy, "dynamodb:Scan") && strcontains(aws_iam_role_policy.backup.policy, "dynamodb:DescribeTable") && !strcontains(aws_iam_role_policy.backup.policy, "dynamodb:PutItem") && !strcontains(aws_iam_role_policy.backup.policy, "dynamodb:UpdateItem") && !strcontains(aws_iam_role_policy.backup.policy, "dynamodb:Query")
    error_message = "the backup reads the whole table and nothing else: Scan and DescribeTable only"
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

  # --- the relay ---
  assert {
    condition     = aws_lambda_function.relay.runtime == "nodejs22.x" && aws_lambda_function.relay.architectures[0] == "arm64" && aws_lambda_function.relay.handler == "index.handler" && aws_lambda_function.relay.layers == null
    error_message = "the relay is a plain handler on Node 22, arm64, no adapter"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.relay.environment[0].variables["ARCHIVE_BUCKET"]) == "aannemer-x-maestro-archive" && nonsensitive(aws_lambda_function.relay.environment[0].variables["ARCHIVE_PREFIX"]) == "identity/" && nonsensitive(aws_lambda_function.relay.environment[0].variables["EVENTS_TOPIC_ARN"]) == "arn:aws:sns:eu-west-1::aannemer-x-spine-events.fifo"
    error_message = "the relay carries the spine's three names as the spine's module output them"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.relay.environment[0].variables["TABLE_NAME"]) == "maestro-identity" && nonsensitive(aws_lambda_function.relay.environment[0].variables["MAESTRO_WORKSPACE_ID"]) == "ws-aannemer-x"
    error_message = "the relay reads the same table and configuration as the service"
  }
  assert {
    condition     = !contains(keys(nonsensitive(aws_lambda_function.relay.environment[0].variables)), "OAUTH_KEY_PASSPHRASE") && !contains(keys(nonsensitive(aws_lambda_function.relay.environment[0].variables)), "AUTH_JWT_SECRET") && !contains(keys(nonsensitive(aws_lambda_function.relay.environment[0].variables)), "IDENTITY_ADMIN_CLIENT_SECRET") && !contains(keys(nonsensitive(aws_lambda_function.relay.environment[0].variables)), "MONGO_URI")
    error_message = "the relay holds no secret at all: a relay cannot sign tokens, and the table is a grant"
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.relay_table.policy, "dynamodb:Query") && strcontains(aws_iam_role_policy.relay_table.policy, "dynamodb:UpdateItem") && strcontains(aws_iam_role_policy.relay_table.policy, "/index/*") && !strcontains(aws_iam_role_policy.relay_table.policy, "dynamodb:Scan")
    error_message = "the relay reads the pending index and acknowledges under the component's grant; it never scans"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.relay.environment[0].variables["NODE_ENV"]) == "production" && nonsensitive(aws_lambda_function.relay.environment[0].variables["LOG_PRETTY"]) == "false"
    error_message = "production, JSON logs — pino-pretty is not in the bundle"
  }
  assert {
    condition     = aws_iam_role_policy.relay_archive.policy == var.archive.relay_policy_json
    error_message = "the relay's archive policy is the spine's, attached unchanged"
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.relay_logs.policy, "s3:") && !strcontains(aws_iam_role_policy.relay_logs.policy, "sns:")
    error_message = "the relay's own policy is its log; the archive and the topic come from the spine's policy"
  }
  assert {
    condition     = aws_lambda_function.relay.reserved_concurrent_executions == 1
    error_message = "one relay at a time: the outbox is drained in order"
  }
  assert {
    condition     = aws_scheduler_schedule.relay.schedule_expression == "rate(1 minute)" && aws_scheduler_schedule.relay.flexible_time_window[0].mode == "OFF"
    error_message = "the relay runs every minute, on the minute"
  }
  assert {
    condition     = aws_scheduler_schedule.relay.target[0].retry_policy[0].maximum_retry_attempts == 2 && aws_scheduler_schedule.relay.target[0].retry_policy[0].maximum_event_age_in_seconds == 300
    error_message = "a tick the scheduler could not deliver is retried twice and dropped after five minutes"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.relay_errors.threshold == 1 && aws_cloudwatch_metric_alarm.relay_errors.period == 3600
    error_message = "one relay error in an hour alarms"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.relay_silent.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.relay_silent.period == 900 && aws_cloudwatch_metric_alarm.relay_silent.comparison_operator == "LessThanThreshold"
    error_message = "a relay that has not run in fifteen minutes is an alarm, not a quiet quarter-hour"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.relay_refused.namespace == "maestro/spine" && aws_cloudwatch_metric_alarm.relay_refused.metric_name == "Refused" && aws_cloudwatch_metric_alarm.relay_refused.dimensions["function"] == "relay" && aws_cloudwatch_metric_alarm.relay_refused.dimensions["component"] == "identity"
    error_message = "a refused event is an alarm on the spine's metric for this component"
  }
  assert {
    condition     = output.relay_function_name == "maestro-identity-relay"
    error_message = "the relay is named after the module"
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
    relay_schedule               = "rate(5 minutes)"
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
  assert {
    condition     = aws_scheduler_schedule.relay.schedule_expression == "rate(5 minutes)"
    error_message = "the tenant chose the relay's schedule"
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
      RECORD_SINK             = "s3" # a tenant's mistake; the module owns this one
      ARCHIVE_BUCKET          = "somewhere-else"
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
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["RECORD_SINK"]) == "off"
    error_message = "RECORD_SINK is the module's: the relay function is the one relay, whatever the tenant's environment says"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.relay.environment[0].variables["ARCHIVE_BUCKET"]) == "aannemer-x-maestro-archive"
    error_message = "the archive's names on the relay are the spine's, not the tenant's environment's"
  }
}

run "rejects_a_domain_without_a_certificate" {
  command = plan

  variables {
    domain = "id.aannemer-x.example"
  }

  expect_failures = [aws_apigatewayv2_domain_name.this]
}

run "rejects_secrets_without_the_key_passphrase" {
  command = plan

  variables {
    secrets = {
      AUTH_JWT_SECRET = "arn:aws:secretsmanager:eu-west-1::secret:aannemer-x/identity/jwt-secret"
    }
  }

  expect_failures = [var.secrets]
}

run "the_tenant_may_name_the_table" {
  command = plan

  variables {
    table_name = "aannemer-x-identity-records"
  }

  assert {
    condition     = aws_dynamodb_table.records.name == "aannemer-x-identity-records" && output.table_name == "aannemer-x-identity-records"
    error_message = "table_name overrides the default, and every function is told the same name"
  }
  assert {
    condition     = nonsensitive(aws_lambda_function.service.environment[0].variables["TABLE_NAME"]) == "aannemer-x-identity-records" && nonsensitive(aws_lambda_function.relay.environment[0].variables["TABLE_NAME"]) == "aannemer-x-identity-records" && nonsensitive(aws_lambda_function.backup.environment[0].variables["TABLE_NAME"]) == "aannemer-x-identity-records"
    error_message = "the service, the relay and the backup all name the one table"
  }
}

run "rejects_a_layer_that_is_not_the_adapter" {
  command = plan

  variables {
    web_adapter_layer_arn = "arn:aws:lambda:eu-west-1::layer:SomethingElse:1"
  }

  expect_failures = [var.web_adapter_layer_arn]
}

run "rejects_an_archive_missing_a_name" {
  command = plan

  variables {
    archive = {
      relay_environment = {
        ARCHIVE_BUCKET = "aannemer-x-maestro-archive"
      }
      relay_policy_json = "{}"
    }
  }

  expect_failures = [var.archive]
}
