# identity-service on AWS (maestro M1, ADR-0002/0006/0016): the Express server unchanged, behind the
# Lambda Web Adapter on a Lambda function, behind an HTTP API Gateway — one realm per deployment. The
# database is the tenant's Atlas cluster, named by MONGO_URI (ADR-0005). Backups are in backup.tf.

locals {
  tags         = merge({ "maestro:component" = "identity-service" }, var.tags)
  service_name = "${var.name}-service"
  port         = "7305" # what the service listens on (PORT, default 7305) and the adapter forwards to

  # The issuer is the realm's public HTTPS URL: the custom domain when there is one, else the API's
  # default endpoint. The API resource itself references nothing of the function, so the function's
  # environment may carry the endpoint and the integration the function — no cycle.
  issuer = var.domain != null ? "https://${var.domain}" : aws_apigatewayv2_api.this.api_endpoint

  secret_values = { for key, version in data.aws_secretsmanager_secret_version.secret : key => version.secret_string }

  # Precedence: the module's defaults, the tenant's environment, the secrets, then the adapter's own
  # variables and the issuer, which nothing overrides.
  service_environment = merge(
    {
      NODE_ENV   = "production"
      LOG_PRETTY = "false"
    },
    var.environment,
    local.secret_values,
    {
      PORT                             = local.port
      AUTH_JWT_ISSUER                  = local.issuer
      GOOGLE_REDIRECT_URI              = "${local.issuer}/oauth2/callback"
      AWS_LAMBDA_EXEC_WRAPPER          = "/opt/bootstrap"
      AWS_LWA_PORT                     = local.port
      AWS_LWA_READINESS_CHECK_PATH     = "/health"
      AWS_LWA_READINESS_CHECK_PROTOCOL = "http"
      # The server connects to the database before it listens; if that outlasts the 10 s init window
      # the adapter keeps waiting during the first invocation instead of failing the cold start.
      AWS_LWA_ASYNC_INIT = "true"
    }
  )
}

data "aws_secretsmanager_secret_version" "secret" {
  for_each  = var.secrets
  secret_id = each.value
}

# --- the service function --------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "service" {
  name              = "/aws/lambda/${local.service_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "service" {
  name = local.service_name
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

# Logs only. The service talks to its database and to Google; its signing keys live encrypted in the
# database (src/utils/key-store.ts), not in any AWS service, so it needs no AWS API.
resource "aws_iam_role_policy" "service" {
  name = "service"
  role = aws_iam_role.service.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.service.arn}:*"
    }]
  })
}

resource "aws_lambda_function" "service" {
  function_name    = local.service_name
  role             = aws_iam_role.service.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "run.sh" # the Web Adapter's zip mode: the layer's bootstrap runs it
  layers           = [var.web_adapter_layer_arn]
  filename         = var.service_package
  source_code_hash = filebase64sha256(var.service_package)
  timeout          = var.timeout_seconds
  memory_size      = var.memory_mb
  tags             = local.tags

  environment {
    variables = local.service_environment
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.service.name
  }

  depends_on = [aws_iam_role_policy.service]
}

# --- the HTTP API -----------------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
  description   = "identity-service: OAuth 2.0 / OIDC issuer, JWKS, management plane"
  tags          = local.tags
}

resource "aws_apigatewayv2_integration" "service" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.service.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

# Every path to the service; the service routes. CORS is the service's too (CORS_ORIGINS), so the API
# adds none of its own.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.service.id}"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  tags        = local.tags

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      path           = "$context.path"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      latencyMs      = "$context.responseLatency"
      integrationErr = "$context.integrationErrorMessage"
      sourceIp       = "$context.identity.sourceIp"
      userAgent      = "$context.identity.userAgent"
    })
  }

  default_route_settings {
    throttling_burst_limit = 500
    throttling_rate_limit  = 200
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.service.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# The custom domain, when the tenant names one. DNS is the root's: an alias to `domain_target`.
resource "aws_apigatewayv2_domain_name" "this" {
  count       = var.domain == null ? 0 : 1
  domain_name = var.domain
  tags        = local.tags

  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  lifecycle {
    precondition {
      condition     = var.certificate_arn != null
      error_message = "A domain needs certificate_arn: an ACM certificate for it in the deployment's region."
    }
  }
}

resource "aws_apigatewayv2_api_mapping" "this" {
  count       = var.domain == null ? 0 : 1
  api_id      = aws_apigatewayv2_api.this.id
  domain_name = aws_apigatewayv2_domain_name.this[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

# The realm is answering with errors: the function failed, timed out or the database is unreachable.
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "identity-service's API returned 5xx: tokens, JWKS or the login are failing."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = local.tags
}
