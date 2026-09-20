# The table (ADR-0023, maestro ADR-0018): one DynamoDB table per deployment, the realm's record store,
# made and owned by this module — the same shape in every component. On-demand, point-in-time recovery
# on, encrypted, and never destroyed by a plan: a tear-down removes `prevent_destroy` in a change of its
# own. Its shape — the keys, the two general indexes, the sparse `pending` index the relay reads, the
# TTL attribute — is declared once more in code, `service/src/db/table.ts`, which the tests and the
# compose loop create their tables from and the service checks its table against at boot; the two must
# match, and a change to one is a change to both in the same pull request.
#
# No database credential exists: each function is granted the actions it needs on the table and its
# indexes (main.tf, relay.tf, backup.tf), and nothing else can reach it.

resource "aws_dynamodb_table" "records" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  tags         = local.tags

  lifecycle {
    prevent_destroy = true
  }

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }
  attribute {
    name = "pending_pk"
    type = "S"
  }
  attribute {
    name = "pending_sk"
    type = "S"
  }

  # A second access path per kind: a credential by application, a refresh token by its hash.
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  # A time-ordered path per kind: a token by type and issue time, a user by creation.
  global_secondary_index {
    name            = "gsi2"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }

  # Sparse: only an undelivered outbox item carries these keys; the relay reads it oldest first and
  # delivering removes them (ADR-0022 §5).
  global_secondary_index {
    name            = "pending"
    hash_key        = "pending_pk"
    range_key       = "pending_sk"
    projection_type = "ALL"
  }

  # Sessions, tokens and in-flight logins expire; the rest carries no `expires_at`.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  # The second line behind the backup (backup.tf): any second of the last 35 days.
  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

locals {
  table_name = coalesce(var.table_name, var.name)

  # The table and its indexes, as a policy names them.
  table_resources = [aws_dynamodb_table.records.arn, "${aws_dynamodb_table.records.arn}/index/*"]

  # What a function that reads and writes items may do: every item action, the transaction, the
  # description the boot check reads — and never Scan, which only the backup (backup.tf) is granted.
  table_actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:Query",
    "dynamodb:BatchGetItem",
    "dynamodb:BatchWriteItem",
    "dynamodb:TransactWriteItems",
    "dynamodb:ConditionCheckItem",
    "dynamodb:DescribeTable"
  ]
}
