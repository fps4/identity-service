# The relay (ADR-0022 §5): a scheduled Lambda runs the spine's relay handler over this service's
# outbox — service/src/relay/lambda.ts — into the archive bucket and the FIFO topic the spine's own
# module owns. That module's outputs arrive as `archive`; this one attaches its policy unchanged and
# carries its names. The service itself runs with RECORD_SINK=off (main.tf): one outbox, one relay.
#
# The relay holds no secret. The signing-key passphrase, the JWT secret and the admin client secret are
# the service's alone: a relay that could sign tokens would be a wider thing than a relay. Its reach into
# the table is the same grant every function of a component gets (table.tf): the pending index it reads,
# the outbox items it acknowledges, the registry rows it resolves principals from.

locals {
  relay_name = "${var.name}-relay"
}

resource "aws_cloudwatch_log_group" "relay" {
  name              = "/aws/lambda/${local.relay_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "relay" {
  name = local.relay_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "relay_logs" {
  name = "logs"
  role = aws_iam_role.relay.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.relay.arn}:*"
    }]
  })
}

# The outbox side: the table and its indexes, under the component's one grant (table.tf).
resource "aws_iam_role_policy" "relay_table" {
  name = "table"
  role = aws_iam_role.relay.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.table_actions
      Resource = local.table_resources
    }]
  })
}

# What the spine allows a relay: read and write the archive prefix, publish to the events topic,
# never delete. The spine's module wrote it; this one attaches it unchanged.
resource "aws_iam_role_policy" "relay_archive" {
  name   = "archive"
  role   = aws_iam_role.relay.id
  policy = var.archive.relay_policy_json
}

# One at a time: the outbox is drained in `seq` order, and a second invocation while one runs is
# throttled and retried by the schedule rather than run beside it.
resource "aws_lambda_function" "relay" {
  function_name                  = local.relay_name
  role                           = aws_iam_role.relay.arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = var.relay_package
  source_code_hash               = filebase64sha256(var.relay_package)
  timeout                        = var.relay_timeout_seconds
  memory_size                    = var.relay_memory_mb
  reserved_concurrent_executions = 1
  tags                           = local.tags

  # Precedence: the module's defaults, the tenant's environment (LOG_LEVEL, the MAESTRO_* names — the
  # same map the service gets), then the table and the spine's three names, which nothing overrides.
  environment {
    variables = merge(
      {
        NODE_ENV   = "production"
        LOG_PRETTY = "false"
      },
      var.environment,
      { TABLE_NAME = aws_dynamodb_table.records.name },
      var.archive.relay_environment
    )
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.relay.name
  }

  depends_on = [aws_iam_role_policy.relay_logs, aws_iam_role_policy.relay_table, aws_iam_role_policy.relay_archive]
}

resource "aws_iam_role" "relay_scheduler" {
  name = "${local.relay_name}-schedule"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "relay_scheduler" {
  name = "invoke-relay"
  role = aws_iam_role.relay_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.relay.arn
    }]
  })
}

# Every minute, on the minute. A run the scheduler could not start is retried twice and dropped after
# five minutes — the next tick is the retry that matters.
resource "aws_scheduler_schedule" "relay" {
  name                         = local.relay_name
  schedule_expression          = var.relay_schedule
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.relay.arn
    role_arn = aws_iam_role.relay_scheduler.arn
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 300
    }
  }
}

# The relay failed; events stay pending in the outbox.
resource "aws_cloudwatch_metric_alarm" "relay_errors" {
  alarm_name          = "${local.relay_name}-errors"
  alarm_description   = "identity-service's relay errored; principal events stay pending in the outbox."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.relay.function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = local.tags
}

# The relay did not run. Silence is the failure a component cannot report about itself.
resource "aws_cloudwatch_metric_alarm" "relay_silent" {
  alarm_name          = "${local.relay_name}-silent"
  alarm_description   = "identity-service's relay has not run in fifteen minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = aws_lambda_function.relay.function_name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = local.tags
}

# The spine refused an event. That workspace's relay stops where it stands, by design, until a person
# looks; the relay reports it as a metric in its log line (embedded metric format, `maestro/spine`).
resource "aws_cloudwatch_metric_alarm" "relay_refused" {
  alarm_name          = "${local.relay_name}-refused"
  alarm_description   = "The spine refused an event from identity-service; that workspace's relay is stopped until a person looks."
  namespace           = "maestro/spine"
  metric_name         = "Refused"
  dimensions          = { function = "relay", component = "identity" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = local.tags
}
