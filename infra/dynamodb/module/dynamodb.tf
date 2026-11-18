# Single table. Only the base keys and one generic GSI are declared; add GSIs when an
# access pattern actually needs one. What sits where, and why connections, messages,
# contacts and invitations need no index at all (GSI1 is declared and unused), is
# design/DECISIONS.md D16.
resource "aws_dynamodb_table" "table" {
  name                        = "${var.project}-${var.stage}-${var.version-suffix}"
  billing_mode                = "PAY_PER_REQUEST"
  deletion_protection_enabled = false
  hash_key                    = "PK"
  range_key                   = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }

  # Deletes each item some time after its `ttl` (epoch seconds) — AWS says typically within
  # a few days — so readers must still filter on expiry (DECISIONS D8).
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  tags = {
    project = var.project
    stage   = var.stage
  }
}

output "table_name" {
  value = aws_dynamodb_table.table.name
}
output "table_arn" {
  value = aws_dynamodb_table.table.arn
}
