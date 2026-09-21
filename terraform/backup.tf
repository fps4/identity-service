# The backup (ADR-0008 on AWS, ADR-0023): a scheduled Lambda pages the whole table to a bucket as
# gzipped canonical JSON lines under <prefix>/<yyyy-mm-dd>/, one file per item kind, with a manifest —
# service/lambda/backup.ts. The bucket is versioned, encrypted, never public, TLS-only, and expires
# backups by a lifecycle rule. No Object Lock: a backup is a recovery point, not the record; the record
# is the spine's archive. The table's point-in-time recovery (table.tf) is the second line.

locals {
  backup_name = "${var.name}-backup"

  # The passphrase is the backup's one secret, and only when the tenant sets one. The table is a grant.
  backup_secrets = var.backup_passphrase_secret_arn == null ? {} : { BACKUP_PASSPHRASE = var.backup_passphrase_secret_arn }
}

data "aws_secretsmanager_secret_version" "backup" {
  for_each  = local.backup_secrets
  secret_id = each.value
}

# --- the bucket ----------------------------------------------------------------------------------

resource "aws_s3_bucket" "backup" {
  bucket = var.backup_bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    id     = "expire-backups"
    status = "Enabled"
    filter {
      prefix = "${trimsuffix(var.backup_prefix, "/")}/"
    }
    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.backup_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.backup]
}

resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.backup]
}

# --- the function --------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "backup" {
  name              = "/aws/lambda/${local.backup_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "backup" {
  name = local.backup_name
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

# Read the whole table, write under the prefix, never read or delete a backup: a compromised backup
# job cannot read a backup, remove one, or change the table.
resource "aws_iam_role_policy" "backup" {
  name = "backup"
  role = aws_iam_role.backup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.records.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.backup.arn}/${trimsuffix(var.backup_prefix, "/")}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.backup.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "backup" {
  function_name    = local.backup_name
  role             = aws_iam_role.backup.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = var.backup_package
  source_code_hash = filebase64sha256(var.backup_package)
  timeout          = var.backup_timeout_seconds
  memory_size      = var.backup_memory_mb
  tags             = local.tags

  environment {
    variables = merge(
      {
        TABLE_NAME    = aws_dynamodb_table.records.name
        BACKUP_BUCKET = aws_s3_bucket.backup.bucket
        BACKUP_PREFIX = trimsuffix(var.backup_prefix, "/")
      },
      { for key, version in data.aws_secretsmanager_secret_version.backup : key => version.secret_string }
    )
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.backup.name
  }

  depends_on = [aws_iam_role_policy.backup]
}

resource "aws_iam_role" "backup_scheduler" {
  name = "${local.backup_name}-schedule"
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

resource "aws_iam_role_policy" "backup_scheduler" {
  name = "invoke-backup"
  role = aws_iam_role.backup_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.backup.arn
    }]
  })
}

resource "aws_scheduler_schedule" "backup" {
  name                         = local.backup_name
  schedule_expression          = var.backup_schedule
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.backup.arn
    role_arn = aws_iam_role.backup_scheduler.arn
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}

# The backup failed.
resource "aws_cloudwatch_metric_alarm" "backup_errors" {
  alarm_name          = "${local.backup_name}-errors"
  alarm_description   = "identity-service's backup errored; there is no recovery point for today."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.backup.function_name }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = local.tags
}

# The backup did not run. Silence is the failure a job cannot report about itself.
resource "aws_cloudwatch_metric_alarm" "backup_silent" {
  alarm_name          = "${local.backup_name}-silent"
  alarm_description   = "identity-service's backup has not run in a day."
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = aws_lambda_function.backup.function_name }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = local.tags
}
