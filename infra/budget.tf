# Cost guardrail, created before anything else is deployed (SPEC.md: Risks).
# Budgets without actions are free per AWS pricing at time of writing; re-check before apply.

locals {
  budget_alerts = {
    actual_50      = { type = "ACTUAL", threshold = 50 }
    actual_80      = { type = "ACTUAL", threshold = 80 }
    actual_100     = { type = "ACTUAL", threshold = 100 }
    forecasted_100 = { type = "FORECASTED", threshold = 100 }
  }
}

resource "aws_budgets_budget" "monthly" {
  name         = "incident-tracker-${var.environment}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = local.budget_alerts
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = [var.budget_alert_email]
    }
  }
}
